import type { Pool, PoolClient } from 'pg'
import type { ApplicantMatchResult, IdentityMatchCategory } from './matching-table.js'
import { IDENTITY_RESOLUTION_REASON, type IdentityResolutionReasonCode } from './reason-codes.js'

export const IDENTITY_PARTICIPANT_MESSAGES = {
  AMBIGUOUS_PENDING_REVIEW:
    '신청 정보를 정확하게 확인하기 위해 담당자가 확인하고 있습니다.\n확인이 완료되면 이 채팅으로 안내드리겠습니다.',
  CAMPAIGN_DISAMBIGUATION: '참여하신 캠페인을 정확하게 확인해야 합니다.\n신청하신 캠페인명을 직접 입력해 주세요.',
  ADDITIONAL_VERIFICATION: '신청 정보를 확인하려면 추가 인증이 필요합니다.',
  APPLICATION_NOT_FOUND: '신청 정보를 확인하지 못했습니다. 담당자가 확인할 수 있도록 안내해 드리겠습니다.',
} as const

export type IdentityResolutionStatus =
  IdentityMatchCategory | 'campaign_disambiguation_required' | 'security_review_required'

export type CampaignContext = Readonly<{
  resolved: boolean
  resolvedCampaignId: string | null
}>

/** A campaign is usable only when the participant has one context, or selected one from the active set. */
export const resolveCampaignContext = (
  activeCampaignIds: readonly string[],
  selectedCampaignId?: string,
): CampaignContext => {
  const uniqueCampaignIds = [...new Set(activeCampaignIds)]
  if (uniqueCampaignIds.length === 0) return { resolved: false, resolvedCampaignId: null }
  if (uniqueCampaignIds.length === 1) {
    const onlyCampaignId = uniqueCampaignIds[0]
    if (onlyCampaignId === undefined || (selectedCampaignId !== undefined && selectedCampaignId !== onlyCampaignId)) {
      return { resolved: false, resolvedCampaignId: null }
    }
    return { resolved: true, resolvedCampaignId: onlyCampaignId }
  }
  if (selectedCampaignId !== undefined && uniqueCampaignIds.includes(selectedCampaignId)) {
    return { resolved: true, resolvedCampaignId: selectedCampaignId }
  }
  return { resolved: false, resolvedCampaignId: null }
}

export type IdentityCandidateLink = Readonly<{
  applicationId: string
  linkedParticipantId: string | null
}>

export type IdentityContextDecision = Readonly<{
  status: IdentityResolutionStatus
  reasonCode: IdentityResolutionReasonCode
  campaignSpecificTransitionsAllowed: boolean
  participantMessagePurpose: string | null
  participantMessage: string | null
  humanReviewReasonCode: IdentityHumanReviewReasonCode | null
  humanReviewRecommendationCode: string | null
}>

export type IdentityHumanReviewReasonCode = 'IDENTITY_AMBIGUOUS' | 'IDENTITY_CONFLICT'

