import { describe, expect, test } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../../packages/db/dist/index.js'
import { withPostgres } from '../../packages/testing/dist/index.js'
import {
  AutomationPauseService,
  EmergencyResumeValidationError,
  PauseAuthorizationError,
} from '../../apps/api/dist/modules/workflow-core/index.js'

const activation = (now, overrides = {}) => ({
  scope: 'global',
  kind: 'emergency_kill_switch',
  incidentReference: 'incident:pseudo:critical-42',
  actorType: 'operator',
  actorId: 'operator:pseudo:senior-1',
  authorized: true,
  correlationId: 'cor:emergency:42',
  reasonCode: 'CRITICAL_OUTBOUND_INCIDENT',
  activatedAt: now,
  ...overrides,
})

const validation = (evaluatedAt, overrides = {}) => ({
  incidentResolved: true,
  reconciliationComplete: true,
  currentStateValidated: true,
  policyVersion: 'emergency-resume-v1',
  evaluatedAt,
  ...overrides,
})

describe('T94 emergency automation kill switch', () => {
  test('requires separate activation and resume authorization plus current validation', async () => {
    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      try {
        const service = new AutomationPauseService(pool)
        const now = new Date('2026-08-26T03:00:00.000Z')
        expect(await service.emergencyStatus()).toEqual({ state: 'inactive' })

        await expect(service.activate(activation(now, { authorized: false }))).rejects.toBeInstanceOf(
          PauseAuthorizationError,
        )
        const pause = await service.activate(activation(now))
        expect(await service.emergencyStatus()).toMatchObject({
          state: 'active',
          pause: {
            id: pause.id,
            kind: 'emergency_kill_switch',
            scope: 'global',
            reasonCode: 'CRITICAL_OUTBOUND_INCIDENT',
          },
        })
        await expect(service.activate(activation(now))).rejects.toMatchObject({
          reasonCode: 'WORKFLOW_PAUSE_ALREADY_ACTIVE',
        })

        await expect(
          service.deactivate({
            pauseId: pause.id,
            actorType: 'operator',
            actorId: 'operator:pseudo:senior-2',
            authorized: false,
            correlationId: 'cor:emergency:unauthorized-resume',
            reasonCode: 'INCIDENT_RESUME_REQUESTED',
            deactivatedAt: new Date(now.getTime() + 60_000),
          }),
        ).rejects.toBeInstanceOf(PauseAuthorizationError)
        await expect(
          service.deactivate({
            pauseId: pause.id,
            actorType: 'operator',
            actorId: 'operator:pseudo:senior-2',
            authorized: true,
            correlationId: 'cor:emergency:incomplete-resume',
            reasonCode: 'INCIDENT_RESUME_REQUESTED',
            emergencyValidation: validation(new Date(now.getTime() + 119_000), {
              reconciliationComplete: false,
            }),
            deactivatedAt: new Date(now.getTime() + 120_000),
          }),
        ).rejects.toBeInstanceOf(EmergencyResumeValidationError)
        expect((await service.emergencyStatus()).state).toBe('active')

        await service.deactivate({
          pauseId: pause.id,
          actorType: 'operator',
          actorId: 'operator:pseudo:senior-2',
          authorized: true,
          correlationId: 'cor:emergency:approved-resume',
          reasonCode: 'INCIDENT_RESOLVED_AND_RECONCILED',
          emergencyValidation: validation(new Date(now.getTime() + 179_000)),
          deactivatedAt: new Date(now.getTime() + 180_000),
        })
        expect(await service.emergencyStatus()).toEqual({ state: 'inactive' })

        const audits = await pool.query(
          `SELECT action, result, reason, protected_action, detail
             FROM audit_logs
            WHERE target_type = 'automation_pause:global'
            ORDER BY occurred_at, id`,
        )
        expect(audits.rows).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              action: 'AUTOMATION_PAUSED',
              result: 'success',
              reason: 'WORKFLOW_EMERGENCY_SWITCH_ACTIVATED',
              protected_action: 'yes',
              detail: expect.objectContaining({ incident_reference: 'incident:pseudo:critical-42' }),
            }),
            expect.objectContaining({
              action: 'AUTOMATION_RESUMED',
              result: 'rejected',
              reason: 'WORKFLOW_EMERGENCY_RESUME_VALIDATION_REQUIRED',
            }),
            expect.objectContaining({
              action: 'AUTOMATION_RESUMED',
              result: 'success',
              reason: 'WORKFLOW_EMERGENCY_SWITCH_DEACTIVATED',
              protected_action: 'yes',
            }),
          ]),
        )
      } finally {
        await pool.end()
      }
    })
  })
})
