export type PaybackConsentResponseClassification =
  'explicit_agreement' | 'explicit_decline' | 'explicit_withdrawal' | 'ambiguous'

const AGREEMENT_RESPONSES: ReadonlySet<string> = new Set(['동의합니다', '네 동의합니다', '예 동의합니다'])

const DECLINE_RESPONSES: ReadonlySet<string> = new Set([
  '동의하지 않습니다',
  '동의하지않습니다',
  '동의 안 합니다',
  '동의안합니다',
])

/**
 * T80 deliberately accepts a very small exact Korean vocabulary. AI evidence, a bare yes, emoji,
 * extra instructions, and substring matches cannot record consent.
 */
export const classifyPaybackConsentResponse = (text: string): PaybackConsentResponseClassification => {
  if (text.length > 1_000) return 'ambiguous'
  const normalized = text
    .normalize('NFKC')
    .trim()
    .replace(/[.!?。！？]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim()

  if (DECLINE_RESPONSES.has(normalized)) return 'explicit_decline'
  if (AGREEMENT_RESPONSES.has(normalized)) return 'explicit_agreement'
  return 'ambiguous'
}
