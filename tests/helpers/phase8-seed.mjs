export const seedPhase8Workflow = async (pool, suffix = 'default') => {
  const now = new Date('2026-08-25T01:00:00Z')
  const campaign = await pool.query(
    `INSERT INTO campaigns (code, name, type, visit_method, status, starts_at, ends_at)
     VALUES ($1, 'Phase 8 secure attachments', 'visit', 'visit_b', 'active', $2, $3)
     RETURNING id`,
    [`phase8-${suffix}`, new Date('2026-08-01T00:00:00Z'), new Date('2026-09-30T00:00:00Z')],
  )
  const participant = await pool.query(`INSERT INTO participants (name) VALUES ('Phase Eight') RETURNING id`)
  const application = await pool.query(
    `INSERT INTO applications (
       source_system, source_application_id, campaign_id, status, source_status,
       applicant_name, phone_normalized, source_version, submitted_at,
       last_source_event_id, last_source_occurred_at, last_synchronized_at
     ) VALUES ('manual_pilot',$1,$2,'received','received','Phase Eight',
               '+821088888888',1,$3,$4,$3,$3)
     RETURNING id`,
    [`phase8-application-${suffix}`, campaign.rows[0].id, now, `phase8-source-${suffix}`],
  )
  const workflow = await pool.query(
    `INSERT INTO workflow_instances (
       participant_id, application_id, campaign_id, campaign_type, visit_method,
       application_state, selection_state, secret_comment_state, reservation_state,
       application_origin_at, selection_origin_at, secret_comment_origin_at,
       payback_consent_origin_at, business_approval_origin_at, shipping_origin_at,
       reservation_origin_at, guideline_origin_at, human_handoff_origin_at,
       automation_mode_origin_at
     ) VALUES ($1,$2,$3,'visit','visit_b','application_matched','manually_selected','screenshot_received',
               'screenshot_received',$4,$4,$4,$4,$4,$4,$4,$4,$4,$4)
     RETURNING id`,
    [participant.rows[0].id, application.rows[0].id, campaign.rows[0].id, now],
  )
  return {
    now,
    campaignId: campaign.rows[0].id,
    participantId: participant.rows[0].id,
    applicationId: application.rows[0].id,
    workflowId: workflow.rows[0].id,
  }
}

export const syntheticPng = () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
