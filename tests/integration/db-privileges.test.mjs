// Integration tier: the application's database role cannot rewrite history.
//
// WHY THIS TEST EXISTS AT ALL. Migration 0002 made the audit triggers ENABLE ALWAYS, which closed
// the `SET session_replication_role = replica` bypass. It could not close the one underneath it: no
// trigger can defend a table against its own OWNER, who may simply run
//
//     ALTER TABLE audit_logs DISABLE TRIGGER ALL;  DELETE FROM audit_logs;
//
// That was measured working, and while the application connected as the owner it meant the audit
// log was append-only in appearance only. Migration 0009 plus tools/db-provision-role.mjs give the
// application a non-owner role instead. This asserts the outcome.
//
// TWO THINGS IT REFUSES TO DO, both of which would make it pass while proving nothing:
//
//   1. It does not `SET ROLE` to the app role from an owner session. A session that can SET ROLE in
//      can SET ROLE straight back out, so every refusal it observes is one the real attacker steps
//      around. It opens a SEPARATE CONNECTION that authenticates as the app role, which is what the
//      api and worker actually do.
//   2. It does not re-implement the provisioning SQL. It runs `tools/db-provision-role.mjs` — the
//      file `pnpm db:migrate` runs — as a subprocess. A test that verified a copy of the SQL would
//      keep passing after the shipped script broke, which is the failure mode this suite has hit
//      before.

import { test, describe, beforeAll, expect } from 'vitest'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = dirname(dirname(import.meta.dirname))
const importBuilt = async (relativePath) => import(pathToFileURL(join(ROOT, relativePath)).href)

const APP_USER = 'helloreview_app_probe'
const APP_PASSWORD = 'probe_password_local_only'

/** The connection string the application would use, given the owner's. */
const appUrlFrom = (ownerUrl) => {
  const url = new URL(ownerUrl)
  url.username = APP_USER
  url.password = APP_PASSWORD
  return url.toString()
}

/**
 * Run the shipped provisioning tool against `ownerUrl`.
 *
 * NODE_ENV is passed through as 'test' deliberately: the tool has no disposable-environment guard,
 * and asserting it runs here is part of the point — a deployment must be able to run it.
 */
const provisionAppRole = (ownerUrl) =>
  spawnSync(process.execPath, [join(ROOT, 'tools', 'db-provision-role.mjs')], {
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      DATABASE_MIGRATION_URL: ownerUrl,
      APP_DB_USER: APP_USER,
      APP_DB_PASSWORD: APP_PASSWORD,
    },
  })

