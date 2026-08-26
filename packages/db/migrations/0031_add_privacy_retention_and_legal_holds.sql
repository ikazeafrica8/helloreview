CREATE TYPE "public"."privacy_deletion_eligibility_decision" AS ENUM('legal_hold_active', 'policy_missing', 'retention_active', 'eligible');--> statement-breakpoint
CREATE TYPE "public"."privacy_legal_hold_event_type" AS ENUM('applied', 'released');--> statement-breakpoint
CREATE TYPE "public"."privacy_legal_hold_scope" AS ENUM('participant', 'participant_data_class', 'record');--> statement-breakpoint
CREATE TYPE "public"."privacy_retention_data_class" AS ENUM('application_sync', 'conversation_content', 'attachments', 'shipping_addresses', 'consent_records', 'selection_decisions', 'audit_logs', 'delivery_records', 'failed_integration_payloads', 'ai_ocr_results', 'privacy_requests');--> statement-breakpoint
CREATE TYPE "public"."privacy_retention_disposition" AS ENUM('delete', 'irreversible_mask');--> statement-breakpoint
CREATE TABLE "privacy_deletion_eligibility_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evaluation_reference" text NOT NULL,
	"participant_id" uuid NOT NULL,
	"data_class" "privacy_retention_data_class" NOT NULL,
	"record_reference" text NOT NULL,
	"retention_anchor_at" timestamp with time zone NOT NULL,
	"decision" "privacy_deletion_eligibility_decision" NOT NULL,
	"schedule_id" uuid,
	"eligible_at" timestamp with time zone,
	"active_hold_references" jsonb NOT NULL,
	"input_digest" text NOT NULL,
	"actor_reference" text NOT NULL,
	"correlation_id" text NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "privacy_deletion_eligibility_evaluations_reference_key" UNIQUE("evaluation_reference"),
	CONSTRAINT "privacy_deletion_eligibility_evaluations_holds_array" CHECK (jsonb_typeof("privacy_deletion_eligibility_evaluations"."active_hold_references") = 'array'),
	CONSTRAINT "privacy_deletion_eligibility_evaluations_input_digest" CHECK ("privacy_deletion_eligibility_evaluations"."input_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "privacy_deletion_eligibility_evaluations_coherence" CHECK (("privacy_deletion_eligibility_evaluations"."decision" = 'legal_hold_active' and jsonb_array_length("privacy_deletion_eligibility_evaluations"."active_hold_references") > 0 and "privacy_deletion_eligibility_evaluations"."schedule_id" is null and "privacy_deletion_eligibility_evaluations"."eligible_at" is null)
          or ("privacy_deletion_eligibility_evaluations"."decision" = 'policy_missing' and jsonb_array_length("privacy_deletion_eligibility_evaluations"."active_hold_references") = 0 and "privacy_deletion_eligibility_evaluations"."schedule_id" is null and "privacy_deletion_eligibility_evaluations"."eligible_at" is null)
          or ("privacy_deletion_eligibility_evaluations"."decision" in ('retention_active', 'eligible') and jsonb_array_length("privacy_deletion_eligibility_evaluations"."active_hold_references") = 0 and "privacy_deletion_eligibility_evaluations"."schedule_id" is not null and "privacy_deletion_eligibility_evaluations"."eligible_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "privacy_legal_hold_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hold_id" uuid NOT NULL,
	"event_type" "privacy_legal_hold_event_type" NOT NULL,
	"actor_reference" text NOT NULL,
	"reason_reference" text NOT NULL,
	"correlation_id" text NOT NULL,
	"deduplication_key" text NOT NULL,
	"input_digest" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "privacy_legal_hold_events_hold_type_key" UNIQUE("hold_id","event_type"),
	CONSTRAINT "privacy_legal_hold_events_deduplication_key" UNIQUE("deduplication_key"),
	CONSTRAINT "privacy_legal_hold_events_input_digest" CHECK ("privacy_legal_hold_events"."input_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "privacy_legal_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hold_reference" text NOT NULL,
	"scope" "privacy_legal_hold_scope" NOT NULL,
	"participant_id" uuid NOT NULL,
	"data_class" "privacy_retention_data_class",
	"record_reference" text,
	"reason_reference" text NOT NULL,
	"applied_by_reference" text NOT NULL,
	"correlation_id" text NOT NULL,
	"input_digest" text NOT NULL,
	"applied_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "privacy_legal_holds_reference_key" UNIQUE("hold_reference"),
	CONSTRAINT "privacy_legal_holds_scope_target" CHECK (("privacy_legal_holds"."scope" = 'participant' and "privacy_legal_holds"."data_class" is null and "privacy_legal_holds"."record_reference" is null)
          or ("privacy_legal_holds"."scope" = 'participant_data_class' and "privacy_legal_holds"."data_class" is not null and "privacy_legal_holds"."record_reference" is null)
          or ("privacy_legal_holds"."scope" = 'record' and "privacy_legal_holds"."data_class" is not null and "privacy_legal_holds"."record_reference" is not null)),
	CONSTRAINT "privacy_legal_holds_input_digest" CHECK ("privacy_legal_holds"."input_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "privacy_retention_schedule_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"data_class" "privacy_retention_data_class" NOT NULL,
	"retention_days" integer NOT NULL,
	"disposition" "privacy_retention_disposition" NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "privacy_retention_schedule_entries_schedule_class_key" UNIQUE("schedule_id","data_class"),
	CONSTRAINT "privacy_retention_schedule_entries_days" CHECK ("privacy_retention_schedule_entries"."retention_days" between 1 and 36500)
);
--> statement-breakpoint
CREATE TABLE "privacy_retention_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schema_version" text NOT NULL,
	"policy_version" text NOT NULL,
	"supersedes_policy_version" text,
	"company_approval_reference" text NOT NULL,
	"legal_approval_reference" text NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"input_digest" text NOT NULL,
	"published_by_reference" text NOT NULL,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "privacy_retention_schedules_policy_version_key" UNIQUE("policy_version"),
	CONSTRAINT "privacy_retention_schedules_schema_version" CHECK ("privacy_retention_schedules"."schema_version" = 'privacy-retention-schedule-v1'),
	CONSTRAINT "privacy_retention_schedules_policy_version" CHECK ("privacy_retention_schedules"."policy_version" ~ '^[a-z][a-z0-9-]*-v[0-9]+$'),
	CONSTRAINT "privacy_retention_schedules_supersedes_version" CHECK ("privacy_retention_schedules"."supersedes_policy_version" is null or "privacy_retention_schedules"."supersedes_policy_version" ~ '^[a-z][a-z0-9-]*-v[0-9]+$'),
	CONSTRAINT "privacy_retention_schedules_effective_after_approval" CHECK ("privacy_retention_schedules"."effective_from" >= "privacy_retention_schedules"."approved_at"),
	CONSTRAINT "privacy_retention_schedules_input_digest" CHECK ("privacy_retention_schedules"."input_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "privacy_deletion_eligibility_evaluations" ADD CONSTRAINT "privacy_deletion_eligibility_evaluations_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_deletion_eligibility_evaluations" ADD CONSTRAINT "privacy_deletion_eligibility_evaluations_schedule_id_privacy_retention_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."privacy_retention_schedules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_legal_hold_events" ADD CONSTRAINT "privacy_legal_hold_events_hold_id_privacy_legal_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."privacy_legal_holds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_legal_holds" ADD CONSTRAINT "privacy_legal_holds_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_retention_schedule_entries" ADD CONSTRAINT "privacy_retention_schedule_entries_schedule_id_privacy_retention_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."privacy_retention_schedules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_retention_schedules" ADD CONSTRAINT "privacy_retention_schedules_supersedes_fk" FOREIGN KEY ("supersedes_policy_version") REFERENCES "public"."privacy_retention_schedules"("policy_version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "privacy_deletion_eligibility_evaluations_subject_idx" ON "privacy_deletion_eligibility_evaluations" USING btree ("participant_id","data_class","evaluated_at");--> statement-breakpoint
CREATE INDEX "privacy_legal_hold_events_timeline_idx" ON "privacy_legal_hold_events" USING btree ("hold_id","occurred_at");--> statement-breakpoint
CREATE INDEX "privacy_legal_holds_subject_idx" ON "privacy_legal_holds" USING btree ("participant_id","data_class","applied_at");--> statement-breakpoint
CREATE INDEX "privacy_retention_schedule_entries_class_idx" ON "privacy_retention_schedule_entries" USING btree ("data_class","schedule_id");--> statement-breakpoint
CREATE INDEX "privacy_retention_schedules_effective_idx" ON "privacy_retention_schedules" USING btree ("effective_from","created_at");

-- T98-T99: approved retention schedules, legal-hold episodes, and deletion-eligibility
-- evaluations are service-internal evidence. They are all append-only; this migration deliberately
-- creates no deletion queue, deletion function, or production schedule values.
ALTER TABLE privacy_retention_schedules ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE privacy_retention_schedule_entries ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE privacy_legal_holds ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE privacy_legal_hold_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE privacy_deletion_eligibility_evaluations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY privacy_retention_schedules_app_select ON privacy_retention_schedules
  FOR SELECT TO helloreview_app USING (true);--> statement-breakpoint
CREATE POLICY privacy_retention_schedules_app_insert ON privacy_retention_schedules
  FOR INSERT TO helloreview_app WITH CHECK (true);--> statement-breakpoint
CREATE POLICY privacy_retention_schedule_entries_app_select ON privacy_retention_schedule_entries
  FOR SELECT TO helloreview_app USING (true);--> statement-breakpoint
CREATE POLICY privacy_retention_schedule_entries_app_insert ON privacy_retention_schedule_entries
  FOR INSERT TO helloreview_app WITH CHECK (true);--> statement-breakpoint
CREATE POLICY privacy_legal_holds_app_select ON privacy_legal_holds
  FOR SELECT TO helloreview_app USING (true);--> statement-breakpoint
CREATE POLICY privacy_legal_holds_app_insert ON privacy_legal_holds
  FOR INSERT TO helloreview_app WITH CHECK (true);--> statement-breakpoint
CREATE POLICY privacy_legal_hold_events_app_select ON privacy_legal_hold_events
  FOR SELECT TO helloreview_app USING (true);--> statement-breakpoint
CREATE POLICY privacy_legal_hold_events_app_insert ON privacy_legal_hold_events
  FOR INSERT TO helloreview_app WITH CHECK (true);--> statement-breakpoint
CREATE POLICY privacy_deletion_eligibility_evaluations_app_select ON privacy_deletion_eligibility_evaluations
  FOR SELECT TO helloreview_app USING (true);--> statement-breakpoint
CREATE POLICY privacy_deletion_eligibility_evaluations_app_insert ON privacy_deletion_eligibility_evaluations
  FOR INSERT TO helloreview_app WITH CHECK (true);--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON privacy_retention_schedules, privacy_retention_schedule_entries,
      privacy_legal_holds, privacy_legal_hold_events,
      privacy_deletion_eligibility_evaluations FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON privacy_retention_schedules, privacy_retention_schedule_entries,
      privacy_legal_holds, privacy_legal_hold_events,
      privacy_deletion_eligibility_evaluations FROM authenticated;
  END IF;
END
$$;--> statement-breakpoint

CREATE TRIGGER privacy_retention_schedules_append_only
BEFORE UPDATE OR DELETE ON privacy_retention_schedules
FOR EACH STATEMENT EXECUTE FUNCTION privacy_request_history_reject_mutation();--> statement-breakpoint
ALTER TABLE privacy_retention_schedules ENABLE ALWAYS TRIGGER privacy_retention_schedules_append_only;--> statement-breakpoint
CREATE TRIGGER privacy_retention_schedules_no_truncate
BEFORE TRUNCATE ON privacy_retention_schedules
FOR EACH STATEMENT EXECUTE FUNCTION privacy_request_history_reject_mutation();--> statement-breakpoint
ALTER TABLE privacy_retention_schedules ENABLE ALWAYS TRIGGER privacy_retention_schedules_no_truncate;--> statement-breakpoint

CREATE TRIGGER privacy_retention_schedule_entries_append_only
BEFORE UPDATE OR DELETE ON privacy_retention_schedule_entries
FOR EACH STATEMENT EXECUTE FUNCTION privacy_request_history_reject_mutation();--> statement-breakpoint
ALTER TABLE privacy_retention_schedule_entries ENABLE ALWAYS TRIGGER privacy_retention_schedule_entries_append_only;--> statement-breakpoint
CREATE TRIGGER privacy_retention_schedule_entries_no_truncate
BEFORE TRUNCATE ON privacy_retention_schedule_entries
FOR EACH STATEMENT EXECUTE FUNCTION privacy_request_history_reject_mutation();--> statement-breakpoint
ALTER TABLE privacy_retention_schedule_entries ENABLE ALWAYS TRIGGER privacy_retention_schedule_entries_no_truncate;--> statement-breakpoint

CREATE TRIGGER privacy_legal_holds_append_only
BEFORE UPDATE OR DELETE ON privacy_legal_holds
FOR EACH STATEMENT EXECUTE FUNCTION privacy_request_history_reject_mutation();--> statement-breakpoint
ALTER TABLE privacy_legal_holds ENABLE ALWAYS TRIGGER privacy_legal_holds_append_only;--> statement-breakpoint
CREATE TRIGGER privacy_legal_holds_no_truncate
BEFORE TRUNCATE ON privacy_legal_holds
FOR EACH STATEMENT EXECUTE FUNCTION privacy_request_history_reject_mutation();--> statement-breakpoint
ALTER TABLE privacy_legal_holds ENABLE ALWAYS TRIGGER privacy_legal_holds_no_truncate;--> statement-breakpoint

CREATE TRIGGER privacy_legal_hold_events_append_only
BEFORE UPDATE OR DELETE ON privacy_legal_hold_events
FOR EACH STATEMENT EXECUTE FUNCTION privacy_request_history_reject_mutation();--> statement-breakpoint
ALTER TABLE privacy_legal_hold_events ENABLE ALWAYS TRIGGER privacy_legal_hold_events_append_only;--> statement-breakpoint
CREATE TRIGGER privacy_legal_hold_events_no_truncate
BEFORE TRUNCATE ON privacy_legal_hold_events
FOR EACH STATEMENT EXECUTE FUNCTION privacy_request_history_reject_mutation();--> statement-breakpoint
ALTER TABLE privacy_legal_hold_events ENABLE ALWAYS TRIGGER privacy_legal_hold_events_no_truncate;--> statement-breakpoint

CREATE TRIGGER privacy_deletion_eligibility_evaluations_append_only
BEFORE UPDATE OR DELETE ON privacy_deletion_eligibility_evaluations
FOR EACH STATEMENT EXECUTE FUNCTION privacy_request_history_reject_mutation();--> statement-breakpoint
ALTER TABLE privacy_deletion_eligibility_evaluations ENABLE ALWAYS TRIGGER privacy_deletion_eligibility_evaluations_append_only;--> statement-breakpoint
CREATE TRIGGER privacy_deletion_eligibility_evaluations_no_truncate
BEFORE TRUNCATE ON privacy_deletion_eligibility_evaluations
FOR EACH STATEMENT EXECUTE FUNCTION privacy_request_history_reject_mutation();--> statement-breakpoint
ALTER TABLE privacy_deletion_eligibility_evaluations ENABLE ALWAYS TRIGGER privacy_deletion_eligibility_evaluations_no_truncate;--> statement-breakpoint

REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON privacy_retention_schedules, privacy_retention_schedule_entries,
     privacy_legal_holds, privacy_legal_hold_events,
     privacy_deletion_eligibility_evaluations
  FROM helloreview_app;
