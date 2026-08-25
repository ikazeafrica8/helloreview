import { createHash, createHmac } from 'node:crypto'
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

export type S3CompatibleAttachmentStorageConfig = Readonly<{
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  encryptionKey: Uint8Array
  region?: string
  /** Injectable for deterministic signing tests. */
  clock?: () => Date
}>

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex')
const MAX_SIGNED_READ_SECONDS = 900

const rfc3986 = (value: string): string =>
  encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)

const formatAmzDate = (date: Date): string => date.toISOString().replace(/[:-]|\.\d{3}/g, '')

const hmac = (key: Uint8Array | string, value: string): Buffer => createHmac('sha256', key).update(value).digest()

const sha256 = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex')

const signingKey = (secret: string, date: string, region: string): Buffer =>
  hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), 's3'), 'aws4_request')

const parseAmzDate = (value: string): Date | undefined => {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value)
  if (match === null) return undefined
  const year = match[1]
  const month = match[2]
  const day = match[3]
  const hour = match[4]
  const minute = match[5]
  const second = match[6]
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  )
    return undefined
  const parsed = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

/**
 * Path-style S3 adapter using only fetch and AWS Signature V4.
 *
 * Plaintext is encrypted with AES-256-GCM before it reaches the object store. The S3-compatible
 * service therefore never needs access to the application encryption key, and the local MinIO
 * emulator exercises the same wire contract a later hosted S3 service will use.
 */
