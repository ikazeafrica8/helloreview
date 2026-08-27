import { Injectable } from '@nestjs/common'
import type { AdminEnvironment } from './operator-principal.js'
import {
  parseSensitiveAccessPolicy,
  SensitiveAccessPolicyError,
  type SensitiveAccessPolicy,
} from './sensitive-access-policy.js'

export const SENSITIVE_ACCESS_POLICY_PROVIDER = Symbol('SENSITIVE_ACCESS_POLICY_PROVIDER')

export type SensitiveAccessPolicyReference = Readonly<{
  environment: AdminEnvironment
  policyVersion: string
}>

export interface SensitiveAccessPolicyProvider {
  resolveCurrentPolicy(reference: SensitiveAccessPolicyReference): Promise<SensitiveAccessPolicy>
}

/**
 * Production-safe default. A future approved policy store must replace this provider explicitly;
 * operation requests can never supply the policy document itself.
 */
@Injectable()
export class ProductionLockedSensitiveAccessPolicyProvider implements SensitiveAccessPolicyProvider {
  resolveCurrentPolicy(_reference: SensitiveAccessPolicyReference): Promise<SensitiveAccessPolicy> {
    return Promise.reject(new SensitiveAccessPolicyError('SENSITIVE_ACCESS_POLICY_PROVIDER_LOCKED'))
  }
}

/** Deterministic test-only provider with current-version and environment checks. */
export class DeterministicSensitiveAccessPolicyProvider implements SensitiveAccessPolicyProvider {
  private readonly policy: SensitiveAccessPolicy

  constructor(policy: unknown) {
    this.policy = parseSensitiveAccessPolicy(policy)
    if (this.policy.status !== 'test_fixture' || this.policy.environment !== 'test')
      throw new SensitiveAccessPolicyError('SENSITIVE_ACCESS_TEST_FIXTURE_BOUNDARY_INVALID')
  }

  resolveCurrentPolicy(reference: SensitiveAccessPolicyReference): Promise<SensitiveAccessPolicy> {
    if (reference.environment !== this.policy.environment)
      return Promise.reject(new SensitiveAccessPolicyError('SENSITIVE_ACCESS_POLICY_ENVIRONMENT_MISMATCH'))
    if (reference.policyVersion !== this.policy.policyVersion)
      return Promise.reject(new SensitiveAccessPolicyError('SENSITIVE_ACCESS_POLICY_VERSION_STALE'))
    return Promise.resolve(this.policy)
  }
}
