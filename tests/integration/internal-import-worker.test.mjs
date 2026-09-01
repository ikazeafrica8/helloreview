// Integration tier: T137/T138 approved internal import event through the real worker runtime.

import { describe, expect, test } from 'vitest'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { applyMigrations, createDbClient } from '../../packages/db/dist/index.js'
import { withPostgres, withRedis } from '../../packages/testing/dist/index.js'
import { QUEUE_NAMES } from '../../packages/contracts/dist/index.js'
import { createQueue, createWorkerRuntime } from '../../apps/worker/dist/runtime.js'
import { createWorkerHandlers } from '../../apps/worker/dist/processors/index.js'

const waitForInboxOutcome = async (pool, inboxId) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await pool.query(`SELECT status, last_error_reason FROM event_inbox WHERE id = $1`, [inboxId])
    const row = result.rows[0]
    if (row?.status === 'processed') return
    if (row?.status === 'failed' || row?.status === 'dead_lettered') {
      throw new Error(`inbound event failed: ${String(row.last_error_reason)}`)
    }
    await delay(50)
  }
  throw new Error('worker did not process the internal import event within 10 seconds')
}

describe('approved internal import worker path', () => {
  test('consumes one import intent, bootstraps one workflow and does not select automatically', async () => {
    await withPostgres(async (postgres) => {
      await withRedis(async (redis) => {
        await applyMigrations(postgres.url)
        const pool = new Pool({ connectionString: postgres.url, max: 4 })
        const db = createDbClient(postgres.url, 4)
        const queue = createQueue(redis.url, QUEUE_NAMES.PROCESS_INBOUND_EVENT)
        const handlers = createWorkerHandlers(db)
        const runtime = createWorkerRuntime({
          redisUrl: redis.url,
          queues: [QUEUE_NAMES.PROCESS_INBOUND_EVENT],
          handlers,
        })
        const occurredAt = new Date('2026-09-01T08:00:00Z')

        try {
          const campaign = await pool.query(
            `INSERT INTO campaigns (code, name, type, visit_method, status, starts_at, ends_at)
             VALUES ('internal-import-worker','Internal Import Worker','shipping','not_applicable','active',$1,$2)
             RETURNING id`,
            [occurredAt, new Date('2026-10-01T08:00:00Z')],
          )
          const application = await pool.query(
            `INSERT INTO applications (
               source_system, source_application_id, campaign_id, status, source_status,
               applicant_name, phone_normalized, blog_url, source_version, submitted_at,
               last_source_event_id, last_source_occurred_at, last_synchronized_at
             ) VALUES (
               'helloreview_website','internal-worker-application',$1,'received','received',
               '내부 테스트','+821055500099','https://blog.example/internal-worker',1,$2,
               'internal-worker-source-event',$2,$2
             ) RETURNING id`,
            [campaign.rows[0].id, occurredAt],
          )
          const batchId = '11111111-1111-4111-8111-111111111111'
          const inbox = await pool.query(
            `INSERT INTO event_inbox (
               source, external_event_id, event_type, payload_hash, payload,
               occurred_at, received_at, correlation_id
             ) VALUES (
               'helloreview_manual_import','internal-worker-import','application.import.completed',
               $1,$2::jsonb,$3,$3,'internal-worker-correlation'
             ) RETURNING id`,
            [
              'a'.repeat(64),
              JSON.stringify({
                batchId,
                sourceSystem: 'helloreview_website',
                applicationIds: [application.rows[0].id],
              }),
              occurredAt,
            ],
          )

          await runtime.start()
          await queue.add(
            'process-inbound-event',
            { inboxId: inbox.rows[0].id, eventType: 'application.import.completed' },
            { jobId: inbox.rows[0].id },
          )
          await waitForInboxOutcome(pool, inbox.rows[0].id)

          const result = await pool.query(
            `SELECT
               (SELECT count(*)::integer FROM workflow_instances WHERE application_id = $1) AS workflows,
               (SELECT application_state FROM workflow_instances WHERE application_id = $1) AS application_state,
               (SELECT selection_state FROM workflow_instances WHERE application_id = $1) AS selection_state,
               (SELECT count(*)::integer
                  FROM workflow_side_effects s
                  JOIN workflow_instances w ON w.id = s.workflow_id
                 WHERE w.application_id = $1 AND s.effect_code = 'BEGIN_IDENTITY_MATCHING') AS identity_effects,
               (SELECT count(*)::integer FROM selection_manual_decisions) AS selection_decisions`,
            [application.rows[0].id],
          )
          expect(result.rows[0]).toEqual({
            workflows: 1,
            application_state: 'application_completed',
            selection_state: 'not_reviewed',
            identity_effects: 1,
            selection_decisions: 0,
          })
        } finally {
          await runtime.stop().catch(() => undefined)
          await queue.obliterate({ force: true }).catch(() => undefined)
          await queue.close()
          await db.close()
          await pool.end()
        }
      })
    })
  }, 300_000)
})
