// Unit tier: T31 ambiguity, campaign-context gating and ownership-conflict routing.

import { describe, expect, test } from 'vitest'
import {
  decideIdentityContext,
  IDENTITY_PARTICIPANT_MESSAGES,
  matchApplicant,
  resolveCampaignContext,
} from '../../apps/api/dist/modules/identity-resolution/index.js'

const decidedAt = new Date('2026-08-24T10:00:00Z')

describe('identity ambiguity guard', () => {
  test('multiple active campaigns block campaign-specific transitions until one valid context is selected', () => {
    expect(resolveCampaignContext(['campaign-a', 'campaign-b'])).toEqual({
      resolved: false,
      resolvedCampaignId: null,
    })
    expect(resolveCampaignContext(['campaign-a', 'campaign-b'], 'not-active')).toEqual({
      resolved: false,
      resolvedCampaignId: null,
    })
    expect(resolveCampaignContext(['campaign-a', 'campaign-b'], 'campaign-b')).toEqual({
      resolved: true,
      resolvedCampaignId: 'campaign-b',
    })

    const match = matchApplicant({ kind: 'verification_token', applicationId: 'application-a' }, decidedAt)
    const blocked = decideIdentityContext({
      participantId: 'participant-a',
      match,
      activeCampaignIds: ['campaign-a', 'campaign-b'],
      candidateLinks: [],
    })
    expect(blocked).toMatchObject({
      status: 'campaign_disambiguation_required',
      campaignSpecificTransitionsAllowed: false,
      participantMessage: IDENTITY_PARTICIPANT_MESSAGES.CAMPAIGN_DISAMBIGUATION,
    })

    const resolved = decideIdentityContext({
      participantId: 'participant-a',
      match,
      activeCampaignIds: ['campaign-a', 'campaign-b'],
      selectedCampaignId: 'campaign-a',
      candidateLinks: [],
    })
    expect(resolved).toMatchObject({ status: 'verified', campaignSpecificTransitionsAllowed: true })
  })

  test('ambiguous candidates reveal no candidate details and route to high-priority human review', () => {
    const privateName = 'Private Applicant Name'
    const privatePhone = '+821012345678'
    const privateBlog = 'https://blog.example/private'
    const match = matchApplicant(
      { kind: 'phone_campaign', candidateApplicationIds: ['application-a', 'application-b'] },
      decidedAt,
    )
    const decision = decideIdentityContext({
      participantId: 'participant-a',
      match,
      activeCampaignIds: ['campaign-a'],
      candidateLinks: [
        {
          applicationId: 'application-a',
          linkedParticipantId: null,
          applicantName: privateName,
          phone: privatePhone,
          blogUrl: privateBlog,
        },
      ],
    })
    expect(decision).toMatchObject({
      status: 'ambiguous',
      campaignSpecificTransitionsAllowed: false,
      participantMessage: IDENTITY_PARTICIPANT_MESSAGES.AMBIGUOUS_PENDING_REVIEW,
      humanReviewReasonCode: 'IDENTITY_AMBIGUOUS',
    })
    const participantOutput = JSON.stringify({ message: decision.participantMessage })
    for (const privateValue of [privateName, privatePhone, privateBlog, 'application-a', 'application-b']) {
      expect(participantOutput).not.toContain(privateValue)
    }
  })

  test('a candidate already linked to another participant always routes to security review', () => {
    const match = matchApplicant(
      { kind: 'phone_campaign_name', applicationId: 'application-a', automaticLinkPolicy: 'allow' },
      decidedAt,
    )
    expect(
      decideIdentityContext({
        participantId: 'participant-a',
        match,
        activeCampaignIds: ['campaign-a'],
        candidateLinks: [{ applicationId: 'application-a', linkedParticipantId: 'participant-b' }],
      }),
    ).toMatchObject({
      status: 'security_review_required',
      campaignSpecificTransitionsAllowed: false,
      participantMessage: IDENTITY_PARTICIPANT_MESSAGES.AMBIGUOUS_PENDING_REVIEW,
      humanReviewReasonCode: 'IDENTITY_CONFLICT',
    })
  })

  test('no campaign context never invents a campaign-disambiguation state', () => {
    const noMatch = matchApplicant({ kind: 'no_candidate_after_reconciliation' }, decidedAt)
    expect(
      decideIdentityContext({
        participantId: 'participant-a',
        match: noMatch,
        activeCampaignIds: [],
        candidateLinks: [],
      }),
    ).toMatchObject({ status: 'no_match', campaignSpecificTransitionsAllowed: false })

    const verified = matchApplicant({ kind: 'verification_token', applicationId: 'application-a' }, decidedAt)
    expect(
      decideIdentityContext({
        participantId: 'participant-a',
        match: verified,
        activeCampaignIds: [],
        candidateLinks: [],
      }),
    ).toMatchObject({ status: 'verified', campaignSpecificTransitionsAllowed: false })
  })

  test('a Strong Match cannot bypass its confirmation or additional-verification policy', () => {
    for (const match of [
      matchApplicant(
        { kind: 'phone_campaign_name', applicationId: 'application-a', automaticLinkPolicy: 'confirm' },
        decidedAt,
      ),
      matchApplicant({ kind: 'blog_campaign', applicationId: 'application-a', approvedPolicy: 'strong' }, decidedAt),
    ]) {
      expect(
        decideIdentityContext({
          participantId: 'participant-a',
          match,
          activeCampaignIds: ['campaign-a'],
          candidateLinks: [],
        }),
      ).toMatchObject({
        status: 'strong_match',
        campaignSpecificTransitionsAllowed: false,
        participantMessage: IDENTITY_PARTICIPANT_MESSAGES.ADDITIONAL_VERIFICATION,
      })
    }
  })
})
