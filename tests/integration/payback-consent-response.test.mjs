import { describe, expect, test } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../../packages/db/dist/index.js'
import { withPostgres } from '../../packages/testing/dist/index.js'
import { MessageTemplateRepository, OutboundIntentService } from '../../apps/api/dist/modules/messaging/index.js'
import { PaybackConsentService } from '../../apps/api/dist/modules/payback-consent/index.js'
import { paybackAt, seedPaybackConsentWorkflow } from '../helpers/payback-consent-seed.mjs'

const serviceFor = (pool) => new PaybackConsentService(pool, new OutboundIntentService(new MessageTemplateRepository()))

const requestInput = (ids) => ({
  workflowId: ids.workflowId,
  participantId: ids.participantId,
  requestId: 'payback-request-v1',
  channel: 'KAKAO',
  recipientReference: 'masked-kakao-payback',
  templateVersion: 1,
  actorId: 'payback-system',
  occurredAt: paybackAt(),
})

const responseInput = (ids, overrides = {}) => ({
  workflowId: ids.workflowId,
  participantId: ids.participantId,
  requestId: 'payback-request-v1',
  termsVersion: 1,
  responseText: '아마 괜찮을 것 같아요',
  evidenceMessageId: 'payback-response-1',
  channel: 'KAKAO',
  recipientReference: 'masked-kakao-payback',
  clarificationTemplateVersion: 1,
  participantReference: 'masked-participant-payback',
  automationActorId: 'payback-system',
  occurredAt: paybackAt(1),
  ...overrides,
})

describe('T80 payback consent response handling', () => {
  test('sends one clarification, deduplicates replay, then pauses for human review', async () => {
    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const pool = new Pool({ connectionString: url })
      try {
        const ids = await seedPaybackConsentWorkflow(pool, 'ambiguity')
        const service = serviceFor(pool)
        await service.requestCurrentTerms(requestInput(ids))

        const first = await service.recordResponse(responseInput(ids))
        expect(first).toMatchObject({
          outcome: 'clarification_sent',
          classification: 'ambiguous',
          consent: { state: 'awaiting_response', termsVersion: 1 },
          notification: { deduplicated: false },
          deduplicated: false,
        })
        expect(await service.recordResponse(responseInput(ids))).toMatchObject({
          outcome: 'clarification_sent',
          deduplicated: true,
        })

        const second = await service.recordResponse(
          responseInput(ids, {
            responseText: '네',
            evidenceMessageId: 'payback-response-2',
            occurredAt: paybackAt(2),
          }),
        )
        expect(second).toMatchObject({
          outcome: 'human_review_required',
          classification: 'ambiguous',
          consent: { state: 'human_review_required', termsVersion: 1 },
        })
        const notifications = await pool.query(
          `SELECT purpose_code, count(*)::integer AS count
             FROM outbound_notifications GROUP BY purpose_code ORDER BY purpose_code`,
        )
        expect(notifications.rows).toEqual([
          { purpose_code: 'PAYBACK_CONSENT_CLARIFICATION', count: 1 },
          { purpose_code: 'PAYBACK_CONSENT_REQUEST', count: 1 },
        ])
        expect(
          (
            await pool.query(
              `SELECT payback_consent_state, human_handoff_state, automation_mode_state
                 FROM workflow_instances WHERE id = $1`,
              [ids.workflowId],
            )
          ).rows[0],
        ).toEqual({
          payback_consent_state: 'human_review_required',
          human_handoff_state: 'queued',
          automation_mode_state: 'paused_for_human',
        })
        expect(
          (
            await pool.query(
              `SELECT reason_code, status, automation_paused
                 FROM human_review_tasks WHERE workflow_reference = $1`,
              [ids.workflowId],
            )
          ).rows,
        ).toEqual([{ reason_code: 'UNKNOWN_INTENT_AFTER_RETRIES', status: 'open', automation_paused: true }])
      } finally {
        await pool.end()
      }
    })
  })

  test.each([
    ['동의합니다', 'agreed'],
    ['동의하지 않습니다', 'declined'],
  ])('records one explicit current-request response: %s', async (responseText, expectedState) => {
    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const pool = new Pool({ connectionString: url })
      try {
        const ids = await seedPaybackConsentWorkflow(pool, expectedState)
        const service = serviceFor(pool)
        await service.requestCurrentTerms(requestInput(ids))
        const response = await service.recordResponse(responseInput(ids, { responseText }))
        expect(response).toMatchObject({ outcome: expectedState, consent: { state: expectedState } })
        expect((await service.history(ids.workflowId, ids.participantId)).map(({ state }) => state)).toEqual([
          'not_requested',
          'awaiting_response',
          expectedState,
        ])
        expect(
          (await pool.query(`SELECT payback_consent_state FROM workflow_instances WHERE id = $1`, [ids.workflowId]))
            .rows[0].payback_consent_state,
        ).toBe(expectedState)
      } finally {
        await pool.end()
      }
    })
  })

  test('does not apply an out-of-order response that predates the active request', async () => {
    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const pool = new Pool({ connectionString: url })
      try {
        const ids = await seedPaybackConsentWorkflow(pool, 'out-of-order')
        const service = serviceFor(pool)
        await service.requestCurrentTerms(requestInput(ids))
        const response = await service.recordResponse(
          responseInput(ids, {
            responseText: '동의합니다',
            evidenceMessageId: 'payback-response-before-request',
            occurredAt: paybackAt(-1),
          }),
        )
        expect(response).toMatchObject({
          outcome: 'current_request_required',
          classification: 'explicit_agreement',
          consent: { state: 'awaiting_response' },
        })
      } finally {
        await pool.end()
      }
    })
  })
})
