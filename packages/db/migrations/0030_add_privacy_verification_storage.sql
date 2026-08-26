CREATE TABLE "privacy_request_processing_pauses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"pause_id" uuid NOT NULL,
	"scope" "automation_pause_scope" NOT NULL,
	"participant_id" uuid,
	"campaign_id" uuid,
	"workflow_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "privacy_request_processing_pauses_request_pause_key" UNIQUE("request_id","pause_id"),
	CONSTRAINT "privacy_request_processing_pauses_scope_target" CHECK (("privacy_request_processing_pauses"."scope" = 'participant' and "privacy_request_processing_pauses"."participant_id" is not null and "privacy_request_processing_pauses"."campaign_id" is null and "privacy_request_processing_pauses"."workflow_id" is null)
          or ("privacy_request_processing_pauses"."scope" = 'participant_campaign' and "privacy_request_processing_pauses"."participant_id" is not null and "privacy_request_processing_pauses"."campaign_id" is not null and "privacy_request_processing_pauses"."workflow_id" is null)
          or ("privacy_request_processing_pauses"."scope" = 'workflow' and "privacy_request_processing_pauses"."participant_id" is null and "privacy_request_processing_pauses"."campaign_id" is null and "privacy_request_processing_pauses"."workflow_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "automation_pauses" DROP CONSTRAINT "automation_pauses_scope_target";--> statement-breakpoint
ALTER TABLE "automation_pauses" ADD COLUMN "workflow_id" uuid;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD COLUMN "verification_policy_reference" text;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD COLUMN "verification_method" text;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "privacy_request_processing_pauses" ADD CONSTRAINT "privacy_request_processing_pauses_request_id_privacy_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."privacy_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_request_processing_pauses" ADD CONSTRAINT "privacy_request_processing_pauses_pause_id_automation_pauses_id_fk" FOREIGN KEY ("pause_id") REFERENCES "public"."automation_pauses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_request_processing_pauses" ADD CONSTRAINT "privacy_request_processing_pauses_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_request_processing_pauses" ADD CONSTRAINT "privacy_request_processing_pauses_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_request_processing_pauses" ADD CONSTRAINT "privacy_request_processing_pauses_workflow_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "privacy_request_processing_pauses_request_idx" ON "privacy_request_processing_pauses" USING btree ("request_id","created_at");--> statement-breakpoint
ALTER TABLE "automation_pauses" ADD CONSTRAINT "automation_pauses_workflow_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_pauses_active_participant_campaign_key" ON "automation_pauses" USING btree ("participant_id","campaign_id","kind") WHERE "automation_pauses"."scope" = 'participant_campaign' and "automation_pauses"."deactivated_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_pauses_active_workflow_key" ON "automation_pauses" USING btree ("workflow_id","kind") WHERE "automation_pauses"."scope" = 'workflow' and "automation_pauses"."deactivated_at" is null;--> statement-breakpoint
ALTER TABLE "automation_pauses" ADD CONSTRAINT "automation_pauses_privacy_scope_only" CHECK ("automation_pauses"."kind" <> 'privacy_request' or "automation_pauses"."scope" in ('participant', 'participant_campaign', 'workflow'));--> statement-breakpoint
ALTER TABLE "automation_pauses" ADD CONSTRAINT "automation_pauses_precise_scope_privacy_only" CHECK ("automation_pauses"."scope" not in ('participant_campaign', 'workflow') or "automation_pauses"."kind" = 'privacy_request');--> statement-breakpoint
ALTER TABLE "automation_pauses" ADD CONSTRAINT "automation_pauses_scope_target" CHECK (("automation_pauses"."scope" = 'global' and "automation_pauses"."campaign_id" is null and "automation_pauses"."workflow_type" is null and "automation_pauses"."participant_id" is null and "automation_pauses"."workflow_id" is null)
          or ("automation_pauses"."scope" = 'campaign' and "automation_pauses"."campaign_id" is not null and "automation_pauses"."workflow_type" is null and "automation_pauses"."participant_id" is null and "automation_pauses"."workflow_id" is null)
          or ("automation_pauses"."scope" = 'workflow_type' and "automation_pauses"."campaign_id" is null and "automation_pauses"."workflow_type" is not null and "automation_pauses"."participant_id" is null and "automation_pauses"."workflow_id" is null)
          or ("automation_pauses"."scope" = 'participant' and "automation_pauses"."campaign_id" is null and "automation_pauses"."workflow_type" is null and "automation_pauses"."participant_id" is not null and "automation_pauses"."workflow_id" is null)
          or ("automation_pauses"."scope" = 'participant_campaign' and "automation_pauses"."campaign_id" is not null and "automation_pauses"."workflow_type" is null and "automation_pauses"."participant_id" is not null and "automation_pauses"."workflow_id" is null)
          or ("automation_pauses"."scope" = 'workflow' and "automation_pauses"."campaign_id" is null and "automation_pauses"."workflow_type" is null and "automation_pauses"."participant_id" is null and "automation_pauses"."workflow_id" is not null));--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_verified_projection_coherence" CHECK (("privacy_requests"."identity_verification_state" = 'verified' and "privacy_requests"."verification_policy_reference" is not null and "privacy_requests"."verification_method" is not null and "privacy_requests"."verified_at" is not null)
          or ("privacy_requests"."identity_verification_state" <> 'verified' and "privacy_requests"."verification_policy_reference" is null and "privacy_requests"."verification_method" is null and "privacy_requests"."verified_at" is null));
--> statement-breakpoint

-- T97: direct Data API roles cannot observe verification or processing-pause data. The application
-- role receives operation-specific policies, and immutable request-to-pause links remain append-only.
ALTER TABLE automation_pauses ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE privacy_request_processing_pauses ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS privacy_requests_app_role ON privacy_requests;--> statement-breakpoint
CREATE POLICY privacy_requests_app_select ON privacy_requests
  FOR SELECT TO helloreview_app USING (true);--> statement-breakpoint
CREATE POLICY privacy_requests_app_insert ON privacy_requests
  FOR INSERT TO helloreview_app WITH CHECK (true);--> statement-breakpoint
CREATE POLICY privacy_requests_app_update ON privacy_requests
  FOR UPDATE TO helloreview_app USING (true) WITH CHECK (true);--> statement-breakpoint

CREATE POLICY automation_pauses_app_select ON automation_pauses
  FOR SELECT TO helloreview_app USING (true);--> statement-breakpoint
CREATE POLICY automation_pauses_app_insert ON automation_pauses
  FOR INSERT TO helloreview_app WITH CHECK (true);--> statement-breakpoint
CREATE POLICY automation_pauses_app_update ON automation_pauses
  FOR UPDATE TO helloreview_app USING (true) WITH CHECK (true);--> statement-breakpoint

CREATE POLICY privacy_request_processing_pauses_app_select ON privacy_request_processing_pauses
  FOR SELECT TO helloreview_app USING (true);--> statement-breakpoint
CREATE POLICY privacy_request_processing_pauses_app_insert ON privacy_request_processing_pauses
  FOR INSERT TO helloreview_app WITH CHECK (true);--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON automation_pauses, privacy_requests, privacy_request_events,
      privacy_request_processing_pauses FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON automation_pauses, privacy_requests, privacy_request_events,
      privacy_request_processing_pauses FROM authenticated;
  END IF;
END
$$;--> statement-breakpoint

CREATE TRIGGER privacy_request_processing_pauses_append_only
BEFORE UPDATE OR DELETE ON privacy_request_processing_pauses
FOR EACH STATEMENT EXECUTE FUNCTION privacy_request_history_reject_mutation();--> statement-breakpoint
ALTER TABLE privacy_request_processing_pauses ENABLE ALWAYS TRIGGER privacy_request_processing_pauses_append_only;--> statement-breakpoint
CREATE TRIGGER privacy_request_processing_pauses_no_truncate
BEFORE TRUNCATE ON privacy_request_processing_pauses
FOR EACH STATEMENT EXECUTE FUNCTION privacy_request_history_reject_mutation();--> statement-breakpoint
ALTER TABLE privacy_request_processing_pauses ENABLE ALWAYS TRIGGER privacy_request_processing_pauses_no_truncate;--> statement-breakpoint

REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON privacy_request_processing_pauses FROM helloreview_app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION privacy_request_processing_pause_validate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM automation_pauses ap
      JOIN privacy_requests pr ON pr.id = NEW.request_id
      LEFT JOIN workflow_instances wi ON wi.id = NEW.workflow_id
     WHERE ap.id = NEW.pause_id
       AND ap.kind = 'privacy_request'
       AND ap.scope = NEW.scope
       AND ap.participant_id IS NOT DISTINCT FROM NEW.participant_id
       AND ap.campaign_id IS NOT DISTINCT FROM NEW.campaign_id
       AND ap.workflow_id IS NOT DISTINCT FROM NEW.workflow_id
       AND (
         (NEW.scope IN ('participant', 'participant_campaign')
           AND pr.claimed_participant_id = NEW.participant_id)
         OR (NEW.scope = 'workflow' AND wi.participant_id = pr.claimed_participant_id)
       )
  ) THEN
    RAISE EXCEPTION 'privacy request processing pause link is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION privacy_request_processing_pause_validate() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER privacy_request_processing_pauses_validate
BEFORE INSERT ON privacy_request_processing_pauses
FOR EACH ROW EXECUTE FUNCTION privacy_request_processing_pause_validate();
