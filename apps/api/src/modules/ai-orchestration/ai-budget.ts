import { createHash } from 'node:crypto'
import { AI_ORCHESTRATION_REASON } from './reason-codes.js'

export type AiBudgetPolicy = Readonly<{
  maximumInputCharacters: number
  maximumEstimatedTokensPerRequest: number
  maximumEstimatedTokensPerScope: number
  maximumEstimatedCostMicrosPerRequest: number
  maximumEstimatedCostMicrosPerScope: number
  estimatedCostMicrosPerThousandTokens: number
}>

export type AiBudgetReservation = Readonly<{
  allowed: boolean
  reasonCode: string | null
  estimatedTokens: number
  estimatedCostMicros: number
  scopeTokensAfter: number
  scopeCostMicrosAfter: number
}>

const isPositiveWhole = (value: number): boolean => Number.isInteger(value) && value > 0

const validatePolicy = (policy: AiBudgetPolicy): void => {
  if (
    !isPositiveWhole(policy.maximumInputCharacters) ||
    !isPositiveWhole(policy.maximumEstimatedTokensPerRequest) ||
    !isPositiveWhole(policy.maximumEstimatedTokensPerScope) ||
    !isPositiveWhole(policy.maximumEstimatedCostMicrosPerRequest) ||
    !isPositiveWhole(policy.maximumEstimatedCostMicrosPerScope) ||
    !isPositiveWhole(policy.estimatedCostMicrosPerThousandTokens)
  ) {
    throw new Error('AI budget values must be positive whole numbers')
  }
  if (
    policy.maximumEstimatedTokensPerScope < policy.maximumEstimatedTokensPerRequest ||
    policy.maximumEstimatedCostMicrosPerScope < policy.maximumEstimatedCostMicrosPerRequest
  ) {
    throw new Error('AI scope budgets must be at least as large as per-request budgets')
  }
}

export const estimateAiUsage = (
  text: string,
  costMicrosPerThousandTokens: number,
): Readonly<{ characters: number; tokens: number; costMicros: number }> => {
  const characters = Array.from(new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(text)).length
  const tokens = Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 3))
  return {
    characters,
    tokens,
    costMicros: Math.ceil((tokens * costMicrosPerThousandTokens) / 1_000),
  }
}

export class AiBudgetLedger {
  private readonly usage = new Map<string, Readonly<{ tokens: number; costMicros: number }>>()
  private readonly requests = new Map<
    string,
    Readonly<{ scopeKey: string; fingerprint: string; reservation: AiBudgetReservation }>
  >()

  constructor(private readonly policy: AiBudgetPolicy | null) {
    if (policy !== null) validatePolicy(policy)
  }

  reserve(requestKey: string, scopeKey: string, text: string): AiBudgetReservation {
    const requestFingerprint = createHash('sha256').update(text).digest('hex')
    const existing = this.requests.get(requestKey)
    if (existing !== undefined) {
      if (existing.scopeKey === scopeKey && existing.fingerprint === requestFingerprint) return existing.reservation
      const current = this.usage.get(scopeKey) ?? { tokens: 0, costMicros: 0 }
      return {
        allowed: false,
        reasonCode: AI_ORCHESTRATION_REASON.BUDGET_REQUEST_CONFLICT,
        estimatedTokens: 0,
        estimatedCostMicros: 0,
        scopeTokensAfter: current.tokens,
        scopeCostMicrosAfter: current.costMicros,
      }
    }

    if (this.policy === null) {
      const reservation = {
        allowed: false,
        reasonCode: AI_ORCHESTRATION_REASON.BUDGET_POLICY_MISSING,
        estimatedTokens: 0,
        estimatedCostMicros: 0,
        scopeTokensAfter: 0,
        scopeCostMicrosAfter: 0,
      }
      this.requests.set(requestKey, { scopeKey, fingerprint: requestFingerprint, reservation })
      return reservation
    }

    const estimate = estimateAiUsage(text, this.policy.estimatedCostMicrosPerThousandTokens)
    const current = this.usage.get(scopeKey) ?? { tokens: 0, costMicros: 0 }
    const after = { tokens: current.tokens + estimate.tokens, costMicros: current.costMicros + estimate.costMicros }
    const requestExceeded =
      estimate.characters > this.policy.maximumInputCharacters ||
      estimate.tokens > this.policy.maximumEstimatedTokensPerRequest ||
      estimate.costMicros > this.policy.maximumEstimatedCostMicrosPerRequest
    if (requestExceeded) {
      const reservation = {
        allowed: false,
        reasonCode: AI_ORCHESTRATION_REASON.INPUT_BUDGET_EXCEEDED,
        estimatedTokens: estimate.tokens,
        estimatedCostMicros: estimate.costMicros,
        scopeTokensAfter: current.tokens,
        scopeCostMicrosAfter: current.costMicros,
      }
      this.requests.set(requestKey, { scopeKey, fingerprint: requestFingerprint, reservation })
      return reservation
    }

    const scopeExceeded =
      after.tokens > this.policy.maximumEstimatedTokensPerScope ||
      after.costMicros > this.policy.maximumEstimatedCostMicrosPerScope
    if (scopeExceeded) {
      const reservation = {
        allowed: false,
        reasonCode: AI_ORCHESTRATION_REASON.SCOPE_BUDGET_EXCEEDED,
        estimatedTokens: estimate.tokens,
        estimatedCostMicros: estimate.costMicros,
        scopeTokensAfter: current.tokens,
        scopeCostMicrosAfter: current.costMicros,
      }
      this.requests.set(requestKey, { scopeKey, fingerprint: requestFingerprint, reservation })
      return reservation
    }

    this.usage.set(scopeKey, after)
    const reservation = {
      allowed: true,
      reasonCode: null,
      estimatedTokens: estimate.tokens,
      estimatedCostMicros: estimate.costMicros,
      scopeTokensAfter: after.tokens,
      scopeCostMicrosAfter: after.costMicros,
    }
    this.requests.set(requestKey, { scopeKey, fingerprint: requestFingerprint, reservation })
    return reservation
  }

  current(scopeKey: string): Readonly<{ tokens: number; costMicros: number }> {
    return this.usage.get(scopeKey) ?? { tokens: 0, costMicros: 0 }
  }
}
