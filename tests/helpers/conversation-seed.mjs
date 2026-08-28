export const conversationAt = (minutes = 0) => new Date(Date.parse('2026-08-27T01:00:00Z') + minutes * 60_000)

/**
 * One campaign, participant, application, and workflow, plus a second participant for rebinding.
 *
 * Only ONE workflow: `workflow_instances_application_campaign_key` allows a single workflow per
 * (application, campaign) pair, which is the constraint that keeps a direct applicant from acquiring
 * two rival workflows for the same campaign.
 */
export const seedConversationWorkflow = async (pool, suffix) => {
  const campaign = await pool.query(
    `INSERT INTO campaigns (code, name, type, visit_method, status, starts_at, ends_at)
     VALUES ($1,'Conversation test','visit','visit_b','active',$2,$3) RETURNING id`,
    [`conversation-${suffix}`, conversationAt(-1_440), conversationAt(43_200)],
  )
  const participant = await pool.query(
    `INSERT INTO participants (name, phone_normalized) VALUES ('Conversation Participant','+821055551111') RETURNING id`,
  )
  const other = await pool.query(
    `INSERT INTO participants (name, phone_normalized) VALUES ('Other Participant','+821055552222') RETURNING id`,
  )
  const identity = await pool.query(
    `INSERT INTO channel_identities (participant_id, provider, external_user_id, verification_state, verified_at)
     VALUES ($1,'kakao_fixture',$2,'verified',$3) RETURNING id`,
    [participant.rows[0].id, `kakao-user-${suffix}`, conversationAt()],
  )
  const application = await pool.query(
    `INSERT INTO applications (
       source_system, source_application_id, campaign_id, status, source_status,
       applicant_name, phone_normalized, source_version, submitted_at,
       last_source_event_id, last_source_occurred_at, last_synchronized_at
     ) VALUES ('test',$1,$2,'received','received','Conversation Participant',
               '+821055551111',1,$3,$4,$3,$3) RETURNING id`,
    [`conversation-application-${suffix}`, campaign.rows[0].id, conversationAt(), `conversation-source-${suffix}`],
  )
  const workflow = await pool.query(
    `INSERT INTO workflow_instances (
       participant_id, application_id, campaign_id, campaign_type, visit_method,
       application_state, selection_state, application_origin_at, selection_origin_at,
       secret_comment_origin_at, payback_consent_origin_at, business_approval_origin_at,
       shipping_origin_at, reservation_origin_at, guideline_origin_at,
       human_handoff_origin_at, automation_mode_origin_at
     ) VALUES ($1,$2,$3,'visit','visit_b','application_matched','manually_selected',
               $4,$4,$4,$4,$4,$4,$4,$4,$4,$4) RETURNING id`,
    [participant.rows[0].id, application.rows[0].id, campaign.rows[0].id, conversationAt()],
  )
  return {
    campaignId: campaign.rows[0].id,
    participantId: participant.rows[0].id,
    otherParticipantId: other.rows[0].id,
    channelIdentityId: identity.rows[0].id,
    applicationId: application.rows[0].id,
    workflowId: workflow.rows[0].id,
  }
}