/** Pure T31 decision. Participant-facing fields are fixed constants and never candidate-derived. */
export const decideIdentityContext = (
  input: Readonly<{
    participantId: string
    match: ApplicantMatchResult
    activeCampaignIds: readonly string[]
    selectedCampaignId?: string
    candidateLinks: readonly IdentityCandidateLink[]
  }>,
): IdentityContextDecision => {
  const matchedApplicationIds = new Set(input.match.candidateApplicationIds)
  const hasForeignParticipantLink = input.candidateLinks.some(
    (candidate) =>
      matchedApplicationIds.has(candidate.applicationId) &&
      candidate.linkedParticipantId !== null &&
      candidate.linkedParticipantId !== input.participantId,
  )
  if (hasForeignParticipantLink || input.match.nextAction === 'security_review') {
    return {
      status: 'security_review_required',
      reasonCode: IDENTITY_RESOLUTION_REASON.PARTICIPANT_LINK_CONFLICT,
      campaignSpecificTransitionsAllowed: false,
      participantMessagePurpose: 'identity_security_review_pending',
      participantMessage: IDENTITY_PARTICIPANT_MESSAGES.AMBIGUOUS_PENDING_REVIEW,
      humanReviewReasonCode: 'IDENTITY_CONFLICT',
      humanReviewRecommendationCode: 'SECURITY_REVIEW_IDENTITY_OWNERSHIP',
    }
  }

  const campaignContext = resolveCampaignContext(input.activeCampaignIds, input.selectedCampaignId)
  const hasSeveralActiveCampaigns = new Set(input.activeCampaignIds).size > 1
  const selectedCampaignIsInvalid = input.selectedCampaignId !== undefined && !campaignContext.resolved
  if (
    input.match.nextAction === 'campaign_disambiguation' ||
    (hasSeveralActiveCampaigns && !campaignContext.resolved) ||
    selectedCampaignIsInvalid
  ) {
    return {
      status: 'campaign_disambiguation_required',
      reasonCode: IDENTITY_RESOLUTION_REASON.CAMPAIGN_DISAMBIGUATION_REQUIRED,
      campaignSpecificTransitionsAllowed: false,
      participantMessagePurpose: 'campaign_disambiguation_request',
      participantMessage: IDENTITY_PARTICIPANT_MESSAGES.CAMPAIGN_DISAMBIGUATION,
      humanReviewReasonCode: null,
      humanReviewRecommendationCode: null,
    }
  }

  if (input.match.category === 'ambiguous') {
    return {
      status: 'ambiguous',
      reasonCode: input.match.reasonCode,
      campaignSpecificTransitionsAllowed: false,
      participantMessagePurpose: 'identity_ambiguous_pending_review',
      participantMessage: IDENTITY_PARTICIPANT_MESSAGES.AMBIGUOUS_PENDING_REVIEW,
      humanReviewReasonCode: 'IDENTITY_AMBIGUOUS',
      humanReviewRecommendationCode: 'VERIFY_IDENTITY_WITHOUT_DISCLOSURE',
    }
  }

  if (input.match.category === 'verified' || input.match.category === 'strong_match') {
    const matchingPolicyAllowsBinding = input.match.automaticLinkAllowed && input.match.nextAction === 'persist_link'
    return {
      status: input.match.category,
      reasonCode: input.match.reasonCode,
      campaignSpecificTransitionsAllowed: campaignContext.resolved && matchingPolicyAllowsBinding,
      participantMessagePurpose: matchingPolicyAllowsBinding ? null : 'additional_verification_request',
      participantMessage: matchingPolicyAllowsBinding ? null : IDENTITY_PARTICIPANT_MESSAGES.ADDITIONAL_VERIFICATION,
      humanReviewReasonCode: null,
      humanReviewRecommendationCode: null,
    }
  }

  if (input.match.category === 'no_match') {
    return {
      status: 'no_match',
      reasonCode: input.match.reasonCode,
      campaignSpecificTransitionsAllowed: false,
      participantMessagePurpose: 'application_not_found',
      participantMessage: IDENTITY_PARTICIPANT_MESSAGES.APPLICATION_NOT_FOUND,
      humanReviewReasonCode: null,
      humanReviewRecommendationCode: null,
    }
  }

  return {
    status: 'weak_match',
    reasonCode: input.match.reasonCode,
    campaignSpecificTransitionsAllowed: false,
    participantMessagePurpose: 'additional_verification_request',
    participantMessage: IDENTITY_PARTICIPANT_MESSAGES.ADDITIONAL_VERIFICATION,
    humanReviewReasonCode: null,
    humanReviewRecommendationCode: null,
  }
}

export type IdentityReviewTaskSink = Readonly<{
  createIdentityReviewTask: (
    client: PoolClient,
    input: Readonly<{
      workflowReference: string
      identityResolutionId: string
      reasonCode: IdentityHumanReviewReasonCode
      stateCode: string
      evidenceCodes: readonly string[]
      recommendationCode: string
      createdAt: Date
    }>,
  ) => Promise<Readonly<{ id: string }>>
}>

export type IdentityAmbiguityResult = Readonly<{
  identityResolutionId: string
  status: IdentityResolutionStatus
  campaignSpecificTransitionsAllowed: boolean
  participantMessage: string | null
  humanReviewTaskId: string | null
}>

const stringColumn = (row: Record<string, unknown>, column: string): string => {
  const value = row[column]
  if (typeof value === 'string') return value
  throw new Error(`identity resolution query returned an invalid ${column}`)
}

const booleanColumn = (row: Record<string, unknown>, column: string): boolean => {
  const value = row[column]
  if (typeof value === 'boolean') return value
  throw new Error(`identity resolution query returned an invalid ${column}`)
}

