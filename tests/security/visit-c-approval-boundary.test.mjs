import { describe, expect, test } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations, runInTransaction } from '../../packages/db/dist/index.js'
import { withPostgres } from '../../packages/testing/dist/index.js'
import {
  BusinessApprovalRepository,
  BusinessApprovalService,
} from '../../apps/api/dist/modules/business-approval/index.js'
import { MessageTemplateRepository, OutboundIntentService } from '../../apps/api/dist/modules/messaging/index.js'
import { seedPhase7Workflow } from '../helpers/phase7-seed.mjs'

describe('Visit C authorization boundary', () => {
  test('participant-origin approval and direct outbox bypass both fail closed', async () => {
    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      try {
        const ids = await seedPhase7Workflow(pool, 'security-visit-c')
        const approvals = new BusinessApprovalService(pool, new BusinessApprovalRepository())
        await expect(
          approvals.record({
            workflowId: ids.workflowId,
            campaignId: ids.campaignId,
            applicationId: ids.applicationId,
            state: 'approved',
            source: 'participant',
            approverReference: 'participant-attempt',
            scopeCode: 'self-asserted',
            reasonCode: 'PARTICIPANT_CLAIMED_APPROVAL',
            issuedAt: ids.now,
            expiresAt: new Date(ids.now.getTime() + 86_400_000),
            recordedAt: ids.now,
          }),
        ).rejects.toMatchObject({ reasonCode: 'APPROVAL_SOURCE_NOT_AUTHORIZED' })
        expect((await pool.query(`SELECT count(*)::integer AS count FROM business_approvals`)).rows[0].count).toBe(0)

        const intents = new OutboundIntentService(new MessageTemplateRepository())
        await expect(
          runInTransaction(pool, (tx) =>
            intents.enqueueIntent(tx, {
              workflowId: ids.workflowId,
              channel: 'KAKAO',
              recipientReference: 'kakao-security',
              purpose: 'VISIT_C_BOOKING_INSTRUCTIONS',
              templatePurposeCode: 'VISIT_C_BOOKING_INSTRUCTIONS',
              templateVersion: 1,
              contentVersion: 'bypass-attempt',
              variables: {},
              source: 'automated',
              actorId: 'unauthorized-caller',
              occurredAt: ids.now,
            }),
          ),
        ).rejects.toMatchObject({ reasonCode: 'VISIT_C_APPROVAL_REQUIRED' })
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
