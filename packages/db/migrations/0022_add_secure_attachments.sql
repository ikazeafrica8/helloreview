CREATE TYPE "public"."attachment_grant_event_type" AS ENUM('issued', 'consumed', 'fulfilled', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."attachment_grant_kind" AS ENUM('upload', 'read');--> statement-breakpoint
CREATE TYPE "public"."attachment_lifecycle_event_type" AS ENUM('evidence_linked', 'operator_review_required', 'legal_hold_applied', 'legal_hold_released', 'deletion_eligible', 'deletion_blocked_policy_missing', 'deletion_blocked_legal_hold', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."attachment_security_state" AS ENUM('quarantined', 'scanning', 'clean', 'rejected', 'scan_failed');--> statement-breakpoint
CREATE TABLE "attachment_access_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "attachment_grant_kind" NOT NULL,
	"token_digest" varchar(64) NOT NULL,
	"workflow_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"attachment_id" uuid,
	"expected_declared_type" text,
	"max_bytes" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "attachment_access_grants_token_digest_key" UNIQUE("token_digest"),
	CONSTRAINT "attachment_access_grants_sha256" CHECK ("attachment_access_grants"."token_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "attachment_access_grants_expiry" CHECK ("attachment_access_grants"."expires_at" > "attachment_access_grants"."created_at"),
	CONSTRAINT "attachment_access_grants_kind_coherence" CHECK (("attachment_access_grants"."kind" = 'upload' and "attachment_access_grants"."attachment_id" is null and "attachment_access_grants"."expected_declared_type" is not null and "attachment_access_grants"."max_bytes" > 0)
          or ("attachment_access_grants"."kind" = 'read' and "attachment_access_grants"."attachment_id" is not null and "attachment_access_grants"."expected_declared_type" is null and "attachment_access_grants"."max_bytes" is null)),
	CONSTRAINT "attachment_access_grants_terminal_time" CHECK (("attachment_access_grants"."consumed_at" is null or "attachment_access_grants"."consumed_at" >= "attachment_access_grants"."created_at")
          and ("attachment_access_grants"."revoked_at" is null or "attachment_access_grants"."revoked_at" >= "attachment_access_grants"."created_at")
          and not ("attachment_access_grants"."consumed_at" is not null and "attachment_access_grants"."revoked_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "attachment_grant_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL,
	"attachment_id" uuid,
	"event_type" "attachment_grant_event_type" NOT NULL,
	"reason_code" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "attachment_grant_events_reason_code" CHECK ("attachment_grant_events"."reason_code" ~ '^[A-Z][A-Z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE "attachment_lifecycle_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attachment_id" uuid NOT NULL,
	"event_type" "attachment_lifecycle_event_type" NOT NULL,
	"reason_code" text NOT NULL,
	"policy_reference" text,
	"actor_reference" text NOT NULL,
	"deduplication_key" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "attachment_lifecycle_events_dedupe_key" UNIQUE("deduplication_key"),
	CONSTRAINT "attachment_lifecycle_events_reason_code" CHECK ("attachment_lifecycle_events"."reason_code" ~ '^[A-Z][A-Z0-9_]*$'),
	CONSTRAINT "attachment_lifecycle_events_actor_length" CHECK (char_length("attachment_lifecycle_events"."actor_reference") between 1 and 200),
	CONSTRAINT "attachment_lifecycle_events_policy_reference_length" CHECK ("attachment_lifecycle_events"."policy_reference" is null or char_length("attachment_lifecycle_events"."policy_reference") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "attachment_security_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attachment_id" uuid NOT NULL,
	"state" "attachment_security_state" NOT NULL,
	"reason_code" text NOT NULL,
	"scanner_provider" text,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "attachment_security_events_reason_code" CHECK ("attachment_security_events"."reason_code" ~ '^[A-Z][A-Z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"source_message_reference" text NOT NULL,
	"provider_reference" text NOT NULL,
	"declared_type" text NOT NULL,
	"detected_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"storage_reference" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "attachments_workflow_provider_reference_key" UNIQUE("workflow_id","provider_reference"),
	CONSTRAINT "attachments_positive_size" CHECK ("attachments"."size_bytes" > 0),
	CONSTRAINT "attachments_sha256" CHECK ("attachments"."content_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "attachments_source_reference_length" CHECK (char_length("attachments"."source_message_reference") between 1 and 500),
	CONSTRAINT "attachments_provider_reference_length" CHECK (char_length("attachments"."provider_reference") between 1 and 500),
	CONSTRAINT "attachments_declared_type_length" CHECK (char_length("attachments"."declared_type") between 1 and 200),
	CONSTRAINT "attachments_detected_type_length" CHECK (char_length("attachments"."detected_type") between 1 and 200),
	CONSTRAINT "attachments_opaque_storage_reference" CHECK ("attachments"."storage_reference" !~* '^https?://')
);
--> statement-breakpoint
ALTER TABLE "attachment_access_grants" ADD CONSTRAINT "attachment_access_grants_workflow_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_access_grants" ADD CONSTRAINT "attachment_access_grants_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_access_grants" ADD CONSTRAINT "attachment_access_grants_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_grant_events" ADD CONSTRAINT "attachment_grant_events_grant_id_attachment_access_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."attachment_access_grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_grant_events" ADD CONSTRAINT "attachment_grant_events_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_lifecycle_events" ADD CONSTRAINT "attachment_lifecycle_events_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_security_events" ADD CONSTRAINT "attachment_security_events_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_workflow_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachment_access_grants_scope_idx" ON "attachment_access_grants" USING btree ("workflow_id","participant_id","expires_at");--> statement-breakpoint
CREATE INDEX "attachment_grant_events_timeline_idx" ON "attachment_grant_events" USING btree ("grant_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "attachment_lifecycle_events_timeline_idx" ON "attachment_lifecycle_events" USING btree ("attachment_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "attachment_security_events_current_idx" ON "attachment_security_events" USING btree ("attachment_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "attachments_content_hash_idx" ON "attachments" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "attachments_owner_idx" ON "attachments" USING btree ("workflow_id","participant_id","created_at");--> statement-breakpoint

-- T57/T60: evidence, security history, lifecycle history, and grant audit are append-only.
-- ENABLE ALWAYS keeps the trigger active under session_replication_role = replica. The application
-- role also loses every table-level rewrite path, matching the audit/workflow history controls.
CREATE OR REPLACE FUNCTION reject_attachment_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint

CREATE TRIGGER attachments_append_only
BEFORE UPDATE OR DELETE ON attachments
FOR EACH ROW EXECUTE FUNCTION reject_attachment_history_mutation();--> statement-breakpoint
ALTER TABLE attachments ENABLE ALWAYS TRIGGER attachments_append_only;--> statement-breakpoint

CREATE TRIGGER attachment_security_events_append_only
BEFORE UPDATE OR DELETE ON attachment_security_events
FOR EACH ROW EXECUTE FUNCTION reject_attachment_history_mutation();--> statement-breakpoint
ALTER TABLE attachment_security_events ENABLE ALWAYS TRIGGER attachment_security_events_append_only;--> statement-breakpoint

CREATE TRIGGER attachment_lifecycle_events_append_only
BEFORE UPDATE OR DELETE ON attachment_lifecycle_events
FOR EACH ROW EXECUTE FUNCTION reject_attachment_history_mutation();--> statement-breakpoint
ALTER TABLE attachment_lifecycle_events ENABLE ALWAYS TRIGGER attachment_lifecycle_events_append_only;--> statement-breakpoint

CREATE TRIGGER attachment_grant_events_append_only
BEFORE UPDATE OR DELETE ON attachment_grant_events
FOR EACH ROW EXECUTE FUNCTION reject_attachment_history_mutation();--> statement-breakpoint
ALTER TABLE attachment_grant_events ENABLE ALWAYS TRIGGER attachment_grant_events_append_only;--> statement-breakpoint

REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON attachments, attachment_security_events, attachment_lifecycle_events, attachment_grant_events
  FROM helloreview_app;--> statement-breakpoint
GRANT SELECT, INSERT
  ON attachments, attachment_security_events, attachment_lifecycle_events, attachment_grant_events
  TO helloreview_app;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION reject_attachment_history_mutation() FROM PUBLIC;--> statement-breakpoint
