import { describe, expect, test } from 'vitest'
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { applyMigrations } from '../../packages/db/dist/index.js'
import { withPostgres } from '../../packages/testing/dist/index.js'
import { ApplicationSyncService, ManualCsvImportService } from '../../apps/api/dist/modules/application-sync/index.js'
import { MessageTemplateRepository, OutboundIntentService } from '../../apps/api/dist/modules/messaging/index.js'
import { RankingEvidenceAdapter, SelectionService } from '../../apps/api/dist/modules/selection/index.js'
import { ShippingService } from '../../apps/api/dist/modules/shipping/index.js'
import { PaybackConsentService } from '../../apps/api/dist/modules/payback-consent/index.js'
import { ReservationService } from '../../apps/api/dist/modules/reservation/index.js'
import {
  GuidelineDeliveryRepository,
  GuidelineDeliveryService,
} from '../../apps/api/dist/modules/guideline-delivery/index.js'

const at = (minutes = 0) => new Date(Date.parse('2026-08-25T01:00:00Z') + minutes * 60_000)

const seedWorkflow = async (
  pool,
  { suffix, type, visitMethod = 'not_applicable', selectionState = 'manually_selected' },
) => {
  const campaign = await pool.query(
    `INSERT INTO campaigns (code, name, type, visit_method, status, starts_at, ends_at)
     VALUES ($1,$2,$3,$4,'active',$5,$6) RETURNING id`,
    [`flow-${suffix}`, `Flow ${suffix}`, type, visitMethod, at(-1_440), at(43_200)],
  )
  const participant = await pool.query(`INSERT INTO participants (name) VALUES ($1) RETURNING id`, [
    `Participant ${suffix}`,
  ])
  const application = await pool.query(
    `INSERT INTO applications (
       source_system, source_application_id, campaign_id, status, source_status,
       applicant_name, phone_normalized, blogger_level, blog_daily_visitors, blogger_region,
       source_version, submitted_at, last_source_event_id, last_source_occurred_at, last_synchronized_at
     ) VALUES ('test',$1,$2,'received','received',$3,'+821011112222',1,1500,'서울',1,$4,$5,$4,$4)
     RETURNING id`,
    [`app-${suffix}`, campaign.rows[0].id, `Applicant ${suffix}`, at(), `event-${suffix}`],
  )
  const routeStates =
    type === 'shipping'
      ? ['address_requested', 'not_applicable']
      : type === 'payback'
        ? ['not_applicable', 'not_requested']
        : ['not_applicable', 'not_applicable']
  const reservationState = type === 'visit' ? 'not_started' : 'not_applicable'
  const workflow = await pool.query(
    `INSERT INTO workflow_instances (
       participant_id, application_id, campaign_id, campaign_type, visit_method,
       application_state, selection_state, shipping_state, payback_consent_state, reservation_state,
       application_origin_at, selection_origin_at, secret_comment_origin_at,
       payback_consent_origin_at, business_approval_origin_at, shipping_origin_at,
       reservation_origin_at, guideline_origin_at, human_handoff_origin_at, automation_mode_origin_at
     ) VALUES ($1,$2,$3,$4,$5,'application_matched',$6,$7,$8,$9,$10,$10,$10,$10,$10,$10,$10,$10,$10,$10)
     RETURNING id`,
    [
      participant.rows[0].id,
      application.rows[0].id,
      campaign.rows[0].id,
      type,
      visitMethod,
      selectionState,
      routeStates[0],
      routeStates[1],
      reservationState,
      at(),
    ],
  )
  return {
    campaignId: campaign.rows[0].id,
    participantId: participant.rows[0].id,
    applicationId: application.rows[0].id,
    workflowId: workflow.rows[0].id,
  }
}

const seedTemplate = async (pool, purpose, body) => {
  await pool.query(
    `INSERT INTO message_templates (
       purpose_code, version, status, legal_classification, body,
       approved_by, approved_at, activated_at
     ) VALUES ($1,1,'active','operational_transactional',$2,'legal-reviewer',$3,$3)`,
    [purpose, body, at()],
  )
}

