-- The application connects as a restricted role (SPEC.md §8, PRD §21.2/§21.4).
--
-- WHAT THIS CHANGES, AND WHAT IT DOES NOT. The human operator keeps the `helloreview` superuser:
-- same login, same ownership of every table, same psql, same db:migrate and db:reset, same ability
-- to delete audit history deliberately. Nothing about a person's access changes.
--
-- What loses power is the credential apps/api and apps/worker read out of DATABASE_URL — two
-- long-running processes reachable from the internet, which execute whatever SQL a dependency or
-- an injected string hands them, and which every automated agent in this repo runs under. Neither
-- has ever needed to rewrite an audit row. This is human-vs-daemon, not human-vs-human.
--
-- THE HOLE IT CLOSES. Migration 0002 made the audit triggers ENABLE ALWAYS, which stopped the
-- `SET session_replication_role = replica` bypass. It could not stop the table's OWNER running
-- `ALTER TABLE audit_logs DISABLE TRIGGER ALL; DELETE FROM audit_logs;` — verified working. No
-- trigger can defend against its own table's owner; only a non-owner role can. Measured against a
-- real cluster, a non-owner is refused on every route:
--
--   DELETE / UPDATE / TRUNCATE      -> permission denied for table audit_logs
--   ALTER TABLE ... DISABLE TRIGGER -> must be owner of table audit_logs
--   DROP TABLE                      -> must be owner of table audit_logs
--   SET session_replication_role    -> permission denied to set parameter
--
-- while INSERT/SELECT on audit_logs and full DML on every other table are untouched.
--
-- WHY THE GRANTS LIVE IN A MIGRATION rather than in one-time setup. `pnpm db:reset` runs
-- `DROP SCHEMA public CASCADE`, which destroys every pg_default_acl row for the schema AND leaves
-- the recreated schema with `nspacl` NULL — so the app role loses even USAGE. Measured: default-ACL
-- rows went 1 -> 0 and `has_schema_privilege(...,'USAGE')` went false. Replaying this migration is
-- the only thing that puts them back.
--
-- A NOLOGIN GROUP HOLDS THE GRANTS. A LOGIN role needs a password, and a password in a committed
-- migration is a SPEC.md §8 "Never". This file owns the grants — identical in every environment and
-- reviewable in git; tools/db-provision-role.mjs creates the LOGIN role from the environment and
-- adds it to this group.
--
-- THE TRAP THIS MIGRATION MUST NEVER FALL INTO. Granting the app role membership in the OWNER role
-- destroys the entire scheme: ownership checks follow role inheritance, so an INHERIT member of the
-- owner can DISABLE TRIGGER and wipe the table despite never being granted DELETE. Verified — and
-- `WITH INHERIT FALSE` does not save you, because `SET ROLE` still works. The assertion block at
-- the end refuses to let this migration succeed if that membership ever exists.

-- 1. The privilege holder. Roles are cluster-wide and survive the schema drop, hence the guard.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helloreview_app') THEN
    CREATE ROLE helloreview_app NOLOGIN;
  END IF;
END
$$;--> statement-breakpoint

-- 2. USAGE, never CREATE. A table the app created it would OWN, handing back exactly the power this
--    migration removes. Load-bearing after db:reset: the recreated schema has no ACL at all, so
--    even PUBLIC's default USAGE is gone until this line runs.
GRANT USAGE ON SCHEMA public TO helloreview_app;--> statement-breakpoint

-- 3. Ordinary DML on everything that exists now. Not retroactive from step 5 — both are needed.
--
--    TRUNCATE is absent from this list on purpose, and therefore absent on EVERY table rather than
--    only on audit_logs. The application deletes rows it can name; emptying a whole table in one
--    statement is operator work. Nothing in the codebase truncates, so this costs nothing today —
--    and if a future migration needs it, it should say so in that migration.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO helloreview_app;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO helloreview_app;--> statement-breakpoint

-- 4. THE CARVE-OUT. Must come AFTER step 3, which just granted DELETE to everything.
--
--    TRUNCATE because it does not fire DELETE triggers. TRIGGER because it would let the app attach
--    its own triggers to this table. REFERENCES because a foreign key is a handle on these rows.
--
--    SELECT is deliberately KEPT: the admin console, retention jobs and health checks all read the
--    audit log, and denying it now buys a modest confidentiality gain in exchange for a guaranteed
--    future "permission denied" puzzle. Revisit only if audit_logs ever carries raw PII, which
--    §17.2 says it must not.
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON audit_logs FROM helloreview_app;--> statement-breakpoint

-- 5. Future tables and sequences, so no Phase 3-9 migration ever has to write a GRANT.
--
--    FOR ROLE is consequential: default privileges fire only for objects created BY that role.
--    A future APPEND-ONLY table must carry its own REVOKE in the migration that creates it — the
--    assertion in step 7 will not know about it.
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO helloreview_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO helloreview_app;--> statement-breakpoint

