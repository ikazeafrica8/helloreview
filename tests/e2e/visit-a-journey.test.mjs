import { describe, expect, test } from 'vitest'
import { Pool } from 'pg'
import { createUnavailableAiTextProvider } from '../../packages/adapters/dist/index.js'
import { applyMigrations } from '../../packages/db/dist/index.js'
import { withPostgres } from '../../packages/testing/dist/index.js'
import {
  AiBudgetLedger,
  AiOrchestrationService,
  KoreanDateTimePipeline,
} from '../../apps/api/dist/modules/ai-orchestration/index.js'
import {
  GuidelineDeliveryRepository,
  GuidelineDeliveryService,
  VisitAJourneyService,
} from '../../apps/api/dist/modules/guideline-delivery/index.js'
import { MessageTemplateRepository, OutboundIntentService } from '../../apps/api/dist/modules/messaging/index.js'
import { ReservationService, VisitAReservationService } from '../../apps/api/dist/modules/reservation/index.js'
import { seedVisitAWorkflow, visitAAt, visitAIntake } from '../helpers/visit-a-seed.mjs'

const journeyFor = (pool) => {
  const intents = new OutboundIntentService(new MessageTemplateRepository())
  const dateTimes = new KoreanDateTimePipeline(
    new AiOrchestrationService([createUnavailableAiTextProvider()]),
    new AiBudgetLedger({
      maximumInputCharacters: 1_000,
      maximumEstimatedTokensPerRequest: 1_000,
      maximumEstimatedTokensPerScope: 10_000,
      maximumEstimatedCostMicrosPerRequest: 10_000,
      maximumEstimatedCostMicrosPerScope: 100_000,
      estimatedCostMicrosPerThousandTokens: 10_000,
    }),
    { now: visitAAt },
  )
  const reservations = new VisitAReservationService(pool, dateTimes, new ReservationService(pool), intents)
  const guidelines = new GuidelineDeliveryService(pool, new GuidelineDeliveryRepository(), intents)
  return new VisitAJourneyService(reservations, guidelines)
}

describe('T87 Visit A journey', () => {
  test('corrects invalid evidence, delivers once after correction, and suppresses repeat or stale effects', async () => {
    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const pool = new Pool({ connectionString: url })
      try {
        const ids = await seedVisitAWorkflow(pool, 'journey')
        const journey = journeyFor(pool)
        const invalid = {
          ...visitAIntake(ids, {
            sourceEventId: 'visit-a-journey-invalid',
            text: '2026년 8월 26일 오후 8시에 예약했어요',
            occurredAt: visitAAt(1),
          }),
          guidelineTemplateVersion: 1,
        }
        await expect(journey.process(invalid)).resolves.toMatchObject({
          reservation: { route: 'correction_required', notification: { deduplicated: false } },
        })

        const corrected = {
          ...visitAIntake(ids, {
            sourceEventId: 'visit-a-journey-corrected',
            occurredAt: visitAAt(2),
          }),
          guidelineTemplateVersion: 1,
        }
        await expect(journey.process(corrected)).resolves.toMatchObject({
          reservation: { route: 'ready', recorded: { reservation: { validationState: 'valid' } } },
          guideline: { outcome: 'queued', notification: { deduplicated: false } },
        })
        await expect(journey.process(corrected)).resolves.toMatchObject({
          reservation: { route: 'ready', recorded: { deduplicated: true } },
          guideline: { outcome: 'suppressed' },
        })
        await expect(
          journey.process({
            ...corrected,
            sourceEventId: 'visit-a-journey-stale',
            occurredAt: visitAAt(0),
          }),
        ).rejects.toMatchObject({ reasonCode: 'RESERVATION_STALE_SOURCE_EVENT' })

        expect(
          (
            await pool.query(
              `SELECT purpose_code, count(*)::integer AS count
                 FROM outbound_notifications WHERE workflow_id = $1
                GROUP BY purpose_code ORDER BY purpose_code`,
              [ids.workflowId],
            )
          ).rows,
        ).toEqual([
          { purpose_code: 'GUIDELINE_DELIVERY:1', count: 1 },
          { purpose_code: 'RESERVATION_CORRECTION:INVALID_TIME', count: 1 },
        ])
        expect(
          (
            await pool.query(`SELECT count(*)::integer AS count FROM guideline_deliveries WHERE workflow_id = $1`, [
              ids.workflowId,
            ])
          ).rows[0].count,
        ).toBe(1)
        expect(
          (
            await pool.query(`SELECT reservation_state, guideline_state FROM workflow_instances WHERE id = $1`, [
              ids.workflowId,
            ])
          ).rows[0],
        ).toEqual({ reservation_state: 'valid', guideline_state: 'delivery_queued' })
      } finally {
        await pool.end()
      }
    })
  })
})
