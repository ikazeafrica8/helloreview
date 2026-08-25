export type ShippingAddressInput = Readonly<{
  recipientName: string
  phone: string
  postalCode: string
  addressLine1: string
  addressLine2: string
  deliveryNote?: string
}>

export type ShippingAddressField = keyof ShippingAddressInput

export type ShippingAddressPolicy = Readonly<{
  version: string
  requiredFields: readonly ShippingAddressField[]
  allowedPostalPrefixes: readonly string[]
  changeCutoffAt: Date
  lockAt: Date
}>

export type ShippingAddressCorrection = Readonly<{
  field: ShippingAddressField
  code: 'REQUIRED_FIELD_MISSING' | 'INVALID_KOREAN_PHONE' | 'INVALID_KOREAN_POSTAL_CODE' | 'POSTAL_CODE_NOT_ALLOWED'
}>

export type NormalizedShippingAddress = Readonly<{
  recipientName: string
  phone: string
  postalCode: string
  addressLine1: string
  addressLine2: string
  deliveryNote: string
}>

export type ShippingAddressValidation = Readonly<{
  valid: boolean
  normalized: NormalizedShippingAddress
  corrections: readonly ShippingAddressCorrection[]
  policyVersion: string
}>

export class ShippingAddressConfigurationError extends Error {
  override readonly name = 'ShippingAddressConfigurationError'
  constructor(readonly reasonCode: 'SHIPPING_POLICY_MISSING' | 'SHIPPING_POLICY_INVALID') {
    super(`shipping address configuration rejected: ${reasonCode}`)
  }
}

const normalizePhone = (phone: string): string | null => {
  const compact = phone.replace(/[\s().-]/g, '')
  if (/^010\d{8}$/.test(compact)) return `+82${compact.slice(1)}`
  if (/^\+8210\d{8}$/.test(compact)) return compact
  return null
}

const trimmed = (input: ShippingAddressInput): NormalizedShippingAddress => ({
  recipientName: input.recipientName.trim(),
  phone: input.phone.trim(),
  postalCode: input.postalCode.trim(),
  addressLine1: input.addressLine1.trim(),
  addressLine2: input.addressLine2.trim(),
  deliveryNote: input.deliveryNote?.trim() ?? '',
})

/** Pure deterministic validation. Policy is mandatory and all corrections use approved codes. */
export const validateShippingAddress = (
  input: ShippingAddressInput,
  policy: ShippingAddressPolicy | null,
): ShippingAddressValidation => {
  if (policy === null) throw new ShippingAddressConfigurationError('SHIPPING_POLICY_MISSING')
  if (policy.version.trim() === '' || policy.lockAt.getTime() < policy.changeCutoffAt.getTime())
    throw new ShippingAddressConfigurationError('SHIPPING_POLICY_INVALID')

  const normalized = trimmed(input)
  const corrections: ShippingAddressCorrection[] = []
  for (const field of policy.requiredFields) {
    if (normalized[field] === '') corrections.push({ field, code: 'REQUIRED_FIELD_MISSING' })
  }
  const phone = normalizePhone(normalized.phone)
  if (normalized.phone !== '' && phone === null) corrections.push({ field: 'phone', code: 'INVALID_KOREAN_PHONE' })
  if (normalized.postalCode !== '' && !/^\d{5}$/.test(normalized.postalCode))
    corrections.push({ field: 'postalCode', code: 'INVALID_KOREAN_POSTAL_CODE' })
  else if (
    normalized.postalCode !== '' &&
    policy.allowedPostalPrefixes.length > 0 &&
    !policy.allowedPostalPrefixes.some((prefix) => normalized.postalCode.startsWith(prefix))
  )
    corrections.push({ field: 'postalCode', code: 'POSTAL_CODE_NOT_ALLOWED' })
  return {
    valid: corrections.length === 0,
    normalized: { ...normalized, phone: phone ?? normalized.phone },
    corrections,
    policyVersion: policy.version,
  }
}
