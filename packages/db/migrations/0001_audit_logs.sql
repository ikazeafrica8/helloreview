CREATE TYPE "public"."audit_actor_type" AS ENUM('system', 'operator', 'participant', 'provider', 'scheduler');--> statement-breakpoint
CREATE TYPE "public"."audit_result" AS ENUM('success', 'failure', 'rejected');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"result" "audit_result" NOT NULL,
	"reason" text,
	"correlation_id" text,
	"protected_action" text DEFAULT 'no' NOT NULL,
	"detail" jsonb
);
--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_type","actor_id");--> statement-breakpoint
CREATE INDEX "audit_logs_target_idx" ON "audit_logs" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_logs_occurred_at_idx" ON "audit_logs" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "audit_logs_correlation_idx" ON "audit_logs" USING btree ("correlation_id");--> statement-breakpoint

-- APPEND-ONLY ENFORCEMENT (T13, PRD §17.2 "Append-only, indexed by actor/target/time").
--
-- Hand-written: Drizzle describes tables, not triggers. Safe to add here because drizzle-kit diffs
-- meta/0001_snapshot.json rather than this SQL, so generate and check stay clean afterwards.
--
-- A TRIGGER that raises, not a RULE that discards. `DO INSTEAD NOTHING` would make an UPDATE
-- silently succeed while changing nothing, which is the worst of both worlds: history is preserved
-- but the caller believes it was rewritten. Raising tells the caller the truth.
--
-- Statement-level, so an UPDATE matching zero rows is rejected too — the intent was still wrong.
--
-- The TRUNCATE trigger is separate and NOT optional: TRUNCATE does not fire DELETE triggers, so a
-- table protected only against DELETE can still be emptied in one statement.
CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Corrections are recorded as new rows (PRD §14.7); history is never rewritten.';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_append_only();--> statement-breakpoint

CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_append_only();--> statement-breakpoint

CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_append_only();
