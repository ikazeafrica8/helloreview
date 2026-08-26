import { describe, expect, test } from 'vitest'
import {
  buildHumanReviewCasePacket,
  HUMAN_REVIEW_CASE_PACKET_VERSION,
  HUMAN_REVIEW_REASON,
  isHumanReviewCasePacket,
} from '../../apps/api/dist/modules/human-tasks/index.js'

const validInput = () => ({
  workflowReference: 'wf:visit:01',
  workflowStateCode: 'HUMAN_REVIEW_REQUIRED',
  maskedIdentity: {
    participantReference: 'participant:masked:7f2a',
    displayName: '홍**',
    phone: '010-****-5678',
  },
  application: { reference: 'application:pseudo:a12', lifecycleStatusCode: 'RECEIVED' },
  campaign: { reference: 'campaign:42', typeCode: 'VISIT' },
  summaryCode: HUMAN_REVIEW_REASON.IDENTITY_AMBIGUOUS,
  evidence: [
    {
      evidenceCode: 'IDENTITY_MATCH_RESULT',
      reference: 'identity-resolution:9',
      observedAt: '2026-08-25T10:30:00.000Z',
    },
  ],
  rules: [{ ruleCode: 'IDENTITY_UNIQUE_MATCH', resultCode: 'AMBIGUOUS', version: 'identity-v1' }],
  allowedActionCodes: ['VERIFY_IDENTITY', 'KEEP_AUTOMATION_PAUSED'],
  priority: 'high',
  recommendationCode: 'VERIFY_IDENTITY_WITHOUT_DISCLOSURE',
  createdAt: new Date('2026-08-25T10:30:01.000Z'),
})

describe('FR-HUM-003 human-review case packet', () => {
  test('builds the complete versioned operator packet with masked identity and deterministic evidence', () => {
    expect(buildHumanReviewCasePacket(validInput())).toEqual({
      schemaVersion: HUMAN_REVIEW_CASE_PACKET_VERSION,
      ...validInput(),
      evidence: validInput().evidence,
      rules: validInput().rules,
      allowedActionCodes: validInput().allowedActionCodes,
      automationPaused: true,
      createdAt: '2026-08-25T10:30:01.000Z',
    })
  })

  test.each([
    ['unmasked name', { maskedIdentity: { ...validInput().maskedIdentity, displayName: '홍길동' } }],
    ['raw phone', { maskedIdentity: { ...validInput().maskedIdentity, phone: '010-1234-5678' } }],
    ['free-form state', { workflowStateCode: 'needs review' }],
    ['unsafe reference', { application: { ...validInput().application, reference: 'application 1' } }],
    ['duplicate action', { allowedActionCodes: ['VERIFY_IDENTITY', 'VERIFY_IDENTITY'] }],
    ['missing evidence', { evidence: [] }],
    ['missing rule results', { rules: [] }],
  ])('fails closed for %s', (_label, replacement) => {
    expect(() => buildHumanReviewCasePacket({ ...validInput(), ...replacement })).toThrow()
  })

  test('copies arrays so later caller mutation cannot rewrite the returned evidence', () => {
    const input = validInput()
    const packet = buildHumanReviewCasePacket(input)
    input.evidence.push({
      evidenceCode: 'LATE_MUTATION',
      reference: 'evidence:late',
      observedAt: '2026-08-25T10:31:00.000Z',
    })
    input.allowedActionCodes.push('UNREVIEWED_ACTION')
    expect(packet.evidence).toHaveLength(1)
    expect(packet.allowedActionCodes).not.toContain('UNREVIEWED_ACTION')
  })

  test('rejects unsafe stored packets when reading from the database', () => {
    const packet = buildHumanReviewCasePacket(validInput())
    expect(isHumanReviewCasePacket(packet)).toBe(true)
    expect(
      isHumanReviewCasePacket({
        ...packet,
        maskedIdentity: { ...packet.maskedIdentity, displayName: '홍길동' },
      }),
    ).toBe(false)
  })
})