describe('selection shadow mode foundations', () => {
  test('imports ranking evidence, makes no automatic transition, and records manual comparison plus revocation', async () => {
    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const pool = new Pool({ connectionString: url })
      try {
        const campaign = await pool.query(
          `INSERT INTO campaigns (code,name,type,visit_method,status,starts_at,ends_at)
           VALUES ('selection-csv','Selection CSV','visit','visit_a','active',$1,$2) RETURNING id`,
          [at(-1_440), at(43_200)],
        )
        const csv = [
          'application_id,campaign_code,application_status,applicant_name,phone_normalized,blog_url,blogger_level,blog_daily_visitors,blogger_region,submitted_at,updated_at',
          'selection-app,selection-csv,received,Pilot Applicant,+821012345678,https://blog.example/pilot,1,1500,서울,2026-08-25T00:30:00Z,2026-08-25T00:45:00Z',
        ].join('\n')
        const importer = new ManualCsvImportService(
          pool,
          new ApplicationSyncService(pool),
          'selection-integration-key-at-least-16-characters',
        )
        await importer.importCsv({
          content: csv,
          sourceSystem: 'helloreview_website',
          exportedAt: at(-10),
          importedAt: at(-9),
        })
        const application = await pool.query(
          `SELECT id FROM applications WHERE source_application_id = 'selection-app'`,
        )
        const participant = await pool.query(`INSERT INTO participants (name) VALUES ('Selection Pilot') RETURNING id`)
        const workflow = await pool.query(
          `INSERT INTO workflow_instances (
             participant_id, application_id, campaign_id, campaign_type, visit_method,
             application_state, selection_state, reservation_state,
             application_origin_at, selection_origin_at, secret_comment_origin_at,
             payback_consent_origin_at, business_approval_origin_at, shipping_origin_at,
             reservation_origin_at, guideline_origin_at, human_handoff_origin_at, automation_mode_origin_at
           ) VALUES ($1,$2,$3,'visit','visit_a','application_matched','not_reviewed','validation_pending',
                     $4,$4,$4,$4,$4,$4,$4,$4,$4,$4) RETURNING id`,
          [participant.rows[0].id, application.rows[0].id, campaign.rows[0].id, at()],
        )
        const ids = {
          workflowId: workflow.rows[0].id,
          participantId: participant.rows[0].id,
          applicationId: application.rows[0].id,
          campaignId: campaign.rows[0].id,
        }
        const adapter = new RankingEvidenceAdapter(pool)
        const facts = await adapter.read({
          workflowId: ids.workflowId,
          participantId: ids.participantId,
          now: at(),
          maximumAgeMs: 15 * 60_000,
          measurementPeriod: 'previous_calendar_day',
          regionMapping: { 서울: 'capital' },
        })
        expect(facts).toMatchObject({
          bloggerLevel: 1,
          blogDailyVisitors: 1500,
          bloggerRegion: '서울',
          mappedRegion: 'capital',
          fresh: true,
        })
        const service = new SelectionService(pool)
        const before = await pool.query(`SELECT selection_state, version FROM workflow_instances WHERE id = $1`, [
          ids.workflowId,
        ])
        const recommendationInput = {
          workflowId: ids.workflowId,
          applicationId: ids.applicationId,
          campaignId: ids.campaignId,
          evidence: facts,
          policy: {
            version: 'selection-v1',
            eligibleLevels: [1, 2],
            minimumDailyVisitors: 1000,
            reviewBand: { lowerInclusive: 900, upperInclusive: 1099 },
            eligibleMappedRegions: ['capital'],
            measurementPeriod: 'previous_calendar_day',
          },
          actorReference: 'shadow-evaluator',
          occurredAt: at(1),
        }
        const recommendation = await service.recordRecommendation(recommendationInput)
        expect(recommendation).toMatchObject({
          evaluation: { result: 'recommend_select' },
          deduplicated: false,
        })
        expect(await service.recordRecommendation(recommendationInput)).toMatchObject({
          id: recommendation.id,
          deduplicated: true,
        })
        expect(
          (await pool.query(`SELECT selection_state, version FROM workflow_instances WHERE id = $1`, [ids.workflowId]))
            .rows[0],
        ).toEqual(before.rows[0])
        expect(
          (
            await pool.query(`SELECT count(*)::integer AS count FROM workflow_events WHERE workflow_id = $1`, [
              ids.workflowId,
            ])
          ).rows[0].count,
        ).toBe(0)
        expect(JSON.stringify(service.participantFacingStatus())).not.toMatch(/1500|level|score|rank/i)
        await expect(
          service.recordManualDecision({
            workflowId: ids.workflowId,
            recommendationId: recommendation.id,
            decision: 'selected',
            actorType: 'participant',
            actorReference: 'participant',
            authorized: false,
            scopeCode: 'WORKFLOW',
            reasonCode: 'MANUAL_OVERRIDE',
            correlationId: 'selection-unauthorized',
            occurredAt: at(2),
          }),
        ).rejects.toMatchObject({ reasonCode: 'SELECTION_OPERATOR_NOT_AUTHORIZED' })
        const decisionInput = {
          workflowId: ids.workflowId,
          recommendationId: recommendation.id,
          decision: 'selected',
          actorType: 'operator',
          actorReference: 'operator-1',
          authorized: true,
          scopeCode: 'WORKFLOW',
          reasonCode: 'MANUAL_OVERRIDE',
          correlationId: 'selection-approved',
          occurredAt: at(3),
        }
        const decision = await service.recordManualDecision(decisionInput)
        expect(decision).toMatchObject({ decision: 'selected', shadowOutcome: 'matched', deduplicated: false })
        expect(await service.recordManualDecision(decisionInput)).toMatchObject({ id: decision.id, deduplicated: true })
        const revoked = await service.recordManualDecision({
          ...decisionInput,
          recommendationId: null,
          decision: 'revoked',
          reasonCode: 'SELECTION_REVOKED',
          correlationId: 'selection-revoked',
          occurredAt: at(4),
        })
        expect(revoked.decision).toBe('revoked')
        expect(
          (
            await pool.query(
              `SELECT selection_state, reservation_state, guideline_state, automation_mode_state
                 FROM workflow_instances WHERE id = $1`,
              [ids.workflowId],
            )
          ).rows[0],
        ).toEqual({
          selection_state: 'human_review_required',
          reservation_state: 'human_review_required',
          guideline_state: 'not_ready',
          automation_mode_state: 'paused_for_human',
        })
        expect(
          (
            await pool.query(`SELECT reason_code FROM human_review_tasks WHERE workflow_reference = $1`, [
              ids.workflowId,
            ])
          ).rows,
        ).toEqual([{ reason_code: 'SELECTION_REVOKED' }])
        expect(
          (
            await pool.query(
              `SELECT action, detail FROM audit_logs
                WHERE target_type = 'selection_decision' AND target_id = $1`,
              [decision.id],
            )
          ).rows[0],
        ).toMatchObject({
          action: 'SELECTION_OVERRIDDEN',
          detail: {
            override_evidence: {
              schemaVersion: 'sensitive-override-evidence-v1',
              scopeCode: 'WORKFLOW',
              priorValueCode: 'not_reviewed',
              newValueCode: 'manually_selected',
              reasonCode: 'MANUAL_OVERRIDE',
            },
          },
        })
        await expect(
          pool.query(`UPDATE selection_recommendations SET reason_code = 'REWRITTEN' WHERE id = $1`, [
            recommendation.id,
          ]),
        ).rejects.toThrow(/append-only/)
        await expect(
          adapter.read({
            ...recommendationInput,
            participantId: randomUUID(),
            now: at(),
            maximumAgeMs: 1,
            measurementPeriod: null,
            regionMapping: {},
          }),
        ).rejects.toMatchObject({
          reasonCode: 'RANKING_EVIDENCE_NOT_FOUND',
        })
      } finally {
        await pool.end()
      }
    })
  })
})

