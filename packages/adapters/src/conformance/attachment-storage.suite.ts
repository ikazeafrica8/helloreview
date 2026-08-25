import { createHash } from 'node:crypto'
import type { AttachmentStorage } from '../ports/attachment-storage.js'

export type AttachmentStorageConformanceCheck = Readonly<{ name: string; run: () => Promise<void> }>

const expectTrue = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message)
}

export const attachmentStorageConformanceChecks = (
  createStorage: () => AttachmentStorage,
): readonly AttachmentStorageConformanceCheck[] => {
  const bytes = Buffer.from('synthetic-attachment-conformance', 'utf8')
  const contentHash = createHash('sha256').update(bytes).digest('hex')
  const now = new Date('2026-08-25T00:00:00Z')
  const expiresAt = new Date('2026-08-25T00:05:00Z')
  return [
    {
      name: 'round-trips encrypted bytes behind an opaque reference',
      run: async () => {
        const storage = createStorage()
        const stored = await storage.putEncrypted({ bytes, contentHash })
        expectTrue(!stored.storageReference.startsWith('http'), 'stored reference must not be a public URL')
        const restored = await storage.getDecrypted({ ...stored, contentHash })
        expectTrue(Buffer.from(restored).equals(bytes), 'decrypted bytes did not round-trip')
      },
    },
    {
      name: 'deduplicates repeated puts by plaintext content hash',
      run: async () => {
        const storage = createStorage()
        const first = await storage.putEncrypted({ bytes, contentHash })
        const second = await storage.putEncrypted({ bytes, contentHash })
        expectTrue(!first.deduplicated, 'first put cannot be reported as a duplicate')
        expectTrue(second.deduplicated, 'repeat put was not deduplicated')
        expectTrue(first.storageReference === second.storageReference, 'repeat put changed the opaque reference')
      },
    },
    {
      name: 'expires signed reads and rejects use after deletion',
      run: async () => {
        const storage = createStorage()
        const stored = await storage.putEncrypted({ bytes, contentHash })
        const signed = await storage.signRead({ ...stored, contentHash, now, expiresAt })
        const restored = await storage.readSigned({ signedReference: signed.signedReference, contentHash, now })
        expectTrue(Buffer.from(restored).equals(bytes), 'signed read did not return the original bytes')
        let expired = false
        try {
          await storage.readSigned({ signedReference: signed.signedReference, contentHash, now: expiresAt })
        } catch {
          expired = true
        }
        expectTrue(expired, 'signed read remained usable at expiry')
        await storage.deleteEncrypted({ ...stored, contentHash })
        let missing = false
        try {
          await storage.getDecrypted({ ...stored, contentHash })
        } catch {
          missing = true
        }
        expectTrue(missing, 'deleted object remained readable')
      },
    },
  ]
}
