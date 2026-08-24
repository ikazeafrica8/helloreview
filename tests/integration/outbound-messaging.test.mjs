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

describe('Phase 6 transactional outbound messaging', () => {
  test('enforces dedupe, rollback atomicity, SKIP LOCKED claims, retries, and ownership suppression', async () => {
    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      const db = createDbClient(postgres.url)
      try {
        const ids = await seedPhase6Workflow(pool, 'integration')
        const templates = new MessageTemplateRepository()
        const intents = new OutboundIntentService(templates)
        const ownership = new HumanOwnershipService(pool)

        const first = await runInTransaction(pool, async (tx) =>
          intents.enqueueIntent(tx, phase6Intent(ids.workflowId, ids.now)),
        )
        expect(first).toMatchObject({ status: 'pending', deduplicated: false, templateVersion: 1 })
        expect(
          (
            await pool.query(`SELECT template_version, rendered_content FROM outbound_notifications WHERE id = $1`, [
              first.id,
            ])
          ).rows[0],
        ).toEqual({ template_version: 1, rendered_content: '안녕하세요 Phase 6 안내입니다.' })
        const duplicate = await runInTransaction(pool, async (tx) =>
          intents.enqueueIntent(tx, phase6Intent(ids.workflowId, ids.now)),
        )
        expect(duplicate).toMatchObject({ id: first.id, deduplicated: true })

        await expect(
          pool.query(
            `INSERT INTO outbound_notifications (
               workflow_id, channel, recipient_reference, purpose_code, content_version,
               business_event_version, deduplication_key, intent_source, template_id,
               template_version, rendered_content, status, next_attempt_at
             )
             SELECT workflow_id, channel, recipient_reference, purpose_code, content_version,
                    business_event_version, deduplication_key, intent_source, template_id,
                    template_version, rendered_content, status, next_attempt_at
               FROM outbound_notifications WHERE id = $1`,
            [first.id],
          ),
        ).rejects.toMatchObject({
          code: '23505',
          constraint: 'outbound_notifications_deduplication_key_key',
        })

        await expect(
          runInTransaction(pool, async (tx) => {
            await tx.query(`UPDATE workflow_instances SET version = version + 1 WHERE id = $1`, [ids.workflowId])
            await intents.enqueueIntent(
              tx,
              phase6Intent(ids.workflowId, ids.now, {
                contentVersion: 'rollback_v1',
                businessEventVersion: 'rollback_event_v1',
              }),
            )
            throw new Error('ROLL_BACK_PHASE_6')
          }),
        ).rejects.toThrow('ROLL_BACK_PHASE_6')
        expect(
          (await pool.query(`SELECT version FROM workflow_instances WHERE id = $1`, [ids.workflowId])).rows[0].version,
        ).toBe(0)
        expect(
          (
            await pool.query(
              `SELECT count(*)::integer AS count FROM outbound_notifications WHERE content_version = $1`,
              ['rollback_v1'],
            )
          ).rows[0].count,
        ).toBe(0)

        const second = await runInTransaction(pool, async (tx) =>
          intents.enqueueIntent(
            tx,
            phase6Intent(ids.workflowId, ids.now, {
              contentVersion: 'template_v2',
              businessEventVersion: 'event_v2',
            }),
          ),
        )
        const store = createOutboundNotificationStore(db)
        const concurrentClaims = await Promise.all([
          store.claimForSend('worker-a', ids.now, 1),
          store.claimForSend('worker-b', ids.now, 1),
        ])
        expect(concurrentClaims.flat()).toHaveLength(2)
        expect(new Set(concurrentClaims.flat().map((notification) => notification.id)).size).toBe(2)
        expect(await store.claimForSend('worker-c', ids.now, 10)).toEqual([])
        expect(concurrentClaims.flat().map((notification) => notification.id)).toEqual(
          expect.arrayContaining([first.id, second.id]),
        )

        const deliveryIntent = await runInTransaction(pool, async (tx) =>
          intents.enqueueIntent(
            tx,
            phase6Intent(ids.workflowId, ids.now, {
              contentVersion: 'delivery_v1',
              businessEventVersion: 'delivery_event_v1',
            }),
          ),
        )
        const provider = createFakeOutboundProvider({ sendPlan: ['timeout', 'accepted'], reconcilePlan: ['failed'] })
        const processor = createOutboundDeliveryProcessor(store, provider, {
          workerId: 'delivery-worker',
          batchSize: 1,
          retryDelayMs: 0,
          reconciliationDelayMs: 0,
        })
        expect(await processor.sendBatch(ids.now)).toBe(1)
        expect(
          (await pool.query(`SELECT status FROM outbound_notifications WHERE id = $1`, [deliveryIntent.id])).rows[0]
            .status,
        ).toBe('unknown')
        expect(await processor.reconcileBatch(ids.now)).toBe(1)
        expect(await processor.sendBatch(ids.now)).toBe(1)
        expect(provider.logicalMessageCount()).toBe(1)
        expect(provider.attempts.map((attempt) => attempt.idempotencyKey)).toEqual([
          deliveryIntent.deduplicationKey,
          deliveryIntent.deduplicationKey,
        ])

        const assignment = await ownership.takeOwnership({
          workflowId: ids.workflowId,
          operatorId: 'operator_phase6',
          reasonCode: 'OPERATOR_JOINED_CONVERSATION',
          occurredAt: new Date(ids.now.getTime() + 1_000),
        })
        expect(assignment).toMatchObject({
          workflowId: ids.workflowId,
          operatorId: 'operator_phase6',
          startedAt: new Date(ids.now.getTime() + 1_000),
        })
        await expect(
          pool.query(
            `INSERT INTO operator_assignments (workflow_id, operator_id, reason_code, started_at)
             VALUES ($1,'operator_constraint','OPERATOR_JOINED_CONVERSATION',$2)`,
            [ids.workflowId, new Date(ids.now.getTime() + 1_500)],
          ),
        ).rejects.toMatchObject({ code: '23505', constraint: 'operator_assignments_one_active_idx' })
        await expect(
          ownership.takeOwnership({
            workflowId: ids.workflowId,
            operatorId: 'operator_other',
            reasonCode: 'OPERATOR_JOINED_CONVERSATION',
            occurredAt: new Date(ids.now.getTime() + 2_000),
          }),
        ).rejects.toMatchObject({
          reasonCode: MESSAGING_REASON.OWNERSHIP_CONFLICT,
        })

        const suppressed = await runInTransaction(pool, async (tx) =>
          intents.enqueueIntent(
            tx,
            phase6Intent(ids.workflowId, new Date(ids.now.getTime() + 3_000), {
              contentVersion: 'ai_owned_v1',
              businessEventVersion: 'ai_owned_event_v1',
            }),
          ),
        )
        expect(suppressed).toMatchObject({
          status: 'suppressed',
          suppressionReason: MESSAGING_REASON.HUMAN_OWNERSHIP_ACTIVE,
        })
        expect(
          (
            await pool.query(
              `SELECT event_type, reason_code FROM outbound_notification_events WHERE notification_id = $1`,
              [suppressed.id],
            )
          ).rows,
        ).toContainEqual({ event_type: 'suppressed', reason_code: MESSAGING_REASON.HUMAN_OWNERSHIP_ACTIVE })

        const approvedSystemNotice = await runInTransaction(pool, async (tx) =>
          intents.enqueueIntent(
            tx,
            phase6Intent(ids.workflowId, new Date(ids.now.getTime() + 4_000), {
              source: 'system_notice',
              actorId: 'system_phase6',
              contentVersion: 'allowed_notice_v1',
              businessEventVersion: 'allowed_notice_event_v1',
            }),
          ),
        )

        const operatorIntent = await runInTransaction(pool, async (tx) =>
          intents.enqueueIntent(
            tx,
            phase6Intent(ids.workflowId, new Date(ids.now.getTime() + 3_500), {
              source: 'operator',
              actorId: 'operator_phase6',
              contentVersion: 'operator_message_v1',
              businessEventVersion: 'operator_message_event_v1',
            }),
          ),
        )
        expect(operatorIntent.status).toBe('pending')

        await expect(
          runInTransaction(pool, async (tx) =>
            intents.enqueueIntent(
              tx,
              phase6Intent(ids.workflowId, new Date(ids.now.getTime() + 3_600), {
                source: 'operator',
                actorId: 'operator_other',
                contentVersion: 'unowned_operator_message_v1',
              }),
            ),
          ),
        ).rejects.toMatchObject({ reasonCode: MESSAGING_REASON.OPERATOR_OWNERSHIP_REQUIRED })
        expect(approvedSystemNotice.status).toBe('pending')

        await expect(
          runInTransaction(pool, async (tx) =>
            intents.enqueueIntent(
              tx,
              phase6Intent(ids.workflowId, new Date(ids.now.getTime() + 5_000), {
                purpose: 'SELECTION_RESULT',
                source: 'system_notice',
                actorId: 'system_phase6',
                contentVersion: 'unapproved_notice_v1',
              }),
            ),
          ),
        ).rejects.toMatchObject({ reasonCode: MESSAGING_REASON.SYSTEM_NOTICE_NOT_ALLOWLISTED })

        await ownership.releaseOwnership(ids.workflowId, 'operator_phase6', new Date(ids.now.getTime() + 6_000))
        expect(
          (
            await pool.query(
              `SELECT operator_id, started_at, ended_at, ended_by FROM operator_assignments WHERE id = $1`,
              [assignment.id],
            )
          ).rows[0],
        ).toMatchObject({ operator_id: 'operator_phase6', ended_by: 'operator_phase6' })
      } finally {
        await db.close()
        await pool.end()
      }
    })
  })
})
