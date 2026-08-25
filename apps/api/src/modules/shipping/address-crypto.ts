import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import type { NormalizedShippingAddress } from './address-validation.js'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12

const canonical = (address: NormalizedShippingAddress): string =>
  JSON.stringify({
    recipientName: address.recipientName,
    phone: address.phone,
    postalCode: address.postalCode,
    addressLine1: address.addressLine1,
    addressLine2: address.addressLine2,
    deliveryNote: address.deliveryNote,
  })

const assertKey = (key: Buffer): void => {
  if (key.byteLength !== 32) throw new Error('shipping address encryption key must be exactly 32 bytes')
}

export const addressFingerprint = (key: Buffer, address: NormalizedShippingAddress): string => {
  assertKey(key)
  return createHmac('sha256', key).update(canonical(address)).digest('hex')
}

export const encryptShippingAddress = (key: Buffer, address: NormalizedShippingAddress): string => {
  assertKey(key)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(canonical(address), 'utf8'), cipher.final()])
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`
}

export const decryptShippingAddress = (key: Buffer, payload: string): NormalizedShippingAddress => {
  assertKey(key)
  const parts = payload.split('.')
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('shipping address ciphertext is malformed')
  const iv = Buffer.from(parts[1] ?? '', 'base64url')
  const tag = Buffer.from(parts[2] ?? '', 'base64url')
  const ciphertext = Buffer.from(parts[3] ?? '', 'base64url')
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  const parsed: unknown = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'))
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('recipientName' in parsed) ||
    !('phone' in parsed) ||
    !('postalCode' in parsed) ||
    !('addressLine1' in parsed) ||
    !('addressLine2' in parsed) ||
    !('deliveryNote' in parsed) ||
    typeof parsed.recipientName !== 'string' ||
    typeof parsed.phone !== 'string' ||
    typeof parsed.postalCode !== 'string' ||
    typeof parsed.addressLine1 !== 'string' ||
    typeof parsed.addressLine2 !== 'string' ||
    typeof parsed.deliveryNote !== 'string'
  )
    throw new Error('shipping address ciphertext contains an invalid document')
  return {
    recipientName: parsed.recipientName,
    phone: parsed.phone,
    postalCode: parsed.postalCode,
    addressLine1: parsed.addressLine1,
    addressLine2: parsed.addressLine2,
    deliveryNote: parsed.deliveryNote,
  }
}

export const maskShippingAddress = (address: NormalizedShippingAddress): string => {
  const suffix = address.addressLine1.length <= 4 ? '****' : `${address.addressLine1.slice(0, 4)}…`
  return `${address.postalCode} ${suffix}`
}