export const createS3CompatibleAttachmentStorage = (config: S3CompatibleAttachmentStorageConfig): AttachmentStorage => {
  const endpoint = new URL(config.endpoint)
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username !== '' || endpoint.password !== '') {
    throw new Error('S3 endpoint must be an HTTP(S) URL without embedded credentials')
  }
  if (endpoint.search !== '' || endpoint.hash !== '') throw new Error('S3 endpoint must not contain query or fragment')
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket)) throw new Error('invalid S3 bucket name')
  if (config.accessKeyId === '' || config.secretAccessKey === '') throw new Error('S3 credentials are required')

  const key = normalizeEncryptionKey(config.encryptionKey)
  const region = config.region ?? 'us-east-1'
  const clock = config.clock ?? (() => new Date())
  const basePath = endpoint.pathname === '/' ? '' : endpoint.pathname.replace(/\/$/, '')

  const objectKey = (contentHash: string): string => {
    validateContentHash(contentHash)
    return `attachments/${contentHash.slice(0, 2)}/${contentHash}`
  }

  const canonicalPath = (keyValue: string): string =>
    `${basePath}/${rfc3986(config.bucket)}/${keyValue.split('/').map(rfc3986).join('/')}`

  const storageReference = (keyValue: string): string => `s3-object:${Buffer.from(keyValue).toString('base64url')}`

  const keyFromReference = (reference: string, contentHash: string): string => {
    const prefix = 's3-object:'
    if (!reference.startsWith(prefix)) throw new AttachmentStorageError(ATTACHMENT_STORAGE_FAILURE.OBJECT_NOT_FOUND)
    let decoded: string
    try {
      decoded = Buffer.from(reference.slice(prefix.length), 'base64url').toString('utf8')
    } catch {
      throw new AttachmentStorageError(ATTACHMENT_STORAGE_FAILURE.OBJECT_NOT_FOUND)
    }
    if (decoded !== objectKey(contentHash)) {
      throw new AttachmentStorageError(ATTACHMENT_STORAGE_FAILURE.OBJECT_NOT_FOUND)
    }
    return decoded
  }

  const authorizationHeaders = (
    method: string,
    path: string,
    payloadHash: string,
    now: Date,
  ): Readonly<Record<string, string>> => {
    const amzDate = formatAmzDate(now)
    const shortDate = amzDate.slice(0, 8)
    const host = endpoint.host
    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
    const canonicalRequest = [method, path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n')
    const scope = `${shortDate}/${region}/s3/aws4_request`
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n')
    const signature = createHmac('sha256', signingKey(config.secretAccessKey, shortDate, region))
      .update(stringToSign)
      .digest('hex')
    return {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    }
  }

  const objectRequest = async (
    method: 'HEAD' | 'GET' | 'PUT' | 'DELETE',
    keyValue: string,
    body?: Uint8Array,
  ): Promise<Response> => {
    const path = canonicalPath(keyValue)
    const payloadHash = body === undefined ? EMPTY_SHA256 : sha256(body)
    const url = `${endpoint.origin}${path}`
    try {
      return await fetch(url, {
        method,
        headers: authorizationHeaders(method, path, payloadHash, clock()),
        ...(body === undefined ? {} : { body: Buffer.from(body) }),
      })
    } catch {
      throw new AttachmentStorageError(ATTACHMENT_STORAGE_FAILURE.STORAGE_UNAVAILABLE)
    }
  }

  const putEncrypted = async (request: PutEncryptedAttachmentRequest): Promise<StoredAttachment> => {
    const keyValue = objectKey(request.contentHash)
    const head = await objectRequest('HEAD', keyValue)
    if (head.ok) return { storageReference: storageReference(keyValue), deduplicated: true }
    if (head.status !== 404) throw new AttachmentStorageError(ATTACHMENT_STORAGE_FAILURE.STORAGE_UNAVAILABLE)
    const encrypted = encryptAttachment(key, request.contentHash, request.bytes)
    const response = await objectRequest('PUT', keyValue, encrypted)
    if (!response.ok) throw new AttachmentStorageError(ATTACHMENT_STORAGE_FAILURE.STORAGE_UNAVAILABLE)
    return { storageReference: storageReference(keyValue), deduplicated: false }
  }

  const getDecrypted = async (request: AttachmentObjectRequest): Promise<Uint8Array> => {
    const response = await objectRequest('GET', keyFromReference(request.storageReference, request.contentHash))
    if (response.status === 404) throw new AttachmentStorageError(ATTACHMENT_STORAGE_FAILURE.OBJECT_NOT_FOUND)
    if (!response.ok) throw new AttachmentStorageError(ATTACHMENT_STORAGE_FAILURE.STORAGE_UNAVAILABLE)
    return decryptAttachment(key, request.contentHash, new Uint8Array(await response.arrayBuffer()))
  }

  const deleteEncrypted = async (request: AttachmentObjectRequest): Promise<Readonly<{ deleted: boolean }>> => {
    const keyValue = keyFromReference(request.storageReference, request.contentHash)
    const head = await objectRequest('HEAD', keyValue)
    if (head.status === 404) return { deleted: false }
    if (!head.ok) throw new AttachmentStorageError(ATTACHMENT_STORAGE_FAILURE.STORAGE_UNAVAILABLE)
    const response = await objectRequest('DELETE', keyValue)
    if (!response.ok) throw new AttachmentStorageError(ATTACHMENT_STORAGE_FAILURE.STORAGE_UNAVAILABLE)
    return { deleted: true }
  }

  const signedUrl = (keyValue: string, now: Date, expiresSeconds: number): string => {
    const path = canonicalPath(keyValue)
    const amzDate = formatAmzDate(now)
    const shortDate = amzDate.slice(0, 8)
    const scope = `${shortDate}/${region}/s3/aws4_request`
    const parameters: Readonly<Record<string, string>> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${config.accessKeyId}/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expiresSeconds),
      'X-Amz-SignedHeaders': 'host',
    }
    const canonicalQuery = Object.entries(parameters)
      .map(([name, value]) => [rfc3986(name), rfc3986(value)] as const)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${name}=${value}`)
      .join('&')
    const canonicalRequest = ['GET', path, canonicalQuery, `host:${endpoint.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join(
      '\n',
    )
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n')
    const signature = createHmac('sha256', signingKey(config.secretAccessKey, shortDate, region))
      .update(stringToSign)
      .digest('hex')
    return `${endpoint.origin}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`
  }

  const signRead = (request: SignAttachmentReadRequest): Promise<SignedAttachmentRead> =>
    Promise.resolve().then(() => {
      const keyValue = keyFromReference(request.storageReference, request.contentHash)
      const lifetimeMs = request.expiresAt.getTime() - request.now.getTime()
      const expiresSeconds = Math.ceil(lifetimeMs / 1_000)
      if (expiresSeconds < 1 || expiresSeconds > MAX_SIGNED_READ_SECONDS) {
        throw new AttachmentStorageError(ATTACHMENT_STORAGE_FAILURE.SIGNED_READ_EXPIRED)
      }
      return {
        signedReference: signedUrl(keyValue, request.now, expiresSeconds),
        expiresAt: request.expiresAt,
      }
    })

  const readSigned = async (request: ReadSignedAttachmentRequest): Promise<Uint8Array> => {
    let url: URL
    try {
      url = new URL(request.signedReference)
    } catch {
      throw new AttachmentStorageError(ATTACHMENT_STORAGE_FAILURE.SIGNED_READ_INVALID)
    }
    const expectedPath = canonicalPath(objectKey(request.contentHash))
    const signedAtRaw = url.searchParams.get('X-Amz-Date')
    const expiresRaw = url.searchParams.get('X-Amz-Expires')
    const signedAt = signedAtRaw === null ? undefined : parseAmzDate(signedAtRaw)
    const expiresSeconds = expiresRaw === null ? Number.NaN : Number(expiresRaw)
    if (
      url.origin !== endpoint.origin ||
      url.pathname !== expectedPath ||
      signedAt === undefined ||
      !Number.isInteger(expiresSeconds) ||
      expiresSeconds < 1 ||
      expiresSeconds > MAX_SIGNED_READ_SECONDS ||
      request.now.getTime() >= signedAt.getTime() + expiresSeconds * 1_000
    ) {
      throw new AttachmentStorageError(ATTACHMENT_STORAGE_FAILURE.SIGNED_READ_INVALID)
    }
    let response: Response
    try {
      response = await fetch(url)
    } catch {
      throw new AttachmentStorageError(ATTACHMENT_STORAGE_FAILURE.STORAGE_UNAVAILABLE)
    }
    if (response.status === 403) throw new AttachmentStorageError(ATTACHMENT_STORAGE_FAILURE.SIGNED_READ_EXPIRED)
    if (response.status === 404) throw new AttachmentStorageError(ATTACHMENT_STORAGE_FAILURE.OBJECT_NOT_FOUND)
    if (!response.ok) throw new AttachmentStorageError(ATTACHMENT_STORAGE_FAILURE.STORAGE_UNAVAILABLE)
    return decryptAttachment(key, request.contentHash, new Uint8Array(await response.arrayBuffer()))
  }

  return Object.freeze({
    provider: 's3-compatible-encrypted-storage',
    putEncrypted,
    getDecrypted,
    deleteEncrypted,
    signRead,
    readSigned,
  })
}
