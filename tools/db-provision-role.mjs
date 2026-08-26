// Create the application's LOGIN role and put it in the privilege group.
//
// WHY THIS IS NOT IN THE MIGRATION. A LOGIN role needs a password, and a password in a committed
// migration is a SPEC.md §8 "Never". Migration 0009 owns the GRANTS — identical everywhere and
// reviewable in git — and this owns the credential, which comes from the environment.
//
// Splitting it this way also avoids a shortcut that does not work: a LOGIN role created with no
// password cannot authenticate under the postgres:16 image's scram-sha-256 host rules, so "create
// the role in the migration and set the password later" produces a system that does not boot.
//
// IT MUST BE RE-RUNNABLE, AND IT MUST RESET THE PASSWORD. Roles are cluster-wide: `db:reset` drops
// schemas but not roles, `services:down` keeps the volume, and nothing in this repo can drop one. A
// password typo'd once would otherwise persist forever and silently beat a corrected .env — the
// symptom being "password authentication failed" against a .env that is already right.

import { Client } from 'pg'
import { requireMigrationUrl } from './db-target.mjs'

const PRIVILEGE_GROUP = 'helloreview_app'
const OWNER_ROLE = 'helloreview'

const fail = (message) => {
  process.stderr.write(`\n  db:provision-role failed\n\n  ${message}\n\n`)
  process.exit(1)
}

const url = requireMigrationUrl('db:provision-role')

const appUser = process.env.APP_DB_USER
const appPassword = process.env.APP_DB_PASSWORD

if (appUser === undefined || appUser === '') {
  fail('APP_DB_USER is not set. It names the role the api and worker connect as.')
}
if (appPassword === undefined || appPassword === '') {
  fail('APP_DB_PASSWORD is not set. It is the credential the api and worker authenticate with.')
}
if (appUser === OWNER_ROLE || appUser === PRIVILEGE_GROUP) {
  // The first would make the application the owner again, undoing the whole point. The second would
  // give a LOGIN password to the NOLOGIN group and try to make it a member of itself.
  fail(`APP_DB_USER must not be "${appUser}" — that is the schema owner or the privilege group itself.`)
}

// No disposable-environment guard: provisioning a role is exactly what a deployment does, so unlike
// db:reset this must run against real environments. It creates and grants; it drops nothing.

const client = new Client({ connectionString: url })
await client.connect()

