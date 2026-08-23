// Integration tier: the audit log is genuinely append-only, and a failed write is not swallowed (T13).
//
// Runs against an ephemeral database so the append-only triggers are exercised from a real migration
// rather than from whatever state the dev database happens to be in.

import { test, describe, beforeAll, expect } from 'vitest'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = dirname(dirname(import.meta.dirname))
const importBuilt = async (relativePath) => import(pathToFileURL(join(ROOT, relativePath)).href)

/** A logger that records rather than prints, so the test can assert on the critical alert. */
const recordingLogger = () => {
  const entries = []
  const at = (level) => (message, context) => entries.push({ level, message, context })
  return {
    entries,
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    child: () => recordingLogger(),
  }
}

describe('audit log', () => {
  beforeAll(() => {
    for (const workspace of ['packages/observability', 'packages/db', 'packages/testing', 'apps/api']) {
      const build = spawnSync('node', [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], {
        cwd: join(ROOT, workspace),
        encoding: 'utf8',
        timeout: 300_000,
      })
      expect(build.status, `${workspace} must compile:\n${build.stdout}${build.stderr}`).toBe(0)
    }
  })

  test('records an entry, taking the correlation id from the ambient scope', async () => {
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations } = await importBuilt('packages/db/dist/index.js')
    const { AuditLogService } = await importBuilt('apps/api/dist/modules/audit-log/index.js')
    const { runWithCorrelation } = await importBuilt('packages/observability/dist/index.js')
    const { Pool } = await import('pg')

    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      try {
        const service = new AuditLogService(pool, recordingLogger())

        await runWithCorrelation('cor_audit_probe', async () =>
          service.record({
            actorType: 'operator',
            // Already masked by the caller — the table never holds a raw identifier.
            actorId: 'id_a1b2c3d4e5',
            action: 'SELECTION_OVERRIDDEN',
            targetType: 'workflow',
            targetId: 'wf_123',
            result: 'success',
            reason: 'OPERATOR_APPROVED',
            detail: { ruleVersion: 'selection-v3' },
          }),
        )

        const { rows } = await pool.query('select * from audit_logs')
        expect(rows).toHaveLength(1)
        const [row] = rows

        expect(row.actor_type).toBe('operator')
        expect(row.action).toBe('SELECTION_OVERRIDDEN')
        expect(row.result).toBe('success')
        expect(row.reason).toBe('OPERATOR_APPROVED')
        // Taken from the scope, not passed in: an entry that must be told its own correlation id is
        // one somebody will eventually forget to tell.
        expect(row.correlation_id).toBe('cor_audit_probe')
        // Classified at write time, so a later change to the protected list cannot retroactively
        // reclassify what was already recorded.
        expect(row.protected_action).toBe('yes')
        expect(row.occurred_at).toBeInstanceOf(Date)
      } finally {
        await pool.end()
      }
    })
  })

  test('the database rejects UPDATE, DELETE and TRUNCATE', async () => {
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations } = await importBuilt('packages/db/dist/index.js')
    const { Pool } = await import('pg')

    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      try {
        await pool.query(
          "insert into audit_logs (actor_type, actor_id, action, target_type, target_id, result) values ('system','id_x','PROBE','workflow','wf_1','success')",
        )

        // Application discipline is not enough for a table whose whole purpose is to be trustworthy
        // after the fact.
        for (const statement of [
          "update audit_logs set action = 'TAMPERED'",
          'delete from audit_logs',
          'truncate audit_logs',
        ]) {
          await expect(pool.query(statement), `"${statement}" should have been rejected`).rejects.toThrow(/append-only/)
        }

        // TRUNCATE does not fire DELETE triggers, which is why it needs its own — and why this
        // assertion matters rather than being redundant.
        const { rows } = await pool.query('select count(*)::int as count from audit_logs')
        expect(rows[0].count).toBe(1)
      } finally {
        await pool.end()
      }
    })
  })

  test('a failed write for a PROTECTED action raises a critical alert and reaches the caller', async () => {
    const { AuditLogService, AuditWriteError } = await importBuilt('apps/api/dist/modules/audit-log/index.js')
    const { Pool } = await import('pg')

    // A pool pointed at a closed port: the write cannot succeed, which is the whole point.
    const pool = new Pool({
      connectionString: 'postgres://nobody:nobody@127.0.0.1:1/nothing',
      connectionTimeoutMillis: 1_000,
    })
    pool.on('error', () => undefined)
    const logger = recordingLogger()

    try {
      const service = new AuditLogService(pool, logger)

      await expect(
        service.record({
          actorType: 'system',
          actorId: 'id_x',
          action: 'GUIDELINE_DELIVERED',
          targetType: 'workflow',
          targetId: 'wf_1',
          result: 'success',
        }),
      ).rejects.toThrow(AuditWriteError)

      // PRD §23.3 lists audit-log failure for a protected action as an immediate alert, so it must
      // be distinguishable from the ordinary error noise.
      const critical = logger.entries.filter((entry) => entry.level === 'fatal')
      expect(critical).toHaveLength(1)
      expect(critical[0].message).toMatch(/CRITICAL/)
      expect(critical[0].message).toMatch(/GUIDELINE_DELIVERED/)
    } finally {
      await pool.end().catch(() => undefined)
    }
  })

  test('a failed write for an UNPROTECTED action still reaches the caller, at a lower level', async () => {
    const { AuditLogService } = await importBuilt('apps/api/dist/modules/audit-log/index.js')
    const { Pool } = await import('pg')

    const pool = new Pool({
      connectionString: 'postgres://nobody:nobody@127.0.0.1:1/nothing',
      connectionTimeoutMillis: 1_000,
    })
    pool.on('error', () => undefined)
    const logger = recordingLogger()

    try {
      const service = new AuditLogService(pool, logger)
      await expect(
        service.record({
          actorType: 'system',
          actorId: 'id_x',
          action: 'HEALTH_CHECKED',
          targetType: 'service',
          targetId: 'api',
          result: 'success',
        }),
      ).rejects.toThrow(/Failed to record audit entry/)

      // Never swallowed — but not an alert either, because losing this record does not make any
      // decision unexplainable.
      expect(logger.entries.filter((entry) => entry.level === 'fatal')).toHaveLength(0)
      expect(logger.entries.filter((entry) => entry.level === 'error')).toHaveLength(1)
    } finally {
      await pool.end().catch(() => undefined)
    }
  })
})
