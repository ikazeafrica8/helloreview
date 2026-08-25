import { describe, expect, test } from 'vitest'
import { detectAttachmentType, inspectAttachmentFile } from '../../apps/api/src/modules/attachments/file-inspection.js'
import { evaluateAttachmentDeletion } from '../../apps/api/src/modules/attachments/retention-gate.js'

const fixtures = {
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]),
  'image/gif': Buffer.from('GIF87a-synthetic', 'ascii'),
  'image/webp': Buffer.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 1]),
  'application/pdf': Buffer.from('%PDF-1.7 synthetic', 'ascii'),
}

const extension = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
}

describe('attachment file inspection', () => {
  test.each(Object.entries(fixtures))('detects and accepts %s by bytes, not extension', (declaredType, bytes) => {
    expect(detectAttachmentType(bytes)).toBe(declaredType)
    expect(
      inspectAttachmentFile({
        filename: `synthetic.${extension[declaredType]}`,
        declaredType,
        bytes,
        maxBytes: 1_000,
      }),
    ).toEqual({ accepted: true, detectedType: declaredType })
  })

  test('recognizes both GIF signatures and the JPEG alias', () => {
    expect(detectAttachmentType(Buffer.from('GIF89a-synthetic', 'ascii'))).toBe('image/gif')
    expect(
      inspectAttachmentFile({
        filename: 'synthetic.jpeg',
        declaredType: 'image/jpeg',
        bytes: fixtures['image/jpeg'],
        maxBytes: 1_000,
      }),
    ).toMatchObject({ accepted: true })
  })

  test.each([
    ['empty', { filename: 'x.png', declaredType: 'image/png', bytes: Buffer.alloc(0), maxBytes: 10 }, 'FILE_EMPTY'],
    [
      'oversize',
      { filename: 'x.png', declaredType: 'image/png', bytes: fixtures['image/png'], maxBytes: 1 },
      'FILE_TOO_LARGE',
    ],
    [
      'unsupported declared type',
      { filename: 'x.exe', declaredType: 'application/x-msdownload', bytes: Buffer.from('MZ'), maxBytes: 10 },
      'UNSUPPORTED_FILE_TYPE',
    ],
    [
      'double extension',
      { filename: 'x.jpg.exe', declaredType: 'image/jpeg', bytes: fixtures['image/jpeg'], maxBytes: 100 },
      'DOUBLE_EXTENSION',
    ],
    [
      'extension mismatch',
      { filename: 'x.gif', declaredType: 'image/png', bytes: fixtures['image/png'], maxBytes: 100 },
      'EXTENSION_TYPE_MISMATCH',
    ],
    [
      'unknown signature',
      { filename: 'x.png', declaredType: 'image/png', bytes: Buffer.from('not-png'), maxBytes: 100 },
      'TYPE_SIGNATURE_MISMATCH',
    ],
    [
      'signature mismatch',
      { filename: 'x.png', declaredType: 'image/png', bytes: fixtures['image/jpeg'], maxBytes: 100 },
      'TYPE_SIGNATURE_MISMATCH',
    ],
  ])('fails closed for %s', (_label, input, reasonCode) => {
    expect(inspectAttachmentFile(input)).toEqual({ accepted: false, reasonCode })
  })

  test('does not treat a normal dotted filename as a malicious double extension', () => {
    expect(
      inspectAttachmentFile({
        filename: 'reservation.final.png',
        declaredType: 'image/png',
        bytes: fixtures['image/png'],
        maxBytes: 100,
      }),
    ).toMatchObject({ accepted: true })
  })
})

describe('attachment retention gate', () => {
  test('blocks deletion when no approved policy exists', () => {
    expect(evaluateAttachmentDeletion({ policyReference: null, legalHoldActive: false })).toEqual({
      allowed: false,
      reasonCode: 'RETENTION_POLICY_MISSING',
    })
    expect(evaluateAttachmentDeletion({ policyReference: '  ', legalHoldActive: false })).toEqual({
      allowed: false,
      reasonCode: 'RETENTION_POLICY_MISSING',
    })
  })

  test('legal hold wins over a configured policy', () => {
    expect(evaluateAttachmentDeletion({ policyReference: 'policy-reviewed-v1', legalHoldActive: true })).toEqual({
      allowed: false,
      reasonCode: 'LEGAL_HOLD_ACTIVE',
    })
  })

  test('allows deletion only with policy and no legal hold', () => {
    expect(evaluateAttachmentDeletion({ policyReference: 'policy-reviewed-v1', legalHoldActive: false })).toEqual({
      allowed: true,
      reasonCode: 'DELETION_ELIGIBLE',
    })
  })
})
