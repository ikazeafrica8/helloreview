import { createHmac, timingSafeEqual } from 'node:crypto'
import type {
  AttachmentObjectRequest,
  AttachmentStorage,
  PutEncryptedAttachmentRequest,
  ReadSignedAttachmentRequest,
  SignAttachmentReadRequest,
  SignedAttachmentRead,
  StoredAttachment,
} from '../ports/attachment-storage.js'
import { ATTACHMENT_STORAGE_FAILURE, AttachmentStorageError } from '../ports/attachment-storage.js'
import {
  decryptAttachment,
  encryptAttachment,
  normalizeEncryptionKey,
  validateContentHash,
} from '../storage/attachment-crypto.js'

export type FakeAttachmentStorage = AttachmentStorage &
  Readonly<{
    storedObjectCount: () => number
    inspectEncryptedBytes: (contentHash: string) => Uint8Array | undefined
  }>

const encode = (value: string): string => Buffer.from(value, 'utf8').toString('base64url')
const decode = (value: string): string => Buffer.from(value, 'base64url').toString('utf8')

export const createFakeAttachmentStorage = (encryptionKey: Uint8Array): FakeAttachmentStorage => {
  const key = normalizeEncryptionKey(encryptionKey)
  const signingKey = createHmac('sha256', key).update('helloreview-attachment-signed-read').digest()
  const objects = new Map<string, Buffer>()

  const referenceFor = (contentHash: string): string => `fake-object:${contentHash}`
  const hashFromReference = (storageReference: string): string | undefined => {
    const prefix = 'fake-object:'
    return storageReference.startsWith(prefix) ? storageReference.slice(prefix.length) : undefined
  }

  const getEnvelope = (request: AttachmentObjectRequest): Buffer => {
    const referenceHash = hashFromReference(request.storageReference)
    if (referenceHash !== request.contentHash) {
      throw new AttachmentStorageError(ATTACHMENT_STORAGE_FAILURE.OBJECT_NOT_FOUND)
    }
    const envelope = objects.get(request.contentHash)
    if (envelope === undefined) throw new AttachmentStorageError(ATTACHMENT_STORAGE_FAILURE.OBJECT_NOT_FOUND)
    return envelope
  }

  const putEncrypted = (request: PutEncryptedAttachmentRequest): Promise<StoredAttachment> =>
    Promise.resolve().then(() => {
      validateContentHash(request.contentHash)
      const existing = objects.has(request.contentHash)
      if (!existing) objects.set(request.contentHash, encryptAttachment(key, request.contentHash, request.bytes))
      return { storageReference: referenceFor(request.contentHash), deduplicated: existing }
    })

  const getDecrypted = (request: AttachmentObjectRequest): Promise<Uint8Array> =>
    Promise.resolve().then(() => decryptAttachment(key, request.contentHash, getEnvelope(request)))

  const deleteEncrypted = (request: AttachmentObjectRequest): Promise<Readonly<{ deleted: boolean }>> =>
    Promise.resolve().then(() => {
      const referenceHash = hashFromReference(request.storageReference)
      if (referenceHash !== request.contentHash) return { deleted: false }
      return { deleted: objects.delete(request.contentHash) }
    })

  const signature = (payload: string): Buffer => createHmac('sha256', signingKey).update(payload).digest()

  const signRead = (request: SignAttachmentReadRequest): Promise<SignedAttachmentRead> =>
    Promise.resolve().then(() => {
      getEnvelope(request)
      if (request.expiresAt.getTime() <= request.now.getTime()) {
        throw new AttachmentStorageError(ATTACHMENT_STORAGE_FAILURE.SIGNED_READ_EXPIRED)
      }
      const payload = encode(
        JSON.stringify({
          storageReference: request.storageReference,
          contentHash: request.contentHash,
          expiresAt: request.expiresAt.toISOString(),
        }),
      )
      return {
        signedReference: `fake-signed:${payload}.${signature(payload).toString('base64url')}`,
        expiresAt: request.expiresAt,
      }
    })

  const readSigned = async (request: ReadSignedAttachmentRequest): Promise<Uint8Array> => {
    const match = /^fake-signed:([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(request.signedReference)
    if (match === null) throw new AttachmentStorageError(ATTACHMENT_STORAGE_FAILURE.SIGNED_READ_INVALID)
    const payload = match[1]
    const encodedSignature = match[2]
    if (payload === undefined || encodedSignature === undefined) {
      throw new AttachmentStorageError(ATTACHMENT_STORAGE_FAILURE.SIGNED_READ_INVALID)
    }
    const supplied = Buffer.from(encodedSignature, 'base64url')
    const expected = signature(payload)
    if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
      throw new AttachmentStorageError(ATTACHMENT_STORAGE_FAILURE.SIGNED_READ_INVALID)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(decode(payload))
    } catch {
      throw new AttachmentStorageError(ATTACHMENT_STORAGE_FAILURE.SIGNED_READ_INVALID)
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('storageReference' in parsed) ||
      !('contentHash' in parsed) ||
      !('expiresAt' in parsed) ||
      typeof parsed.storageReference !== 'string' ||
      typeof parsed.contentHash !== 'string' ||
      typeof parsed.expiresAt !== 'string' ||
      parsed.contentHash !== request.contentHash
    ) {
      throw new AttachmentStorageError(ATTACHMENT_STORAGE_FAILURE.SIGNED_READ_INVALID)
    }
    const expiresAt = new Date(parsed.expiresAt)
    if (Number.isNaN(expiresAt.getTime())) {
      throw new AttachmentStorageError(ATTACHMENT_STORAGE_FAILURE.SIGNED_READ_INVALID)
    }
    if (request.now.getTime() >= expiresAt.getTime()) {
      throw new AttachmentStorageError(ATTACHMENT_STORAGE_FAILURE.SIGNED_READ_EXPIRED)
    }
    return getDecrypted({ storageReference: parsed.storageReference, contentHash: parsed.contentHash })
  }

  return Object.freeze({
    provider: 'fake-encrypted-storage',
    putEncrypted,
    getDecrypted,
    deleteEncrypted,
    signRead,
    readSigned,
    storedObjectCount: () => objects.size,
    inspectEncryptedBytes: (contentHash: string) => objects.get(contentHash),
  })
}
