import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { matchApplicant, type ApplicantMatchResult } from './matching-table.js'
import { IDENTITY_RESOLUTION_REASON, type IdentityResolutionReasonCode } from './reason-codes.js'

const TOKEN_DOMAIN = 'helloreview-application-verification-token-v1\0'
const DIGEST_SHAPE = /^[0-9a-f]{64}$/
const DUMMY_DIGEST = '0'.repeat(64)

export type VerificationTokenRecord = Readonly<{
  id: string
  applicationId: string
  tokenDigest: string
  expiresAt: Date
  consumedAt: Date | null
}>

export class VerificationTokenError extends Error {
  override readonly name = 'VerificationTokenError'

  constructor(readonly reasonCode: IdentityResolutionReasonCode) {
    // The raw bearer token is intentionally absent from every error surface.
    super(`Application verification token rejected: ${reasonCode}`)
  }
}

const validKey = (key: string): void => {
  if (key.length < 16) {
    throw new VerificationTokenError(IDENTITY_RESOLUTION_REASON.TOKEN_CONFIGURATION_INVALID)
  }
}

/** Stable keyed lookup digest. A database leak does not reveal reusable bearer tokens. */
export const verificationTokenDigest = (rawToken: string, key: string): string => {
  validKey(key)
  return createHmac('sha256', key).update(TOKEN_DOMAIN).update(rawToken).digest('hex')
}

/** Fixed-length comparison backed by node:crypto's constant-time primitive. */
export const constantTimeTokenDigestMatch = (candidateDigest: string, storedDigest: string): boolean => {
  const candidate = DIGEST_SHAPE.test(candidateDigest) ? Buffer.from(candidateDigest, 'hex') : Buffer.alloc(32)
  const stored = DIGEST_SHAPE.test(storedDigest) ? Buffer.from(storedDigest, 'hex') : Buffer.alloc(32, 1)
  return timingSafeEqual(candidate, stored)
}

/** Fail-closed token decision. Unknown, expired and reused tokens never enter the weaker match table. */
export const matchVerificationToken = (
  rawToken: string,
  key: string,
  record: VerificationTokenRecord | undefined,
  decidedAt: Date,
): ApplicantMatchResult => {
  const candidateDigest = verificationTokenDigest(rawToken, key)
  const storedDigest = record?.tokenDigest ?? DUMMY_DIGEST
  // Always execute the fixed-length comparison, including for an unknown lookup.
  const digestMatches = constantTimeTokenDigestMatch(candidateDigest, storedDigest)
  if (record === undefined || !digestMatches) {
    throw new VerificationTokenError(IDENTITY_RESOLUTION_REASON.TOKEN_UNKNOWN)
  }
  if (Number.isNaN(record.expiresAt.getTime()) || Number.isNaN(decidedAt.getTime())) {
    throw new VerificationTokenError(IDENTITY_RESOLUTION_REASON.TOKEN_CONFIGURATION_INVALID)
  }
  if (record.consumedAt !== null) {
    throw new VerificationTokenError(IDENTITY_RESOLUTION_REASON.TOKEN_REUSED)
  }
  if (record.expiresAt.getTime() <= decidedAt.getTime()) {
    throw new VerificationTokenError(IDENTITY_RESOLUTION_REASON.TOKEN_EXPIRED)
  }
  return matchApplicant({ kind: 'verification_token', applicationId: record.applicationId }, decidedAt)
}

const dateColumn = (row: Record<string, unknown>, column: string): Date => {
  const value = row[column]
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  throw new Error(`verification token query returned an invalid ${column}`)
}

const nullableDateColumn = (row: Record<string, unknown>, column: string): Date | null => {
  if (row[column] === null) return null
  return dateColumn(row, column)
}

const stringColumn = (row: Record<string, unknown>, column: string): string => {
  const value = row[column]
  if (typeof value === 'string') return value
  throw new Error(`verification token query returned an invalid ${column}`)
}

const tokenRecord = (row: Record<string, unknown>): VerificationTokenRecord => ({
  id: stringColumn(row, 'id'),
  applicationId: stringColumn(row, 'application_id'),
  tokenDigest: stringColumn(row, 'token_digest'),
  expiresAt: dateColumn(row, 'expires_at'),
  consumedAt: nullableDateColumn(row, 'consumed_at'),
})

export class ApplicationVerificationTokenService {
  constructor(
    private readonly pool: Pool,
    private readonly tokenKey: string,
  ) {
    validKey(tokenKey)
  }

  async registerWebsiteToken(
    input: Readonly<{
      applicationId: string
      rawToken: string
      issuedAt: Date
      expiresAt: Date
    }>,
  ): Promise<string> {
    if (
      Number.isNaN(input.issuedAt.getTime()) ||
      Number.isNaN(input.expiresAt.getTime()) ||
      input.expiresAt.getTime() <= input.issuedAt.getTime()
    ) {
      throw new VerificationTokenError(IDENTITY_RESOLUTION_REASON.TOKEN_CONFIGURATION_INVALID)
    }
    const result = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO application_verification_tokens (application_id, token_digest, issued_at, expires_at)
       VALUES ($1,$2,$3,$4)
       RETURNING id`,
      [input.applicationId, verificationTokenDigest(input.rawToken, this.tokenKey), input.issuedAt, input.expiresAt],
    )
    const row = result.rows[0]
    if (row === undefined) throw new Error('verification token insert returned no row')
    return stringColumn(row, 'id')
  }

  async consume(
    input: Readonly<{
      rawToken: string
      participantId: string
      consumedAt: Date
    }>,
  ): Promise<ApplicantMatchResult> {
    if (Number.isNaN(input.consumedAt.getTime())) {
      throw new VerificationTokenError(IDENTITY_RESOLUTION_REASON.TOKEN_CONFIGURATION_INVALID)
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const record = await this.lockByDigest(client, verificationTokenDigest(input.rawToken, this.tokenKey))
      const match = matchVerificationToken(input.rawToken, this.tokenKey, record, input.consumedAt)
      if (record === undefined) {
        // matchVerificationToken already rejects this branch; retain an explicit narrow for TypeScript.
        throw new VerificationTokenError(IDENTITY_RESOLUTION_REASON.TOKEN_UNKNOWN)
      }
      const consumed = await client.query(
        `UPDATE application_verification_tokens
            SET consumed_at = $2, consumed_by_participant_id = $3
          WHERE id = $1 AND consumed_at IS NULL`,
        [record.id, input.consumedAt, input.participantId],
      )
      if (consumed.rowCount !== 1) {
        throw new VerificationTokenError(IDENTITY_RESOLUTION_REASON.TOKEN_REUSED)
      }
      await client.query('COMMIT')
      return match
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  private async lockByDigest(client: PoolClient, digest: string): Promise<VerificationTokenRecord | undefined> {
    const result = await client.query<Record<string, unknown>>(
      `SELECT id, application_id, token_digest, expires_at, consumed_at
         FROM application_verification_tokens
        WHERE token_digest = $1
        FOR UPDATE`,
      [digest],
    )
    const row = result.rows[0]
    return row === undefined ? undefined : tokenRecord(row)
  }
}
