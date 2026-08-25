import { describe, expect, test } from 'vitest'
import {
  ShippingAddressConfigurationError,
  validateShippingAddress,
  type ShippingAddressInput,
  type ShippingAddressPolicy,
} from '../../apps/api/src/modules/shipping/address-validation.js'
import {
  addressFingerprint,
  decryptShippingAddress,
  encryptShippingAddress,
  maskShippingAddress,
} from '../../apps/api/src/modules/shipping/address-crypto.js'

const address = (overrides: Partial<ShippingAddressInput> = {}): ShippingAddressInput => ({
  recipientName: '홍길동',
  phone: '010-1234-5678',
  postalCode: '06236',
  addressLine1: '서울특별시 강남구 테헤란로 123',
  addressLine2: '4층',
  deliveryNote: '문 앞',
  ...overrides,
})

const policy = (overrides: Partial<ShippingAddressPolicy> = {}): ShippingAddressPolicy => ({
  version: 'shipping-v3',
  requiredFields: ['recipientName', 'phone', 'postalCode', 'addressLine1', 'addressLine2'],
  allowedPostalPrefixes: ['06'],
  changeCutoffAt: new Date('2026-09-01T00:00:00Z'),
  lockAt: new Date('2026-09-02T00:00:00Z'),
  ...overrides,
})

describe('deterministic shipping address validation', () => {
  test('requires valid campaign configuration', () => {
    expect(() => validateShippingAddress(address(), null)).toThrow(ShippingAddressConfigurationError)
    expect(() => validateShippingAddress(address(), policy({ version: '' }))).toThrow(/SHIPPING_POLICY_INVALID/)
    expect(() =>
      validateShippingAddress(
        address(),
        policy({ changeCutoffAt: new Date('2026-09-03T00:00:00Z'), lockAt: new Date('2026-09-02T00:00:00Z') }),
      ),
    ).toThrow(/SHIPPING_POLICY_INVALID/)
  })

  test.each([
    ['missing required value', address({ addressLine1: ' ' }), 'REQUIRED_FIELD_MISSING'],
    ['invalid phone', address({ phone: '02-123-4567' }), 'INVALID_KOREAN_PHONE'],
    ['invalid postal code', address({ postalCode: 'ABC' }), 'INVALID_KOREAN_POSTAL_CODE'],
    ['disallowed postal region', address({ postalCode: '12345' }), 'POSTAL_CODE_NOT_ALLOWED'],
  ])('%s receives an approved correction code', (_label, input, correction) => {
    const validation = validateShippingAddress(input, policy())
    expect(validation.valid).toBe(false)
    expect(validation.corrections.map((item) => item.code)).toContain(correction)
  })

  test('normalizes a Korean mobile number and allows an unrestricted valid postcode policy', () => {
    const validation = validateShippingAddress(address(), policy({ allowedPostalPrefixes: [] }))
    expect(validation).toMatchObject({ valid: true, corrections: [] })
    expect(validation.normalized.phone).toBe('+821012345678')
  })

  test('accepts an already-normalized Korean mobile number', () => {
    expect(validateShippingAddress(address({ phone: '+821012345678' }), policy()).valid).toBe(true)
  })
})

describe('protected shipping address cryptography', () => {
  test('encrypts with randomized ciphertext, stable keyed dedupe, masking, and authenticated round trip', () => {
    const key = Buffer.alloc(32, 7)
    const normalized = validateShippingAddress(address(), policy()).normalized
    const first = encryptShippingAddress(key, normalized)
    const second = encryptShippingAddress(key, normalized)
    expect(first).not.toBe(second)
    expect(first).not.toContain(normalized.addressLine1)
    expect(decryptShippingAddress(key, first)).toEqual(normalized)
    expect(addressFingerprint(key, normalized)).toBe(addressFingerprint(key, normalized))
    expect(maskShippingAddress(normalized)).toBe('06236 서울특별…')
  })

  test('fails closed for wrong keys, malformed payloads, and invalid key sizes', () => {
    const key = Buffer.alloc(32, 4)
    const encrypted = encryptShippingAddress(key, validateShippingAddress(address(), policy()).normalized)
    expect(() => decryptShippingAddress(Buffer.alloc(32, 5), encrypted)).toThrow()
    expect(() => decryptShippingAddress(key, 'broken')).toThrow(/malformed/)
    expect(() => addressFingerprint(Buffer.alloc(16), validateShippingAddress(address(), policy()).normalized)).toThrow(
      /32 bytes/,
    )
  })
})
