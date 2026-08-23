// The provider gateway: the authenticated webhook edge (PRD §18.3).

export { ProviderGatewayModule } from './provider-gateway.module.js'
export { ProviderRegistry } from './provider-registry.js'
export { SignatureGuard } from './signature.guard.js'
export { RateLimitGuard } from './rate-limit.guard.js'
export { WebhookRateLimiter } from './rate-limit.js'
export type { RateLimitPolicy, RateLimitDecision } from './rate-limit.js'
export { ContractErrorFilter } from './contract-error.filter.js'
export { RAW_BODY, collectRawBody, createRawBodyMiddleware } from './raw-body.middleware.js'
export type { RequestWithRawBody } from './raw-body.middleware.js'
export * from './signature/index.js'
