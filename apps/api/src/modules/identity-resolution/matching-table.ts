import { IDENTITY_RESOLUTION_REASON, type IdentityResolutionReasonCode } from './reason-codes.js'

export const IDENTITY_MATCH_CATEGORIES = ['verified', 'strong_match', 'weak_match', 'ambiguous', 'no_match'] as const

export type IdentityMatchCategory = (typeof IDENTITY_MATCH_CATEGORIES)[number]

export type ApplicantMatchingEvidence =
  | Readonly<{ kind: 'verification_token'; applicationId: string }>
  | Readonly<{
      kind: 'phone_campaign_name'
      applicationId: string
      automaticLinkPolicy: 'allow' | 'confirm'
    }>
  | Readonly<{ kind: 'phone_campaign'; candidateApplicationIds: readonly string[] }>
  | Readonly<{ kind: 'name_campaign'; applicationId: string }>
  | Readonly<{ kind: 'phone_multiple_campaigns'; candidateApplicationIds: readonly string[] }>
  | Readonly<{ kind: 'secret_comment_screenshot' }>
  | Readonly<{ kind: 'blog_campaign'; applicationId: string; approvedPolicy: 'weak' | 'strong' }>
  | Readonly<{ kind: 'no_candidate_after_reconciliation' }>
  | Readonly<{ kind: 'participant_link_conflict'; applicationId: string }>

export type ApplicantMatchMethod =
  | 'application_verification_token'
  | 'normalized_phone_campaign_name'
  | 'normalized_phone_campaign'
  | 'name_campaign'
  | 'normalized_phone_multiple_campaigns'
  | 'secret_comment_screenshot'
  | 'blog_url_campaign'
  | 'reconciliation'
  | 'existing_participant_link'

export type ApplicantEvidenceCategory =
  | 'application_specific'
  | 'multi_factor'
  | 'phone_campaign'
  | 'name_only'
  | 'campaign_context'
  | 'supporting_only'
  | 'blog_campaign'
  | 'no_candidate'
  | 'ownership_conflict'

export type ApplicantMatchNextAction =
  | 'persist_link'
  | 'confirm_then_persist'
  | 'additional_verification'
  | 'human_review'
  | 'campaign_disambiguation'
  | 'continue_matching'
  | 'application_not_found'
  | 'security_review'

export type ApplicantMatchResult = Readonly<{
  category: IdentityMatchCategory
  method: ApplicantMatchMethod
  evidenceCategory: ApplicantEvidenceCategory
  reasonCode: IdentityResolutionReasonCode
  candidateApplicationIds: readonly string[]
  automaticLinkAllowed: boolean
  nextAction: ApplicantMatchNextAction
  decidedAt: Date
}>

export class MatchingTableError extends Error {
  override readonly name = 'MatchingTableError'

  constructor(readonly reasonCode: IdentityResolutionReasonCode) {
    super(`Applicant matching rejected: ${reasonCode}`)
  }
}

const result = (decidedAt: Date, fields: Omit<ApplicantMatchResult, 'decidedAt'>): ApplicantMatchResult => ({
  ...fields,
  decidedAt,
})

