export { IdentityResolutionModule } from './identity-resolution.module.js'
export {
  normalizeKoreanMobilePhone,
  PhoneNormalizationError,
  PHONE_NORMALIZATION_FAILURES,
} from './phone-normalization.js'
export type { PhoneNormalizationFailure } from './phone-normalization.js'
export { matchApplicant, MatchingTableError, IDENTITY_MATCH_CATEGORIES } from './matching-table.js'
export type {
  ApplicantMatchingEvidence,
  IdentityMatchCategory,
  ApplicantMatchMethod,
  ApplicantEvidenceCategory,
  ApplicantMatchNextAction,
  ApplicantMatchResult,
} from './matching-table.js'
export { IDENTITY_RESOLUTION_REASON } from './reason-codes.js'
export type { IdentityResolutionReasonCode } from './reason-codes.js'
export {
  verificationTokenDigest,
  constantTimeTokenDigestMatch,
  matchVerificationToken,
  ApplicationVerificationTokenService,
  VerificationTokenError,
} from './verification-token.js'
export type { VerificationTokenRecord } from './verification-token.js'
export {
  decideIdentityContext,
  resolveCampaignContext,
  IDENTITY_PARTICIPANT_MESSAGES,
  IdentityAmbiguityService,
} from './ambiguity.service.js'
export type {
  CampaignContext,
  IdentityCandidateLink,
  IdentityContextDecision,
  IdentityReviewTaskSink,
  IdentityAmbiguityResult,
  IdentityResolutionStatus,
  IdentityHumanReviewReasonCode,
} from './ambiguity.service.js'
