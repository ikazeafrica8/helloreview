// Shared field types for the PRD §18 payloads.
//
// Defined once so that "what counts as a valid timestamp" has a single answer. Eleven payloads
// each spelling out their own date rule is eleven chances for one of them to be laxer than the
// rest, and the lax one is the one an attacker or a buggy provider finds.

import { z } from 'zod'

/** A non-empty identifier. Bare z.string() accepts "", which is never a valid id. */
export const identifier = z.string().min(1)

/**
 * An ISO 8601 timestamp WITH an offset, which every PRD §18 example carries (`+09:00`).
 *
 * `z.iso.datetime({ offset: true })` rather than a bare string: an event whose time cannot be
 * placed on a timeline is useless for ordering, and ordering is what FR-MSG-007 turns on. The
 * offset must be permitted rather than required-UTC because the platform's operating timezone is
 * Asia/Seoul and providers send local time.
 */
export const isoTimestamp = z.iso.datetime({ offset: true })

/**
 * A phone number already normalised to E.164 by the producer.
 *
 * The contract validates the SHAPE only. Normalisation itself is T28's job and is deliberately not
 * duplicated here — but accepting an un-normalised number at the edge would push the ambiguity
 * into identity matching, where PRD §16 forbids matching on a name alone precisely because
 * identifier quality is what makes a match safe.
 */
export const e164Phone = z.string().regex(/^\+[1-9]\d{7,14}$/, {
  message: 'must be E.164, for example +821012345678',
})

/** A URL a participant supplied. Constrained to http(s) so a `javascript:` value cannot be stored. */
export const webUrl = z.url({ protocol: /^https?$/ })

/** A positive version counter. Versions start at 1; 0 and negatives indicate a producer bug. */
export const version = z.number().int().positive()

/** SCREAMING_SNAKE machine-readable code (SPEC.md §6 Naming). */
export const reasonCode = z.string().regex(/^[A-Z][A-Z0-9_]*$/, {
  message: 'must be SCREAMING_SNAKE',
})
