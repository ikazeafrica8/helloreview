import { describe, expect, test } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../../packages/db/dist/index.js'
import { withPostgres } from '../../packages/testing/dist/index.js'
import {
  PRIVACY_DATA_CLASSES,
  PRIVACY_LEGAL_HOLD_SCOPE_SCHEMA_VERSION,
  PRIVACY_RETENTION_SCHEDULE_SCHEMA_VERSION,
  PRIVACY_RETENTION_SUBJECT_SCHEMA_VERSION,
  PrivacyRetentionService,
} from '../../apps/api/dist/modules/privacy-ops/index.js'

const approvedAt = new Date('2026-08-01T00:00:00.000Z')
const effectiveFrom = new Date('2026-08-02T00:00:00.000Z')
const actor = {
  actorReference: 'privacy-reviewer:pseudo:98',
  privacyReviewerAuthorized: true,
  correlationId: 'cor:privacy-retention:98',
}
const testSchedule = (overrides = {}) => ({
  schemaVersion: PRIVACY_RETENTION_SCHEDULE_SCHEMA_VERSION,
  policyVersion: 'privacy-retention-test-fixture-v1',
  supersedesPolicyVersion: null,
  approved: true,
  companyApprovalReference: 'test-fixture:company-approval:98',
  legalApprovalReference: 'test-fixture:legal-approval:98',
  approvedAt,
  effectiveFrom,
  entries: PRIVACY_DATA_CLASSES.map((dataClass) => ({ dataClass, retentionDays: 2, disposition: 'delete' })),
  ...overrides,
})
const subject = (participantId, overrides = {}) => ({
  schemaVersion: PRIVACY_RETENTION_SUBJECT_SCHEMA_VERSION,
  participantId,
  dataClass: 'attachments',
  recordReference: 'attachment:pseudo:99',
  retentionAnchorAt: new Date('2026-08-01T00:00:00.000Z'),
  ...overrides,
})

