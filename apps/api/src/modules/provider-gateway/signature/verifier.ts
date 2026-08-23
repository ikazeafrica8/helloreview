// The provider-neutral signature verification port (PRD §18.3, T16).
//
// Every provider signs differently — different header names, different signing payloads, some over
// the body alone, some over a timestamp and the body together — and PRD §18 is explicit that its
// contracts "are not claims about actual Kakao, Aligo, Naver, or website payloads". The scheme is
// unverified for all of them.
//
// So this is a PORT, and the HMAC implementation beside it is one adapter. When the Kakao dealer
// answers the §33.3 capability questions, a second adapter lands here and nothing upstream of it
// changes. A verifier hard-coded to one scheme would have to be unpicked from the controller.
//
// WHAT A VERIFIER MUST NOT DO. It must not parse the body — verification happens on the RAW bytes,
// because parsing and re-serialising changes them and invalidates the signature, and because a body
// that has not been authenticated has no business reaching a parser. It must not log. It must not
// put anything derived from the secret, the expected digest, or the body into its result.

/** Why a request was refused. SCREAMING_SNAKE (SPEC.md §6); safe to log and to count. */
export const SIGNATURE_REJECTIONS = {
  /** No signature header at all. */
  MISSING_SIGNATURE: 'MISSING_SIGNATURE',
  /** No timestamp header, so the replay window cannot be evaluated. */
  MISSING_TIMESTAMP: 'MISSING_TIMESTAMP',
  /** A timestamp that is not a whole number of seconds since the epoch. */
  MALFORMED_TIMESTAMP: 'MALFORMED_TIMESTAMP',
  /** Outside the configured window, in either direction. */
  REPLAY_WINDOW_EXCEEDED: 'REPLAY_WINDOW_EXCEEDED',
  /** Present, well-formed, and wrong. */
  SIGNATURE_MISMATCH: 'SIGNATURE_MISMATCH',
} as const

export type SignatureRejection = (typeof SIGNATURE_REJECTIONS)[keyof typeof SIGNATURE_REJECTIONS]

/**
 * The outcome of verification.
 *
 * A discriminated union rather than a boolean plus an out-parameter, so a caller cannot read the
 * reason without first having checked that there was one. The failure case carries ONLY a reason
 * code: the whole object is what a controller logs, so it is safe by construction rather than
 * safe if the caller remembers to pick fields out of it.
 */
export type SignatureVerification = Readonly<{ ok: true }> | Readonly<{ ok: false; reasonCode: SignatureRejection }>

/**
 * A request as it arrives, before anything has been parsed.
 *
 * `rawBody` is a Buffer, deliberately. The signature is over bytes; `JSON.parse` followed by
 * `JSON.stringify` reorders keys and normalises whitespace, and the resulting string will not
 * verify against a signature computed over the original.
 */
export type SignedRequest = Readonly<{
  rawBody: Buffer
  headers: Readonly<Record<string, string | undefined>>
  /** When the request arrived. Injected rather than read from the clock so the window is testable. */
  receivedAt: Date
}>

export type SignatureVerifier = Readonly<{
  /** Which provider this verifier speaks for. */
  provider: string
  verify: (request: SignedRequest) => SignatureVerification
}>

/**
 * Read a header case-insensitively.
 *
 * RFC 9110 makes field names case-insensitive. Node lowercases them on the way in, but a proxy, a
 * test harness or a future framework may not — and a verifier that accepts only one casing rejects
 * genuine traffic while looking, in the logs, exactly like an attack.
 */
export const headerValue = (
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined => {
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value
  }
  return undefined
}

export const rejected = (reasonCode: SignatureRejection): SignatureVerification => ({ ok: false, reasonCode })
export const accepted: SignatureVerification = { ok: true }
