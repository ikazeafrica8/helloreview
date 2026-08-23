import { createHmac } from 'node:crypto'

// Masking for personal data, per SPEC.md §21.4 and §6.
//
// TWO PROPERTIES MAKE A MASK USEFUL RATHER THAN JUST SAFE:
//
//   STABLE — the same input always yields the same output, so two log lines about one participant
//   can be tied together. A mask that varies is no better than dropping the field.
//
//   DISTINGUISHING — different participants yield different output, so a support engineer can tell
//   two cases apart without learning who either person is.
//
// Every function here fails CLOSED: an input that does not match the expected shape is masked
// entirely rather than passed through. A mask that silently returns its input on an unexpected
// format is worse than no mask at all, because the caller believes the value is safe.

const FULLY_MASKED = '[masked]'
const EMPTY = '[empty]'

const isBlank = (raw: string): boolean => raw.trim() === ''

/**
 * Korean mobile numbers in one canonical digit string, so every written form masks identically.
 *
 * `+82 10-1234-5678`, `010-1234-5678` and `01012345678` are the same number; a mask that treated
 * them differently would scatter one participant across three identities in a trace.
 */
const normalizeKoreanDigits = (raw: string): string => {
  const digits = raw.replace(/\D/g, '')
  // +82 country code replaces the national trunk prefix 0.
  return digits.startsWith('82') ? `0${digits.slice(2)}` : digits
}

/**
 * A phone number reduced to its shape plus two trailing digits.
 *
 * Two digits rather than the four Korean convention often shows: four plus a masked name is enough
 * to identify someone to anybody who already knows them, and a log aggregator is read by people who
 * do. Two is still enough to distinguish cases in practice.
 */
export const maskPhone = (raw: string): string => {
  if (isBlank(raw)) return EMPTY
  const digits = normalizeKoreanDigits(raw)
  // Too short to be a phone number at all — do not guess, just mask.
  if (digits.length < 7) return FULLY_MASKED

  const prefix = digits.slice(0, 3)
  const suffix = digits.slice(-2)
  const hidden = '*'.repeat(Math.max(digits.length - 5, 1))
  return `${prefix}${hidden}${suffix}`
}

/**
 * A name reduced to its first character.
 *
 * Matches the convention PRD §20.4's own dashboard wireframe uses — a participant appears there as
 * 홍** — so operators see the same shape in a log line as on screen.
 */
export const maskName = (raw: string): string => {
  if (isBlank(raw)) return EMPTY
  const trimmed = raw.trim()
  // A single character IS the whole name; keeping it would mask nothing.
  if (trimmed.length < 2) return FULLY_MASKED
  return `${trimmed.slice(0, 1)}${'*'.repeat(trimmed.length - 1)}`
}

/**
 * An address reduced to its broadest administrative unit.
 *
 * Enough to know which region a fulfilment problem is in; not enough to find the door. A one-token
 * address has no broad part to keep, so it is masked entirely.
 */
const ADMINISTRATIVE_UNIT = /[가-힣]+(?:특별시|광역시|특별자치시|특별자치도|시|도)$/

export const maskAddress = (raw: string): string => {
  if (isBlank(raw)) return EMPTY
  const tokens = raw.trim().split(/\s+/)

  // Keep a token only if it IS an administrative unit. Keeping tokens[0] unconditionally — which is
  // what this did before — leaked whatever happened to come first: Korean addresses are commonly
  // written leading with a postal code ("06236 서울특별시 …") or, in a delivery form, with the
  // building and unit. That is the door, not the region.
  const region = tokens.find((token) => ADMINISTRATIVE_UNIT.test(token))
  if (region === undefined) return FULLY_MASKED

  return `${region} ***`
}

/**
 * An opaque identifier — a Kakao user id, a provider conversation id — reduced to a stable tag.
 *
 * KEYED, not a plain digest. An unsalted hash of a LOW-ENTROPY value is reversible by anybody who
 * can guess the input space, and these inputs are exactly that: a phone number is ~10^8 candidates
 * and a provider id often follows a guessable scheme, so a plain SHA-256 can be brute-forced back
 * to the original in seconds on a laptop. SPEC.md §21.4 permits a pseudonymous identifier in a log
 * precisely because it is supposed to be unlinkable, and an unkeyed digest is not.
 *
 * The pepper is passed in rather than read here so this stays a pure function, and so a caller
 * cannot accidentally use it without one. It belongs in the secret set — see SECRET_KEYS in
 * packages/config — and unlinkability holds only for as long as it stays secret.
 *
 * Truncated to 16 hex characters (64 bits): long enough that collisions are not a practical concern
 * across the platform's identifier volume, short enough to read in a terminal.
 */
export const maskIdentifier = (raw: string, pepper: string): string => {
  if (isBlank(raw)) return EMPTY
  if (isBlank(pepper)) {
    // Fail loudly rather than silently degrading to an unkeyed — and therefore reversible — digest.
    throw new Error('maskIdentifier requires a pepper; an unkeyed digest of a low-entropy id is reversible')
  }
  return `id_${createHmac('sha256', pepper).update(raw).digest('hex').slice(0, 16)}`
}

/**
 * The generic fallback, for a value whose kind is not known.
 *
 * Prefer a specific masker: this one has to assume the worst and therefore keeps nothing useful.
 */
export const mask = (raw: string): string => (isBlank(raw) ? EMPTY : FULLY_MASKED)
