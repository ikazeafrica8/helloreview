export const visitAAt = (minutes = 0) => new Date(Date.parse('2026-08-25T01:00:00Z') + minutes * 60_000)

export const seedVisitAWorkflow = async (pool, suffix, overrides = {}) => {
  const campaign = await pool.query(
    `INSERT INTO campaigns (code, name, type, visit_method, status, starts_at, ends_at)
     VALUES ($1,'Visit A test','visit','visit_a',$2,$3,$4) RETURNING id`,
    [
      `visit-a-${suffix}`,
      overrides.campaignStatus ?? 'active',
      new Date('2026-08-01T00:00:00Z'),
      new Date('2026-09-30T00:00:00Z'),
    ],
  )
  const participant = await pool.query(`INSERT INTO participants (name) VALUES ('Visit A Participant') RETURNING id`)
  const application = await pool.query(
    `INSERT INTO applications (
       source_system, source_application_id, campaign_id, status, source_status,
       applicant_name, phone_normalized, source_version, submitted_at,
       last_source_event_id, last_source_occurred_at, last_synchronized_at
     ) VALUES ('test',$1,$2,'received','received','Visit A Participant',
               '+821066661111',1,$3,$4,$3,$3) RETURNING id`,
    [`visit-a-application-${suffix}`, campaign.rows[0].id, visitAAt(), `visit-a-source-${suffix}`],
  )
  const workflow = await pool.query(
    `INSERT INTO workflow_instances (
       participant_id, application_id, campaign_id, campaign_type, visit_method,
       application_state, selection_state, business_approval_state, reservation_state, guideline_state,
       application_origin_at, selection_origin_at, secret_comment_origin_at,
       payback_consent_origin_at, business_approval_origin_at, shipping_origin_at,
       reservation_origin_at, guideline_origin_at, human_handoff_origin_at, automation_mode_origin_at
     ) VALUES ($1,$2,$3,'visit','visit_a','application_matched','manually_selected','not_required','not_started','not_ready',
               $4,$4,$4,$4,$4,$4,$4,$4,$4,$4) RETURNING id`,
    [participant.rows[0].id, application.rows[0].id, campaign.rows[0].id, visitAAt()],
  )
  const configuration = {
    expectedCampaignId: campaign.rows[0].id,
    businesses: [{ normalizedName: '테스트카페', normalizedBranch: '강남점' }],
    campaignStartsOn: '2026-08-01',
    campaignEndsOn: '2026-09-30',
    allowedIsoWeekdays: [1, 2, 3, 4, 5],
    windowsByIsoWeekday: {
      1: [{ startsAt: '09:00:00', endsAt: '18:00:00', startInclusive: true, endInclusive: false }],
      2: [{ startsAt: '09:00:00', endsAt: '18:00:00', startInclusive: true, endInclusive: false }],
      3: [{ startsAt: '09:00:00', endsAt: '18:00:00', startInclusive: true, endInclusive: false }],
      4: [{ startsAt: '09:00:00', endsAt: '18:00:00', startInclusive: true, endInclusive: false }],
      5: [{ startsAt: '09:00:00', endsAt: '18:00:00', startInclusive: true, endInclusive: false }],
    },
    timezone: 'Asia/Seoul',
    bookingMethod: 'visit_a',
    requireCurrentBusinessApproval: false,
    acceptedReservationStatus: 'completed',
    minimumLeadMinutes: 60,
    blackoutDates: overrides.blackoutDates ?? [],
    requiredCampaignStatus: 'active',
    capacityRestrictionConfigured: false,
    ...overrides.configuration,
  }
  await pool.query(
    `INSERT INTO campaign_rules (
       campaign_id, rule_type, version, status, configuration, effective_from, published_by, published_at
     ) VALUES ($1,'reservation',1,'published',$2::jsonb,$3,'visit-a-operator',$3)`,
    [campaign.rows[0].id, JSON.stringify(configuration), new Date('2026-08-01T00:00:00Z')],
  )
  await pool.query(
    `INSERT INTO guideline_versions (
       campaign_id, version, status, body_text, effective_from, published_by, published_at
     ) VALUES ($1,1,'published','Visit A guideline version 1',$2,'visit-a-operator',$2)`,
    [campaign.rows[0].id, new Date('2026-08-01T00:00:00Z')],
  )
  await pool.query(
    `INSERT INTO message_templates (
       purpose_code, version, status, legal_classification, body, approved_by, approved_at, activated_at
     ) VALUES
       ('RESERVATION_CORRECTION:DATE_TIME_CLARIFICATION',1,'active','operational_transactional','예약 날짜와 시간을 정확히 알려 주세요. 보내주신 내용: {{submitted_value}} / 필요한 조건: {{expected_condition}}','visit-a-legal',$1,$1),
       ('RESERVATION_CORRECTION:INVALID_TIME',1,'active','operational_transactional','예약 가능 시간을 다시 선택해 주세요. 보내주신 내용: {{submitted_value}} / 필요한 조건: {{expected_condition}}','visit-a-legal',$1,$1),
       ('RESERVATION_CORRECTION:WRONG_BUSINESS',1,'active','operational_transactional','지정된 매장 예약인지 확인해 주세요. 보내주신 내용: {{submitted_value}} / 필요한 조건: {{expected_condition}}','visit-a-legal',$1,$1),
       ('RESERVATION_CORRECTION:BLACKOUT_DATE',1,'active','operational_transactional','예약 불가 날짜이므로 다른 날짜를 선택해 주세요. 보내주신 내용: {{submitted_value}} / 필요한 조건: {{expected_condition}}','visit-a-legal',$1,$1),
       ('RESERVATION_CORRECTION:INVALID_BOUNDARY',1,'active','operational_transactional','마감 시간 전 예약으로 변경해 주세요. 보내주신 내용: {{submitted_value}} / 필요한 조건: {{expected_condition}}','visit-a-legal',$1,$1),
       ('RESERVATION_CORRECTION:INSUFFICIENT_LEAD_TIME',1,'active','operational_transactional','예약 준비 시간을 확보해 다시 선택해 주세요. 보내주신 내용: {{submitted_value}} / 필요한 조건: {{expected_condition}}','visit-a-legal',$1,$1),
       ('RESERVATION_CANCELLATION_ACK',1,'active','operational_transactional','예약 취소를 확인했습니다.','visit-a-legal',$1,$1),
       ('RESERVATION_RESCHEDULE_ACK',1,'active','operational_transactional','변경할 예약 날짜와 시간을 알려 주세요.','visit-a-legal',$1,$1)
      ,('GUIDELINE_DELIVERY',1,'active','operational_transactional','가이드: {{guideline}}','visit-a-legal',$1,$1)
     ON CONFLICT (purpose_code, version) DO NOTHING`,
    [visitAAt()],
  )
  return {
    campaignId: campaign.rows[0].id,
    participantId: participant.rows[0].id,
    applicationId: application.rows[0].id,
    workflowId: workflow.rows[0].id,
  }
}

export const visitAIntake = (ids, overrides = {}) => ({
  workflowId: ids.workflowId,
  participantId: ids.participantId,
  sourceEventId: 'visit-a-message-1',
  text: '2026년 8월 26일 오후 2시에 예약했어요',
  messageTimestamp: visitAAt(),
  businessName: '테스트 카페',
  businessBranch: '강남점',
  recipientReference: 'masked-kakao-visit-a',
  correctionTemplateVersion: 1,
  participantReference: 'masked-participant-visit-a',
  automationActorId: 'visit-a-system',
  occurredAt: visitAAt(1),
  ...overrides,
})
