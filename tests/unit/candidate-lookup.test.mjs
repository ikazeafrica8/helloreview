import { describe, expect, test } from 'vitest'
import { ApplicationCandidateLookupService } from '../../apps/api/dist/modules/identity-resolution/index.js'

const rows = [
  {
    application_id: '11111111-1111-4111-8111-111111111111',
    campaign_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    applicant_name: '홍길동',
    phone_normalized: '+821012345678',
    blog_url: 'https://blog.example/one',
  },
  {
    application_id: '22222222-2222-4222-8222-222222222222',
    campaign_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    applicant_name: '김하나',
    phone_normalized: '+821012345678',
    blog_url: 'https://blog.example/two',
  },
]

const pool = { query: async () => ({ rows }) }

describe('deterministic application candidate lookup', () => {
  test('uses phone, campaign and name as strong evidence but redacts candidate identifiers', async () => {
    const service = new ApplicationCandidateLookupService(pool)
    const result = await service.lookup({
      phoneNormalized: '+821012345678',
      campaignId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      applicantName: '홍길동',
      phoneNamePolicy: 'allow',
      blogCampaignPolicy: 'weak',
      decidedAt: new Date('2026-08-24T01:00:00Z'),
    })

    expect(result.internal).toMatchObject({
      category: 'strong_match',
      candidateApplicationIds: ['11111111-1111-4111-8111-111111111111'],
      automaticLinkAllowed: true,
    })
    expect(result.participantSafe).toMatchObject({
      category: 'strong_match',
      automaticLinkAllowed: true,
      nextAction: 'persist_link',
    })
    expect(result.participantSafe).not.toHaveProperty('candidateApplicationIds')
  })

  test('shared phone evidence alone never binds automatically', async () => {
    const service = new ApplicationCandidateLookupService(pool)
    const result = await service.lookup({
      phoneNormalized: '+821012345678',
      campaignId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      phoneNamePolicy: 'allow',
      blogCampaignPolicy: 'weak',
      decidedAt: new Date('2026-08-24T01:00:00Z'),
    })

    expect(result.internal).toMatchObject({ category: 'ambiguous', automaticLinkAllowed: false })
    expect(result.internal.candidateApplicationIds).toHaveLength(2)
    expect(result.participantSafe).not.toHaveProperty('candidateApplicationIds')
  })
})
