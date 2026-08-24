CREATE TYPE "public"."business_approval_source" AS ENUM('authorized_operator', 'authorized_system');--> statement-breakpoint
CREATE TYPE "public"."guideline_delivery_attempt_outcome" AS ENUM('queued', 'suppressed', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."guideline_delivery_status" AS ENUM('queued', 'delivered', 'failed');--> statement-breakpoint
CREATE TYPE "public"."guideline_incident_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TABLE "business_approval_heads" (
	"workflow_id" uuid PRIMARY KEY NOT NULL,
	"approval_id" uuid NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "business_approval_heads_approval_id_unique" UNIQUE("approval_id")
);
--> statement-breakpoint
CREATE TABLE "business_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"state" "workflow_business_approval_state" NOT NULL,
	"source" "business_approval_source" NOT NULL,
	"approver_reference" text NOT NULL,
	"scope_code" text NOT NULL,
	"reason_code" text NOT NULL,
	"issued_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"recorded_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_approvals_workflow_version_key" UNIQUE("workflow_id","version"),
	CONSTRAINT "business_approvals_positive_version" CHECK ("business_approvals"."version" > 0),
	CONSTRAINT "business_approvals_reason_code" CHECK ("business_approvals"."reason_code" ~ '^[A-Z][A-Z0-9_]*$'),
	CONSTRAINT "business_approvals_scope_code" CHECK (char_length("business_approvals"."scope_code") between 1 and 200),
	CONSTRAINT "business_approvals_issued_evidence" CHECK ("business_approvals"."state" <> 'approved' or "business_approvals"."issued_at" is not null),
	CONSTRAINT "business_approvals_expiry_after_issue" CHECK ("business_approvals"."expires_at" is null or ("business_approvals"."issued_at" is not null and "business_approvals"."expires_at" > "business_approvals"."issued_at"))
);
--> statement-breakpoint
CREATE TABLE "guideline_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"guideline_version_id" uuid NOT NULL,
	"guideline_version" integer NOT NULL,
	"channel" text NOT NULL,
	"triggering_event_id" text NOT NULL,
	"rule_result" jsonb NOT NULL,
	"status" "guideline_delivery_status" DEFAULT 'queued' NOT NULL,
	"outbound_notification_id" uuid NOT NULL,
	"provider_result" jsonb NOT NULL,
	"deduplication_key" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"delivered_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guideline_deliveries_workflow_version_key" UNIQUE("workflow_id","guideline_version"),
	CONSTRAINT "guideline_deliveries_deduplication_key" UNIQUE("deduplication_key"),
	CONSTRAINT "guideline_deliveries_positive_version" CHECK ("guideline_deliveries"."guideline_version" > 0),
	CONSTRAINT "guideline_deliveries_channel_code" CHECK ("guideline_deliveries"."channel" ~ '^[A-Z][A-Z0-9_]*$'),
	CONSTRAINT "guideline_deliveries_delivery_evidence" CHECK ("guideline_deliveries"."status" <> 'delivered' or "guideline_deliveries"."delivered_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "guideline_delivery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"delivery_id" uuid,
	"guideline_version" integer,
	"triggering_event_id" text NOT NULL,
	"outcome" "guideline_delivery_attempt_outcome" NOT NULL,
	"reason_code" text NOT NULL,
	"rule_result" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "guideline_delivery_attempts_reason_code" CHECK ("guideline_delivery_attempts"."reason_code" ~ '^[A-Z][A-Z0-9_]*$'),
	CONSTRAINT "guideline_delivery_attempts_version_coherence" CHECK (("guideline_delivery_attempts"."outcome" = 'blocked') or ("guideline_delivery_attempts"."guideline_version" is not null and "guideline_delivery_attempts"."delivery_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "guideline_delivery_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"severity" text DEFAULT 'critical' NOT NULL,
	"status" "guideline_incident_status" DEFAULT 'open' NOT NULL,
	"reason_code" text NOT NULL,
	"state_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "guideline_delivery_incidents_delivery_reason_key" UNIQUE("delivery_id","reason_code"),
	CONSTRAINT "guideline_delivery_incidents_critical_only" CHECK ("guideline_delivery_incidents"."severity" = 'critical'),
	CONSTRAINT "guideline_delivery_incidents_reason_code" CHECK ("guideline_delivery_incidents"."reason_code" ~ '^[A-Z][A-Z0-9_]*$')
);
--> statement-breakpoint
ALTER TABLE "business_approval_heads" ADD CONSTRAINT "business_approval_heads_workflow_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_approval_heads" ADD CONSTRAINT "business_approval_heads_approval_id_business_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."business_approvals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_approvals" ADD CONSTRAINT "business_approvals_workflow_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_approvals" ADD CONSTRAINT "business_approvals_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_approvals" ADD CONSTRAINT "business_approvals_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guideline_deliveries" ADD CONSTRAINT "guideline_deliveries_workflow_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guideline_deliveries" ADD CONSTRAINT "guideline_deliveries_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guideline_deliveries" ADD CONSTRAINT "guideline_deliveries_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guideline_deliveries" ADD CONSTRAINT "guideline_deliveries_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guideline_deliveries" ADD CONSTRAINT "guideline_deliveries_guideline_version_id_guideline_versions_id_fk" FOREIGN KEY ("guideline_version_id") REFERENCES "public"."guideline_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guideline_deliveries" ADD CONSTRAINT "guideline_deliveries_outbound_notification_id_outbound_notifications_id_fk" FOREIGN KEY ("outbound_notification_id") REFERENCES "public"."outbound_notifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guideline_delivery_attempts" ADD CONSTRAINT "guideline_delivery_attempts_workflow_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guideline_delivery_attempts" ADD CONSTRAINT "guideline_delivery_attempts_delivery_id_guideline_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."guideline_deliveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guideline_delivery_incidents" ADD CONSTRAINT "guideline_delivery_incidents_delivery_id_guideline_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."guideline_deliveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guideline_delivery_incidents" ADD CONSTRAINT "guideline_delivery_incidents_workflow_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guideline_delivery_incidents" ADD CONSTRAINT "guideline_delivery_incidents_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "business_approvals_scope_history_idx" ON "business_approvals" USING btree ("campaign_id","application_id","version");--> statement-breakpoint
CREATE INDEX "guideline_deliveries_audit_idx" ON "guideline_deliveries" USING btree ("campaign_id","participant_id","created_at");--> statement-breakpoint
CREATE INDEX "guideline_deliveries_status_idx" ON "guideline_deliveries" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "guideline_delivery_attempts_timeline_idx" ON "guideline_delivery_attempts" USING btree ("workflow_id","occurred_at");--> statement-breakpoint
CREATE INDEX "guideline_delivery_incidents_open_idx" ON "guideline_delivery_incidents" USING btree ("status","created_at");
--> statement-breakpoint

-- Approval versions and delivery attempts are evidence. Supersession changes only the mutable
-- approval head; repeated delivery requests append another attempt.
CREATE OR REPLACE FUNCTION phase_7_history_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is forbidden', TG_TABLE_NAME, TG_OP;
END;
$$;--> statement-breakpoint

CREATE TRIGGER business_approvals_no_update_or_delete
  BEFORE UPDATE OR DELETE ON business_approvals
  FOR EACH ROW EXECUTE FUNCTION phase_7_history_reject_mutation();--> statement-breakpoint
CREATE TRIGGER business_approvals_no_truncate
  BEFORE TRUNCATE ON business_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION phase_7_history_reject_mutation();--> statement-breakpoint
CREATE TRIGGER guideline_delivery_attempts_no_update_or_delete
  BEFORE UPDATE OR DELETE ON guideline_delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION phase_7_history_reject_mutation();--> statement-breakpoint
CREATE TRIGGER guideline_delivery_attempts_no_truncate
  BEFORE TRUNCATE ON guideline_delivery_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION phase_7_history_reject_mutation();--> statement-breakpoint

ALTER TABLE business_approvals ENABLE ALWAYS TRIGGER business_approvals_no_update_or_delete;--> statement-breakpoint
ALTER TABLE business_approvals ENABLE ALWAYS TRIGGER business_approvals_no_truncate;--> statement-breakpoint
ALTER TABLE guideline_delivery_attempts ENABLE ALWAYS TRIGGER guideline_delivery_attempts_no_update_or_delete;--> statement-breakpoint
ALTER TABLE guideline_delivery_attempts ENABLE ALWAYS TRIGGER guideline_delivery_attempts_no_truncate;--> statement-breakpoint

-- The head must point to an approval version from the same workflow.
CREATE OR REPLACE FUNCTION business_approval_head_scope_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM business_approvals a
     WHERE a.id = NEW.approval_id AND a.workflow_id = NEW.workflow_id
  ) THEN
    RAISE EXCEPTION 'business approval head scope mismatch';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER business_approval_heads_scope_guard
  BEFORE INSERT OR UPDATE ON business_approval_heads
  FOR EACH ROW EXECUTE FUNCTION business_approval_head_scope_guard();--> statement-breakpoint
ALTER TABLE business_approval_heads ENABLE ALWAYS TRIGGER business_approval_heads_scope_guard;--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION phase_7_history_reject_mutation() FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION business_approval_head_scope_guard() FROM PUBLIC;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON business_approvals FROM helloreview_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON guideline_delivery_attempts FROM helloreview_app;
