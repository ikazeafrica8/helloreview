import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { createS3CompatibleAttachmentStorage } from '../../packages/adapters/dist/index.js'

const readLocalEnvironment = () => {
  const values = new Map()
  for (const raw of readFileSync('.env', 'utf8').split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1))
  }
  const required = (name) => {
    const value = values.get(name)
    if (value === undefined || value === '') throw new Error(`${name} is required for the MinIO integration test`)
    return value
  }
  return {
    endpoint: required('S3_ENDPOINT'),
    bucket: required('S3_BUCKET'),
    accessKeyId: required('S3_ACCESS_KEY_ID'),
    secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
    // Existing developer .env files predate Phase 8; the committed local-only placeholder keeps
    // this test reproducible without mutating an ignored secrets file.
    encryptionKey: Buffer.from(
      values.get('ATTACHMENT_ENCRYPTION_KEY_BASE64') ?? 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      'base64',
    ),
  }
}

describe('S3-compatible encrypted attachment storage', () => {
  test('round-trips encrypted bytes, deduplicates, signs a short read, and deletes against local MinIO', async () => {
    const storage = createS3CompatibleAttachmentStorage(readLocalEnvironment())
    const bytes = Buffer.from(`synthetic-minio-${randomUUID()}`, 'utf8')
    const contentHash = createHash('sha256').update(bytes).digest('hex')
    const first = await storage.putEncrypted({ bytes, contentHash })
    const repeat = await storage.putEncrypted({ bytes, contentHash })
    expect(first).toMatchObject({ deduplicated: false })
    expect(repeat).toEqual({ ...first, deduplicated: true })
    await expect(storage.getDecrypted({ ...first, contentHash })).resolves.toEqual(bytes)

    const now = new Date()
    const signed = await storage.signRead({
      ...first,
      contentHash,
      now,
      expiresAt: new Date(now.getTime() + 60_000),
    })
    expect(signed.signedReference).toContain('X-Amz-Signature=')
    await expect(storage.readSigned({ signedReference: signed.signedReference, contentHash, now })).resolves.toEqual(
      bytes,
    )

    await expect(storage.deleteEncrypted({ ...first, contentHash })).resolves.toEqual({ deleted: true })
    await expect(storage.getDecrypted({ ...first, contentHash })).rejects.toMatchObject({
      reasonCode: 'OBJECT_NOT_FOUND',
    })
  })
})
