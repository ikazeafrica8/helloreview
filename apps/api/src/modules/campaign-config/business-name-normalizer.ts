// Comparing a business name written by a participant against the one we approved (T23, FR-CAM-004).
//
// WHAT THIS IS FOR. §16.7's Business check reads "Exact normalized name or approved alias and
// branch". The participant does not type the name; it is read off a booking screenshot by OCR, or
// typed from memory. Two strings that a human reads as the same business differ in ways a byte
// comparison cannot forgive, and a false rejection here sends a correction message to somebody who
// booked correctly.
//
// PURE, by filename. `*-normalizer.ts` is in eslint.config.js's PURE set: no clock, no I/O, no
// randomness. That is what makes 100% branch coverage reachable, and it is what lets a stored
// normalized form be trusted — a normalizer that could vary by environment would produce a database
// full of values that no longer match what it produces today.
//
// THE ORDER OF OPERATIONS MATTERS and is not arbitrary. Unicode normalization comes FIRST, because
// every later step assumes it can compare characters: '강남' typed on one keyboard and '강남'
// pasted from another are different byte sequences until NFKC composes them, and every subsequent
// rule would silently operate on the wrong one.

/**
 * Characters that carry no identity for a business name.
 *
 * Brackets and their full-width and Korean variants appear inconsistently — "스타벅스(강남점)",
 * "스타벅스 [강남점]" — and none of them distinguish one business from another. Middle dots and
 * the various dashes are the same story.
 */
const INSIGNIFICANT = /[()[\]{}（）［］｛｝【】〔〕「」『』・·，,.\-–—_/\\|'"`]/g

/**
 * Every kind of space, including the ones Korean input methods produce.
 *
 * `\s` alone is enough, and the explicit character class this replaced was not merely redundant
 * but harmful: ECMAScript's WhiteSpace already covers the whole Unicode Zs category — U+3000
 * IDEOGRAPHIC SPACE and U+00A0 NO-BREAK SPACE included — plus U+FEFF. Writing those characters
 * literally put invisible bytes in the source, which `no-irregular-whitespace` correctly rejects:
 * a reviewer cannot see them, and a stray one silently changes the pattern.
 */
const ANY_WHITESPACE = /\s+/g

/**
 * The normalized form of a business name, for equality comparison only.
 *
 * NEVER SHOW THIS TO ANYONE. It is lossy by design — spacing and punctuation are destroyed — so a
 * message built from it would read as gibberish to a participant. Display always uses the stored
 * original.
 *
 * NFKC rather than NFC. NFC alone composes Hangul, which is the essential part; NFKC additionally
 * folds full-width Latin ("ＳＴＡＲ" → "STAR") and the compatibility forms Korean input methods
 * emit, including ㈜ → (주). Those are the same business written differently, and treating them as
 * different is precisely the false rejection this exists to prevent.
 *
 * WHITESPACE IS REMOVED, not collapsed. Korean does not space consistently — "스타벅스 강남점" and
 * "스타벅스강남점" are the same name — so collapsing runs to a single space would still leave the
 * two unequal. This is the one rule that could create a FALSE match, and it is accepted knowingly:
 * §16.7 pairs the business check with a separate branch check, so a name collision alone cannot
 * validate a booking.
 */
export const normalizeBusinessName = (raw: string): string =>
  raw.normalize('NFKC').toLowerCase().replace(INSIGNIFICANT, '').replace(ANY_WHITESPACE, '')

/**
 * Does `candidate` match the approved name or any approved alias?
 *
 * Aliases are a first-class list rather than a delimited string: a business is genuinely known by
 * several names — its legal name, its sign, its Naver listing — and splitting a string on a
 * separator breaks the first time one of those names contains the separator.
 */
export const matchesApprovedName = (
  candidate: string,
  approvedName: string,
  aliases: readonly string[] = [],
): boolean => {
  const normalized = normalizeBusinessName(candidate)
  // An empty candidate must never match, including against an empty approved name — otherwise a
  // screenshot OCR that read nothing would validate as the right business.
  if (normalized === '') return false

  return [approvedName, ...aliases].some((approved) => normalizeBusinessName(approved) === normalized)
}

/**
 * Does the branch match?
 *
 * SEPARATE from the name check, which is T23's third acceptance criterion and the reason it exists:
 * a booking at the right business but the wrong branch is a different failure from a booking at the
 * wrong business, and §16.7's failure action ("Wrong-business correction") has to be able to say
 * which. Folding branch into the name would make the two indistinguishable.
 *
 * A campaign with no branch configured matches any branch — a single-location business should not
 * have to invent one.
 */
export const matchesBranch = (candidate: string | undefined, approvedBranch: string | null): boolean => {
  if (approvedBranch === null || normalizeBusinessName(approvedBranch) === '') return true
  if (candidate === undefined) return false
  return normalizeBusinessName(candidate) === normalizeBusinessName(approvedBranch)
}
