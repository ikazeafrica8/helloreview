import { z } from 'zod'

export type ShippingAddressInput = Readonly<{
  recipientName: string
  phone: string
  postalCode: string
  addressLine1: string
  addressLine2: string
  deliveryNote?: string
}>

export type ShippingAddressField = keyof ShippingAddressInput

/** The runtime allowlist behind `ShippingAddressField`, so a rule cannot name a field that does not exist. */
export const SHIPPING_ADDRESS_FIELDS = [
  'recipientName',
  'phone',
  'postalCode',
  'addressLine1',
  'addressLine2',
  'deliveryNote',
] as const satisfies readonly ShippingAddressField[]

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

/**
 * The stored shape of a `campaign_rules` row with `rule_type = 'shipping'`.
 *
 * The version comes from the immutable rule row rather than the configuration body, so the
 * `policy_version` written next to a stored address always names a rule version that still exists
 * and can be read back.
 */
export type ShippingRulePolicySource = Readonly<{ ruleVersion: number; configuration: unknown }>

const shippingRuleConfigurationSchema = z.strictObject({
  requiredFields: z.array(z.enum(SHIPPING_ADDRESS_FIELDS)).min(1).max(SHIPPING_ADDRESS_FIELDS.length),
  allowedPostalPrefixes: z.array(z.string().regex(/^\d{1,5}$/)).max(100),
  changeCutoffAt: z.iso.datetime(),
  lockAt: z.iso.datetime(),
})

/**
 * Turns a published campaign shipping rule into the validation policy.
 *
 * This is the ONLY way a policy may be produced for a participant submission. A submission cannot
 * carry its own policy, so it cannot shorten `requiredFields`, widen `allowedPostalPrefixes`, or
 * push the cutoff and lock instants out of the way. Anything unrecognised fails closed rather than
 * being validated against a partially understood rule.
 */
export const parseShippingRulePolicy = (source: ShippingRulePolicySource | null): ShippingAddressPolicy => {
  if (source === null) throw new ShippingAddressConfigurationError('SHIPPING_POLICY_MISSING')
  const parsed = shippingRuleConfigurationSchema.safeParse(source.configuration)
  if (!parsed.success || !Number.isSafeInteger(source.ruleVersion) || source.ruleVersion < 1)
    throw new ShippingAddressConfigurationError('SHIPPING_POLICY_INVALID')
  const changeCutoffAt = new Date(parsed.data.changeCutoffAt)
  const lockAt = new Date(parsed.data.lockAt)
  if (
    Number.isNaN(changeCutoffAt.getTime()) ||
    Number.isNaN(lockAt.getTime()) ||
    lockAt.getTime() < changeCutoffAt.getTime() ||
    new Set(parsed.data.requiredFields).size !== parsed.data.requiredFields.length
  )
    throw new ShippingAddressConfigurationError('SHIPPING_POLICY_INVALID')
  return Object.freeze({
    version: `shipping-rule-v${String(source.ruleVersion)}`,
    requiredFields: Object.freeze([...parsed.data.requiredFields]),
    allowedPostalPrefixes: Object.freeze([...parsed.data.allowedPostalPrefixes]),
    changeCutoffAt,
    lockAt,
  })
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
