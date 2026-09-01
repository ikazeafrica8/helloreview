import { Inject, Injectable } from '@nestjs/common'
import { POSTGRES_POOL } from '@helloreview/db'
import type { Pool } from 'pg'
import { matchApplicant, type ApplicantMatchResult } from './matching-table.js'

export type CandidateLookupInput = Readonly<{
  verifiedApplicationId?: string
  phoneNormalized?: string
  campaignId?: string
  applicantName?: string
  blogUrl?: string
  phoneNamePolicy: 'allow' | 'confirm'
  blogCampaignPolicy: 'weak' | 'strong'
  decidedAt?: Date
}>

export type ParticipantSafeCandidateResult = Readonly<{
  category: ApplicantMatchResult['category']
  reasonCode: ApplicantMatchResult['reasonCode']
  automaticLinkAllowed: boolean
  nextAction: ApplicantMatchResult['nextAction']
}>

export type CandidateLookupResult = Readonly<{
  internal: ApplicantMatchResult
  participantSafe: ParticipantSafeCandidateResult
}>

type Candidate = Readonly<{
  applicationId: string
  campaignId: string
  applicantName: string
  phoneNormalized: string
  blogUrl: string | null
}>

const safeResult = (internal: ApplicantMatchResult): CandidateLookupResult => ({
  internal,
  participantSafe: {
    category: internal.category,
    reasonCode: internal.reasonCode,
    automaticLinkAllowed: internal.automaticLinkAllowed,
    nextAction: internal.nextAction,
  },
})

const normalizedName = (value: string): string => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ko-KR')

const candidateFromRow = (row: Record<string, unknown>): Candidate => {
  const applicationId = row.application_id
  const campaignId = row.campaign_id
  const applicantName = row.applicant_name
  const phoneNormalized = row.phone_normalized
  const blogUrl = row.blog_url
  if (
    typeof applicationId !== 'string' ||
    typeof campaignId !== 'string' ||
    typeof applicantName !== 'string' ||
    typeof phoneNormalized !== 'string' ||
    (blogUrl !== null && typeof blogUrl !== 'string')
  ) {
    throw new Error('candidate lookup returned an invalid application row')
  }
  return { applicationId, campaignId, applicantName, phoneNormalized, blogUrl }
}

/** Deterministic lookup only. Candidate identifiers never appear in participantSafe. */
@Injectable()
export class ApplicationCandidateLookupService {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async lookup(input: CandidateLookupInput): Promise<CandidateLookupResult> {
    const decidedAt = input.decidedAt ?? new Date()
    if (
      input.verifiedApplicationId === undefined &&
      input.phoneNormalized === undefined &&
      input.applicantName === undefined &&
      input.blogUrl === undefined
    ) {
      return safeResult(matchApplicant({ kind: 'no_candidate_after_reconciliation' }, decidedAt))
    }
    const candidates = await this.candidates(input)

    if (input.verifiedApplicationId !== undefined) {
      const verified = candidates.find((candidate) => candidate.applicationId === input.verifiedApplicationId)
      return safeResult(
        verified === undefined
          ? matchApplicant({ kind: 'no_candidate_after_reconciliation' }, decidedAt)
          : matchApplicant({ kind: 'verification_token', applicationId: verified.applicationId }, decidedAt),
      )
    }

    if (input.phoneNormalized !== undefined && input.campaignId !== undefined) {
      const exactPhone = candidates.filter(
        (candidate) => candidate.phoneNormalized === input.phoneNormalized && candidate.campaignId === input.campaignId,
      )
      if (input.applicantName !== undefined) {
        const exactName = exactPhone.filter(
          (candidate) => normalizedName(candidate.applicantName) === normalizedName(input.applicantName ?? ''),
        )
        if (exactName.length === 1) {
          return safeResult(
            matchApplicant(
              {
                kind: 'phone_campaign_name',
                applicationId: exactName[0]?.applicationId ?? '',
                automaticLinkPolicy: input.phoneNamePolicy,
              },
              decidedAt,
            ),
          )
        }
        if (exactName.length > 1) {
          return safeResult(
            matchApplicant(
              {
                kind: 'multiple_candidates',
                candidateApplicationIds: exactName.map((candidate) => candidate.applicationId),
              },
              decidedAt,
            ),
          )
        }
      }
      if (exactPhone.length > 0) {
        return safeResult(
          matchApplicant(
            { kind: 'phone_campaign', candidateApplicationIds: exactPhone.map((candidate) => candidate.applicationId) },
            decidedAt,
          ),
        )
      }
    }

    if (input.blogUrl !== undefined && input.campaignId !== undefined) {
      const exactBlog = candidates.filter(
        (candidate) => candidate.blogUrl === input.blogUrl && candidate.campaignId === input.campaignId,
      )
      if (exactBlog.length === 1) {
        return safeResult(
          matchApplicant(
            {
              kind: 'blog_campaign',
              applicationId: exactBlog[0]?.applicationId ?? '',
              approvedPolicy: input.blogCampaignPolicy,
            },
            decidedAt,
          ),
        )
      }
      if (exactBlog.length > 1) {
        return safeResult(
          matchApplicant(
            {
              kind: 'multiple_candidates',
              candidateApplicationIds: exactBlog.map((candidate) => candidate.applicationId),
            },
            decidedAt,
          ),
        )
      }
    }

    if (input.applicantName !== undefined && input.campaignId !== undefined) {
      const exactName = candidates.filter(
        (candidate) =>
          candidate.campaignId === input.campaignId &&
          normalizedName(candidate.applicantName) === normalizedName(input.applicantName ?? ''),
      )
      if (exactName.length === 1) {
        return safeResult(
          matchApplicant({ kind: 'name_campaign', applicationId: exactName[0]?.applicationId ?? '' }, decidedAt),
        )
      }
      if (exactName.length > 1) {
        return safeResult(
          matchApplicant(
            {
              kind: 'multiple_candidates',
              candidateApplicationIds: exactName.map((candidate) => candidate.applicationId),
            },
            decidedAt,
          ),
        )
      }
    }

    if (input.phoneNormalized !== undefined) {
      const exactPhone = candidates.filter((candidate) => candidate.phoneNormalized === input.phoneNormalized)
      if (exactPhone.length > 0) {
        return safeResult(
          matchApplicant(
            {
              kind: 'phone_multiple_campaigns',
              candidateApplicationIds: exactPhone.map((candidate) => candidate.applicationId),
            },
            decidedAt,
          ),
        )
      }
    }

    return safeResult(matchApplicant({ kind: 'no_candidate_after_reconciliation' }, decidedAt))
  }

  private async candidates(input: CandidateLookupInput): Promise<readonly Candidate[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT id AS application_id, campaign_id, applicant_name, phone_normalized, blog_url
         FROM applications
        WHERE source_status <> 'cancelled'
          AND (
            ($1::uuid IS NOT NULL AND id = $1::uuid)
            OR ($2::text IS NOT NULL AND phone_normalized = $2)
            OR ($4::text IS NOT NULL AND blog_url = $4)
            OR (
              $5::text IS NOT NULL
              AND lower(regexp_replace(btrim(applicant_name), '[[:space:]]+', ' ', 'g')) = $5
            )
          )
          AND ($3::uuid IS NULL OR campaign_id = $3::uuid)
        ORDER BY submitted_at DESC, id ASC`,
      [
        input.verifiedApplicationId ?? null,
        input.phoneNormalized ?? null,
        input.campaignId ?? null,
        input.blogUrl ?? null,
        input.applicantName === undefined ? null : normalizedName(input.applicantName),
      ],
    )
    return result.rows.map(candidateFromRow)
  }
}
