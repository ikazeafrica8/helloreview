-- Harden the audit_logs append-only triggers against the session_replication_role bypass.
--
-- WHY 0002 AND NOT AN EDIT TO 0001: 0001 has been applied, and Drizzle records that a migration ran
-- but never re-checks its contents. Editing it would leave every database that already ran it
-- silently different from what the file says.
--
-- THE BYPASS THIS CLOSES. A trigger created normally is enabled for "origin" (pg_trigger.tgenabled
-- = 'O'), which means it does NOT fire when the session sets:
--
--     SET session_replication_role = replica;
--     DELETE FROM audit_logs;          -- succeeded, no DDL, no error
--
-- Measured against this database before the change: the audit log was emptied by a session variable
-- and one DELETE. ENABLE ALWAYS ('A') makes the triggers fire regardless of replication role.
--
-- WHAT THIS DOES *NOT* CLOSE, stated plainly because the code previously overclaimed:
-- the table OWNER can still run `ALTER TABLE audit_logs DISABLE TRIGGER ALL`, and a SUPERUSER can
-- do anything at all. Triggers cannot defend against the role that owns the table. Closing that
-- requires privilege separation — a migration/owner role distinct from the application role, with
-- UPDATE, DELETE and TRUNCATE revoked from the latter — which is a deployment decision about how
-- roles are provisioned, not something a migration can decide on its own. It is recorded in
-- tasks/todo.md as an open decision rather than silently assumed.
--
-- So: this makes the guarantee real against accident and against the cheap deliberate bypass. The
-- expensive deliberate bypass needs the role work.

ALTER TABLE audit_logs ENABLE ALWAYS TRIGGER audit_logs_no_update;--> statement-breakpoint
ALTER TABLE audit_logs ENABLE ALWAYS TRIGGER audit_logs_no_delete;--> statement-breakpoint
ALTER TABLE audit_logs ENABLE ALWAYS TRIGGER audit_logs_no_truncate;
