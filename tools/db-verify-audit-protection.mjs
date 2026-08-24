// `pnpm db:verify-audit-protection` — assert the audit log is actually append-only.
//
// Run this after ANY restore, and after any migration that touched audit_logs.
//
// The failure it exists to catch is quiet by construction: a database that has been restored with
// `--no-owner --no-acl`, or whose triggers came back as 'O' (origin) instead of 'A' (always), runs
// the application perfectly. Every test passes. The only difference is that history can now be
// rewritten, and nothing anywhere says so.
//
// Four properties are checked, because they fail independently:
//
//   1. The three triggers exist and are ENABLE ALWAYS. A trigger at 'O' is disabled by
//      `SET session_replication_role = replica`, which is how the table was bypassable before
//      migration 0002.
//   2. No non-superuser role holds UPDATE, DELETE or TRUNCATE on the table. A migration that
//      recreates audit_logs picks the privileges back up from ALTER DEFAULT PRIVILEGES, silently.
//   3. The role the APPLICATION connects as is neither the owner nor a superuser. Check 2 excludes
//      both, so without this one, pointing DATABASE_URL back at the owner passes every check here
//      while leaving the table freely deletable — the protection reported as verified would be
//      entirely notional.
//   4. No SECURITY DEFINER function in `public` is executable by the application role. Such a
//      function runs as its owner, so it bypasses checks 1-3 entirely. This one is a DETECTOR
//      rather than a preventer, and deliberately so — see the note beside it below.

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

  // --- 3. the role the APPLICATION uses is constrained by checks 1 and 2 at all ---
  //
  // Check 2 skips superusers and the owner because no ACL can constrain them. That exclusion is
  // correct and it is also the blind spot: if the application connects as one of them, check 2
  // inspects roles that are not the application and reports success.
  const appUser = process.env.APP_DB_USER
  if (appUser === undefined || appUser === '') {
    problems.push(
      'APP_DB_USER is not set, so the role the application connects as cannot be checked. ' +
        'Checks 1 and 2 cannot tell whether they constrain the application or only bystanders.',
    )
  } else {
    // BOTH 'USAGE' AND 'MEMBER', because they answer different questions and only one of them was
    // asked here originally. 'USAGE' is true when the privileges are INHERITED automatically.
    // 'MEMBER' is true whenever the role may `SET ROLE` to the owner — which a member created
    // `WITH INHERIT FALSE` can still do, acquiring ownership on demand while 'USAGE' reports false.
    // The comment below already claimed SET ROLE was covered; this is what makes that true.
    const role = await client.query(
      `WITH owner AS (
         SELECT pg_get_userbyid(relowner) AS name FROM pg_class WHERE oid = 'audit_logs'::regclass
       )
       SELECT r.rolsuper,
              r.rolname = (SELECT name FROM owner) AS is_owner,
              pg_has_role(r.rolname, (SELECT name FROM owner), 'USAGE') AS inherits_owner,
              pg_has_role(r.rolname, (SELECT name FROM owner), 'MEMBER') AS can_become_owner
         FROM pg_roles r WHERE r.rolname = $1`,
      [appUser],
    )
    const app = role.rows[0]

    if (app === undefined) {
      problems.push(`APP_DB_USER names "${appUser}", which does not exist. Run \`pnpm db:migrate\`.`)
    } else {
      if (app.rolsuper === true) {
        problems.push(`the application connects as "${appUser}", a SUPERUSER — every REVOKE above is inert against it`)
      }
      if (app.is_owner === true) {
        problems.push(
          `the application connects as "${appUser}", which OWNS audit_logs — it can run ` +
            'ALTER TABLE ... DISABLE TRIGGER and then delete, whatever is revoked',
        )
      }
      // Membership is as good as ownership, by either route.
      if (app.is_owner !== true && (app.inherits_owner === true || app.can_become_owner === true)) {
        const route =
          app.inherits_owner === true
            ? 'ownership checks follow inherited membership, so it can disable the triggers and delete'
            : 'it does not inherit, but it may SET ROLE to the owner and then disable the triggers and delete'
        problems.push(`the application role "${appUser}" is a member of the owner of audit_logs — ${route}`)
      }

      // --- 4. no SECURITY DEFINER function is a way around all of the above ---
      //
      // A SECURITY DEFINER function runs as its OWNER. One owned by the schema owner that disables
      // the triggers and deletes would let the application erase history with no DELETE privilege
      // and no trigger firing — every check above still passing.
      //
      // THIS IS A DETECTOR BECAUSE PREVENTION IS INCOMPLETE. Migration 0009 revokes PUBLIC EXECUTE
      // on the non-extension functions that exist WHEN IT RUNS, and `ALTER DEFAULT PRIVILEGES ...
      // REVOKE EXECUTE ON FUNCTIONS` does not work (measured on 16.15 — it records nothing and new
      // functions keep PUBLIC EXECUTE, unlike the table equivalent, which does apply). So a function
      // added by a LATER migration is executable by the app role until someone revokes it. This is
      // the thing that notices.
      const definers = await client.query(
        `SELECT p.oid::regprocedure::text AS signature
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND p.prosecdef
            AND has_function_privilege($1, p.oid, 'EXECUTE')`,
        [appUser],
      )
      for (const row of definers.rows) {
        problems.push(
          `"${appUser}" can execute SECURITY DEFINER function ${row.signature} — it runs as its ` +
            'owner, so it routes around every REVOKE on audit_logs. ' +
            `Fix with: REVOKE EXECUTE ON FUNCTION ${row.signature} FROM PUBLIC;`,
        )
      }
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
      '  In both cases the fix is `pnpm db:migrate`. Note WHAT repairs it: a drizzle migration runs\n' +
      '  once and is never replayed, so migration 0009 applies no SQL on an existing database. The\n' +
      '  repair is tools/db-provision-role.mjs, which db:migrate runs afterwards every time and\n' +
      '  re-asserts the grants and the carve-out. See docs/backup-and-restore.md.\n\n',
  )
  process.exit(1)
}

process.stdout.write(
  '  audit-log protection verified: 3 triggers ENABLE ALWAYS, no role can rewrite history,\n' +
    `  and the application connects as "${String(process.env.APP_DB_USER)}", which owns nothing\n`,
)