describe('the application database role', () => {
  beforeAll(() => {
    for (const workspace of ['packages/db', 'packages/testing']) {
      const build = spawnSync('node', [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], {
        cwd: join(ROOT, workspace),
        encoding: 'utf8',
        timeout: 300_000,
      })
      expect(build.status, `${workspace} must compile:\n${build.stdout}${build.stderr}`).toBe(0)
    }
  })

  test('is refused every route to rewriting audit_logs, while ordinary work still succeeds', async () => {
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations } = await importBuilt('packages/db/dist/index.js')
    const { Client } = await import('pg')

    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)

      const provisioned = provisionAppRole(postgres.url)
      expect(
        provisioned.status,
        `tools/db-provision-role.mjs must succeed:\n${provisioned.stdout}${provisioned.stderr}`,
      ).toBe(0)

      // Seed as the OWNER, so the rows the app tries to delete below were not written by it.
      const owner = new Client({ connectionString: postgres.url })
      await owner.connect()
      try {
        await owner.query(
          `INSERT INTO audit_logs (actor_type, actor_id, action, target_type, target_id, result)
           VALUES ('system', 'id_seed', 'SEEDED', 'workflow', 'wf_seed', 'success')`,
        )
        await owner.query(
          `INSERT INTO campaigns (code, name, type, starts_at, ends_at)
           VALUES ('privilege-probe', 'Privilege Probe', 'visit', now(), now() + interval '30 days')`,
        )
      } finally {
        await owner.end()
      }

      // A REAL authenticated connection as the app role. Not SET ROLE — see the header.
      const app = new Client({ connectionString: appUrlFrom(postgres.url) })
      await app.connect()
      try {
        const identity = await app.query(
          `SELECT current_user AS who,
                  (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser`,
        )
        // Guards the whole suite against being vacuous: everything below is only meaningful if this
        // connection is genuinely the restricted role rather than the owner under another name.
        expect(identity.rows[0]?.who).toBe(APP_USER)
        expect(identity.rows[0]?.is_superuser).toBe(false)

        const refuse = async (label, sql, expected) => {
          let message = null
          try {
            await app.query(sql)
          } catch (error) {
            message = error instanceof Error ? error.message : String(error)
          }
          expect(message, `${label} was ALLOWED for the application role`).not.toBeNull()
          expect(message, `${label} failed for an unexpected reason: ${String(message)}`).toMatch(expected)
        }

        // --- every route to erasing history ---
        await refuse('DELETE FROM audit_logs', 'DELETE FROM audit_logs', /permission denied/i)
        await refuse('UPDATE audit_logs', `UPDATE audit_logs SET action = 'TAMPERED'`, /permission denied/i)
        await refuse('TRUNCATE audit_logs', 'TRUNCATE audit_logs', /permission denied/i)

        const protectedHistoryTables = [
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
          'reservations',
          'reservation_versions',
        ]
        const protectedHistory = await app.query(
          `SELECT table_name,
                  has_table_privilege(current_user, table_name, 'SELECT') AS can_select,
                  has_table_privilege(current_user, table_name, 'INSERT') AS can_insert,
                  has_table_privilege(current_user, table_name, 'UPDATE') AS can_update,
                  has_table_privilege(current_user, table_name, 'DELETE') AS can_delete,
                  has_table_privilege(current_user, table_name, 'TRUNCATE') AS can_truncate
             FROM unnest($1::text[]) AS protected_table(table_name)
            ORDER BY table_name`,
          [protectedHistoryTables],
        )
        expect(protectedHistory.rows).toEqual(
          protectedHistoryTables.sort().map((tableName) => ({
            table_name: tableName,
            can_select: true,
            can_insert: true,
            can_update: false,
            can_delete: false,
            can_truncate: false,
          })),
        )

        // The one that ENABLE ALWAYS alone could not stop, and the reason for this whole change.
        await refuse(
          'ALTER TABLE audit_logs DISABLE TRIGGER ALL',
          'ALTER TABLE audit_logs DISABLE TRIGGER ALL',
          /must be owner/i,
        )
        await refuse('DROP TABLE audit_logs', 'DROP TABLE audit_logs', /must be owner/i)

        // Dropping the triggers individually, rather than disabling them.
        await refuse(
          'DROP TRIGGER audit_logs_no_delete',
          'DROP TRIGGER audit_logs_no_delete ON audit_logs',
          /must be owner/i,
        )

        // The pre-0002 bypass. Superuser by default, but delegable since PG15 with
        // GRANT SET ON PARAMETER, so it is asserted rather than assumed.
        await refuse(
          'SET session_replication_role = replica',
          `SET session_replication_role = 'replica'`,
          /permission denied to set parameter/i,
        )

        // Becoming the owner. If this succeeded, every refusal above would be one command away
        // from being undone.
        await refuse('SET ROLE helloreview', 'SET ROLE helloreview', /permission denied to set role/i)

        // Creating its own table — which it would OWN, handing back the power just removed.
        await refuse('CREATE TABLE', 'CREATE TABLE shadow_audit (id int)', /permission denied for schema/i)

        // Renaming audit_logs out of the way and writing a permissive replacement.
        await refuse(
          'ALTER TABLE audit_logs RENAME',
          'ALTER TABLE audit_logs RENAME TO audit_logs_old',
          /must be owner/i,
        )

        // --- and the history is still there ---
        const surviving = await app.query('SELECT count(*)::int AS n FROM audit_logs')
        expect(surviving.rows[0]?.n, 'the seeded audit row must still exist').toBe(1)
      } finally {
        await app.end()
      }
    })
  })

  test('can still do every ordinary thing the application needs', async () => {
    // The other half, and the half that actually breaks a deployment. A role locked down until the
    // app cannot function is not a safer system; it is an outage. Failing here is the difference
    // between the previous test proving a privilege split and it proving a broken database.
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations } = await importBuilt('packages/db/dist/index.js')
    const { Client } = await import('pg')

    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      expect(provisionAppRole(postgres.url).status).toBe(0)

      const app = new Client({ connectionString: appUrlFrom(postgres.url) })
      await app.connect()
      try {
        // Audit: append and read, which is all the audit-log module ever does.
        await app.query(
          `INSERT INTO audit_logs (actor_type, actor_id, action, target_type, target_id, result)
           VALUES ('operator', 'id_app', 'CAMPAIGN_ACTIVATED', 'campaign', 'camp_1', 'success')`,
        )
        expect((await app.query('SELECT count(*)::int AS n FROM audit_logs')).rows[0]?.n).toBe(1)

        // Ordinary tables: the full set of verbs, including the DELETE that audit_logs refuses.
        await app.query(
          `INSERT INTO campaigns (code, name, type, starts_at, ends_at)
           VALUES ('app-role-probe', 'App Role Probe', 'visit', now(), now() + interval '30 days')`,
        )
        await app.query(`UPDATE campaigns SET name = 'Renamed' WHERE code = 'app-role-probe'`)
        await app.query(`DELETE FROM campaigns WHERE code = 'app-role-probe'`)

        // The event inbox, which the gateway writes on every webhook, and the relay updates.
        await app.query(
          `INSERT INTO event_inbox (external_event_id, source, event_type, payload_hash, payload, occurred_at)
           VALUES ('evt_probe', 'website', 'application.submitted', 'sha256:probe', '{}'::jsonb, now())`,
        )
        await app.query(`UPDATE event_inbox SET status = 'processed', processed_at = now()`)

        // citext and pg_trgm. Migration 0000 installs both into `public` with no SCHEMA clause, so
        // a blanket `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC` — the obvious way
        // to close the SECURITY DEFINER hole — would take these with it and break §17.3's citext
        // uniqueness and §16.1's trigram matching, for the application only.
        const similarity = await app.query(`SELECT similarity('스타벅스', '스타벅스 강남점') AS score`)
        expect(Number(similarity.rows[0]?.score), 'pg_trgm must remain usable by the app role').toBeGreaterThan(0)
        expect((await app.query(`SELECT 'A'::citext = 'a'::citext AS equal`)).rows[0]?.equal).toBe(true)
      } finally {
        await app.end()
      }
    })
  })

  test('the immutability triggers still fire for the restricted role', async () => {
    // Revoking privileges must not have cost the protections that were already working. A trigger
    // function is invoked implicitly, so whether PostgreSQL re-checks EXECUTE on it at fire time is
    // a question about the cluster, not about our SQL — and the answer decides whether a published
    // campaign rule is editable. Measured rather than reasoned about.
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations } = await importBuilt('packages/db/dist/index.js')
    const { Client } = await import('pg')

    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      expect(provisionAppRole(postgres.url).status).toBe(0)

      const app = new Client({ connectionString: appUrlFrom(postgres.url) })
      await app.connect()
      try {
        const { rows } = await app.query(
          `INSERT INTO campaigns (code, name, type, starts_at, ends_at)
           VALUES ('trigger-probe', 'Trigger Probe', 'visit', now(), now() + interval '30 days')
           RETURNING id`,
        )
        const campaignId = rows[0]?.id

        await app.query(
          `INSERT INTO campaign_rules (campaign_id, rule_type, version, status, configuration, effective_from)
           VALUES ($1, 'selection', 1, 'draft', '{"threshold": 10}'::jsonb, now())`,
          [campaignId],
        )

        // A draft is editable — the app must be able to do its job.
        await app.query(`UPDATE campaign_rules SET configuration = '{"threshold": 20}'::jsonb WHERE version = 1`)
        await app.query(`UPDATE campaign_rules SET status = 'published' WHERE version = 1`)

        // Published is not, and the refusal must come from the TRIGGER, not from a missing grant —
        // an important distinction, because "permission denied" here would mean the app had lost
        // the ability to publish rules at all rather than the ability to rewrite them.
        await expect(
          app.query(`UPDATE campaign_rules SET configuration = '{"threshold": 999}'::jsonb WHERE version = 1`),
        ).rejects.toThrow(/published and cannot be modified/i)

        await expect(app.query('DELETE FROM campaign_rules WHERE version = 1')).rejects.toThrow(
          /published and cannot be deleted/i,
        )

        const survived = await app.query('SELECT configuration FROM campaign_rules WHERE version = 1')
        expect(survived.rows[0]?.configuration).toEqual({ threshold: 20 })
      } finally {
        await app.end()
      }
    })
  })

  test('migration 0009 strips PUBLIC EXECUTE from our functions and spares extension functions', async () => {
    // THE ROUTE THAT DEFEATS EVERY OTHER REFUSAL. A SECURITY DEFINER function runs as its OWNER, so
    // one owned by the schema owner that disables the triggers and deletes lets the application
    // erase history with no DELETE privilege and no trigger firing.
    //
    // This was NOT hypothetical. Migration 0009 originally used
    //     ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC
    // which records nothing on PostgreSQL 16.15 and leaves new functions with PUBLIC EXECUTE — while
    // the identical construct for TABLES does apply, which is what made it look right. Measured: the
    // app role called such a function, it ran ALTER TABLE audit_logs DISABLE TRIGGER ALL and DELETE,
    // and it worked. An explicit revoke loop replaced it, and THIS asserts the loop's effect rather
    // than re-testing PostgreSQL: it inspects what the migration actually left behind.
    //
    // BOTH DIRECTIONS MATTER. Deleting the loop makes `leaked` non-zero. Widening it into the
    // blanket `REVOKE ... ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC` makes `broken` non-zero,
    // and would take citext (§17.3 uniqueness) and pg_trgm (§16.1 matching) with it.
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations } = await importBuilt('packages/db/dist/index.js')
    const { Client } = await import('pg')

    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)

      const owner = new Client({ connectionString: postgres.url })
      await owner.connect()
      try {
        // "PUBLIC may execute" is `proacl IS NULL` (the built-in default grants PUBLIC EXECUTE) or
        // an aclitem whose grantee is empty, which renders as "=X/owner". Matching on '%=X/%'
        // instead would be wrong: "helloreview=X/helloreview" contains it and means owner-ONLY.
        const { rows } = await owner.query(
          `SELECT count(*) FILTER (WHERE NOT is_extension AND public_executes) AS leaked,
                  count(*) FILTER (WHERE is_extension AND NOT public_executes) AS broken,
                  count(*) FILTER (WHERE is_extension) AS extension_functions,
                  count(*) FILTER (WHERE NOT is_extension) AS our_functions
             FROM (
               SELECT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') AS is_extension,
                      (p.proacl IS NULL
                       OR EXISTS (SELECT 1 FROM unnest(p.proacl) AS item WHERE item::text LIKE '=%')) AS public_executes
                 FROM pg_proc p
                 JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public'
             ) AS classified`,
        )
        const counts = rows[0]

        // Guards both directions against being vacuous on a database that happens to have neither
        // category present.
        expect(Number(counts?.extension_functions), 'citext and pg_trgm must be installed in public').toBeGreaterThan(0)
        expect(Number(counts?.our_functions), 'our trigger functions must be in public').toBeGreaterThan(0)

        expect(
          Number(counts?.leaked),
          'a function of ours still carries PUBLIC EXECUTE. If it is SECURITY DEFINER, the ' +
            'application can call it and it runs as the owner — around every REVOKE on audit_logs.',
        ).toBe(0)
        expect(
          Number(counts?.broken),
          'the revoke reached an extension function. citext and pg_trgm back §17.3 uniqueness and ' +
            '§16.1 matching, and the application needs both.',
        ).toBe(0)
      } finally {
        await owner.end()
      }
    })
  })

  test('a SECURITY DEFINER function added AFTER the migration is the documented gap, and is detected', async () => {
    // HONEST ABOUT THE LIMIT. The revoke loop covers functions that exist when 0009 runs. A later
    // migration creating one gets PUBLIC EXECUTE again, and `db:reset` replays 0009 BEFORE those
    // later migrations, so it cannot cover them either.
    //
    // Rather than pretend otherwise, this asserts both halves of what actually ships: the gap is
    // real, and `db:verify-audit-protection` names it. If someone later closes the gap properly
    // (an event trigger, or extensions moved to their own schema), the first assertion fails and
    // this test should be rewritten — which is the correct outcome, not an annoyance.
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations } = await importBuilt('packages/db/dist/index.js')
    const { Client } = await import('pg')

    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      expect(provisionAppRole(postgres.url).status).toBe(0)

      const owner = new Client({ connectionString: postgres.url })
      await owner.connect()
      try {
        await owner.query(
          `CREATE FUNCTION public.probe_escalate() RETURNS text
             LANGUAGE plpgsql SECURITY DEFINER AS $fn$
             BEGIN
               ALTER TABLE audit_logs DISABLE TRIGGER ALL;
               DELETE FROM audit_logs;
               RETURN 'escalated';
             END
           $fn$`,
        )
      } finally {
        await owner.end()
      }

      // The gap, stated as an assertion so nobody has to take the comment's word for it.
      const app = new Client({ connectionString: appUrlFrom(postgres.url) })
      await app.connect()
      try {
        const reachable = await app.query(
          `SELECT has_function_privilege(current_user, 'public.probe_escalate()', 'EXECUTE') AS can_execute`,
        )
        expect(
          reachable.rows[0]?.can_execute,
          'A function created after the migration is expected to carry PUBLIC EXECUTE. If this is ' +
            'now false the gap has been closed and the detector below is no longer the guarantee.',
        ).toBe(true)
      } finally {
        await app.end()
      }

      // DETECTION: the operator-facing tool refuses and names the function.
      const verified = spawnSync(process.execPath, [join(ROOT, 'tools', 'db-verify-audit-protection.mjs')], {
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, DATABASE_MIGRATION_URL: postgres.url, APP_DB_USER: APP_USER },
      })

      expect(verified.status, 'db:verify-audit-protection must fail while the app can escalate').not.toBe(0)
      expect(verified.stderr).toMatch(/SECURITY DEFINER/i)
      expect(verified.stderr, 'the offending function must be named, or the operator cannot act').toMatch(
        /probe_escalate/,
      )

      // REPAIR: provisioning runs after every migration, so the next db:migrate closes it. This is
      // the half the migration cannot do — 0009 is replayed before any later migration exists.
      expect(provisionAppRole(postgres.url).status, 'provisioning must succeed and repair').toBe(0)

      const repaired = new Client({ connectionString: appUrlFrom(postgres.url) })
      await repaired.connect()
      try {
        await expect(repaired.query('SELECT public.probe_escalate()')).rejects.toThrow(
          /permission denied for function/i,
        )
      } finally {
        await repaired.end()
      }

      const reverified = spawnSync(process.execPath, [join(ROOT, 'tools', 'db-verify-audit-protection.mjs')], {
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, DATABASE_MIGRATION_URL: postgres.url, APP_DB_USER: APP_USER },
      })
      expect(reverified.status, `must pass after the repair:\n${reverified.stdout}${reverified.stderr}`).toBe(0)
    })
  })

  test('db:provision-role repairs a broad GRANT ALL, which no migration replay can', async () => {
    // THE DOCUMENTED RECOVERY, asserted rather than described. A drizzle migration runs ONCE — it is
    // recorded in drizzle.__drizzle_migrations and only applied when the recorded timestamp is older
    // than the file's — so migration 0009 applies no SQL on an existing database, forever.
    //
    // docs/backup-and-restore.md used to say `pnpm db:migrate` re-applied the carve-out "because it
    // is idempotent by design". The SQL is idempotent; nothing replayed it. Measured: after the
    // GRANT ALL below, db:migrate alone left DELETE granted. The repair lives in provisioning, which
    // db:migrate runs afterwards every time — and which works on a staging or production host,
    // where `pnpm db:reset` (the only other thing that replays migrations) refuses outright.
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations } = await importBuilt('packages/db/dist/index.js')
    const { Client } = await import('pg')

    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      expect(provisionAppRole(postgres.url).status).toBe(0)

      const owner = new Client({ connectionString: postgres.url })
      await owner.connect()
      try {
        // The reflex fix for an application that lost access after a restore.
        await owner.query('GRANT ALL ON ALL TABLES IN SCHEMA public TO helloreview_app')

        // Non-vacuous: the damage must be real before the repair is meaningful.
        const damaged = await owner.query(`SELECT has_table_privilege($1, 'audit_logs', 'DELETE') AS can_delete`, [
          APP_USER,
        ])
        expect(damaged.rows[0]?.can_delete, 'GRANT ALL must re-grant DELETE, or this proves nothing').toBe(true)

        // Applying migrations again must NOT be what fixes it — asserted so the comment above
        // cannot quietly become false again.
        await applyMigrations(postgres.url)
        const afterMigrate = await owner.query(`SELECT has_table_privilege($1, 'audit_logs', 'DELETE') AS can_delete`, [
          APP_USER,
        ])
        expect(
          afterMigrate.rows[0]?.can_delete,
          'If replaying migrations now repairs this, the drizzle ledger behaviour has changed and ' +
            'the reasoning in db-provision-role.mjs and docs/backup-and-restore.md needs revisiting.',
        ).toBe(true)
      } finally {
        await owner.end()
      }

      expect(provisionAppRole(postgres.url).status, 'provisioning must repair the carve-out').toBe(0)

      const app = new Client({ connectionString: appUrlFrom(postgres.url) })
      await app.connect()
      try {
        await expect(app.query('DELETE FROM audit_logs')).rejects.toThrow(/permission denied/i)
        // And the application must still work afterwards — a repair that locks the app out is an
        // outage, not a fix.
        await app.query(
          `INSERT INTO audit_logs (actor_type, actor_id, action, target_type, target_id, result)
           VALUES ('system', 'id_after_repair', 'PROBE', 'workflow', 'wf_1', 'success')`,
        )
      } finally {
        await app.end()
      }
    })
  })

  test('db:provision-role restores grants stripped by a --no-owner --no-acl restore', async () => {
    // The other documented failure mode. `pg_restore --no-owner --no-acl` leaves the app with no
    // grants at all — it fails closed, loudly, on every query. Recovery must not require db:reset,
    // which refuses off loopback and is exactly where a restore happens.
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations } = await importBuilt('packages/db/dist/index.js')
    const { Client } = await import('pg')

    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      expect(provisionAppRole(postgres.url).status).toBe(0)

      const owner = new Client({ connectionString: postgres.url })
      await owner.connect()
      try {
        await owner.query('REVOKE ALL ON SCHEMA public FROM helloreview_app')
        await owner.query('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM helloreview_app')

        // PUBLIC TOO, and this line is the interesting one. On a PRISTINE database the `public`
        // schema still carries PostgreSQL's built-in `PUBLIC=U` grant, so revoking from
        // helloreview_app alone leaves USAGE reachable through PUBLIC and the app keeps working —
        // this test asserted the strip and found the app unharmed.
        //
        // After `pnpm db:reset` the same two statements DO remove USAGE, because `create schema
        // public` leaves a NULL ACL with no PUBLIC grant at all. Verifying this by hand on a reset
        // dev database and then asserting it in a fresh container therefore gives opposite results
        // — the reason to strip PUBLIC explicitly rather than rely on whichever database the test
        // happens to meet.
        await owner.query('REVOKE ALL ON SCHEMA public FROM PUBLIC')

        const stripped = await owner.query(
          `SELECT has_schema_privilege($1, 'public', 'USAGE') AS usage,
                  has_table_privilege($1, 'audit_logs', 'INSERT') AS insert_audit`,
          [APP_USER],
        )
        expect(stripped.rows[0]?.usage, 'the strip must actually remove USAGE').toBe(false)
        expect(stripped.rows[0]?.insert_audit).toBe(false)
      } finally {
        await owner.end()
      }

      expect(provisionAppRole(postgres.url).status, 'provisioning must restore the grants').toBe(0)

      const app = new Client({ connectionString: appUrlFrom(postgres.url) })
      await app.connect()
      try {
        await app.query(
          `INSERT INTO audit_logs (actor_type, actor_id, action, target_type, target_id, result)
           VALUES ('system', 'id_restored', 'PROBE', 'workflow', 'wf_1', 'success')`,
        )
        // Restored, not over-restored: the carve-out must come back with everything else.
        await expect(app.query('DELETE FROM audit_logs')).rejects.toThrow(/permission denied/i)
      } finally {
        await app.end()
      }
    })
  })

  test('db:verify-audit-protection passes on a correctly provisioned database', async () => {
    // The other half. A detector that fails on a healthy database is one people learn to ignore,
    // and it would also make the failure assertions above meaningless.
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations } = await importBuilt('packages/db/dist/index.js')

    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      expect(provisionAppRole(postgres.url).status).toBe(0)

      const verified = spawnSync(process.execPath, [join(ROOT, 'tools', 'db-verify-audit-protection.mjs')], {
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, DATABASE_MIGRATION_URL: postgres.url, APP_DB_USER: APP_USER },
      })

      expect(verified.status, `must pass on a healthy database:\n${verified.stdout}${verified.stderr}`).toBe(0)
      expect(verified.stdout).toMatch(/protection verified/i)
    })
  })

  test('db:verify-audit-protection catches owner membership granted WITH INHERIT FALSE', async () => {
    // THE ROUTE A NAIVE MEMBERSHIP CHECK MISSES. `pg_has_role(role, owner, 'USAGE')` answers "does
    // it inherit the owner's privileges automatically?" — false for a member created WITH INHERIT
    // FALSE. But that member can still `SET ROLE` to the owner and acquire ownership on demand,
    // which is the whole attack. 'MEMBER' is the predicate that answers the real question.
    //
    // The tool's comment already claimed SET ROLE was covered while only 'USAGE' was tested. This
    // is the test that makes the claim true rather than aspirational.
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations } = await importBuilt('packages/db/dist/index.js')
    const { Client } = await import('pg')

    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      expect(provisionAppRole(postgres.url).status).toBe(0)

      const owner = new Client({ connectionString: postgres.url })
      await owner.connect()
      try {
        await owner.query(`GRANT helloreview TO ${APP_USER} WITH INHERIT FALSE`)

        // Non-vacuous, and the point of the whole test: the naive predicate says "fine".
        const predicates = await owner.query(
          `SELECT pg_has_role($1, 'helloreview', 'USAGE') AS inherits,
                  pg_has_role($1, 'helloreview', 'MEMBER') AS can_set_role`,
          [APP_USER],
        )
        expect(predicates.rows[0]?.inherits, 'WITH INHERIT FALSE must not inherit').toBe(false)
        expect(predicates.rows[0]?.can_set_role, 'but SET ROLE must still be available').toBe(true)
      } finally {
        await owner.end()
      }

      const verified = spawnSync(process.execPath, [join(ROOT, 'tools', 'db-verify-audit-protection.mjs')], {
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, DATABASE_MIGRATION_URL: postgres.url, APP_DB_USER: APP_USER },
      })

      expect(verified.status, 'a SET ROLE route to the owner must be reported').not.toBe(0)
      expect(verified.stderr).toMatch(/member of the owner/i)
      expect(verified.stderr, 'the message should name the SET ROLE route, not inheritance').toMatch(/SET ROLE/i)
    })
  })

  test('db:verify-audit-protection fails when the application is pointed back at the owner', async () => {
    // CHECK 3'S REASON FOR EXISTING. Checks 1 and 2 exclude superusers and the owner, correctly —
    // no ACL constrains them. That exclusion is also the blind spot: without check 3, pointing
    // DATABASE_URL back at the owner passes every check while audit_logs is freely deletable, and
    // the tool prints "protection verified".
    //
    // This is the realistic path, not a contrived one: after a `pg_restore --no-owner --no-acl` the
    // application cannot connect, and repointing it at the owner is the fastest way to restore
    // service. See docs/backup-and-restore.md.
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations } = await importBuilt('packages/db/dist/index.js')

    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)

      const asOwner = spawnSync(process.execPath, [join(ROOT, 'tools', 'db-verify-audit-protection.mjs')], {
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, DATABASE_MIGRATION_URL: postgres.url, APP_DB_USER: 'helloreview' },
      })

      expect(asOwner.status, 'the tool must refuse to certify an application running as the owner').not.toBe(0)
      expect(asOwner.stderr).toMatch(/OWNS audit_logs|SUPERUSER/i)
    })
  })

  describe('provisioning refuses a role that would void the separation', () => {
    test('the owner named directly — a plain name check that never reaches the database', async () => {
      // HONEST ABOUT WHAT IT COVERS. tools/db-provision-role.mjs compares APP_DB_USER against the
      // owner's name in JavaScript, before it opens a connection. That is worth having and worth
      // testing, but it catches only the literal-name mistake — NOT the realistic one, which is a
      // distinctly-named role that has been granted membership in the owner. That is the next test,
      // and it is the one that exercises the pg_has_role guard.
      //
      // No database is started here, deliberately: starting one would imply this test needs it.
      const asOwner = spawnSync(process.execPath, [join(ROOT, 'tools', 'db-provision-role.mjs')], {
        encoding: 'utf8',
        timeout: 120_000,
        env: {
          ...process.env,
          DATABASE_MIGRATION_URL: 'postgres://helloreview:unused@127.0.0.1:1/unused',
          APP_DB_USER: 'helloreview',
          APP_DB_PASSWORD: 'irrelevant',
        },
      })

      expect(asOwner.status, 'provisioning the owner as the app role must be refused').not.toBe(0)
      expect(asOwner.stderr).toMatch(/schema owner|privilege group/i)
      expect(`${asOwner.stdout}${asOwner.stderr}`).not.toContain('irrelevant')
    })

    test('a differently-named role that was granted membership in the owner', async () => {
      // THE TRAP THE PREVIOUS TEST DOES NOT COVER, and the one the production code calls "the trap
      // that voids the entire scheme". Ownership checks follow role membership, so `GRANT
      // helloreview TO helloreview_api` gives the application the power to disable the triggers and
      // delete, despite it holding no DELETE privilege and having a different name.
      //
      // Deleting the pg_has_role block from tools/db-provision-role.mjs makes this test fail. It
      // made no other test fail, which is why it exists.
      const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
      const { applyMigrations } = await importBuilt('packages/db/dist/index.js')
      const { Client } = await import('pg')

      await withPostgres(async (postgres) => {
        await applyMigrations(postgres.url)
        expect(provisionAppRole(postgres.url).status, 'the first provisioning must succeed').toBe(0)

        const owner = new Client({ connectionString: postgres.url })
        await owner.connect()
        try {
          await owner.query(`GRANT helloreview TO ${APP_USER}`)

          // Prove the membership actually confers ownership power, so the refusal below is
          // protecting against something real rather than a name pattern.
          const escalated = await owner.query(
            `SELECT pg_has_role($1, 'helloreview', 'USAGE') AS inherits,
                    has_table_privilege($1, 'audit_logs', 'DELETE') AS can_delete`,
            [APP_USER],
          )
          expect(escalated.rows[0]?.inherits, 'the GRANT must actually take effect').toBe(true)
          // Still no DELETE grant — which is exactly why this is dangerous: it looks safe.
          expect(escalated.rows[0]?.can_delete).toBe(true)
        } finally {
          await owner.end()
        }

        const rerun = provisionAppRole(postgres.url)
        expect(rerun.status, 'provisioning must refuse a role that inherits the owner').not.toBe(0)
        expect(rerun.stderr).toMatch(/privileges of the schema owner/i)
        expect(`${rerun.stdout}${rerun.stderr}`).not.toContain(APP_PASSWORD)
      })
    })

    test('a failing statement never echoes the password, even from the PostgreSQL error', async () => {
      // THE REDACTION PATH, exercised rather than asserted about. A reserved role name makes the
      // `ALTER ROLE %I ... PASSWORD %L` inside the DO block fail, and PostgreSQL attaches the whole
      // failing statement — password literal included — as the error's CONTEXT.
      //
      // Measured without the redaction in place: stderr contained
      //     ALTER ROLE pg_monitor WITH LOGIN ... PASSWORD 'LEAK_CANARY'
      // which is a SPEC.md §8 violation written to a terminal and any CI log. The previous version
      // of this assertion lived on the owner-name path, which exits before connecting, so no error
      // object ever existed and it passed no matter what the redaction did.
      const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
      const { applyMigrations } = await importBuilt('packages/db/dist/index.js')

      await withPostgres(async (postgres) => {
        await applyMigrations(postgres.url)

        const canary = 'LEAK_CANARY_PASSWORD_9999'
        const failed = spawnSync(process.execPath, [join(ROOT, 'tools', 'db-provision-role.mjs')], {
          encoding: 'utf8',
          timeout: 120_000,
          env: {
            ...process.env,
            DATABASE_MIGRATION_URL: postgres.url,
            // Reserved: PostgreSQL refuses to ALTER it, and the refusal quotes the statement.
            APP_DB_USER: 'pg_monitor',
            APP_DB_PASSWORD: canary,
          },
        })

        const output = `${failed.stdout}${failed.stderr}`

        expect(failed.status, 'a reserved role name must fail the provisioning').not.toBe(0)
        // Guards against passing for the wrong reason — it must have reached the database and been
        // refused there, not exited early on a name check.
        expect(output, 'the failure must come from PostgreSQL, not from an early guard').toMatch(/reserved/i)
        // Proof the CONTEXT carrying the statement text is actually present and being printed.
        expect(output, 'the failing statement must be reported, minus the credential').toMatch(/ALTER ROLE/i)
        expect(output, 'the password reached the output').not.toContain(canary)
        expect(output).toContain('[redacted]')
      })
    })
  })
})
