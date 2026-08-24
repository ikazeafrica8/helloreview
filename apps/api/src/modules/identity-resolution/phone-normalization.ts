// Pure Korean mobile normalization for identity evidence (FR-ID-004, T28).
//
// The normalized value is deliberately narrow: only modern 010 Korean mobile numbers become
// identity evidence. Landlines, legacy mobile prefixes, foreign numbers, extensions and malformed
// values reject instead of being guessed into a plausible-looking participant match.

export const PHONE_NORMALIZATION_FAILURES = {
  EMPTY: 'PHONE_NORMALIZATION_EMPTY',
  UNSUPPORTED_FORMAT: 'PHONE_NORMALIZATION_UNSUPPORTED_FORMAT',
} as const

export type PhoneNormalizationFailure = (typeof PHONE_NORMALIZATION_FAILURES)[keyof typeof PHONE_NORMALIZATION_FAILURES]

export class PhoneNormalizationError extends Error {
  override readonly name = 'PhoneNormalizationError'

  constructor(readonly reasonCode: PhoneNormalizationFailure) {
    // Never include the raw phone number: this error can safely cross logging and API boundaries.
    super(`Phone normalization rejected: ${reasonCode}`)
  }
}

const ALLOWED_INPUT = /^[+0-9\s().-]+$/
const SEPARATORS = /[\s().-]/g
const LOCAL_MOBILE = /^010\d{8}$/
const INTERNATIONAL_MOBILE = /^(?:\+82|82|0082)10\d{8}$/
const INTERNATIONAL_WITH_TRUNK = /^(?:\+82|82|0082)010\d{8}$/

/** Normalize a Korean 010 mobile number to E.164 `+8210xxxxxxxx`. */
export const normalizeKoreanMobilePhone = (raw: string): string => {
  const prepared = raw.normalize('NFKC').trim()
  if (prepared === '') throw new PhoneNormalizationError(PHONE_NORMALIZATION_FAILURES.EMPTY)
  if (!ALLOWED_INPUT.test(prepared)) {
    throw new PhoneNormalizationError(PHONE_NORMALIZATION_FAILURES.UNSUPPORTED_FORMAT)
  }

  const compact = prepared.replace(SEPARATORS, '')
  if (LOCAL_MOBILE.test(compact)) return `+82${compact.slice(1)}`
  if (INTERNATIONAL_MOBILE.test(compact)) {
    const digits = compact.startsWith('+') ? compact.slice(1) : compact.startsWith('0082') ? compact.slice(2) : compact
    return `+${digits}`
  }
  if (INTERNATIONAL_WITH_TRUNK.test(compact)) {
    const digits = compact.startsWith('+') ? compact.slice(1) : compact.startsWith('0082') ? compact.slice(2) : compact
    return `+82${digits.slice(3)}`
  }

  throw new PhoneNormalizationError(PHONE_NORMALIZATION_FAILURES.UNSUPPORTED_FORMAT)
}
