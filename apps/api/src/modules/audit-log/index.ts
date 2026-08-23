// The ONLY public surface of audit-log (SPEC.md §5).

export { AuditLogModule } from './audit-log.module.js'
export { AuditLogService, AuditWriteError } from './audit-log.service.js'
export type { AuditEntry, AuditActorType, AuditResult } from './audit-log.service.js'
export { AUDIT_ACTION, PROTECTED_ACTIONS, isProtectedAction } from './reason-codes.js'
export type { AuditAction } from './reason-codes.js'
