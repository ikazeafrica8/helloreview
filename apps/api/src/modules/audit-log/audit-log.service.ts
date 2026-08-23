import { Inject, Injectable } from '@nestjs/common'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { auditLogs } from '@helloreview/db'
import { currentCorrelationId, type Logger } from '@helloreview/observability'
import { APP_LOGGER, POSTGRES_POOL } from '../platform-core/index.js'
import { isProtectedAction } from './reason-codes.js'

export type AuditActorType = 'system' | 'operator' | 'participant' | 'provider' | 'scheduler'
export type AuditResult = 'success' | 'failure' | 'rejected'

export interface AuditEntry {
  actorType: AuditActorType
  /** MUST already be masked or pseudonymous — see maskIdentifier (SPEC.md §21.4). */
  actorId: string
  /**
   * Prefer a constant from AUDIT_ACTION. Typed as string rather than the union because a module
   * landing later will have actions this registry has not heard of yet, and rejecting them here
   * would push callers into casting — which is worse than accepting an unfamiliar name.
   */
  action: string
  targetType: string
  targetId: string
  result: AuditResult
  /** A reason CODE, not prose. */
  reason?: string
  /** Masked evidence references only. Never raw personal data. */
  detail?: Record<string, unknown>
  /** Defaults to now; pass an event's own timestamp when recording something that already happened. */
  occurredAt?: Date
}

/** Thrown when the audit write fails, so a caller cannot proceed believing it was recorded. */
export class AuditWriteError extends Error {
  override readonly name = 'AuditWriteError'

  constructor(
    readonly action: string,
    readonly protectedAction: boolean,
    override readonly cause: unknown,
  ) {
    super(`Failed to record audit entry for "${action}"`)
  }
}

@Injectable()
export class AuditLogService {
  private readonly db

  constructor(
    @Inject(POSTGRES_POOL) pool: Pool,
    @Inject(APP_LOGGER) private readonly logger: Logger,
  ) {
    this.db = drizzle(pool)
  }

  /**
   * Record one entry.
   *
   * THROWS RATHER THAN SWALLOWS. An audit write that fails quietly leaves the system having done
   * something it cannot explain — and SPEC.md §9 requires every automated decision to remain
   * reconstructable from this log. The caller decides what to do about it; it must not be able to
   * proceed unaware.
   *
   * For a PROTECTED action the failure is additionally a critical incident (PRD §23.3), logged at
   * fatal so alerting picks it up rather than leaving it in the noise of ordinary errors.
   */
  async record(entry: AuditEntry): Promise<void> {
    const protectedAction = isProtectedAction(entry.action)

    try {
      await this.db.insert(auditLogs).values({
        actorType: entry.actorType,
        actorId: entry.actorId,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        result: entry.result,
        reason: entry.reason ?? null,
        // Taken from the ambient scope rather than the caller: an entry that had to be told its own
        // correlation id is one somebody will eventually forget to tell.
        correlationId: currentCorrelationId() ?? null,
        protectedAction: protectedAction ? 'yes' : 'no',
        detail: entry.detail ?? null,
        ...(entry.occurredAt === undefined ? {} : { occurredAt: entry.occurredAt }),
      })
    } catch (error) {
      const context = {
        operation: 'audit.record',
        result: 'error',
        errorCategory: error instanceof Error ? error.name : 'unknown',
        actorId: entry.actorId,
      }

      if (protectedAction) {
        // PRD §23.3: "Audit-log failure for protected actions" is an immediate alert.
        this.logger.fatal(`CRITICAL: audit write failed for protected action ${entry.action}`, context)
      } else {
        this.logger.error(`audit write failed for ${entry.action}`, context)
      }

      throw new AuditWriteError(entry.action, protectedAction, error)
    }
  }
}
