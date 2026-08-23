import { createHash } from 'node:crypto'

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
export const maskAddress = (raw: string): string => {
  if (isBlank(raw)) return EMPTY
  const tokens = raw.trim().split(/\s+/)
  const [region] = tokens
  if (tokens.length < 2 || region === undefined) return FULLY_MASKED
  return `${region} ***`
}

/**
 * An opaque identifier — a Kakao user id, a provider conversation id — reduced to a stable tag.
 *
 * SPEC.md §21.1 treats these as persistent identifiers, so the raw value never reaches a log. A
 * truncating mask would still leak a recognizable prefix, so this hashes instead: unlinkable to the
 * original, stable across processes, and short enough to read.
 */
export const maskIdentifier = (raw: string): string => {
  if (isBlank(raw)) return EMPTY
  return `id_${createHash('sha256').update(raw).digest('hex').slice(0, 10)}`
}

/**
 * The generic fallback, for a value whose kind is not known.
 *
 * Prefer a specific masker: this one has to assume the worst and therefore keeps nothing useful.
 */
export const mask = (raw: string): string => (isBlank(raw) ? EMPTY : FULLY_MASKED)
