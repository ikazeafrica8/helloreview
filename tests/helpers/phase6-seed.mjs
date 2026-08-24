export const seedPhase6Workflow = async (pool, suffix = 'default') => {
  const now = new Date('2026-08-24T12:00:00Z')
  const campaign = await pool.query(
    `INSERT INTO campaigns (code, name, type, visit_method, status, starts_at, ends_at)
     VALUES ($1, 'Phase 6 messaging', 'shipping', 'not_applicable', 'active', $2, $3)
     RETURNING id`,
    [`phase6-${suffix}`, new Date('2026-08-01T00:00:00Z'), new Date('2026-09-30T00:00:00Z')],
  )
  const participant = await pool.query(`INSERT INTO participants (name) VALUES ('Phase Six') RETURNING id`)
  const application = await pool.query(
    `INSERT INTO applications (
       source_system, source_application_id, campaign_id, status, source_status,
       applicant_name, phone_normalized, source_version, submitted_at,
       last_source_event_id, last_source_occurred_at, last_synchronized_at
     ) VALUES ('manual_pilot',$1,$2,'received','received','Phase Six',
               '+821099999999',1,$3,$4,$3,$3)
     RETURNING id`,
    [`phase6-application-${suffix}`, campaign.rows[0].id, now, `phase6-source-${suffix}`],
  )
  const workflow = await pool.query(
    `INSERT INTO workflow_instances (
       participant_id, application_id, campaign_id, campaign_type,
       application_origin_at, selection_origin_at, secret_comment_origin_at,
       payback_consent_origin_at, business_approval_origin_at, shipping_origin_at,
       reservation_origin_at, guideline_origin_at, human_handoff_origin_at,
       automation_mode_origin_at
     ) VALUES ($1,$2,$3,'shipping',$4,$4,$4,$4,$4,$4,$4,$4,$4,$4)
     RETURNING id`,
    [participant.rows[0].id, application.rows[0].id, campaign.rows[0].id, now],
  )
  const template = await pool.query(
    `INSERT INTO message_templates (
       purpose_code, version, status, legal_classification, body,
       approved_by, approved_at, activated_at
     ) VALUES ('SYSTEM_DELAY_NOTICE',1,'active','service_notice',
               '안녕하세요 {{campaign_name}} 안내입니다.','legal_phase6',$1,$1)
     RETURNING id`,
    [now],
  )
  return {
    now,
    campaignId: campaign.rows[0].id,
    participantId: participant.rows[0].id,
    applicationId: application.rows[0].id,
    workflowId: workflow.rows[0].id,
    templateId: template.rows[0].id,
  }
}

export const phase6Intent = (workflowId, occurredAt, overrides = {}) => ({
  workflowId,
  channel: 'KAKAO',
  recipientReference: 'kakao-recipient-phase6',
  purpose: 'SYSTEM_DELAY_NOTICE',
  templatePurposeCode: 'SYSTEM_DELAY_NOTICE',
  templateVersion: 1,
  contentVersion: 'template_v1',
  businessEventVersion: 'event_v1',
  variables: { campaign_name: 'Phase 6' },
  source: 'automated',
  actorId: 'ai_phase6',
  occurredAt,
  ...overrides,
})