describe('T98-T99 approved retention registry and legal-hold eligibility', () => {
  test('fails closed without policy, records immutable evidence, and never executes deletion', async () => {
    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      try {
        const participantId = (await pool.query(`INSERT INTO participants DEFAULT VALUES RETURNING id`)).rows[0].id
        const service = new PrivacyRetentionService(pool)
        const input = {
          ...actor,
          evaluationReference: 'eligibility:pseudo:no-policy',
          subject: subject(participantId),
          evaluatedAt: new Date('2026-08-10T00:00:00.000Z'),
        }
        const first = await service.evaluateDeletionEligibility(input)
        const replay = await service.evaluateDeletionEligibility(input)

        expect(first).toMatchObject({ deduplicated: false, result: { decision: 'policy_missing' } })
        expect(replay).toMatchObject({ deduplicated: true, id: first.id })
        await expect(
          service.evaluateDeletionEligibility({
            ...input,
            subject: subject(participantId, { recordReference: 'attachment:pseudo:changed' }),
          }),
        ).rejects.toMatchObject({ reasonCode: 'PRIVACY_ELIGIBILITY_REFERENCE_CONFLICT' })
        const audit = await pool.query(
          `SELECT detail FROM audit_logs WHERE action = 'PRIVACY_DELETION_ELIGIBILITY_EVALUATED'`,
        )
        expect(audit.rows).toHaveLength(1)
        expect(audit.rows[0].detail).toMatchObject({ decision: 'policy_missing', deletion_executed: false })
        await expect(
          pool.query(`UPDATE privacy_deletion_eligibility_evaluations SET decision = 'eligible'`),
        ).rejects.toThrow(/append-only/)
        await expect(pool.query(`DELETE FROM privacy_deletion_eligibility_evaluations`)).rejects.toThrow(/append-only/)
        await expect(pool.query(`TRUNCATE privacy_deletion_eligibility_evaluations`)).rejects.toThrow(/append-only/)
      } finally {
        await pool.end()
      }
    })
  })

  test('publishes only complete dual-approved versions and evaluates active versus elapsed retention', async () => {
    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      try {
        const participantId = (await pool.query(`INSERT INTO participants DEFAULT VALUES RETURNING id`)).rows[0].id
        const service = new PrivacyRetentionService(pool)
        const publishInput = { ...actor, schedule: testSchedule(), occurredAt: new Date('2026-08-01T01:00:00.000Z') }
        const published = await service.publishSchedule(publishInput)
        const replay = await service.publishSchedule(publishInput)

        expect(published).toMatchObject({
          deduplicated: false,
          schedule: { schedule: { policyVersion: 'privacy-retention-test-fixture-v1' } },
        })
        expect(replay).toMatchObject({ deduplicated: true, schedule: { id: published.schedule.id } })
        expect(
          (await pool.query(`SELECT count(*)::integer AS count FROM privacy_retention_schedule_entries`)).rows[0].count,
        ).toBe(PRIVACY_DATA_CLASSES.length)
        await expect(
          service.publishSchedule({
            ...publishInput,
            schedule: testSchedule({
              entries: testSchedule().entries.map((entry) => ({ ...entry, retentionDays: 3 })),
            }),
          }),
        ).rejects.toMatchObject({ reasonCode: 'PRIVACY_RETENTION_POLICY_VERSION_CONFLICT' })

        const active = await service.evaluateDeletionEligibility({
          ...actor,
          evaluationReference: 'eligibility:pseudo:active',
          subject: subject(participantId),
          evaluatedAt: new Date('2026-08-02T12:00:00.000Z'),
        })
        const eligible = await service.evaluateDeletionEligibility({
          ...actor,
          evaluationReference: 'eligibility:pseudo:eligible',
          subject: subject(participantId),
          evaluatedAt: new Date('2026-08-03T00:00:00.000Z'),
        })
        expect(active.result).toMatchObject({ decision: 'retention_active', disposition: 'delete' })
        expect(eligible.result).toMatchObject({ decision: 'eligible', disposition: 'delete' })

        const replacement = testSchedule({
          policyVersion: 'privacy-retention-test-fixture-v2',
          supersedesPolicyVersion: 'privacy-retention-test-fixture-v1',
          approvedAt: new Date('2026-08-03T00:00:00.000Z'),
          effectiveFrom: new Date('2026-08-04T00:00:00.000Z'),
        })
        await expect(
          service.publishSchedule({
            ...actor,
            schedule: { ...replacement, supersedesPolicyVersion: null },
            occurredAt: new Date('2026-08-03T01:00:00.000Z'),
          }),
        ).rejects.toMatchObject({ reasonCode: 'PRIVACY_RETENTION_SUPERSEDES_MISMATCH' })
        await service.publishSchedule({
          ...actor,
          schedule: replacement,
          occurredAt: new Date('2026-08-03T01:00:00.000Z'),
        })
        await expect(pool.query(`DELETE FROM privacy_retention_schedules`)).rejects.toThrow(/append-only/)
      } finally {
        await pool.end()
      }
    })
  })

  test('serializes concurrent first publication so the schedule history cannot fork', async () => {
    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      try {
        const service = new PrivacyRetentionService(pool)
        const occurredAt = new Date('2026-08-01T01:00:00.000Z')
        const outcomes = await Promise.allSettled([
          service.publishSchedule({
            ...actor,
            schedule: testSchedule({ policyVersion: 'concurrent-root-a-v1' }),
            occurredAt,
          }),
          service.publishSchedule({
            ...actor,
            schedule: testSchedule({ policyVersion: 'concurrent-root-b-v1' }),
            occurredAt,
          }),
        ])
        expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
        expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
        expect(outcomes.find((outcome) => outcome.status === 'rejected').reason).toMatchObject({
          reasonCode: 'PRIVACY_RETENTION_SUPERSEDES_MISMATCH',
        })
        expect(
          (await pool.query(`SELECT count(*)::integer AS count FROM privacy_retention_schedules`)).rows[0].count,
        ).toBe(1)
      } finally {
        await pool.end()
      }
    })
  })

  test('legal hold wins over missing or elapsed retention until an immutable release event', async () => {
    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      try {
        const participantId = (await pool.query(`INSERT INTO participants DEFAULT VALUES RETURNING id`)).rows[0].id
        const service = new PrivacyRetentionService(pool)
        const holdInput = {
          ...actor,
          holdReference: 'legal-hold:pseudo:99',
          scope: {
            schemaVersion: PRIVACY_LEGAL_HOLD_SCOPE_SCHEMA_VERSION,
            scope: 'record',
            participantId,
            dataClass: 'attachments',
            recordReference: 'attachment:pseudo:99',
          },
          reasonReference: 'legal-matter:pseudo:99',
          occurredAt: new Date('2026-08-02T00:00:00.000Z'),
        }
        const applied = await service.applyLegalHold(holdInput)
        expect(applied).toMatchObject({ deduplicated: false, hold: { releasedAt: null } })
        expect(await service.applyLegalHold(holdInput)).toMatchObject({
          deduplicated: true,
          hold: { id: applied.hold.id },
        })

        const held = await service.evaluateDeletionEligibility({
          ...actor,
          evaluationReference: 'eligibility:pseudo:held',
          subject: subject(participantId),
          evaluatedAt: new Date('2026-08-10T00:00:00.000Z'),
        })
        expect(held.result).toMatchObject({
          decision: 'legal_hold_active',
          policyVersion: null,
          activeHoldReferences: ['legal-hold:pseudo:99'],
        })

        const releaseInput = {
          ...actor,
          holdReference: 'legal-hold:pseudo:99',
          operationReference: 'legal-hold-release:pseudo:99',
          reasonReference: 'legal-release:pseudo:99',
          occurredAt: new Date('2026-08-11T00:00:00.000Z'),
        }
        expect(await service.releaseLegalHold(releaseInput)).toMatchObject({
          deduplicated: false,
          hold: { releasedAt: releaseInput.occurredAt },
        })
        expect(await service.releaseLegalHold(releaseInput)).toMatchObject({ deduplicated: true })
        const afterRelease = await service.evaluateDeletionEligibility({
          ...actor,
          evaluationReference: 'eligibility:pseudo:after-release',
          subject: subject(participantId),
          evaluatedAt: new Date('2026-08-12T00:00:00.000Z'),
        })
        expect(afterRelease.result).toMatchObject({ decision: 'policy_missing' })
        await expect(pool.query(`UPDATE privacy_legal_hold_events SET reason_reference = 'tampered'`)).rejects.toThrow(
          /append-only/,
        )
      } finally {
        await pool.end()
      }
    })
  })

  test('keeps all new evidence tables internal, RLS-enabled, append-only, and creates no deletion executor', async () => {
    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      try {
        const evidenceTables = [
          'privacy_retention_schedules',
          'privacy_retention_schedule_entries',
          'privacy_legal_holds',
          'privacy_legal_hold_events',
          'privacy_deletion_eligibility_evaluations',
        ]
        const rls = await pool.query(
          `SELECT relname, relrowsecurity FROM pg_class WHERE relname = ANY($1::text[]) ORDER BY relname`,
          [evidenceTables],
        )
        expect(rls.rows).toEqual(evidenceTables.sort().map((relname) => ({ relname, relrowsecurity: true })))
        const executorObjects = await pool.query(
          `SELECT relname FROM pg_class
            WHERE relnamespace = 'public'::regnamespace
              AND (relname LIKE 'privacy_deletion_job%' OR relname LIKE 'privacy_deletion_queue%')`,
        )
        expect(executorObjects.rows).toEqual([])
      } finally {
        await pool.end()
      }
    })
  })
})