const nullableStringColumn = (row: Record<string, unknown>, column: string): string | null => {
  const value = row[column]
  if (value === null || typeof value === 'string') return value
  throw new Error(`identity resolution query returned an invalid ${column}`)
}

const assertReplayMatches = (
  row: Record<string, unknown>,
  participantId: string,
  match: ApplicantMatchResult,
  decision: IdentityContextDecision,
): string => {
  if (
    stringColumn(row, 'participant_id') !== participantId ||
    stringColumn(row, 'match_category') !== match.category ||
    stringColumn(row, 'status') !== decision.status ||
    stringColumn(row, 'reason_code') !== decision.reasonCode ||
    booleanColumn(row, 'campaign_specific_transitions_allowed') !== decision.campaignSpecificTransitionsAllowed ||
    nullableStringColumn(row, 'participant_message_purpose') !== decision.participantMessagePurpose
  ) {
    throw new Error('identity resolution source key was replayed with conflicting evidence')
  }
  return stringColumn(row, 'id')
}

export class IdentityAmbiguityService {
  constructor(
    private readonly pool: Pool,
    private readonly reviewTaskSink: IdentityReviewTaskSink,
  ) {}

  async resolve(
    input: Readonly<{
      sourceKey: string
      participantId: string
      channelIdentityId?: string
      campaignId?: string
      selectedCampaignId?: string
      workflowReference: string
      match: ApplicantMatchResult
      activeCampaignIds: readonly string[]
      candidateLinks: readonly IdentityCandidateLink[]
      decidedAt: Date
    }>,
  ): Promise<IdentityAmbiguityResult> {
    if (input.sourceKey.length === 0 || input.sourceKey.length > 256 || Number.isNaN(input.decidedAt.getTime())) {
      throw new Error('identity resolution input is invalid')
    }
    const decision = decideIdentityContext(input)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const inserted = await client.query<Record<string, unknown>>(
        `INSERT INTO identity_resolution_cases (
           source_key, participant_id, channel_identity_id, campaign_id, match_category, status,
           match_method, evidence_category, reason_code, candidate_application_ids,
           campaign_specific_transitions_allowed, participant_message_purpose,
           decided_at, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$13,$13)
         ON CONFLICT (source_key) DO NOTHING
         RETURNING id, participant_id, match_category, status, reason_code,
                   campaign_specific_transitions_allowed, participant_message_purpose`,
        [
          input.sourceKey,
          input.participantId,
          input.channelIdentityId ?? null,
          input.campaignId ?? input.selectedCampaignId ?? null,
          input.match.category,
          decision.status,
          input.match.method,
          input.match.evidenceCategory,
          decision.reasonCode,
          JSON.stringify(input.match.candidateApplicationIds),
          decision.campaignSpecificTransitionsAllowed,
          decision.participantMessagePurpose,
          input.decidedAt,
        ],
      )
      let resolutionRow = inserted.rows[0]
      if (resolutionRow === undefined) {
        const replay = await client.query<Record<string, unknown>>(
          `SELECT id, participant_id, match_category, status, reason_code,
                  campaign_specific_transitions_allowed, participant_message_purpose
             FROM identity_resolution_cases WHERE source_key = $1`,
          [input.sourceKey],
        )
        resolutionRow = replay.rows[0]
      }
      if (resolutionRow === undefined) throw new Error('identity resolution replay was not visible')
      const identityResolutionId = assertReplayMatches(resolutionRow, input.participantId, input.match, decision)

      let humanReviewTaskId: string | null = null
      if (decision.humanReviewReasonCode !== null && decision.humanReviewRecommendationCode !== null) {
        const task = await this.reviewTaskSink.createIdentityReviewTask(client, {
          workflowReference: input.workflowReference,
          identityResolutionId,
          reasonCode: decision.humanReviewReasonCode,
          stateCode: decision.status,
          evidenceCodes: [input.match.evidenceCategory, input.match.method, decision.reasonCode],
          recommendationCode: decision.humanReviewRecommendationCode,
          createdAt: input.decidedAt,
        })
        humanReviewTaskId = task.id
      }
      await client.query('COMMIT')
      return {
        identityResolutionId,
        status: decision.status,
        campaignSpecificTransitionsAllowed: decision.campaignSpecificTransitionsAllowed,
        participantMessage: decision.participantMessage,
        humanReviewTaskId,
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}
