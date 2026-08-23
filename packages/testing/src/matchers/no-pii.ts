// Detect personal data in text that should not contain any (T12).
//
// SPEC.md §21.4 lists what a log line must never carry. Review cannot enforce that reliably — the
// leak is usually a field somebody added to an existing object months later — so this turns it into
// a build failure.
//
// TWO DESIGN RULES, both about being trusted rather than merely strict:
//
//   NO FALSE POSITIVES. A matcher that trips on a UUID or a correlation id gets disabled within a
//   week, and then it protects nothing. Every pattern below is anchored tightly enough to leave
//   ordinary identifiers alone, and the fixture tests assert exactly that.
//
//   NAME WHAT WAS FOUND. "PII detected" sends someone hunting. The finding carries the kind and the
//   matched excerpt, itself redacted, so the failure points at the line to fix.

export interface PiiFinding {
  kind: 'korean-phone' | 'international-phone' | 'resident-registration-number' | 'korean-address' | 'authorization'
  /** The offending text, itself partly masked — a failure message must not become the leak. */
  excerpt: string
}

interface Pattern {
  kind: PiiFinding['kind']
  regex: RegExp
}

const PATTERNS: readonly Pattern[] = [
  // Korean mobile: 010-1234-5678, 01012345678, 010 1234 5678. The 01[016789] prefix set is what
  // keeps this from matching an arbitrary 11-digit number such as a timestamp in milliseconds.
  { kind: 'korean-phone', regex: /\b01[016789][-\s]?\d{3,4}[-\s]?\d{4}\b/g },

  // +82 form, with the national trunk 0 either present or dropped.
  { kind: 'international-phone', regex: /\+82[-\s]?0?1[016789][-\s]?\d{3,4}[-\s]?\d{4}\b/g },

  // 주민등록번호. The century/sex digit is 1-4 for citizens, 5-8 for registered foreigners, which is
  // what separates this from an arbitrary 13-digit run.
  { kind: 'resident-registration-number', regex: /\b\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[-\s]?[1-8]\d{6}\b/g },

  // A Korean street address: an administrative unit followed by a road and a building number.
  // Requiring the number is what stops it matching a business name that merely ends in 로.
  { kind: 'korean-address', regex: /[가-힣]+(?:시|도)\s*[가-힣]+(?:구|군|시)\s*[가-힣0-9]+(?:로|길)\s*\d+/g },

  // An Authorization header value, however it was spelled.
  { kind: 'authorization', regex: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g },
]

/** Redact the middle of a match, so a failure message names the problem without repeating it. */
const excerpt = (match: string): string =>
  match.length <= 6 ? '*'.repeat(match.length) : `${match.slice(0, 3)}${'*'.repeat(match.length - 5)}${match.slice(-2)}`

/**
 * Every piece of personal data found in `text`.
 *
 * Pure and exported separately from the matcher so it can be unit-tested directly — a security
 * control whose own detection logic is only reachable through a test framework is one nobody
 * exercises properly.
 */
export const detectPii = (text: string): PiiFinding[] => {
  const findings: PiiFinding[] = []
  for (const { kind, regex } of PATTERNS) {
    // A fresh RegExp per call: a shared /g regex carries lastIndex between calls and would skip
    // matches on every second invocation.
    for (const match of text.matchAll(new RegExp(regex.source, regex.flags))) {
      findings.push({ kind, excerpt: excerpt(match[0]) })
    }
  }
  return findings
}

export const describeFindings = (findings: readonly PiiFinding[]): string =>
  findings.map((finding) => `  - ${finding.kind}: ${finding.excerpt}`).join('\n')
