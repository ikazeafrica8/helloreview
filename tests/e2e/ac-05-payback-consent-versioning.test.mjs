import { describe, expect, test } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../../packages/db/dist/index.js'
import { withPostgres } from '../../packages/testing/dist/index.js'
import { MessageTemplateRepository, OutboundIntentService } from '../../apps/api/dist/modules/messaging/index.js'
import { PaybackConsentService } from '../../apps/api/dist/modules/payback-consent/index.js'
import { paybackAt, seedPaybackConsentWorkflow } from '../helpers/payback-consent-seed.mjs'

describe('AC-05 old payback consent', () => {
  test('keeps version 2 awaiting when an explicit agreement is linked to version 1', async () => {
    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const pool = new Pool({ connectionString: url })
      try {
        const ids = await seedPaybackConsentWorkflow(pool, 'ac05')
        const service = new PaybackConsentService(pool, new OutboundIntentService(new MessageTemplateRepository()))
        const commonRequest = {
          workflowId: ids.workflowId,
          participantId: ids.participantId,
          channel: 'KAKAO',
          recipientReference: 'masked-kakao-ac05',
          templateVersion: 1,
          actorId: 'payback-system',
        }
        const commonResponse = {
          workflowId: ids.workflowId,
          participantId: ids.participantId,
          responseText: '동의합니다',
          channel: 'KAKAO',
          recipientReference: 'masked-kakao-ac05',
          clarificationTemplateVersion: 1,
          participantReference: 'masked-participant-ac05',
          automationActorId: 'payback-system',
        }

        await service.requestCurrentTerms({
          ...commonRequest,
          requestId: 'ac05-request-v1',
          occurredAt: paybackAt(),
        })
        await expect(
          service.recordResponse({
            ...commonResponse,
            requestId: 'ac05-request-v1',
            termsVersion: 1,
            evidenceMessageId: 'ac05-response-v1',
            occurredAt: paybackAt(1),
          }),
        ).resolves.toMatchObject({ outcome: 'agreed', consent: { state: 'agreed', termsVersion: 1 } })

        await pool.query(
          `UPDATE campaign_rules
              SET status = 'superseded', effective_to = $2
            WHERE campaign_id = $1 AND rule_type = 'payback' AND version = 1`,
          [ids.campaignId, paybackAt(5)],
        )
        await pool.query(
          `INSERT INTO campaign_rules (
             campaign_id, rule_type, version, status, configuration,
             effective_from, published_by, published_at
           ) VALUES ($1,'payback',2,'published',$2::jsonb,$3,'operator-terms-v2',$3)`,
          [ids.campaignId, JSON.stringify({ terms: '페이백 조건 버전 2' }), paybackAt(5)],
        )
        await service.requestCurrentTerms({
          ...commonRequest,
          requestId: 'ac05-request-v2',
          occurredAt: paybackAt(6),
        })
        expect(
          (
            await pool.query(
              `SELECT reason, protected_action, detail
                 FROM audit_logs
                WHERE target_id = $1 AND reason = 'PAYBACK_TERMS_SUPERSEDED'`,
              [ids.workflowId],
            )
          ).rows,
        ).toEqual([
          expect.objectContaining({
            reason: 'PAYBACK_TERMS_SUPERSEDED',
            protected_action: 'yes',
            detail: expect.objectContaining({ previous_terms_version: 1, current_terms_version: 2 }),
          }),
        ])

        const stale = await service.recordResponse({
          ...commonResponse,
          requestId: 'ac05-request-v1',
          termsVersion: 1,
          evidenceMessageId: 'ac05-stale-response-v1',
          occurredAt: paybackAt(7),
        })
        expect(stale).toMatchObject({
          outcome: 'current_request_required',
          classification: 'explicit_agreement',
          consent: { state: 'awaiting_response', requestId: 'ac05-request-v2', termsVersion: 2 },
        })
        expect(await service.current(ids.workflowId, ids.participantId)).toMatchObject({
          state: 'awaiting_response',
          requestId: 'ac05-request-v2',
          termsVersion: 2,
        })
        const requests = await pool.query(
          `SELECT business_event_version, rendered_content
             FROM outbound_notifications
            WHERE purpose_code = 'PAYBACK_CONSENT_REQUEST'
            ORDER BY created_at`,
        )
        expect(requests.rows).toHaveLength(2)
        expect(requests.rows[1]).toMatchObject({ business_event_version: 'ac05-request-v2' })
        expect(requests.rows[1].rendered_content).toContain('버전 2')

        const current = await service.recordResponse({
          ...commonResponse,
          requestId: 'ac05-request-v2',
          termsVersion: 2,
          evidenceMessageId: 'ac05-response-v2',
          occurredAt: paybackAt(8),
        })
        expect(current).toMatchObject({ outcome: 'agreed', consent: { state: 'agreed', termsVersion: 2 } })
        expect(
          (await pool.query(`SELECT count(*)::integer AS count FROM payback_consent_response_events`)).rows[0].count,
        ).toBe(3)
        await expect(pool.query(`UPDATE payback_consent_response_events SET outcome = 'agreed'`)).rejects.toThrow(
          /append-only/,
        )
      } finally {
        await pool.end()
      }
    })
  })
})
