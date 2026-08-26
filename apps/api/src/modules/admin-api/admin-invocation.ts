import {
  ADMIN_AUTHORIZATION_REQUEST_SCHEMA_VERSION,
  assertAdminAuthorized,
  type AdminAction,
  type AdminAuthorizationContext,
  type AdminAuthorizationDecision,
  type AdminAuthorizationPolicy,
} from './admin-authorization.js'
import type { OperatorPrincipal } from './operator-principal.js'

export type AdminInvocation = Readonly<{
  principal: OperatorPrincipal
  policy: AdminAuthorizationPolicy
  context: AdminAuthorizationContext
  requestReference: string
  correlationId: string
}>

export const authorizeAdminInvocation = (
  invocation: AdminInvocation,
  action: AdminAction,
  targetCampaignId: string | null,
): AdminAuthorizationDecision =>
  assertAdminAuthorized({
    principal: invocation.principal,
    policy: invocation.policy,
    context: invocation.context,
    request: {
      schemaVersion: ADMIN_AUTHORIZATION_REQUEST_SCHEMA_VERSION,
      requestReference: invocation.requestReference,
      correlationId: invocation.correlationId,
      action,
      targetCampaignId,
    },
  })
