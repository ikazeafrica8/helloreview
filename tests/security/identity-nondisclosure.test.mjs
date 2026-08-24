// Security tier: ambiguity output cannot become an applicant/candidate enumeration oracle (T31/T33).

import { describe, expect, test } from 'vitest'
import { decideIdentityContext, matchApplicant } from '../../apps/api/dist/modules/identity-resolution/index.js'

describe('identity resolution non-disclosure', () => {
  test('participant output is invariant when private candidate records change', () => {
    const match = matchApplicant(
      { kind: 'phone_campaign', candidateApplicationIds: ['secret-app-1', 'secret-app-2'] },
      new Date('2026-08-24T11:00:00Z'),
    )
    const base = {
      participantId: 'participant-a',
      match,
      activeCampaignIds: ['campaign-a'],
    }
    const first = decideIdentityContext({
      ...base,
      candidateLinks: [
        { applicationId: 'secret-app-1', linkedParticipantId: null, applicantName: 'Alice', phone: '01011112222' },
      ],
    })
    const second = decideIdentityContext({
      ...base,
      candidateLinks: [
        { applicationId: 'secret-app-1', linkedParticipantId: null, applicantName: 'Bob', phone: '01099998888' },
      ],
    })
    expect(first.participantMessage).toBe(second.participantMessage)
    const participantOutput = JSON.stringify({ message: first.participantMessage })
    for (const secret of ['Alice', 'Bob', '01011112222', '01099998888', 'secret-app-1', 'secret-app-2']) {
      expect(participantOutput).not.toContain(secret)
    }
  })
})
