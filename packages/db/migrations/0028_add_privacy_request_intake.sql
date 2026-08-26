CREATE TYPE "public"."privacy_identity_verification_state" AS ENUM('unverified', 'pending', 'verified', 'failed');--> statement-breakpoint
CREATE TYPE "public"."privacy_request_actor_type" AS ENUM('system', 'operator', 'participant');--> statement-breakpoint
CREATE TYPE "public"."privacy_request_event_type" AS ENUM('intake_recorded', 'identity_verification_changed', 'scope_changed', 'assigned', 'released', 'status_changed', 'evidence_recorded', 'completed', 'denied', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."privacy_request_status" AS ENUM('received', 'identity_verification', 'in_review', 'blocked', 'completed', 'denied', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."privacy_request_type" AS ENUM('unspecified', 'access', 'correction', 'deletion', 'export');--> statement-breakpoint
CREATE TABLE "privacy_request_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"event_type" "privacy_request_event_type" NOT NULL,
	"from_status" "privacy_request_status",
	"to_status" "privacy_request_status",
	"from_verification_state" "privacy_identity_verification_state",
	"to_verification_state" "privacy_identity_verification_state",
	"actor_type" "privacy_request_actor_type" NOT NULL,
	"actor_reference" text NOT NULL,
	"reason_code" text NOT NULL,
	"evidence_reference" text NOT NULL,
	"correlation_id" text NOT NULL,
	"detail" jsonb NOT NULL,
	"deduplication_key" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "privacy_request_events_deduplication_key" UNIQUE("deduplication_key"),
	CONSTRAINT "privacy_request_events_reason_code" CHECK ("privacy_request_events"."reason_code" ~ '^[A-Z][A-Z0-9_]*$'),
	CONSTRAINT "privacy_request_events_actor_reference" CHECK (char_length("privacy_request_events"."actor_reference") between 1 and 200),
	CONSTRAINT "privacy_request_events_evidence_reference" CHECK (char_length("privacy_request_events"."evidence_reference") between 1 and 200),
	CONSTRAINT "privacy_request_events_correlation" CHECK (char_length("privacy_request_events"."correlation_id") between 1 and 200),
	CONSTRAINT "privacy_request_events_deduplication_key_length" CHECK (char_length("privacy_request_events"."deduplication_key") between 1 and 256),
	CONSTRAINT "privacy_request_events_detail_object" CHECK (jsonb_typeof("privacy_request_events"."detail") = 'object')
);
--> statement-breakpoint
CREATE TABLE "privacy_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_reference" text NOT NULL,
	"requester_reference" text NOT NULL,
	"claimed_participant_id" uuid,
	"request_type" "privacy_request_type" NOT NULL,
	"identity_verification_state" "privacy_identity_verification_state" DEFAULT 'unverified' NOT NULL,
	"scope_version" text NOT NULL,
	"scope" jsonb NOT NULL,
	"status" "privacy_request_status" DEFAULT 'received' NOT NULL,
	"deadline_policy_reference" text,
	"deadline_at" timestamp with time zone,
	"assignee_id" text,
	"input_digest" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "privacy_requests_request_reference_key" UNIQUE("request_reference"),
	CONSTRAINT "privacy_requests_request_reference" CHECK (char_length("privacy_requests"."request_reference") between 1 and 200),
	CONSTRAINT "privacy_requests_requester_reference" CHECK (char_length("privacy_requests"."requester_reference") between 1 and 200),
	CONSTRAINT "privacy_requests_scope_version" CHECK ("privacy_requests"."scope_version" ~ '^[a-z][a-z0-9-]*-v[0-9]+$'),
	CONSTRAINT "privacy_requests_scope_object" CHECK (jsonb_typeof("privacy_requests"."scope") = 'object'),
	CONSTRAINT "privacy_requests_deadline_policy_coherence" CHECK (("privacy_requests"."deadline_policy_reference" is null and "privacy_requests"."deadline_at" is null) or ("privacy_requests"."deadline_policy_reference" is not null and "privacy_requests"."deadline_at" is not null)),
	CONSTRAINT "privacy_requests_assignee_reference" CHECK ("privacy_requests"."assignee_id" is null or char_length("privacy_requests"."assignee_id") between 1 and 200),
	CONSTRAINT "privacy_requests_input_digest" CHECK ("privacy_requests"."input_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "privacy_request_events" ADD CONSTRAINT "privacy_request_events_request_id_privacy_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."privacy_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_claimed_participant_id_participants_id_fk" FOREIGN KEY ("claimed_participant_id") REFERENCES "public"."participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "privacy_request_events_timeline_idx" ON "privacy_request_events" USING btree ("request_id","occurred_at");--> statement-breakpoint
CREATE INDEX "privacy_requests_queue_idx" ON "privacy_requests" USING btree ("status","deadline_at","assignee_id","created_at");--> statement-breakpoint
CREATE INDEX "privacy_requests_claimed_participant_idx" ON "privacy_requests" USING btree ("claimed_participant_id","created_at");--> statement-breakpoint

-- T96: privacy intake stays internal. Direct Data API roles receive no table privileges even when
-- this schema is deployed into Supabase, while the restricted application group receives explicit
-- RLS policies for its service-only connection.
ALTER TABLE privacy_requests ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE privacy_request_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY privacy_requests_app_role ON privacy_requests
  FOR ALL TO helloreview_app USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY privacy_request_events_app_role ON privacy_request_events
  FOR SELECT TO helloreview_app USING (true);--> statement-breakpoint
CREATE POLICY privacy_request_events_app_insert ON privacy_request_events
  FOR INSERT TO helloreview_app WITH CHECK (true);--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON privacy_requests, privacy_request_events FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON privacy_requests, privacy_request_events FROM authenticated;
  END IF;
END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION privacy_request_history_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION privacy_request_history_reject_mutation() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER privacy_request_events_append_only
BEFORE UPDATE OR DELETE ON privacy_request_events
FOR EACH STATEMENT EXECUTE FUNCTION privacy_request_history_reject_mutation();--> statement-breakpoint
ALTER TABLE privacy_request_events ENABLE ALWAYS TRIGGER privacy_request_events_append_only;--> statement-breakpoint
CREATE TRIGGER privacy_request_events_no_truncate
BEFORE TRUNCATE ON privacy_request_events
FOR EACH STATEMENT EXECUTE FUNCTION privacy_request_history_reject_mutation();--> statement-breakpoint
ALTER TABLE privacy_request_events ENABLE ALWAYS TRIGGER privacy_request_events_no_truncate;--> statement-breakpoint

REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON privacy_request_events FROM helloreview_app;
