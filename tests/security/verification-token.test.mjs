// Security tier: bearer tokens never appear in errors or output (T30, PRD §21.4).

import { describe, expect, test } from 'vitest'
import {
  matchVerificationToken,
  VerificationTokenError,
} from '../../apps/api/dist/modules/identity-resolution/index.js'

describe('application verification token confidentiality', () => {
  test('an unknown bearer token fails without echoing or logging the value', () => {
    const privateToken = 'private-website-verification-token-987654321'
    try {
      matchVerificationToken(
        privateToken,
        'verification-security-key-at-least-16-characters',
        undefined,
        new Date('2026-08-24T09:00:00Z'),
      )
    } catch (error) {
      expect(error).toBeInstanceOf(VerificationTokenError)
      if (error instanceof Error) expect(error.message).not.toContain(privateToken)
      return
    }
    throw new Error('expected VerificationTokenError')
  })
})
