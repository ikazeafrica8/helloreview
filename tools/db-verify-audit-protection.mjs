// `pnpm db:verify-audit-protection` — assert the audit log is actually append-only.
//
// Run this after ANY restore, and after any migration that touched audit_logs.
//
// The failure it exists to catch is quiet by construction: a database that has been restored with
// `--no-owner --no-acl`, or whose triggers came back as 'O' (origin) instead of 'A' (always), runs
// the application perfectly. Every test passes. The only difference is that history can now be
// rewritten, and nothing anywhere says so.
//
// Two properties are checked, because they fail independently:
//
//   1. The three triggers exist and are ENABLE ALWAYS. A trigger at 'O' is disabled by
//      `SET session_replication_role = replica`, which is how the table was bypassable before
//      migration 0002.
//   2. No non-superuser role holds UPDATE, DELETE or TRUNCATE on the table. This is a no-op until
//      the role split lands, and becomes the load-bearing check afterwards — in particular a
//      migration that recreates audit_logs picks the privileges back up from ALTER DEFAULT
//      PRIVILEGES, silently.

import { Client } from 'pg'
import { requireMigrationUrl } from './db-target.mjs'

const url = requireMigrationUrl('db:verify-audit-protection')

const REQUIRED_TRIGGERS = ['audit_logs_no_delete', 'audit_logs_no_truncate', 'audit_logs_no_update']

const problems = []
const client = new Client({ connectionString: url })
await client.connect()

try {
  const table = await client.query(`SELECT to_regclass('public.audit_logs') AS oid`)
  if (table.rows[0]?.oid === null) {
    process.stderr.write('\n  db:verify-audit-protection failed\n\n  audit_logs does not exist.\n\n')
    process.exit(1)
  }

  // --- 1. triggers present and ALWAYS ---
  const triggers = await client.query(
    `SELECT tgname, tgenabled FROM pg_trigger
      WHERE tgrelid = 'audit_logs'::regclass AND NOT tgisinternal`,
  )
  const byName = new Map(triggers.rows.map((row) => [row.tgname, row.tgenabled]))

  for (const name of REQUIRED_TRIGGERS) {
    const state = byName.get(name)
    if (state === undefined) {
      problems.push(`trigger ${name} is missing — audit_logs is not append-only`)
    } else if (state !== 'A') {
      problems.push(
        `trigger ${name} is '${String(state)}', not 'A' (ENABLE ALWAYS) — ` +
          'a session can disable it with SET session_replication_role = replica',
      )
    }
  }

  // --- 2. no role can rewrite history ---
  // Superusers and the table owner are excluded deliberately: no ACL can constrain them, that is
  // the documented residual gap, and flagging them would make this check cry wolf every run.
  const rewriters = await client.query(
    `SELECT r.rolname,
            array_remove(ARRAY[
              CASE WHEN has_table_privilege(r.rolname,'audit_logs','UPDATE')   THEN 'UPDATE'   END,
              CASE WHEN has_table_privilege(r.rolname,'audit_logs','DELETE')   THEN 'DELETE'   END,
              CASE WHEN has_table_privilege(r.rolname,'audit_logs','TRUNCATE') THEN 'TRUNCATE' END
            ], NULL) AS held
       FROM pg_roles r
      WHERE NOT r.rolsuper
        AND r.rolname NOT LIKE 'pg\\_%'
        AND r.rolname <> (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'audit_logs'::regclass)`,
  )

  for (const row of rewriters.rows) {
    if (row.held.length > 0) {
      problems.push(
        `role "${row.rolname}" holds ${row.held.join(', ')} on audit_logs — it can rewrite history. ` +
          'A migration that recreated the table re-grants these from ALTER DEFAULT PRIVILEGES.',
      )
    }
  }
} finally {
  await client.end()
}

if (problems.length > 0) {
  process.stderr.write(
    `\n  db:verify-audit-protection FAILED — ${String(problems.length)} problem(s)\n\n` +
      problems.map((p) => `    - ${p}`).join('\n') +
      '\n\n  The two ways this normally happens, both measured:\n' +
      '    - a broad `GRANT ALL ON ALL TABLES IN SCHEMA public`, usually run to fix an application\n' +
      '      that lost access after a restore. It re-grants DELETE on audit_logs as a side effect.\n' +
      '    - a migration that DROPped and recreated audit_logs: the new table picks its privileges\n' +
      '      up from ALTER DEFAULT PRIVILEGES, DELETE included.\n\n' +
      '  In both cases the fix is `pnpm db:migrate`, which re-applies the REVOKE. It is idempotent.\n' +
      '  See docs/backup-and-restore.md.\n\n',
  )
  process.exit(1)
}

process.stdout.write('  audit-log protection verified: 3 triggers ENABLE ALWAYS, no role can rewrite history\n')