/** The PRD §16.1 decision table as one pure, exhaustive function. */
export const matchApplicant = (evidence: ApplicantMatchingEvidence, decidedAt: Date): ApplicantMatchResult => {
  switch (evidence.kind) {
    case 'verification_token':
      return result(decidedAt, {
        category: 'verified',
        method: 'application_verification_token',
        evidenceCategory: 'application_specific',
        reasonCode: IDENTITY_RESOLUTION_REASON.VERIFICATION_TOKEN,
        candidateApplicationIds: [evidence.applicationId],
        automaticLinkAllowed: true,
        nextAction: 'persist_link',
      })
    case 'phone_campaign_name':
      return result(decidedAt, {
        category: 'strong_match',
        method: 'normalized_phone_campaign_name',
        evidenceCategory: 'multi_factor',
        reasonCode: IDENTITY_RESOLUTION_REASON.PHONE_CAMPAIGN_NAME,
        candidateApplicationIds: [evidence.applicationId],
        automaticLinkAllowed: evidence.automaticLinkPolicy === 'allow',
        nextAction: evidence.automaticLinkPolicy === 'allow' ? 'persist_link' : 'confirm_then_persist',
      })
    case 'phone_campaign':
      return result(decidedAt, {
        category: 'ambiguous',
        method: 'normalized_phone_campaign',
        evidenceCategory: 'phone_campaign',
        reasonCode: IDENTITY_RESOLUTION_REASON.PHONE_CAMPAIGN_AMBIGUOUS,
        candidateApplicationIds: evidence.candidateApplicationIds,
        automaticLinkAllowed: false,
        nextAction: 'human_review',
      })
    case 'name_campaign':
      return result(decidedAt, {
        category: 'weak_match',
        method: 'name_campaign',
        evidenceCategory: 'name_only',
        reasonCode: IDENTITY_RESOLUTION_REASON.NAME_ONLY_WEAK,
        candidateApplicationIds: [evidence.applicationId],
        automaticLinkAllowed: false,
        nextAction: 'additional_verification',
      })
    case 'phone_multiple_campaigns':
      return result(decidedAt, {
        category: 'ambiguous',
        method: 'normalized_phone_multiple_campaigns',
        evidenceCategory: 'campaign_context',
        reasonCode: IDENTITY_RESOLUTION_REASON.MULTIPLE_CAMPAIGNS,
        candidateApplicationIds: evidence.candidateApplicationIds,
        automaticLinkAllowed: false,
        nextAction: 'campaign_disambiguation',
      })
    case 'secret_comment_screenshot':
      return result(decidedAt, {
        category: 'weak_match',
        method: 'secret_comment_screenshot',
        evidenceCategory: 'supporting_only',
        reasonCode: IDENTITY_RESOLUTION_REASON.SECRET_COMMENT_SUPPORTING_ONLY,
        candidateApplicationIds: [],
        automaticLinkAllowed: false,
        nextAction: 'continue_matching',
      })
    case 'blog_campaign':
      return result(decidedAt, {
        category: evidence.approvedPolicy === 'strong' ? 'strong_match' : 'weak_match',
        method: 'blog_url_campaign',
        evidenceCategory: 'blog_campaign',
        reasonCode:
          evidence.approvedPolicy === 'strong'
            ? IDENTITY_RESOLUTION_REASON.BLOG_CAMPAIGN_STRONG
            : IDENTITY_RESOLUTION_REASON.BLOG_CAMPAIGN_WEAK,
        candidateApplicationIds: [evidence.applicationId],
        automaticLinkAllowed: false,
        nextAction: 'additional_verification',
      })
    case 'no_candidate_after_reconciliation':
      return result(decidedAt, {
        category: 'no_match',
        method: 'reconciliation',
        evidenceCategory: 'no_candidate',
        reasonCode: IDENTITY_RESOLUTION_REASON.NO_CANDIDATE,
        candidateApplicationIds: [],
        automaticLinkAllowed: false,
        nextAction: 'application_not_found',
      })
    case 'participant_link_conflict':
      return result(decidedAt, {
        category: 'ambiguous',
        method: 'existing_participant_link',
        evidenceCategory: 'ownership_conflict',
        reasonCode: IDENTITY_RESOLUTION_REASON.PARTICIPANT_LINK_CONFLICT,
        candidateApplicationIds: [evidence.applicationId],
        automaticLinkAllowed: false,
        nextAction: 'security_review',
      })
  }
  // TypeScript callers are exhaustive; this remains the runtime fail-closed guard for untyped input.
  throw new MatchingTableError(IDENTITY_RESOLUTION_REASON.MATCHING_EVIDENCE_INVALID)
}
