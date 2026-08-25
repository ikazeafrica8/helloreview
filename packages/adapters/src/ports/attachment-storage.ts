export const ATTACHMENT_STORAGE = Symbol('ATTACHMENT_STORAGE')

export const ATTACHMENT_STORAGE_FAILURE = {
  INVALID_CONTENT_HASH: 'INVALID_CONTENT_HASH',
  CONTENT_HASH_MISMATCH: 'CONTENT_HASH_MISMATCH',
  OBJECT_NOT_FOUND: 'OBJECT_NOT_FOUND',
  SIGNED_READ_INVALID: 'SIGNED_READ_INVALID',
  SIGNED_READ_EXPIRED: 'SIGNED_READ_EXPIRED',
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
} as const

export type AttachmentStorageFailureCode = (typeof ATTACHMENT_STORAGE_FAILURE)[keyof typeof ATTACHMENT_STORAGE_FAILURE]

export class AttachmentStorageError extends Error {
  override readonly name = 'AttachmentStorageError'

  constructor(readonly reasonCode: AttachmentStorageFailureCode) {
    super(`attachment storage operation failed: ${reasonCode}`)
  }
}

export type PutEncryptedAttachmentRequest = Readonly<{
  /** SHA-256 of the plaintext bytes. It is also the idempotency key. */
  contentHash: string
  bytes: Uint8Array
}>

export type StoredAttachment = Readonly<{
  /** Opaque to core modules and safe to persist. Never a credential or signed URL. */
  storageReference: string
  deduplicated: boolean
}>

export type AttachmentObjectRequest = Readonly<{
  storageReference: string
  /** Bound into authenticated encryption so reference substitution fails closed. */
  contentHash: string
}>

export type SignedAttachmentRead = Readonly<{
  signedReference: string
  expiresAt: Date
}>

export type SignAttachmentReadRequest = AttachmentObjectRequest &
  Readonly<{
    now: Date
    expiresAt: Date
  }>

export type ReadSignedAttachmentRequest = Readonly<{
  signedReference: string
  contentHash: string
  now: Date
}>

/** Provider-neutral encrypted object operations used by the attachments module. */
export type AttachmentStorage = Readonly<{
  provider: string
  putEncrypted: (request: PutEncryptedAttachmentRequest) => Promise<StoredAttachment>
  getDecrypted: (request: AttachmentObjectRequest) => Promise<Uint8Array>
  deleteEncrypted: (request: AttachmentObjectRequest) => Promise<Readonly<{ deleted: boolean }>>
  signRead: (request: SignAttachmentReadRequest) => Promise<SignedAttachmentRead>
  readSigned: (request: ReadSignedAttachmentRequest) => Promise<Uint8Array>
}>
