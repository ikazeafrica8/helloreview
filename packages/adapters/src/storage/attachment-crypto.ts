import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { ATTACHMENT_STORAGE_FAILURE, AttachmentStorageError } from '../ports/attachment-storage.js'

const FORMAT_VERSION = 1
const NONCE_BYTES = 12
const TAG_BYTES = 16
const MINIMUM_ENVELOPE_BYTES = 1 + NONCE_BYTES + TAG_BYTES
const SHA256_HEX = /^[a-f0-9]{64}$/

export const validateContentHash = (contentHash: string): void => {
  if (!SHA256_HEX.test(contentHash)) {
    throw new AttachmentStorageError(ATTACHMENT_STORAGE_FAILURE.INVALID_CONTENT_HASH)
  }
}

export const verifyPlaintextHash = (contentHash: string, bytes: Uint8Array): void => {
  validateContentHash(contentHash)
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== contentHash) {
    throw new AttachmentStorageError(ATTACHMENT_STORAGE_FAILURE.CONTENT_HASH_MISMATCH)
  }
}

export const normalizeEncryptionKey = (key: Uint8Array): Buffer => {
  if (key.byteLength !== 32) {
    throw new Error('attachment encryption key must contain exactly 32 bytes')
  }
  return Buffer.from(key)
}

/** AES-256-GCM envelope: version || nonce || auth tag || ciphertext. */
export const encryptAttachment = (key: Buffer, contentHash: string, bytes: Uint8Array): Buffer => {
  verifyPlaintextHash(contentHash, bytes)
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(contentHash, 'ascii'))
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()])
  return Buffer.concat([Buffer.from([FORMAT_VERSION]), nonce, cipher.getAuthTag(), ciphertext])
}

export const decryptAttachment = (key: Buffer, contentHash: string, envelope: Uint8Array): Uint8Array => {
  validateContentHash(contentHash)
  const stored = Buffer.from(envelope)
  if (stored.byteLength < MINIMUM_ENVELOPE_BYTES || stored[0] !== FORMAT_VERSION) {
    throw new AttachmentStorageError(ATTACHMENT_STORAGE_FAILURE.STORAGE_UNAVAILABLE)
  }
  const nonce = stored.subarray(1, 1 + NONCE_BYTES)
  const tag = stored.subarray(1 + NONCE_BYTES, MINIMUM_ENVELOPE_BYTES)
  const ciphertext = stored.subarray(MINIMUM_ENVELOPE_BYTES)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(Buffer.from(contentHash, 'ascii'))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    throw new AttachmentStorageError(ATTACHMENT_STORAGE_FAILURE.STORAGE_UNAVAILABLE)
  }
}
