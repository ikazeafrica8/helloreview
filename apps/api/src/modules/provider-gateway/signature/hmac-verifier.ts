import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  SIGNATURE_REJECTIONS,
  accepted,
  headerValue,
  rejected,
  type SignatureVerification,
  type SignatureVerifier,
  type SignedRequest,
} from './verifier.js'

// HMAC-SHA256 webhook signature verification (PRD §18.3, T16).
//
// The scheme: the provider computes `HMAC(secret, "<timestamp>.<raw body>")` and sends the hex
// digest alongside the timestamp. It is the shape most providers converge on, and this is the
// reference adapter — the port beside it is what makes a different scheme a new file rather than
// an edit here.
//
// THE TIMESTAMP IS INSIDE THE SIGNED PAYLOAD, and that is the whole design. Signing the body alone
// produces a signature that never expires: capture one legitimate request and it can be replayed
// forever, because nothing in the signed material changes. Binding the timestamp in means a replay
// must either reuse the original timestamp — and fall outside the window — or use a fresh one,
// which invalidates the signature. Neither works. A test covers each half, because a verifier that
// checks a timestamp it did not sign is a verifier whose timestamp is decorative.

export type HmacVerifierOptions = Readonly<{
  provider: string
  /** The shared secret. Never stored where it can be enumerated — see below. */
  secret: string
  /** How old a request may be. Per provider, because providers differ in how long they retry. */
  replayWindowSeconds: number
  signatureHeader?: string
  timestampHeader?: string
  /**
   * How far into the future a timestamp may be, for clock skew between us and the provider.
   *
   * Small and bounded rather than absent. Unbounded forward tolerance means a far-future timestamp
   * stays valid for as long as it takes the clock to reach it.
   */
  clockSkewToleranceSeconds?: number
}>

const DEFAULT_SIGNATURE_HEADER = 'x-helloreview-signature'
const DEFAULT_TIMESTAMP_HEADER = 'x-helloreview-timestamp'
const DEFAULT_CLOCK_SKEW_TOLERANCE_SECONDS = 60

/** Whole seconds since the epoch, or undefined. Rejects '', '12.5', '-1', '1e3' and 'yesterday'. */
const parseEpochSeconds = (value: string): number | undefined => {
  if (!/^\d+$/.test(value)) return undefined
  const seconds = Number(value)
  return Number.isSafeInteger(seconds) ? seconds : undefined
}

/**
 * Compare two hex digests without leaking, through timing, how much of one was correct.
 *
 * `expected === actual` on a digest returns as soon as two bytes differ, so the time it takes
 * reveals the length of the matching prefix. That turns forging a signature from 2^256 work into a
 * few thousand requests, one byte at a time. `timingSafeEqual` always reads both buffers fully.
 *
 * The length check before it is required, not optional: `timingSafeEqual` THROWS on buffers of
 * unequal length, which would turn a malformed signature into a 500 — and a 500 is a different,
 * and therefore informative, response than a 401. The length of a digest is not a secret, so
 * comparing it early leaks nothing.
 */
const digestsMatch = (expected: Buffer, candidateHex: string): boolean => {
  if (!/^[0-9a-f]+$/i.test(candidateHex)) return false
  const candidate = Buffer.from(candidateHex, 'hex')
  if (candidate.length !== expected.length) return false
  return timingSafeEqual(candidate, expected)
}

/**
 * Build a verifier for one provider.
 *
 * The secret is captured in this closure and never becomes a property of the returned object.
 * `JSON.stringify(verifier)` and `Object.values(verifier)` therefore cannot disclose it, which
 * matters because the verifier will live on a module that something eventually logs.
 */
export const createHmacSignatureVerifier = (options: HmacVerifierOptions): SignatureVerifier => {
  const signatureHeader = options.signatureHeader ?? DEFAULT_SIGNATURE_HEADER
  const timestampHeader = options.timestampHeader ?? DEFAULT_TIMESTAMP_HEADER
  const skewTolerance = options.clockSkewToleranceSeconds ?? DEFAULT_CLOCK_SKEW_TOLERANCE_SECONDS
  const { secret, replayWindowSeconds } = options

  const verify = (request: SignedRequest): SignatureVerification => {
    const signature = headerValue(request.headers, signatureHeader)
    if (signature === undefined || signature === '') return rejected(SIGNATURE_REJECTIONS.MISSING_SIGNATURE)

    const rawTimestamp = headerValue(request.headers, timestampHeader)
    if (rawTimestamp === undefined || rawTimestamp === '') return rejected(SIGNATURE_REJECTIONS.MISSING_TIMESTAMP)

    const timestamp = parseEpochSeconds(rawTimestamp)
    if (timestamp === undefined) return rejected(SIGNATURE_REJECTIONS.MALFORMED_TIMESTAMP)

    // The window is checked BEFORE the HMAC, deliberately: it is the cheap test, and it means a
    // flood of stale replays cannot be used to make this service do unbounded HMAC work.
    const receivedSeconds = Math.floor(request.receivedAt.getTime() / 1000)
    const age = receivedSeconds - timestamp
    if (age > replayWindowSeconds || age < -skewTolerance) {
      return rejected(SIGNATURE_REJECTIONS.REPLAY_WINDOW_EXCEEDED)
    }

    // Signed over the RAW bytes. Concatenating the timestamp is what binds the two together, so
    // neither can be swapped independently.
    const expected = createHmac('sha256', secret).update(`${rawTimestamp}.`).update(request.rawBody).digest()

    return digestsMatch(expected, signature) ? accepted : rejected(SIGNATURE_REJECTIONS.SIGNATURE_MISMATCH)
  }

  // `provider` is the only enumerable property. The secret lives in the closure above.
  return Object.freeze({ provider: options.provider, verify })
}