try {
  // ONE TRANSACTION, and not for atomicity alone: a transaction-local setting outside a transaction
  // block is silently discarded, so the DO block below would fail on an unrecognized parameter.
  // CREATE ROLE and GRANT are transactional in PostgreSQL, so a failed assertion rolls the role back.
  await client.query('BEGIN')

  // Passed as SETTINGS rather than concatenated, so neither the role name nor the password is
  // interpolated into a statement string that could reach a log line or an error message.
  //
  // set_config() rather than `SET LOCAL`: SET is parsed before parameters are bound, so `SET LOCAL
  // x = $1` is a syntax error, not a substitution. The third argument is the is_local flag — pass
  // it as false and the password persists for the whole session.
  await client.query('SELECT set_config($1, $2, true)', ['helloreview.app_user', appUser])
  await client.query('SELECT set_config($1, $2, true)', ['helloreview.app_password', appPassword])

  await client.query(`
    DO $do$
    DECLARE
      app_user text := current_setting('helloreview.app_user');
      app_pw   text := current_setting('helloreview.app_password');
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PRIVILEGE_GROUP}') THEN
        RAISE EXCEPTION 'the privilege group ${PRIVILEGE_GROUP} does not exist'
          USING HINT = 'Run pnpm db:migrate first; migration 0009 creates it.';
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_user) THEN
        EXECUTE format(
          'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
          app_user, app_pw);
      ELSE
        -- Re-runnable ON PURPOSE, and this branch is the reason. See the note at the top.
        EXECUTE format(
          'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
          app_user, app_pw);
      END IF;

      EXECUTE format('GRANT ${PRIVILEGE_GROUP} TO %I', app_user);

      -- THE TRAP THAT VOIDS THE ENTIRE SCHEME. Ownership checks follow role membership, so a member
      -- of the owner can DISABLE TRIGGER and delete audit history despite holding no DELETE
      -- privilege. Refused here as well as in migration 0009, because this script is what a
      -- deployment runs and the membership could be added by hand afterwards.
      IF pg_has_role(app_user, '${OWNER_ROLE}', 'USAGE') OR pg_has_role(app_user, '${OWNER_ROLE}', 'MEMBER') THEN
        RAISE EXCEPTION '% has the privileges of the schema owner; the privilege separation is void', app_user
          USING HINT = 'Revoke that membership. WITH INHERIT FALSE does not help — SET ROLE still works.';
      END IF;
    END
    $do$;
  `)

  // RE-ASSERT THE GRANTS, because nothing else can.
  //
  // A migration runs ONCE. drizzle records it in `drizzle.__drizzle_migrations` and then applies a
  // migration only when `lastDbMigration.created_at < migration.folderMillis`; after 0009 lands,
  // that comparison is false forever. So `pnpm db:migrate` on an existing database applies zero SQL,
  // and the two documented ways the carve-out gets undone had NO working repair:
  //
  //   `GRANT ALL ON ALL TABLES IN SCHEMA public TO helloreview_app` — the reflex fix for an app that
  //   lost access after a restore — re-grants DELETE on audit_logs. Measured: db:migrate alone left
  //   has_table_privilege(...,'DELETE') true.
  //
  //   `pg_restore --no-owner --no-acl` strips every grant, so the app loses even USAGE and fails
  //   closed on every query. Measured: db:migrate alone left USAGE false.
  //
  // The only thing that replayed them was `pnpm db:reset`, which refuses off loopback — i.e. exactly
  // where a restore happens. This block runs on EVERY db:migrate, is idempotent, and is what makes
  // the recovery in docs/backup-and-restore.md true rather than aspirational.
  //
  // Ordered as in migration 0009: the carve-out MUST follow the blanket table grant above it.
  await client.query(`GRANT USAGE ON SCHEMA public TO ${PRIVILEGE_GROUP}`)
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${PRIVILEGE_GROUP}`)
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${PRIVILEGE_GROUP}`)
  await client.query(`REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON audit_logs FROM ${PRIVILEGE_GROUP}`)
  await client.query(
    `REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
       ON business_approvals, guideline_delivery_attempts FROM ${PRIVILEGE_GROUP}`,
  )
  await client.query(
    `REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
       ON attachments, attachment_security_events, attachment_lifecycle_events, attachment_grant_events
       FROM ${PRIVILEGE_GROUP}`,
  )
  await client.query(
    `REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
       ON selection_recommendations, selection_manual_decisions, selection_shadow_comparisons,
          shipping_addresses, shipping_address_reveals,
          payback_consent_aggregates, payback_consent_versions, payback_consent_requests,
          payback_consent_response_events,
          reservations, reservation_versions,
          human_review_task_events, human_review_holding_messages,
          privacy_request_events, privacy_request_processing_pauses,
          privacy_retention_schedules, privacy_retention_schedule_entries,
          privacy_legal_holds, privacy_legal_hold_events,
          privacy_deletion_eligibility_evaluations,
          admin_retry_operations
       FROM ${PRIVILEGE_GROUP}`,
  )

  // The function revoke, repeated from the migration for a case the migration cannot reach: this
  // runs AFTER every migration, so a SECURITY DEFINER function created by a LATER migration is
  // caught here. Inside 0009 it never could be — `db:reset` replays 0009 before 0010 exists.
  await client.query(`
    DO $do$
    DECLARE
      fn record;
    BEGIN
      FOR fn IN
        SELECT p.oid::regprocedure AS signature
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           -- citext and pg_trgm live in public. Revoking their EXECUTE breaks §17.3 uniqueness
           -- and §16.1 matching for the app role.
           AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
      LOOP
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', fn.signature);
      END LOOP;
    END
    $do$;
  `)

  // Verified rather than assumed: the point of the whole exercise is one specific refusal, and a
  // migration replayed out of order is enough to undo it.
  const { rows } = await client.query(
    `SELECT has_table_privilege($1, 'audit_logs', 'DELETE') AS can_delete,
            has_table_privilege($1, 'audit_logs', 'UPDATE') AS can_update,
            has_table_privilege($1, 'audit_logs', 'INSERT') AS can_insert,
            (SELECT rolsuper FROM pg_roles WHERE rolname = $1) AS is_superuser`,
    [appUser],
  )
  const grants = rows[0] ?? {}

  if (grants.is_superuser === true) {
    await client.query('ROLLBACK')
    fail(`${appUser} is a superuser, so every REVOKE in migration 0009 is inert.`)
  }
  if (grants.can_delete === true || grants.can_update === true) {
    await client.query('ROLLBACK')
    fail(`${appUser} can rewrite audit_logs. The carve-out in migration 0009 is not in effect.`)
  }
  if (grants.can_insert !== true) {
    await client.query('ROLLBACK')
    fail(`${appUser} cannot INSERT into audit_logs. Every audited action would fail closed.`)
  }

  const appendOnlyHistoryTables = [
    'attachments',
    'attachment_security_events',
    'attachment_lifecycle_events',
    'attachment_grant_events',
    'selection_recommendations',
    'selection_manual_decisions',
    'selection_shadow_comparisons',
    'shipping_addresses',
    'shipping_address_reveals',
    'payback_consent_aggregates',
    'payback_consent_versions',
    'payback_consent_requests',
    'payback_consent_response_events',
    'reservations',
    'reservation_versions',
    'human_review_task_events',
    'human_review_holding_messages',
    'privacy_request_events',
    'privacy_request_processing_pauses',
    'privacy_retention_schedules',
    'privacy_retention_schedule_entries',
    'privacy_legal_holds',
    'privacy_legal_hold_events',
    'privacy_deletion_eligibility_evaluations',
    'admin_retry_operations',
  ]
  const appendOnlyHistoryPrivileges = await client.query(
    `SELECT table_name,
            has_table_privilege($1, table_name, 'SELECT') AS can_select,
            has_table_privilege($1, table_name, 'INSERT') AS can_insert,
            has_table_privilege($1, table_name, 'UPDATE') AS can_update,
            has_table_privilege($1, table_name, 'DELETE') AS can_delete,
            has_table_privilege($1, table_name, 'TRUNCATE') AS can_truncate
       FROM unnest($2::text[]) AS protected_table(table_name)`,
    [appUser, appendOnlyHistoryTables],
  )
  for (const table of appendOnlyHistoryPrivileges.rows) {
    if (table.can_select !== true || table.can_insert !== true) {
      await client.query('ROLLBACK')
      fail(`${appUser} cannot append and read ${table.table_name}. Immutable workflow evidence would fail closed.`)
    }
    if (table.can_update === true || table.can_delete === true || table.can_truncate === true) {
      await client.query('ROLLBACK')
      fail(`${appUser} can rewrite append-only history in ${table.table_name}.`)
    }
  }

  await client.query('COMMIT')

  process.stdout.write(
    `  provisioned ${appUser} in ${PRIVILEGE_GROUP}\n` +
      '    append-only history: INSERT and SELECT only — UPDATE, DELETE and TRUNCATE are revoked\n',
  )
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined)

  // REDACTED, not merely trusted to be clean. When a statement inside the DO block fails,
  // PostgreSQL attaches the failing statement text — `CREATE ROLE ... PASSWORD 'literal'` — as the
  // error's CONTEXT. `.message` alone does not carry it today, which is why this reads as belt and
  // braces; but printing a credential to a terminal, a CI log, or somebody's pasted bug report is a
  // SPEC.md §8 "Never", and "the driver does not currently expose that field in .message" is a thin
  // thing to rest that on.
  const raw = error instanceof Error ? `${error.message}${error.where === undefined ? '' : `\n  ${error.where}`}` : ''
  fail(raw === '' ? String(error) : raw.split(appPassword).join('[redacted]'))
} finally {
  await client.end()
}
