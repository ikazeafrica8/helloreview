import { describe, expect, test } from 'vitest'
import { Pool } from 'pg'
import { createFakeOutboundProvider } from '../../packages/adapters/dist/index.js'
import { applyMigrations, createDbClient, runInTransaction } from '../../packages/db/dist/index.js'
import { withPostgres } from '../../packages/testing/dist/index.js'
import {
  HumanOwnershipService,
  MESSAGING_REASON,
  MessageTemplateRepository,
  OutboundIntentService,
} from '../../apps/api/dist/modules/messaging/index.js'
import {
  createOutboundDeliveryProcessor,
  createOutboundNotificationStore,
} from '../../apps/worker/dist/processors/index.js'
import { phase6Intent, seedPhase6Workflow } from '../helpers/phase6-seed.mjs'

describe('AC-06 operator and AI concurrency — release gate', () => {
  test('Given operator owns conversation, When AI intent is created, Then it is suppressed with HUMAN_OWNERSHIP_ACTIVE', async () => {
    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      const db = createDbClient(postgres.url)
      try {
        const ids = await seedPhase6Workflow(pool, 'ac06')
        const ownership = new HumanOwnershipService(pool)
        const intents = new OutboundIntentService(new MessageTemplateRepository())
        await ownership.takeOwnership({
          workflowId: ids.workflowId,
          operatorId: 'operator_ac06',
          reasonCode: 'OPERATOR_JOINED_CONVERSATION',
          occurredAt: ids.now,
        })

        const aiIntent = await runInTransaction(pool, async (tx) =>
          intents.enqueueIntent(tx, phase6Intent(ids.workflowId, new Date(ids.now.getTime() + 1_000))),
        )
        expect(aiIntent).toMatchObject({
          status: 'suppressed',
          suppressionReason: MESSAGING_REASON.HUMAN_OWNERSHIP_ACTIVE,
        })

        const provider = createFakeOutboundProvider()
        const processor = createOutboundDeliveryProcessor(createOutboundNotificationStore(db), provider, {
          workerId: 'ac06-worker',
        })
        expect(await processor.sendBatch(new Date(ids.now.getTime() + 60_000))).toBe(0)
        expect(provider.attempts).toHaveLength(0)
      } finally {
        await db.close()
        await pool.end()
      }
    })
  })
})
