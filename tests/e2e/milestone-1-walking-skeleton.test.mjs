// Milestone 1 Checkpoint E — one complete composition through the core spine.
//
// This is deliberately a test composition, not a production participant flow. The real provider
// bindings and participant journeys start in Milestone 2; Milestone 1 proves that the production
// mechanisms and in-repo fakes can be wired without a hidden contract gap.

import { describe, expect, test } from 'vitest'
import { Pool } from 'pg'
import {
  createFakeInboundAdapter,
  createFakeOutboundProvider,
  fakeWireEvent,
} from '../../packages/adapters/dist/index.js'
import { EVENT_TYPES, QUEUE_NAMES } from '../../packages/contracts/dist/index.js'
import { applyMigrations, createDbClient } from '../../packages/db/dist/index.js'
import { waitingJobs, withPostgres, withRedis } from '../../packages/testing/dist/index.js'
import {
  GuidelineDeliveryRepository,
  GuidelineDeliveryService,
} from '../../apps/api/dist/modules/guideline-delivery/index.js'
import { MessageTemplateRepository, OutboundIntentService } from '../../apps/api/dist/modules/messaging/index.js'
import { InboxRepository, InboxService } from '../../apps/api/dist/modules/provider-gateway/index.js'
import {
  AutomationPauseService,
  WorkflowInstanceService,
  WorkflowTransitionService,
  WORKFLOW_GUARD,
  WORKFLOW_TRIGGER,
} from '../../apps/api/dist/modules/workflow-core/index.js'
import {
  createOutboundDeliveryProcessor,
  createOutboundNotificationStore,
} from '../../apps/worker/dist/processors/index.js'
import { guidelineRequest, seedPhase7Workflow } from '../helpers/phase7-seed.mjs'

describe('Milestone 1 walking skeleton — Checkpoint E', () => {
  test('fake inbound event reaches inbox, transition, gate, outbox, and fake provider', async () => {
    await withPostgres(async (postgres) => {
      await withRedis(async (redis) => {
        await applyMigrations(postgres.url)
        const pool = new Pool({ connectionString: postgres.url })
        const db = createDbClient(postgres.url)
        const inbox = new InboxService(new InboxRepository(pool), {
          environment: 'test',
          redisUrl: redis.url,
        })

        try {
          const ids = await seedPhase7Workflow(pool, 'walking-skeleton', {
            route: 'visit_a',
            approvalState: 'not_required',
          })
          await pool.query(
            `UPDATE workflow_instances
                SET selection_state = 'review_pending', selection_origin_at = $2
              WHERE id = $1`,
            [ids.workflowId, ids.now],
          )

          const occurredAt = new Date(ids.now.getTime() + 1_000)
          const wire = fakeWireEvent(EVENT_TYPES.SELECTION_UPDATED, 'helloreview_website', {
            eventId: 'evt_milestone1_walking_skeleton',
            occurredAt: occurredAt.toISOString(),
            payload: {
              application_id: ids.applicationId,
              campaign_id: ids.campaignId,
              selection_result: 'manually_selected',
              decision_id: 'decision_milestone1_walking_skeleton',
              decision_reason_code: 'OPERATOR_APPROVED',
              rule_version: 'manual-v1',
            },
          })
          const translated = createFakeInboundAdapter().translate({
            provider: 'helloreview_website',
            raw: wire,
            receivedAt: occurredAt,
          })
          expect(translated.ok).toBe(true)
          if (!translated.ok) throw new Error(`fake inbound translation failed: ${translated.reasonCode}`)

          const accepted = await inbox.accept(translated.event, Buffer.from(JSON.stringify(wire)))
          expect(accepted).toMatchObject({ accepted: true, duplicate: false, processing_status: 'queued' })

          const jobs = await waitingJobs(redis.url, QUEUE_NAMES.PROCESS_INBOUND_EVENT)
          expect(jobs).toHaveLength(1)
          expect(jobs[0]?.data).toMatchObject({ eventType: EVENT_TYPES.SELECTION_UPDATED })
          const inboxId = jobs[0]?.data?.inboxId
          expect(typeof inboxId).toBe('string')

          const workflows = new WorkflowInstanceService(pool)
          const transitions = new WorkflowTransitionService(pool, workflows, new AutomationPauseService(pool))
          const transition = await transitions.apply({
            workflowId: ids.workflowId,
            expectedVersion: 0,
            dimension: 'selection',
            to: 'manually_selected',
            trigger: WORKFLOW_TRIGGER.OPERATOR_SELECTED,
            triggeringEventId: translated.event.eventId,
            actorType: 'system',
            actorId: 'fake-inbound-selection-processor',
            preconditionCodes: [WORKFLOW_GUARD.AUTHORIZED_SELECTION_WITH_REASON],
            guardResults: { [WORKFLOW_GUARD.AUTHORIZED_SELECTION_WITH_REASON]: true },
            ruleVersion: 'manual-v1',
            decisionReason: 'OPERATOR_APPROVED',
            correlationId: 'cor_milestone1_walking_skeleton',
            occurredAt,
            automated: true,
          })
          expect(transition).toMatchObject({
            workflowVersion: 1,
            transitionId: 'selection_manually_selected',
            snapshot: { selection: 'manually_selected' },
          })

          const delivery = new GuidelineDeliveryService(
            pool,
            new GuidelineDeliveryRepository(),
            new OutboundIntentService(new MessageTemplateRepository()),
          )
          const gated = await delivery.request(
            guidelineRequest(ids, {
              triggeringEventId: translated.event.eventId,
              occurredAt: new Date(occurredAt.getTime() + 1_000),
            }),
          )
          expect(gated).toMatchObject({ outcome: 'queued', gate: { ready: true, reasonCode: 'GUIDELINE_READY' } })

          const provider = createFakeOutboundProvider()
          const outbound = createOutboundDeliveryProcessor(createOutboundNotificationStore(db), provider, {
            workerId: 'milestone1-walking-skeleton-worker',
          })
          expect(await outbound.sendBatch(new Date(occurredAt.getTime() + 60_000))).toBe(1)
          expect(provider.logicalMessageCount()).toBe(1)
          expect(provider.attempts).toHaveLength(1)
          expect(provider.attempts[0]).toMatchObject({
            purpose: 'GUIDELINE_DELIVERY:3',
            renderedContent: '가이드: Phase 7 guideline v3',
          })

          await pool.query(`UPDATE event_inbox SET status = 'processed' WHERE id = $1`, [inboxId])
          const evidence = await pool.query(
            `SELECT
               (SELECT status FROM event_inbox WHERE id = $1) AS inbox_status,
               (SELECT count(*)::integer FROM workflow_events
                 WHERE workflow_id = $2 AND triggering_event_id = $3 AND result = 'success') AS transitions,
               (SELECT count(*)::integer FROM guideline_deliveries WHERE workflow_id = $2) AS deliveries,
               (SELECT status FROM outbound_notifications WHERE workflow_id = $2) AS outbound_status`,
            [inboxId, ids.workflowId, translated.event.eventId],
          )
          expect(evidence.rows[0]).toEqual({
            inbox_status: 'processed',
            transitions: 1,
            deliveries: 1,
            outbound_status: 'accepted',
          })
        } finally {
          await inbox.onModuleDestroy()
          await db.close()
          await pool.end()
        }
      })
    })
  })
})
