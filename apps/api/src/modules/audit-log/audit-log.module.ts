import { Module } from '@nestjs/common'
import { AuditLogService } from './audit-log.service.js'

/**
 * Preserves decision and access evidence (SPEC.md §3.1, `audit-log`).
 *
 * Depends only on platform-core, which is what the capability map says and what keeps this module
 * importable by every later one without creating a cycle.
 */
@Module({
  providers: [AuditLogService],
  exports: [AuditLogService],
})
export class AuditLogModule {}
