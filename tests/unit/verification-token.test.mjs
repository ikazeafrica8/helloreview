// Unit tier: strongest application-specific identity evidence (T30, FR-ID-003).

import { describe, expect, test } from 'vitest'
import {
  constantTimeTokenDigestMatch,
  matchVerificationToken,
  verificationTokenDigest,
  VerificationTokenError,
  IDENTITY_RESOLUTION_REASON,
} from '../../apps/api/dist/modules/identity-resolution/index.js'

const key = 'verification-test-key-at-least-16-characters'
const rawToken = 'website-issued-token-123456789'
const decidedAt = new Date('2026-08-24T09:00:00Z')

const record = (overrides = {}) => ({
  id: 'token-record-1',
  applicationId: 'application-1',
  tokenDigest: verificationTokenDigest(rawToken, key),
  expiresAt: new Date('2026-08-24T10:00:00Z'),
  consumedAt: null,
  ...overrides,
})

const reasonOf = (body) => {
  try {
    body()
  } catch (error) {
    if (error instanceof VerificationTokenError) return error.reasonCode
    throw error
  }
  throw new Error('expected VerificationTokenError')
}

describe('application verification token', () => {
  test('a valid token resolves only its intended application as Verified', () => {
    expect(matchVerificationToken(rawToken, key, record(), decidedAt)).toMatchObject({
      category: 'verified',
      candidateApplicationIds: ['application-1'],
      automaticLinkAllowed: true,
      nextAction: 'persist_link',
    })
  })

  test.each([
    ['unknown token', undefined, IDENTITY_RESOLUTION_REASON.TOKEN_UNKNOWN],
    [
      'digest mismatch',
      record({ tokenDigest: verificationTokenDigest('different-token', key) }),
      IDENTITY_RESOLUTION_REASON.TOKEN_UNKNOWN,
    ],
    [
      'expired token',
      record({ expiresAt: new Date('2026-08-24T09:00:00Z') }),
      IDENTITY_RESOLUTION_REASON.TOKEN_EXPIRED,
    ],
    ['reused token', record({ consumedAt: new Date('2026-08-24T08:59:00Z') }), IDENTITY_RESOLUTION_REASON.TOKEN_REUSED],
    [
      'invalid expiration timestamp',
      record({ expiresAt: new Date(Number.NaN) }),
      IDENTITY_RESOLUTION_REASON.TOKEN_CONFIGURATION_INVALID,
    ],
  ])('%s fails closed without trying a weaker evidence path', (_label, stored, reasonCode) => {
    expect(reasonOf(() => matchVerificationToken(rawToken, key, stored, decidedAt))).toBe(reasonCode)
  })

  test('an invalid decision timestamp fails closed', () => {
    expect(reasonOf(() => matchVerificationToken(rawToken, key, record(), new Date(Number.NaN)))).toBe(
      IDENTITY_RESOLUTION_REASON.TOKEN_CONFIGURATION_INVALID,
    )
  })

  test('lookup digests are deterministic, keyed and compared with the fixed-length primitive', () => {
    const digest = verificationTokenDigest(rawToken, key)
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(verificationTokenDigest(rawToken, key)).toBe(digest)
    expect(verificationTokenDigest(rawToken, 'a-different-key-at-least-16-characters')).not.toBe(digest)
    expect(constantTimeTokenDigestMatch(digest, digest)).toBe(true)
    expect(constantTimeTokenDigestMatch(digest, 'f'.repeat(64))).toBe(false)
    expect(constantTimeTokenDigestMatch('invalid', digest)).toBe(false)
    expect(constantTimeTokenDigestMatch(digest, 'invalid')).toBe(false)
  })

  test('a short digest key fails before token evidence can be accepted', () => {
    expect(reasonOf(() => verificationTokenDigest(rawToken, 'short'))).toBe(
      IDENTITY_RESOLUTION_REASON.TOKEN_CONFIGURATION_INVALID,
    )
  })
})
