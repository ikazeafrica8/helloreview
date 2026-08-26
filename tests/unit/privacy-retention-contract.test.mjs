import { describe, expect, test } from 'vitest'
import {
  PRIVACY_DATA_CLASSES,
  PrivacyRequestContractError,
} from '../../apps/api/src/modules/privacy-ops/privacy-request-contract.ts'
import {
  PRIVACY_LEGAL_HOLD_SCOPE_SCHEMA_VERSION,
  PRIVACY_RETENTION_SCHEDULE_SCHEMA_VERSION,
  PRIVACY_RETENTION_SUBJECT_SCHEMA_VERSION,
  parsePrivacyLegalHoldScope,
  parsePrivacyRetentionSchedule,
  parsePrivacyRetentionSubject,
} from '../../apps/api/src/modules/privacy-ops/privacy-retention-contract.ts'

const participantId = '8d2a408e-9a26-4f0e-8469-08305a4fbb99'
const schedule = (overrides = {}) => ({
  schemaVersion: PRIVACY_RETENTION_SCHEDULE_SCHEMA_VERSION,
  policyVersion: 'privacy-retention-test-fixture-v1',
  supersedesPolicyVersion: null,
  approved: true,
  companyApprovalReference: 'test-fixture:company-approval:98',
  legalApprovalReference: 'test-fixture:legal-approval:98',
  approvedAt: new Date('2026-08-01T00:00:00.000Z'),
  effectiveFrom: new Date('2026-08-02T00:00:00.000Z'),
  entries: [...PRIVACY_DATA_CLASSES].reverse().map((dataClass) => ({
    dataClass,
    retentionDays: 30,
    disposition: dataClass === 'audit_logs' ? 'irreversible_mask' : 'delete',
  })),
  ...overrides,
})

describe('T98 retention schedule contract', () => {
  test('accepts a dual-approved complete version and canonicalizes all data classes', () => {
    const parsed = parsePrivacyRetentionSchedule(schedule())
    expect(parsed.entries.map((entry) => entry.dataClass)).toEqual(PRIVACY_DATA_CLASSES)
    expect(parsed.approved).toBe(true)
  })

  test.each([
    ['missing data class', () => schedule({ entries: schedule().entries.slice(1) })],
    [
      'duplicate data class',
      () =>
        schedule({
          entries: schedule().entries.map((entry, index) =>
            index === 0 ? { ...entry, dataClass: 'attachments' } : entry,
          ),
        }),
    ],
    [
      'zero days',
      () =>
        schedule({
          entries: schedule().entries.map((entry, index) => (index === 0 ? { ...entry, retentionDays: 0 } : entry)),
        }),
    ],
    ['unapproved policy', () => schedule({ approved: false })],
    ['raw approval email', () => schedule({ legalApprovalReference: 'lawyer@example.com' })],
    ['unknown field', () => schedule({ notes: 'not part of the contract' })],
    ['effective before approval', () => schedule({ effectiveFrom: new Date('2026-07-31T00:00:00.000Z') })],
  ])('rejects %s', (_name, fixture) => {
    expect(() => parsePrivacyRetentionSchedule(fixture())).toThrow(PrivacyRequestContractError)
  })
})

describe('T99 legal-hold and eligibility subjects', () => {
  test('accepts the three exact legal-hold scopes', () => {
    expect(
      parsePrivacyLegalHoldScope({
        schemaVersion: PRIVACY_LEGAL_HOLD_SCOPE_SCHEMA_VERSION,
        scope: 'participant',
        participantId,
      }),
    ).toMatchObject({ scope: 'participant', participantId })
    expect(
      parsePrivacyLegalHoldScope({
        schemaVersion: PRIVACY_LEGAL_HOLD_SCOPE_SCHEMA_VERSION,
        scope: 'participant_data_class',
        participantId,
        dataClass: 'attachments',
      }),
    ).toMatchObject({ scope: 'participant_data_class', dataClass: 'attachments' })
    expect(
      parsePrivacyLegalHoldScope({
        schemaVersion: PRIVACY_LEGAL_HOLD_SCOPE_SCHEMA_VERSION,
        scope: 'record',
        participantId,
        dataClass: 'attachments',
        recordReference: 'attachment:pseudo:99',
      }),
    ).toMatchObject({ scope: 'record', recordReference: 'attachment:pseudo:99' })
  })

  test('rejects scope ambiguity and raw record identifiers', () => {
    expect(() =>
      parsePrivacyLegalHoldScope({
        schemaVersion: PRIVACY_LEGAL_HOLD_SCOPE_SCHEMA_VERSION,
        scope: 'participant',
        participantId,
        dataClass: 'attachments',
      }),
    ).toThrow(PrivacyRequestContractError)
    expect(() =>
      parsePrivacyLegalHoldScope({
        schemaVersion: PRIVACY_LEGAL_HOLD_SCOPE_SCHEMA_VERSION,
        scope: 'record',
        participantId,
        dataClass: 'attachments',
        recordReference: '010-1234-5678',
      }),
    ).toThrow(PrivacyRequestContractError)
  })

  test('requires a strict versioned pseudonymous eligibility subject', () => {
    const subject = {
      schemaVersion: PRIVACY_RETENTION_SUBJECT_SCHEMA_VERSION,
      participantId,
      dataClass: 'attachments',
      recordReference: 'attachment:pseudo:99',
      retentionAnchorAt: new Date('2026-08-01T00:00:00.000Z'),
    }
    expect(parsePrivacyRetentionSubject(subject)).toEqual(subject)
    expect(() => parsePrivacyRetentionSubject({ ...subject, recordReference: 'https://example.com/private' })).toThrow(
      PrivacyRequestContractError,
    )
  })
})
