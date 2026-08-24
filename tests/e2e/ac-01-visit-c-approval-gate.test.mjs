import { describe, expect, test } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations, runInTransaction } from '../../packages/db/dist/index.js'
import { withPostgres } from '../../packages/testing/dist/index.js'
import {
  BusinessApprovalRepository,
  BusinessApprovalService,
  VisitCBookingService,
} from '../../apps/api/dist/modules/business-approval/index.js'
import { MessageTemplateRepository, OutboundIntentService } from '../../apps/api/dist/modules/messaging/index.js'
import { seedPhase7Workflow } from '../helpers/phase7-seed.mjs'

describe('AC-01 Visit C approval gate — release gate', () => {
  test('Given selected Visit C and Pending, When booking link requested, Then only approval-pending is queued', async () => {
    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      try {
        const ids = await seedPhase7Workflow(pool, 'ac01')
        const repository = new BusinessApprovalRepository()
        await new BusinessApprovalService(pool, repository).record({
          workflowId: ids.workflowId,
          campaignId: ids.campaignId,
          applicationId: ids.applicationId,
          state: 'pending',
          source: 'authorized_operator',
          approverReference: 'operator_ac01',
          scopeCode: 'assigned-campaign-and-application',
          reasonCode: 'APPROVAL_REQUESTED',
          issuedAt: null,
          expiresAt: null,
          recordedAt: ids.now,
        })
        const booking = new VisitCBookingService(repository, new OutboundIntentService(new MessageTemplateRepository()))
        const result = await runInTransaction(pool, (tx) =>
          booking.request(tx, {
            workflowId: ids.workflowId,
            channel: 'KAKAO',
            recipientReference: 'kakao-ac01',
            templateVersion: 1,
            triggeringEventId: 'ac01-booking-link-request',
            actorId: 'system_ac01',
            occurredAt: ids.now,
          }),
        )
        expect(result).toMatchObject({
          gate: { allowed: false, reasonCode: 'APPROVAL_PENDING' },
          notificationPurpose: 'VISIT_C_APPROVAL_STATUS',
        })
        expect((await pool.query(`SELECT purpose_code FROM outbound_notifications`)).rows).toEqual([
          { purpose_code: 'VISIT_C_APPROVAL_STATUS' },
        ])
        expect(
          (
            await pool.query(
              `SELECT count(*)::integer AS count FROM outbound_notifications WHERE purpose_code = 'VISIT_C_BOOKING_INSTRUCTIONS'`,
            )
          ).rows[0].count,
        ).toBe(0)
      } finally {
        await pool.end()
      }
    })
  })
})
