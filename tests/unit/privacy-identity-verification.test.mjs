import { describe, expect, test } from 'vitest'
import {
  PRIVACY_IDENTITY_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
  PRIVACY_IDENTITY_VERIFICATION_POLICY_SCHEMA_VERSION,
  parsePrivacyAffectedProcessingScopes,
  parsePrivacyIdentityVerificationEvidence,
  parsePrivacyIdentityVerificationPolicy,
} from '../../apps/api/src/modules/privacy-ops/privacy-identity-verification.ts'
import { PrivacyRequestContractError } from '../../apps/api/src/modules/privacy-ops/privacy-request-contract.ts'

const participantId = '8d2a408e-9a26-4f0e-8469-08305a4fbb99'
const campaignId = 'bc10666c-56c2-48f6-9151-5ac6588bb97a'

describe('T97 privacy identity-verification contracts', () => {
  test('accepts only an explicitly approved, versioned minimal verification policy', () => {
    const policy = {
      schemaVersion: PRIVACY_IDENTITY_VERIFICATION_POLICY_SCHEMA_VERSION,
      policyVersion: 'privacy-verified-channel-fixture-v1',
      approved: true,
      approvedByReference: 'privacy-governance:pseudo:1',
      approvedAt: new Date('2026-08-26T07:00:00.000Z'),
      method: 'verified_channel_identity',
    }
    expect(parsePrivacyIdentityVerificationPolicy(policy)).toEqual(policy)
    expect(() => parsePrivacyIdentityVerificationPolicy({ ...policy, approved: false })).toThrow(
      PrivacyRequestContractError,
    )
    expect(() => parsePrivacyIdentityVerificationPolicy({ ...policy, method: 'phone_lookup' })).toThrow(
      PrivacyRequestContractError,
    )
    expect(() => parsePrivacyIdentityVerificationPolicy({ ...policy, contact: '010-1234-5678' })).toThrow(
      PrivacyRequestContractError,
    )
  })

  test('accepts only a verified-channel identity reference and rejects raw contact evidence', () => {
    const evidence = {
      schemaVersion: PRIVACY_IDENTITY_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
      method: 'verified_channel_identity',
      channelIdentityId: 'd6d481e2-71d1-407e-98f6-fd695692019c',
      reference: 'verification:evidence:pseudo:97',
    }
    expect(parsePrivacyIdentityVerificationEvidence(evidence)).toEqual(evidence)
    expect(() => parsePrivacyIdentityVerificationEvidence({ ...evidence, reference: 'person@example.com' })).toThrow(
      PrivacyRequestContractError,
    )
  })

  test('canonicalizes bounded exact affected scopes and rejects duplicates or broad scopes', () => {
    expect(
      parsePrivacyAffectedProcessingScopes([
        { scope: 'participant_campaign', participantId, campaignId },
        { scope: 'workflow', workflowId: 'd6d481e2-71d1-407e-98f6-fd695692019c' },
      ]),
    ).toHaveLength(2)
    expect(() =>
      parsePrivacyAffectedProcessingScopes([
        { scope: 'participant', participantId },
        { scope: 'participant', participantId },
      ]),
    ).toThrow(PrivacyRequestContractError)
    expect(() => parsePrivacyAffectedProcessingScopes([{ scope: 'global' }])).toThrow(PrivacyRequestContractError)
  })
})
