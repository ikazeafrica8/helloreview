import { describe, expect, test } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../../packages/db/dist/index.js'
import { withPostgres } from '../../packages/testing/dist/index.js'
import {
  GuidelineDeliveryRepository,
  GuidelineDeliveryService,
} from '../../apps/api/dist/modules/guideline-delivery/index.js'
import { MessageTemplateRepository, OutboundIntentService } from '../../apps/api/dist/modules/messaging/index.js'
import { activateNextGuidelineVersion, guidelineRequest, seedPhase7Workflow } from '../helpers/phase7-seed.mjs'

describe('AC-08 guideline version update — release gate', () => {
  test('Given v3 delivered and v4 active, Then v4 queues once, v3 remains, and repeats suppress', async () => {
    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      try {
        const ids = await seedPhase7Workflow(pool, 'ac08', { route: 'visit_b', approvalState: 'not_required' })
        const service = new GuidelineDeliveryService(
          pool,
          new GuidelineDeliveryRepository(),
          new OutboundIntentService(new MessageTemplateRepository()),
        )
        const version3 = await service.request(guidelineRequest(ids, { triggeringEventId: 'ac08-v3' }))
        await pool.query(
          `UPDATE outbound_notifications
              SET status = 'delivered', provider_name = 'fake', provider_message_id = 'ac08-v3-provider',
                  delivered_at = $2, updated_at = $2
            WHERE id = $1`,
          [version3.notification.id, ids.now],
        )
        await pool.query(
          `UPDATE guideline_deliveries SET status = 'delivered', delivered_at = $2, updated_at = $2 WHERE id = $1`,
          [version3.deliveryId, ids.now],
        )

        const effectiveAt = new Date(ids.now.getTime() + 10_000)
        await activateNextGuidelineVersion(pool, ids, 4, effectiveAt)
        const version4 = await service.request(
          guidelineRequest(ids, { triggeringEventId: 'ac08-v4-1', occurredAt: effectiveAt }),
        )
        const repeat = await service.request(
          guidelineRequest(ids, {
            triggeringEventId: 'ac08-v4-2',
            occurredAt: new Date(effectiveAt.getTime() + 1_000),
          }),
        )

        expect(version4.outcome).toBe('queued')
        expect(repeat.outcome).toBe('suppressed')
        expect(
          (await pool.query(`SELECT guideline_version, status FROM guideline_deliveries ORDER BY guideline_version`))
            .rows,
        ).toEqual([
          { guideline_version: 3, status: 'delivered' },
          { guideline_version: 4, status: 'queued' },
        ])
        expect(
          (
            await pool.query(
              `SELECT count(*)::integer AS count FROM outbound_notifications WHERE purpose_code = 'GUIDELINE_DELIVERY:4'`,
            )
          ).rows[0].count,
        ).toBe(1)
        expect(
          (
            await pool.query(
              `SELECT outcome FROM guideline_delivery_attempts WHERE guideline_version = 4 ORDER BY occurred_at`,
            )
          ).rows,
        ).toEqual([{ outcome: 'queued' }, { outcome: 'suppressed' }])
      } finally {
        await pool.end()
      }
    })
  })
})
