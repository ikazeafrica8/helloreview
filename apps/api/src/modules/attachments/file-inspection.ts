import { ATTACHMENT_REASON, type AttachmentReasonCode } from './reason-codes.js'

export const ATTACHMENT_ALLOWED_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
] as const
export type AttachmentAllowedType = (typeof ATTACHMENT_ALLOWED_TYPES)[number]

export type FileInspectionResult =
  | Readonly<{ accepted: true; detectedType: AttachmentAllowedType }>
  | Readonly<{ accepted: false; reasonCode: AttachmentReasonCode }>

const EXTENSIONS: Readonly<Record<AttachmentAllowedType, readonly string[]>> = Object.freeze({
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'application/pdf': ['pdf'],
})

const KNOWN_EXTENSIONS = new Set(Object.values(EXTENSIONS).flat())

const isAllowedType = (value: string): value is AttachmentAllowedType =>
  ATTACHMENT_ALLOWED_TYPES.some((allowed) => allowed === value)

const startsWith = (bytes: Uint8Array, prefix: readonly number[]): boolean =>
  prefix.every((value, index) => bytes[index] === value)

export const detectAttachmentType = (bytes: Uint8Array): AttachmentAllowedType | undefined => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])) return 'image/gif'
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return 'image/gif'
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return 'image/webp'
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'
  return undefined
}

export const inspectAttachmentFile = (
  input: Readonly<{
    filename: string
    declaredType: string
    bytes: Uint8Array
    maxBytes: number
  }>,
): FileInspectionResult => {
  if (input.bytes.byteLength === 0) return { accepted: false, reasonCode: ATTACHMENT_REASON.FILE_EMPTY }
  if (input.bytes.byteLength > input.maxBytes) {
    return { accepted: false, reasonCode: ATTACHMENT_REASON.FILE_TOO_LARGE }
  }
  if (!isAllowedType(input.declaredType)) {
    return { accepted: false, reasonCode: ATTACHMENT_REASON.UNSUPPORTED_FILE_TYPE }
  }

  const parts = input.filename.toLowerCase().split('.')
  const extension = parts.at(-1)
  const expectedExtensions = EXTENSIONS[input.declaredType]
  const intermediateExtensions = parts.slice(1, -1)
  if (intermediateExtensions.some((candidate) => KNOWN_EXTENSIONS.has(candidate))) {
    return { accepted: false, reasonCode: ATTACHMENT_REASON.DOUBLE_EXTENSION }
  }
  if (extension === undefined || !expectedExtensions.includes(extension)) {
    return { accepted: false, reasonCode: ATTACHMENT_REASON.EXTENSION_TYPE_MISMATCH }
  }

  const detectedType = detectAttachmentType(input.bytes)
  if (detectedType === undefined || detectedType !== input.declaredType) {
    return { accepted: false, reasonCode: ATTACHMENT_REASON.TYPE_SIGNATURE_MISMATCH }
  }
  return { accepted: true, detectedType }
}
