import { Inject, Injectable } from '@nestjs/common'
import { runWithCorrelation } from '@helloreview/observability'
import { AUDIT_ACTION, AuditLogService } from '../audit-log/index.js'
import { ShippingService, type NormalizedShippingAddress } from '../shipping/index.js'
import { AdminAuthorizationDeniedError } from './admin-authorization.js'
import { authorizeAdminInvocation, type AdminInvocation } from './admin-invocation.js'
import {
  assertSensitiveAccessAllowed,
  SensitiveAccessPolicyError,
  type SensitiveAccessOperation,
} from './sensitive-access-policy.js'
import {
  SENSITIVE_ACCESS_POLICY_PROVIDER,
  type SensitiveAccessPolicyProvider,
} from './sensitive-access-policy-provider.js'

export type RevealShippingAddressAdminCommand = Readonly<{
  workflowId: string
  participantId: string
  reasonCode: string
  occurredAt: Date
  sensitiveAccessPolicyVersion: string
}>

export type RequestSensitiveExportCommand = Readonly<{
  operationReference: string
  reasonCode: string
  requestedRecordCount: number
  occurredAt: Date
  sensitiveAccessPolicyVersion: string
}>

export type SensitiveExportUnavailable = Readonly<{
  operationReference: string
  outcome: 'unavailable_safe_fallback'
  realExportPerformed: false
  reasonCode: 'SENSITIVE_EXPORT_UNAVAILABLE_SAFE_FALLBACK'
}>

@Injectable()
export class SensitiveAccessAdminService {
  constructor(
    private readonly shipping: ShippingService,
    private readonly audit: AuditLogService,
    @Inject(SENSITIVE_ACCESS_POLICY_PROVIDER)
    private readonly sensitiveAccessPolicyProvider: SensitiveAccessPolicyProvider,
  ) {}

  async revealShippingAddress(
    invocation: AdminInvocation,
    command: RevealShippingAddressAdminCommand,
  ): Promise<NormalizedShippingAddress> {
    let policyVersion: string
    let decision
    try {
      decision = authorizeAdminInvocation(invocation, 'sensitive_values.reveal', null)
      const policy = await this.sensitiveAccessPolicyProvider.resolveCurrentPolicy({
        environment: invocation.context.environment,
        policyVersion: command.sensitiveAccessPolicyVersion,
      })
      policyVersion = assertSensitiveAccessAllowed({
        policy,
        environment: invocation.context.environment,
        operation: 'shipping_address.reveal',
        reasonCode: command.reasonCode,
        requestedRecords: 1,
      }).policyVersion
    } catch (error) {
      await this.recordRejectedAttempt(
        invocation,
        'shipping_address.reveal',
        command.workflowId,
        command.occurredAt,
        error,
      )
      throw error
    }

    try {
      return await this.shipping.reveal({
        workflowId: command.workflowId,
        participantId: command.participantId,
        actorType: 'operator',
        actorReference: invocation.principal.principalReference,
        authorized: true,
        reasonCode: command.reasonCode,
        correlationId: invocation.correlationId,
        occurredAt: command.occurredAt,
        authorizationEvidence: {
          action: 'sensitive_values.reveal',
          authorizationPolicyVersion: decision.policyVersion,
          sensitiveAccessPolicyVersion: policyVersion,
          authorizationVersion: decision.authorizationVersion,
          requestReference: invocation.requestReference,
          sessionReference: decision.sessionReference,
        },
      })
    } catch (error) {
      await this.recordRejectedAttempt(
        invocation,
        'shipping_address.reveal',
        command.workflowId,
        command.occurredAt,
        error,
      )
      throw error
    }
  }

  async requestSensitiveExport(
    invocation: AdminInvocation,
    command: RequestSensitiveExportCommand,
  ): Promise<SensitiveExportUnavailable> {
    let policyVersion: string
    try {
      authorizeAdminInvocation(invocation, 'sensitive_data.export', null)
      const policy = await this.sensitiveAccessPolicyProvider.resolveCurrentPolicy({
        environment: invocation.context.environment,
        policyVersion: command.sensitiveAccessPolicyVersion,
      })
      policyVersion = assertSensitiveAccessAllowed({
        policy,
        environment: invocation.context.environment,
        operation: 'participant_data.export',
        reasonCode: command.reasonCode,
        requestedRecords: command.requestedRecordCount,
      }).policyVersion
    } catch (error) {
      await this.recordRejectedAttempt(
        invocation,
        'participant_data.export',
        command.operationReference,
        command.occurredAt,
        error,
      )
      throw error
    }

    await runWithCorrelation(invocation.correlationId, () =>
      this.audit.record({
        actorType: 'operator',
        actorId: invocation.principal.principalReference,
        action: AUDIT_ACTION.SENSITIVE_DATA_EXPORT_REQUESTED,
        targetType: 'sensitive_export',
        targetId: command.operationReference,
        result: 'rejected',
        reason: 'SENSITIVE_EXPORT_UNAVAILABLE_SAFE_FALLBACK',
        detail: {
          requestedRecordCount: command.requestedRecordCount,
          authorizationPolicyVersion: invocation.policy.policyVersion,
          sensitiveAccessPolicyVersion: policyVersion,
        },
        occurredAt: command.occurredAt,
      }),
    )
    return {
      operationReference: command.operationReference,
      outcome: 'unavailable_safe_fallback',
      realExportPerformed: false,
      reasonCode: 'SENSITIVE_EXPORT_UNAVAILABLE_SAFE_FALLBACK',
    }
  }

  private async recordRejectedAttempt(
    invocation: AdminInvocation,
    operation: SensitiveAccessOperation,
    targetId: string,
    occurredAt: Date,
    error: unknown,
  ): Promise<void> {
    const reason =
      error instanceof AdminAuthorizationDeniedError
        ? error.decision.reasonCode
        : error instanceof SensitiveAccessPolicyError
          ? error.reasonCode
          : error instanceof Error && 'reasonCode' in error && typeof error.reasonCode === 'string'
            ? error.reasonCode
            : 'SENSITIVE_ACCESS_OPERATION_FAILED'
    await runWithCorrelation(invocation.correlationId, () =>
      this.audit.record({
        actorType: 'operator',
        actorId: invocation.principal.principalReference,
        action:
          operation === 'shipping_address.reveal'
            ? AUDIT_ACTION.SENSITIVE_FIELD_REVEALED
            : AUDIT_ACTION.SENSITIVE_DATA_EXPORT_REQUESTED,
        targetType: operation === 'shipping_address.reveal' ? 'shipping_workflow' : 'sensitive_export',
        targetId,
        result: 'rejected',
        reason,
        detail: { operation, authorizationPolicyVersion: invocation.policy.policyVersion },
        occurredAt,
      }),
    )
  }
}
