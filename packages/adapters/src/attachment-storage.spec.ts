import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { attachmentStorageConformanceChecks } from './conformance/attachment-storage.suite.js'
import { createFakeAttachmentStorage } from './fakes/attachment-storage-fake.js'
import { createFakeMalwareScanner } from './fakes/malware-scanner-fake.js'
import { createUnavailableMalwareScanner } from './ports/malware-scanner.js'

const encryptionKey = Buffer.alloc(32, 7)

describe('encrypted attachment storage conformance', () => {
  for (const check of attachmentStorageConformanceChecks(() => createFakeAttachmentStorage(encryptionKey))) {
    test(check.name, check.run)
  }

  test('stores no plaintext and rejects a substituted content hash', async () => {
    const storage = createFakeAttachmentStorage(encryptionKey)
    const bytes = Buffer.from('synthetic-private-screenshot', 'utf8')
    const contentHash = createHash('sha256').update(bytes).digest('hex')
    const otherHash = createHash('sha256').update('other').digest('hex')
    const stored = await storage.putEncrypted({ bytes, contentHash })

    const encrypted = storage.inspectEncryptedBytes(contentHash)
    expect(encrypted).toBeDefined()
    expect(Buffer.from(encrypted ?? []).includes(bytes)).toBe(false)
    await expect(
      storage.getDecrypted({ storageReference: stored.storageReference, contentHash: otherHash }),
    ).rejects.toMatchObject({ reasonCode: 'OBJECT_NOT_FOUND' })
  })

  test('rejects tampered signed references', async () => {
    const storage = createFakeAttachmentStorage(encryptionKey)
    const bytes = Buffer.from('synthetic-signed-read', 'utf8')
    const contentHash = createHash('sha256').update(bytes).digest('hex')
    const stored = await storage.putEncrypted({ bytes, contentHash })
    const now = new Date('2026-08-25T00:00:00Z')
    const signed = await storage.signRead({
      ...stored,
      contentHash,
      now,
      expiresAt: new Date(now.getTime() + 60_000),
    })

    await expect(
      storage.readSigned({ signedReference: `${signed.signedReference}x`, contentHash, now }),
    ).rejects.toMatchObject({ reasonCode: 'SIGNED_READ_INVALID' })
  })
})

describe('malware scanner boundary', () => {
  const request = {
    contentHash: createHash('sha256').update('safe').digest('hex'),
    detectedType: 'image/png',
    bytes: Buffer.from('safe'),
  }

  test('the configurable fake records requests and follows its plan', async () => {
    const scanner = createFakeMalwareScanner([{ status: 'infected', threatCode: 'EICAR_TEST' }])
    await expect(scanner.scan(request)).resolves.toEqual({ status: 'infected', threatCode: 'EICAR_TEST' })
    expect(scanner.requests).toHaveLength(1)
  })

  test('the unconfigured production boundary fails closed', async () => {
    await expect(createUnavailableMalwareScanner().scan(request)).resolves.toEqual({
      status: 'error',
      failureCode: 'MALWARE_SCANNER_UNAVAILABLE',
    })
  })
})
