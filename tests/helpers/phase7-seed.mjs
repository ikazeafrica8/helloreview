export const seedPhase7Workflow = async (
  pool,
  suffix,
  { route = 'visit_c', reservationState = 'valid', approvalState = 'pending', guidelineVersion = 3 } = {},
) => {
  const now = new Date('2026-08-24T12:00:00Z')
  const campaignType = route === 'shipping' ? 'shipping' : route === 'payback' ? 'payback' : 'visit'
  const visitMethod = campaignType === 'visit' ? route : 'not_applicable'
  const campaign = await pool.query(
    `INSERT INTO campaigns (code, name, type, visit_method, status, starts_at, ends_at)
     VALUES ($1, 'Phase 7 safety gates', $2, $3, 'active', $4, $5)
     RETURNING id`,
    [`phase7-${suffix}`, campaignType, visitMethod, new Date('2026-08-01T00:00:00Z'), new Date('2026-09-30T00:00:00Z')],
  )
  const participant = await pool.query(`INSERT INTO participants (name) VALUES ('Phase Seven') RETURNING id`)
  const application = await pool.query(
    `INSERT INTO applications (
       source_system, source_application_id, campaign_id, status, source_status,
       applicant_name, phone_normalized, source_version, submitted_at,
       last_source_event_id, last_source_occurred_at, last_synchronized_at
     ) VALUES ('manual_pilot',$1,$2,'received','received','Phase Seven',
               '+821077777777',1,$3,$4,$3,$3)
     RETURNING id`,
    [`phase7-application-${suffix}`, campaign.rows[0].id, now, `phase7-source-${suffix}`],
  )
  const workflow = await pool.query(
    `INSERT INTO workflow_instances (
       participant_id, application_id, campaign_id, campaign_type, visit_method,
       application_state, selection_state, secret_comment_state,
       payback_consent_state, business_approval_state, shipping_state,
       reservation_state, guideline_state,
       application_origin_at, selection_origin_at, secret_comment_origin_at,
       payback_consent_origin_at, business_approval_origin_at, shipping_origin_at,
       reservation_origin_at, guideline_origin_at, human_handoff_origin_at,
       automation_mode_origin_at
     ) VALUES ($1,$2,$3,$4,$5,'application_matched','manually_selected','verified',$6,$7,$8,$9,'not_ready',
               $10,$10,$10,$10,$10,$10,$10,$10,$10,$10)
     RETURNING id`,
    [
      participant.rows[0].id,
      application.rows[0].id,
      campaign.rows[0].id,
      campaignType,
      visitMethod,
      campaignType === 'payback' ? 'agreed' : 'not_applicable',
      route === 'visit_c' ? approvalState : 'not_required',
      campaignType === 'shipping' ? 'address_valid' : 'not_applicable',
      campaignType === 'visit' ? reservationState : 'not_applicable',
      now,
    ],
  )
  const guideline = await pool.query(
    `INSERT INTO guideline_versions (
       campaign_id, version, status, body_text, effective_from, published_by, published_at
     ) VALUES ($1,$2,'published',$3,$4,'operator_phase7',$4)
     RETURNING id`,
    [
      campaign.rows[0].id,
      guidelineVersion,
      `Phase 7 guideline v${String(guidelineVersion)}`,
      new Date('2026-08-01T00:00:00Z'),
    ],
  )
  await pool.query(
    `INSERT INTO message_templates (
       purpose_code, version, status, legal_classification, body,
       approved_by, approved_at, activated_at
     ) VALUES
       ('VISIT_C_APPROVAL_STATUS',1,'active','operational_transactional','승인 대기 중입니다.','legal_phase7',$1,$1),
       ('VISIT_C_BOOKING_INSTRUCTIONS',1,'active','operational_transactional','예약 링크입니다.','legal_phase7',$1,$1),
       ('GUIDELINE_DELIVERY',1,'active','operational_transactional','가이드: {{guideline}}','legal_phase7',$1,$1),
       ('RESERVATION_CORRECTION:INVALID_TIME',1,'active','operational_transactional','예약 가능 시간을 다시 선택해 주세요. 보내주신 내용: {{submitted_value}} / 필요한 조건: {{expected_condition}}','legal_phase7',$1,$1)`,
    [now],
  )
  return {
    now,
    campaignId: campaign.rows[0].id,
    participantId: participant.rows[0].id,
    applicationId: application.rows[0].id,
    workflowId: workflow.rows[0].id,
    guidelineVersionId: guideline.rows[0].id,
  }
}

export const guidelineRequest = (ids, overrides = {}) => ({
  workflowId: ids.workflowId,
  channel: 'KAKAO',
  recipientReference: 'kakao-recipient-phase7',
  templateVersion: 1,
  triggeringEventId: 'phase7-guideline-request-1',
  actorId: 'system_phase7',
  occurredAt: ids.now,
  consentTermsVersion: null,
  activeTermsVersion: null,
  safeScreenshotReceived: true,
  criticalFieldsExtracted: true,
  shippingPrerequisitesSatisfied: true,
  paybackPrerequisitesSatisfied: true,
  ...overrides,
})

export const activateNextGuidelineVersion = async (pool, ids, version, effectiveAt) => {
  await pool.query(
    `UPDATE guideline_versions
        SET status = 'superseded', effective_to = $2
      WHERE campaign_id = $1 AND status = 'published' AND effective_to IS NULL`,
    [ids.campaignId, effectiveAt],
  )
  return pool.query(
    `INSERT INTO guideline_versions (
       campaign_id, version, status, body_text, effective_from, published_by, published_at
     ) VALUES ($1,$2,'published',$3,$4,'operator_phase7',$4)
     RETURNING id`,
    [ids.campaignId, version, `Phase 7 guideline v${String(version)}`, effectiveAt],
  )
}