-- 6. FUNCTION PRIVILEGES — the hole a straightforward version of this migration leaves open.
--
--    PostgreSQL grants EXECUTE on every new function to PUBLIC by default. An owner-owned
--    SECURITY DEFINER function that disabled the triggers and deleted would therefore be callable
--    by the app role, routing straight around everything above.
--
--    DO NOT write `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC` here. Migration
--    0000 installs citext and pg_trgm with no SCHEMA clause, so their operators and support
--    functions live in `public` — confirmed by listing them. A blanket revoke breaks §17.3's citext
--    uniqueness and §16.1's trigram matching for the app role. Hence the loop below, which skips
--    anything an extension owns (pg_depend deptype 'e'). Install any FUTURE extension into its own
--    schema and this stops being delicate.
--
--    THIS REPLACED `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`, WHICH
--    SILENTLY DID NOTHING. Measured on PostgreSQL 16.15: the statement records no pg_default_acl
--    row at all, and even after forcing a row to exist (by granting to the owner first) a function
--    created afterwards still came back with `proacl` NULL — meaning PUBLIC kept EXECUTE. A
--    SECURITY DEFINER probe function was callable by the app role in every variation. The identical
--    construct for TABLES in step 5 *does* apply, verified the same way, which is exactly what made
--    the function version look plausible. A no-op that reads like a protection is worse than no
--    line at all, so it is gone rather than kept "for good measure".
--
--    WHAT THIS DOES NOT COVER, stated plainly: functions that exist WHEN THIS MIGRATION RUNS. A
--    later migration that creates a function gets PUBLIC EXECUTE again, and `db:reset` replays 0009
--    before those later migrations, so it cannot catch them either. Two things follow, and both are
--    load-bearing: any migration adding a SECURITY DEFINER function MUST revoke PUBLIC EXECUTE
--    itself, and `pnpm db:verify-audit-protection` checks for exactly this so the gap is detectable
--    rather than theoretical.
--
--    MEASURED, because it decides whether this step is safe at all: the immutability triggers still
--    fire for a non-owner that holds no EXECUTE on their functions. PostgreSQL does not re-check
--    EXECUTE on a trigger function at fire time. A published campaign_rules row was still refused
--    with "published and cannot be modified" from a real app-role connection, and audit_logs still
--    rejected the writes it is supposed to. Revoking function privileges therefore costs none of
--    the protection migrations 0002 and 0005 already provide.
DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS signature
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       -- Extension-owned functions are left alone. citext and pg_trgm live here.
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', fn.signature);
  END LOOP;
END
$$;--> statement-breakpoint

-- 7. Prove it, inside the migration. Without this a silently restored privilege is invisible: a
--    table whose carve-out was undone looks exactly like one whose carve-out holds.
DO $$
DECLARE
  owner_name text := (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'audit_logs'::regclass);
  member record;
BEGIN
  IF has_table_privilege('helloreview_app', 'audit_logs', 'UPDATE')
     OR has_table_privilege('helloreview_app', 'audit_logs', 'DELETE')
     OR has_table_privilege('helloreview_app', 'audit_logs', 'TRUNCATE') THEN
    RAISE EXCEPTION 'audit_logs is not append-only for helloreview_app: it holds a rewrite privilege'
      USING HINT = 'A migration that recreated audit_logs re-granted it from ALTER DEFAULT PRIVILEGES.';
  END IF;

  IF NOT (has_table_privilege('helloreview_app', 'audit_logs', 'INSERT')
          AND has_table_privilege('helloreview_app', 'audit_logs', 'SELECT')) THEN
    RAISE EXCEPTION 'helloreview_app cannot write audit_logs: the audit-log module will fail closed';
  END IF;

  -- THE INHERITANCE TRAP. Ownership checks follow role membership, so a member of the owner can
  -- DISABLE TRIGGER and delete despite holding no DELETE privilege of its own. Verified working.
  IF pg_has_role('helloreview_app', owner_name, 'USAGE') OR pg_has_role('helloreview_app', owner_name, 'MEMBER') THEN
    RAISE EXCEPTION 'helloreview_app has the privileges of %, the owner of audit_logs', owner_name
      USING HINT = 'Membership in the owner voids the whole scheme; WITH INHERIT FALSE does not help.';
  END IF;

  IF (SELECT rolsuper FROM pg_roles WHERE rolname = 'helloreview_app') THEN
    RAISE EXCEPTION 'helloreview_app is a superuser; the privilege separation is void';
  END IF;

  -- 0002 must still hold. A provider default or a careless migration can reset a trigger to 'O'.
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'audit_logs'::regclass
               AND NOT tgisinternal AND tgenabled <> 'A') THEN
    RAISE EXCEPTION 'an audit_logs trigger is no longer ENABLE ALWAYS';
  END IF;

  -- SET UNLOGGED is owner-only and destroys the table at the next unclean shutdown, with no DELETE
  -- to find and no trigger to fire. Cheap to assert, invisible otherwise.
  IF (SELECT relpersistence FROM pg_class WHERE oid = 'audit_logs'::regclass) <> 'p' THEN
    RAISE EXCEPTION 'audit_logs is not logged; it will be truncated on the next unclean shutdown';
  END IF;

  -- The SECURITY DEFINER escalation path.
  FOR member IN
    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosecdef
       AND has_function_privilege('helloreview_app', p.oid, 'EXECUTE')
  LOOP
    RAISE EXCEPTION 'helloreview_app can execute SECURITY DEFINER function %', member.proname
      USING HINT = 'Such a function runs as its owner and routes around every REVOKE above.';
  END LOOP;

  -- session_replication_role is superuser BY DEFAULT, not superuser-only: since PG15 it can be
  -- delegated with GRANT SET ON PARAMETER, recorded in the cluster-wide pg_parameter_acl.
  IF EXISTS (SELECT 1 FROM pg_parameter_acl
             WHERE parname = 'session_replication_role'
               AND array_to_string(paracl, ',') LIKE '%helloreview_app%') THEN
    RAISE EXCEPTION 'helloreview_app holds SET on session_replication_role';
  END IF;
END
$$;
