// Unit tier: Korean mobile normalization used by deterministic identity matching (T28, FR-ID-004).

import { describe, expect, test } from 'vitest'
import {
  normalizeKoreanMobilePhone,
  PhoneNormalizationError,
  PHONE_NORMALIZATION_FAILURES,
} from '../../apps/api/dist/modules/identity-resolution/index.js'

const CANONICAL = '+821012345678'

describe('normalizeKoreanMobilePhone accepted representations', () => {
  test.each([
    ['local hyphenated', '010-1234-5678'],
    ['local compact', '01012345678'],
    ['local spaces', '010 1234 5678'],
    ['local dots', '010.1234.5678'],
    ['local parentheses', '(010) 1234-5678'],
    ['international E.164', '+821012345678'],
    ['international spaced', '+82 10 1234 5678'],
    ['international hyphenated', '+82-10-1234-5678'],
    ['international without plus', '821012345678'],
    ['international dial prefix', '00821012345678'],
    ['international with optional trunk', '+82 (0)10-1234-5678'],
    ['international without plus and with trunk', '82 (0)10-1234-5678'],
    ['full-width input', '０１０－１２３４－５６７８'],
    ['surrounding whitespace', '  010-1234-5678  '],
  ])('%s normalizes to one canonical value', (_label, raw) => {
    expect(normalizeKoreanMobilePhone(raw)).toBe(CANONICAL)
  })

  test('normalization is idempotent and deterministic', () => {
    expect(normalizeKoreanMobilePhone(CANONICAL)).toBe(CANONICAL)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(normalizeKoreanMobilePhone('010-1234-5678')).toBe(CANONICAL)
    }
  })
})

describe('normalizeKoreanMobilePhone rejected representations', () => {
  test.each([
    ['empty', '', PHONE_NORMALIZATION_FAILURES.EMPTY],
    ['whitespace only', '   ', PHONE_NORMALIZATION_FAILURES.EMPTY],
    ['too short', '0101234567', PHONE_NORMALIZATION_FAILURES.UNSUPPORTED_FORMAT],
    ['too long', '010123456789', PHONE_NORMALIZATION_FAILURES.UNSUPPORTED_FORMAT],
    ['legacy mobile prefix', '011-1234-5678', PHONE_NORMALIZATION_FAILURES.UNSUPPORTED_FORMAT],
    ['landline', '02-1234-5678', PHONE_NORMALIZATION_FAILURES.UNSUPPORTED_FORMAT],
    ['foreign number', '+1 415 555 0100', PHONE_NORMALIZATION_FAILURES.UNSUPPORTED_FORMAT],
    ['wrong Korean mobile prefix', '+821112345678', PHONE_NORMALIZATION_FAILURES.UNSUPPORTED_FORMAT],
    ['letters', '010-ABCD-5678', PHONE_NORMALIZATION_FAILURES.UNSUPPORTED_FORMAT],
    ['extension', '010-1234-5678 ext 9', PHONE_NORMALIZATION_FAILURES.UNSUPPORTED_FORMAT],
    ['multiple plus signs', '++821012345678', PHONE_NORMALIZATION_FAILURES.UNSUPPORTED_FORMAT],
  ])('%s rejects with a stable reason', (_label, raw, reasonCode) => {
    expect(() => normalizeKoreanMobilePhone(raw)).toThrowError(PhoneNormalizationError)
    try {
      normalizeKoreanMobilePhone(raw)
    } catch (error) {
      expect(error).toMatchObject({ reasonCode })
      if (error instanceof Error && raw.trim() !== '') expect(error.message).not.toContain(raw.trim())
      return
    }
    throw new Error('expected PhoneNormalizationError')
  })
})