describe('shipping, payback consent, and reservation foundations', () => {
  test('protects and versions addresses through one-time workflow-bound forms', async () => {
    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const pool = new Pool({ connectionString: url })
      try {
        const ids = await seedWorkflow(pool, { suffix: 'shipping', type: 'shipping' })
        const other = await seedWorkflow(pool, { suffix: 'shipping-other', type: 'shipping' })
        await seedTemplate(pool, 'SHIPPING_ADDRESS_REQUEST', '주소를 입력해 주세요: {{form_link}}')
        const service = new ShippingService(
          pool,
          Buffer.alloc(32, 9),
          new OutboundIntentService(new MessageTemplateRepository()),
        )
        const issueInput = {
          workflowId: ids.workflowId,
          participantId: ids.participantId,
          channel: 'KAKAO',
          recipientReference: 'masked-kakao-shipping',
          formBaseUrl: 'https://forms.example/shipping',
          tokenTtlSeconds: 600,
          templateVersion: 1,
          actorId: 'shipping-system',
          occurredAt: at(),
        }
        const issued = await service.issueForm(issueInput)
        expect(issued).toMatchObject({ outcome: 'issued' })
        expect(issued.token).toBeTypeOf('string')
        expect(await service.issueForm(issueInput)).toMatchObject({ outcome: 'already_issued', token: null })
        expect((await pool.query(`SELECT count(*)::integer AS count FROM outbound_notifications`)).rows[0].count).toBe(
          1,
        )
        const address = {
          recipientName: '홍길동',
          phone: '010-1234-5678',
          postalCode: '06236',
          addressLine1: '서울특별시 강남구 테헤란로 123',
          addressLine2: '4층',
          deliveryNote: '문 앞',
        }
        const policy = {
          version: 'shipping-v1',
          requiredFields: ['recipientName', 'phone', 'postalCode', 'addressLine1', 'addressLine2'],
          allowedPostalPrefixes: ['06'],
          changeCutoffAt: at(120),
          lockAt: at(180),
        }
        await expect(
          service.submit({
            token: issued.token,
            workflowId: other.workflowId,
            participantId: other.participantId,
            address,
            policy,
            actorReference: 'participant',
            occurredAt: at(1),
          }),
        ).rejects.toMatchObject({ reasonCode: 'SHIPPING_FORM_NOT_FOUND' })
        expect(
          await service.submit({
            token: issued.token,
            workflowId: ids.workflowId,
            participantId: ids.participantId,
            address: { ...address, postalCode: 'bad' },
            policy,
            actorReference: 'participant',
            occurredAt: at(2),
          }),
        ).toMatchObject({ outcome: 'invalid' })
        const stored = await service.submit({
          token: issued.token,
          workflowId: ids.workflowId,
          participantId: ids.participantId,
          address,
          policy,
          actorReference: 'participant',
          occurredAt: at(3),
        })
        expect(stored).toMatchObject({ outcome: 'stored', version: 1, maskedSummary: '06236 서울특별…' })
        await pool.query(
          `INSERT INTO guideline_versions (
             campaign_id, version, status, body_text, effective_from, published_by, published_at
           ) VALUES ($1,1,'published','배송 캠페인 가이드',$2,'operator-guideline',$2)`,
          [ids.campaignId, at(-10)],
        )
        await seedTemplate(pool, 'GUIDELINE_DELIVERY', '가이드: {{guideline}}')
        const guideline = new GuidelineDeliveryService(
          pool,
          new GuidelineDeliveryRepository(),
          new OutboundIntentService(new MessageTemplateRepository()),
        )
        const guidelineInput = {
          workflowId: ids.workflowId,
          channel: 'KAKAO',
          recipientReference: 'masked-kakao-shipping',
          templateVersion: 1,
          triggeringEventId: 'shipping-guideline-ready-1',
          actorId: 'guideline-system',
          occurredAt: at(3),
          consentTermsVersion: null,
          activeTermsVersion: null,
          safeScreenshotReceived: true,
          criticalFieldsExtracted: true,
          shippingPrerequisitesSatisfied: true,
          paybackPrerequisitesSatisfied: true,
        }
        expect(await guideline.request(guidelineInput)).toMatchObject({ outcome: 'queued', gate: { ready: true } })
        expect(await guideline.request(guidelineInput)).toMatchObject({
          outcome: 'suppressed',
          gate: { ready: false, reasonCode: 'VERSION_ALREADY_DELIVERED' },
        })
        expect(
          (
            await pool.query(
              `SELECT count(*)::integer AS count FROM outbound_notifications
                WHERE purpose_code = 'GUIDELINE_DELIVERY:1'`,
            )
          ).rows[0].count,
        ).toBe(1)
        await expect(
          service.submit({
            token: issued.token,
            workflowId: ids.workflowId,
            participantId: ids.participantId,
            address,
            policy,
            actorReference: 'participant',
            occurredAt: at(4),
          }),
        ).rejects.toMatchObject({ reasonCode: 'SHIPPING_FORM_ALREADY_USED' })
        expect(await service.currentMasked(ids.workflowId, ids.participantId)).toMatchObject({ version: 1 })
        expect(await service.currentMasked(ids.workflowId, other.participantId)).toBeNull()
        expect(
          JSON.stringify((await pool.query(`SELECT encrypted_payload, masked_summary FROM shipping_addresses`)).rows),
        ).not.toContain(address.addressLine1)
        expect(await service.issueForm({ ...issueInput, occurredAt: at(5) })).toMatchObject({
          outcome: 'already_valid',
        })
        await expect(
          service.reveal({
            workflowId: ids.workflowId,
            participantId: ids.participantId,
            actorType: 'participant',
            actorReference: 'participant',
            authorized: false,
            reasonCode: 'FULFILLMENT',
            correlationId: 'reveal-rejected',
            occurredAt: at(6),
            authorizationEvidence: {
              action: 'sensitive_values.reveal',
              authorizationPolicyVersion: 'admin-rbac-test-fixture-v1',
              sensitiveAccessPolicyVersion: 'sensitive-access-test-fixture-v1',
              authorizationVersion: 1,
              requestReference: 'request:reveal-rejected',
              sessionReference: 'session:reveal-rejected',
            },
          }),
        ).rejects.toMatchObject({ reasonCode: 'SHIPPING_REVEAL_NOT_AUTHORIZED' })
        await expect(
          service.reveal({
            workflowId: ids.workflowId,
            participantId: other.participantId,
            actorType: 'operator',
            actorReference: 'operator-ship',
            authorized: true,
            reasonCode: 'FULFILLMENT',
            correlationId: 'cross-owner-reveal',
            occurredAt: at(7),
            authorizationEvidence: {
              action: 'sensitive_values.reveal',
              authorizationPolicyVersion: 'admin-rbac-test-fixture-v1',
              sensitiveAccessPolicyVersion: 'sensitive-access-test-fixture-v1',
              authorizationVersion: 1,
              requestReference: 'request:cross-owner-reveal',
              sessionReference: 'session:cross-owner-reveal',
            },
          }),
        ).rejects.toMatchObject({ reasonCode: 'SHIPPING_ADDRESS_NOT_FOUND' })
        expect(
          await service.reveal({
            workflowId: ids.workflowId,
            participantId: ids.participantId,
            actorType: 'operator',
            actorReference: 'operator-ship',
            authorized: true,
            reasonCode: 'FULFILLMENT',
            correlationId: 'approved-reveal',
            occurredAt: at(8),
            authorizationEvidence: {
              action: 'sensitive_values.reveal',
              authorizationPolicyVersion: 'admin-rbac-test-fixture-v1',
              sensitiveAccessPolicyVersion: 'sensitive-access-test-fixture-v1',
              authorizationVersion: 1,
              requestReference: 'request:approved-reveal',
              sessionReference: 'session:approved-reveal',
            },
          }),
        ).toMatchObject({ addressLine1: address.addressLine1, phone: '+821012345678' })
        const revealEvidence = await pool.query(
          `SELECT address_id::text, correlation_id FROM shipping_address_reveals
            WHERE correlation_id = 'approved-reveal'`,
        )
        expect(revealEvidence.rows).toHaveLength(1)
        expect(
          (
            await pool.query(
              `SELECT target_id, correlation_id, result::text, protected_action FROM audit_logs
                WHERE correlation_id = 'approved-reveal' AND action = 'SENSITIVE_FIELD_REVEALED'`,
            )
          ).rows,
        ).toEqual([
          {
            target_id: revealEvidence.rows[0].address_id,
            correlation_id: 'approved-reveal',
            result: 'success',
            protected_action: 'yes',
          },
        ])
        const change = await service.issueForm({ ...issueInput, requestAddressChange: true, occurredAt: at(10) })
        expect(change.outcome).toBe('issued')
        expect(
          await service.submit({
            token: change.token,
            workflowId: ids.workflowId,
            participantId: ids.participantId,
            address: { ...address, addressLine2: '5층' },
            policy,
            actorReference: 'participant',
            occurredAt: at(11),
          }),
        ).toMatchObject({ outcome: 'stored', version: 2 })
        const late = await service.issueForm({ ...issueInput, requestAddressChange: true, occurredAt: at(119) })
        expect(
          await service.submit({
            token: late.token,
            workflowId: ids.workflowId,
            participantId: ids.participantId,
            address: { ...address, addressLine2: '6층' },
            policy,
            actorReference: 'participant',
            occurredAt: at(121),
          }),
        ).toMatchObject({ outcome: 'human_review' })
        expect((await pool.query(`SELECT count(*)::integer AS count FROM shipping_addresses`)).rows[0].count).toBe(2)
        expect(
          (
            await pool.query(`SELECT reason_code FROM human_review_tasks WHERE workflow_reference = $1`, [
              ids.workflowId,
            ])
          ).rows[0].reason_code,
        ).toBe('SHIPPING_CHANGE_AFTER_CUTOFF')
        await expect(
          pool.query(`DELETE FROM shipping_addresses WHERE workflow_id = $1`, [ids.workflowId]),
        ).rejects.toThrow(/append-only/)
      } finally {
        await pool.end()
      }
    })
  })

  test('ties one payback request to the current immutable terms version and current request id', async () => {
    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const pool = new Pool({ connectionString: url })
      try {
        const ids = await seedWorkflow(pool, { suffix: 'payback', type: 'payback' })
        await seedTemplate(pool, 'PAYBACK_CONSENT_REQUEST', '{{terms}} 요청 {{request_id}} 버전 {{terms_version}}')
        await pool.query(
          `INSERT INTO campaign_rules (
             campaign_id, rule_type, version, status, configuration,
             effective_from, published_by, published_at
           ) VALUES ($1,'payback',3,'published',$2::jsonb,$3,'operator-terms',$3)`,
          [ids.campaignId, JSON.stringify({ terms: '현재 페이백 이용 조건' }), at(-10)],
        )
        const service = new PaybackConsentService(pool, new OutboundIntentService(new MessageTemplateRepository()))
        const requestInput = {
          workflowId: ids.workflowId,
          participantId: ids.participantId,
          requestId: 'payback-request-current',
          channel: 'KAKAO',
          recipientReference: 'masked-kakao-payback',
          templateVersion: 1,
          actorId: 'payback-system',
          occurredAt: at(),
        }
        await expect(service.requestCurrentTerms({ ...requestInput, requestId: '' })).rejects.toMatchObject({
          reasonCode: 'PAYBACK_REQUEST_ID_REQUIRED',
        })
        const requested = await service.requestCurrentTerms(requestInput)
        expect(requested).toMatchObject({
          consent: { state: 'awaiting_response', termsVersion: 3, requestId: 'payback-request-current' },
          deduplicated: false,
        })
        expect(
          await service.requestCurrentTerms({
            ...requestInput,
            requestId: 'duplicate-unrelated-id',
            occurredAt: at(1),
          }),
        ).toMatchObject({ deduplicated: true, consent: { requestId: 'payback-request-current' } })
        expect((await service.history(ids.workflowId, ids.participantId)).map((entry) => entry.state)).toEqual([
          'not_requested',
          'awaiting_response',
        ])
        expect(await service.current(ids.workflowId, randomUUID())).toBeNull()
        expect(
          await service.correlatesWithCurrentRequest(ids.workflowId, ids.participantId, 'payback-request-current', 3),
        ).toBe(true)
        expect(await service.correlatesWithCurrentRequest(ids.workflowId, ids.participantId, 'old-request', 3)).toBe(
          false,
        )
        expect(
          await service.correlatesWithCurrentRequest(ids.workflowId, ids.participantId, 'payback-request-current', 2),
        ).toBe(false)
        expect((await pool.query(`SELECT count(*)::integer AS count FROM outbound_notifications`)).rows[0].count).toBe(
          1,
        )
        await expect(pool.query(`UPDATE payback_consent_versions SET state = 'agreed'`)).rejects.toThrow(/append-only/)
      } finally {
        await pool.end()
      }
    })
  })

  test('keeps a unique reservation head and immutable supersession history under deterministic rule authority', async () => {
    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const pool = new Pool({ connectionString: url })
      try {
        const ids = await seedWorkflow(pool, { suffix: 'reservation', type: 'visit', visitMethod: 'visit_a' })
        const other = await seedWorkflow(pool, { suffix: 'reservation-other', type: 'visit', visitMethod: 'visit_a' })
        const service = new ReservationService(pool)
        const candidate = {
          workflowId: ids.workflowId,
          participantId: ids.participantId,
          source: 'ai_assisted',
          sourceReference: 'message-reservation-1',
          extractionProvenance: { provider: 'deterministic_fake', requestId: 'ai-request-1' },
          reservedDate: '2026-08-28',
          reservedTime: '14:00',
          timezone: 'Asia/Seoul',
          businessReference: 'business-masked-1',
          visitMethod: 'visit_a',
          status: 'pending',
          cancellationReason: null,
          validationState: 'pending',
          validationAuthority: 'none',
          ruleVersion: null,
          validationEvidence: { candidateOnly: true },
          actorType: 'participant',
          actorReference: 'participant-masked',
          authorized: false,
          occurredAt: at(),
        }
        await expect(
          service.recordVersion({
            ...candidate,
            validationState: 'valid',
            status: 'confirmed',
          }),
        ).rejects.toMatchObject({ reasonCode: 'RESERVATION_RULE_VALIDATION_REQUIRED' })
        const first = await service.recordVersion(candidate)
        expect(first).toMatchObject({ reservation: { version: 1, validationState: 'pending' }, deduplicated: false })
        expect(await service.recordVersion(candidate)).toMatchObject({
          reservation: { versionId: first.reservation.versionId },
          deduplicated: true,
        })
        const validated = await service.recordVersion({
          ...candidate,
          source: 'operator',
          sourceReference: 'operator-validation-1',
          status: 'confirmed',
          validationState: 'valid',
          validationAuthority: 'deterministic_rules',
          ruleVersion: 'reservation-v4',
          validationEvidence: { passedRules: ['DATE', 'TIME', 'BUSINESS'] },
          actorType: 'operator',
          actorReference: 'operator-reservation',
          authorized: true,
          occurredAt: at(1),
        })
        expect(validated).toMatchObject({
          reservation: {
            version: 2,
            validationState: 'valid',
            validationAuthority: 'deterministic_rules',
            supersedesVersionId: first.reservation.versionId,
          },
        })
        expect((await service.current(ids.workflowId, ids.participantId)).versionId).toBe(
          validated.reservation.versionId,
        )
        expect(await service.current(ids.workflowId, other.participantId)).toBeNull()
        expect((await service.history(ids.workflowId, ids.participantId)).map((entry) => entry.version)).toEqual([1, 2])
        await expect(
          service.recordVersion({
            ...candidate,
            source: 'operator',
            actorType: 'participant',
            sourceReference: 'bad-actor',
          }),
        ).rejects.toMatchObject({ reasonCode: 'RESERVATION_SOURCE_NOT_AUTHORIZED' })
        await expect(pool.query(`UPDATE reservation_versions SET status = 'cancelled'`)).rejects.toThrow(/append-only/)
        expect((await pool.query(`SELECT count(*)::integer AS count FROM reservation_heads`)).rows[0].count).toBe(1)
      } finally {
        await pool.end()
      }
    })
  })
})
