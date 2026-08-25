export const paybackAt = (minutes = 0) => new Date(Date.parse('2026-08-25T01:00:00Z') + minutes * 60_000)

export const seedPaybackConsentWorkflow = async (pool, suffix = 'default') => {
  const campaign = await pool.query(
    `INSERT INTO campaigns (code, name, type, visit_method, status, starts_at, ends_at)
     VALUES ($1,'Payback consent test','payback','not_applicable','active',$2,$3) RETURNING id`,
    [`payback-consent-${suffix}`, paybackAt(-1_440), paybackAt(43_200)],
  )
  const participant = await pool.query(`INSERT INTO participants (name) VALUES ('Payback Participant') RETURNING id`)
  const application = await pool.query(
    `INSERT INTO applications (
       source_system, source_application_id, campaign_id, status, source_status,
       applicant_name, phone_normalized, source_version, submitted_at,
       last_source_event_id, last_source_occurred_at, last_synchronized_at
     ) VALUES ('test',$1,$2,'received','received','Payback Participant',
               '+821055551111',1,$3,$4,$3,$3) RETURNING id`,
    [`payback-consent-application-${suffix}`, campaign.rows[0].id, paybackAt(), `payback-event-${suffix}`],
  )
  const workflow = await pool.query(
    `INSERT INTO workflow_instances (
       participant_id, application_id, campaign_id, campaign_type, visit_method,
       application_state, selection_state, payback_consent_state,
       application_origin_at, selection_origin_at, secret_comment_origin_at,
       payback_consent_origin_at, business_approval_origin_at, shipping_origin_at,
       reservation_origin_at, guideline_origin_at, human_handoff_origin_at, automation_mode_origin_at
     ) VALUES ($1,$2,$3,'payback','not_applicable','application_matched','manually_selected','not_requested',
               $4,$4,$4,$4,$4,$4,$4,$4,$4,$4) RETURNING id`,
    [participant.rows[0].id, application.rows[0].id, campaign.rows[0].id, paybackAt()],
  )
  await pool.query(
    `INSERT INTO campaign_rules (
       campaign_id, rule_type, version, status, configuration,
       effective_from, published_by, published_at
     ) VALUES ($1,'payback',1,'published',$2::jsonb,$3,'operator-terms',$3)`,
    [campaign.rows[0].id, JSON.stringify({ terms: '페이백 조건 버전 1' }), paybackAt(-10)],
  )
  await pool.query(
    `INSERT INTO message_templates (
       purpose_code, version, status, legal_classification, body,
       approved_by, approved_at, activated_at
     ) VALUES
       ('PAYBACK_CONSENT_REQUEST',1,'active','operational_transactional',
        '{{terms}} 요청 {{request_id}} 버전 {{terms_version}}','legal-reviewer',$1,$1),
       ('PAYBACK_CONSENT_CLARIFICATION',1,'active','operational_transactional',
        '동의하시면 동의합니다, 동의하지 않으시면 동의하지 않습니다라고 보내 주세요.',
        'legal-reviewer',$1,$1)`,
    [paybackAt()],
  )
  return {
    campaignId: campaign.rows[0].id,
    participantId: participant.rows[0].id,
    applicationId: application.rows[0].id,
    workflowId: workflow.rows[0].id,
  }
}
