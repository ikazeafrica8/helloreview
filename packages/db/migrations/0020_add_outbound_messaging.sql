CREATE TYPE "public"."outbound_intent_source" AS ENUM('automated', 'operator', 'system_notice');--> statement-breakpoint
CREATE TYPE "public"."outbound_notification_event_type" AS ENUM('created', 'claimed', 'send_started', 'send_accepted', 'delivery_unknown', 'delivered', 'failed', 'retry_scheduled', 'suppressed');--> statement-breakpoint
CREATE TYPE "public"."outbound_notification_status" AS ENUM('pending', 'claimed', 'sending', 'accepted', 'unknown', 'delivered', 'failed', 'suppressed');--> statement-breakpoint
CREATE TABLE "operator_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"operator_id" text NOT NULL,
	"reason_code" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by" text,
	CONSTRAINT "operator_assignments_reason_code" CHECK ("operator_assignments"."reason_code" ~ '^[A-Z][A-Z0-9_]*$'),
	CONSTRAINT "operator_assignments_end_coherence" CHECK (("operator_assignments"."ended_at" is null and "operator_assignments"."ended_by" is null) or ("operator_assignments"."ended_at" is not null and "operator_assignments"."ended_by" is not null))
);
--> statement-breakpoint
CREATE TABLE "outbound_notification_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notification_id" uuid NOT NULL,
	"event_type" "outbound_notification_event_type" NOT NULL,
	"status" "outbound_notification_status" NOT NULL,
	"reason_code" text NOT NULL,
	"provider_message_id" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"actor_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "outbound_notification_events_reason_code" CHECK ("outbound_notification_events"."reason_code" ~ '^[A-Z][A-Z0-9_]*$'),
	CONSTRAINT "outbound_notification_events_nonnegative_retry_count" CHECK ("outbound_notification_events"."retry_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "outbound_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"recipient_reference" text NOT NULL,
	"purpose_code" text NOT NULL,
	"content_version" text NOT NULL,
	"business_event_version" text,
	"authorized_redelivery_id" text,
	"deduplication_key" text NOT NULL,
	"intent_source" "outbound_intent_source" NOT NULL,
	"template_id" uuid NOT NULL,
	"template_version" integer NOT NULL,
	"rendered_content" text NOT NULL,
	"provider_template_code" text,
	"provider_name" text,
	"provider_message_id" text,
	"status" "outbound_notification_status" DEFAULT 'pending' NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"suppression_reason" text,
	"last_failure_code" text,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"last_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_notifications_deduplication_key_key" UNIQUE("deduplication_key"),
	CONSTRAINT "outbound_notifications_positive_template_version" CHECK ("outbound_notifications"."template_version" > 0),
	CONSTRAINT "outbound_notifications_nonnegative_retry_count" CHECK ("outbound_notifications"."retry_count" >= 0),
	CONSTRAINT "outbound_notifications_channel_code" CHECK ("outbound_notifications"."channel" ~ '^[A-Z][A-Z0-9_]*$'),
	CONSTRAINT "outbound_notifications_purpose_code" CHECK ("outbound_notifications"."purpose_code" ~ '^[A-Z][A-Z0-9_:]*$'),
	CONSTRAINT "outbound_notifications_nonempty_recipient" CHECK (length(btrim("outbound_notifications"."recipient_reference")) > 0),
	CONSTRAINT "outbound_notifications_nonempty_content" CHECK (length("outbound_notifications"."rendered_content") > 0),
	CONSTRAINT "outbound_notifications_suppression_coherence" CHECK (("outbound_notifications"."status" = 'suppressed') = ("outbound_notifications"."suppression_reason" is not null)),
	CONSTRAINT "outbound_notifications_claim_coherence" CHECK (("outbound_notifications"."status" in ('claimed', 'sending')) = ("outbound_notifications"."claimed_at" is not null and "outbound_notifications"."claimed_by" is not null)),
	CONSTRAINT "outbound_notifications_delivery_evidence" CHECK ("outbound_notifications"."status" <> 'delivered' or ("outbound_notifications"."provider_message_id" is not null and "outbound_notifications"."delivered_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "operator_assignments" ADD CONSTRAINT "operator_assignments_workflow_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_notification_events" ADD CONSTRAINT "outbound_notification_events_notification_id_outbound_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."outbound_notifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_notifications" ADD CONSTRAINT "outbound_notifications_workflow_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_notifications" ADD CONSTRAINT "outbound_notifications_template_id_message_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."message_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_assignments_one_active_idx" ON "operator_assignments" USING btree ("workflow_id") WHERE "operator_assignments"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "operator_assignments_timeline_idx" ON "operator_assignments" USING btree ("workflow_id","started_at");--> statement-breakpoint
CREATE INDEX "outbound_notification_events_timeline_idx" ON "outbound_notification_events" USING btree ("notification_id","occurred_at");--> statement-breakpoint
CREATE INDEX "outbound_notifications_dispatch_idx" ON "outbound_notifications" USING btree ("status","next_attempt_at","created_at");--> statement-breakpoint
CREATE INDEX "outbound_notifications_workflow_idx" ON "outbound_notifications" USING btree ("workflow_id","created_at");--> statement-breakpoint
CREATE INDEX "outbound_notifications_provider_message_idx" ON "outbound_notifications" USING btree ("provider_name","provider_message_id");
--> statement-breakpoint

-- Notification events are evidence, not a mutable projection. Corrections append a new event.
CREATE OR REPLACE FUNCTION outbound_notification_history_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'outbound_notification_events is append-only; % is forbidden', TG_OP;
END;
$$;--> statement-breakpoint

CREATE TRIGGER outbound_notification_events_no_update_or_delete
  BEFORE UPDATE OR DELETE ON outbound_notification_events
  FOR EACH ROW EXECUTE FUNCTION outbound_notification_history_reject_mutation();--> statement-breakpoint

CREATE TRIGGER outbound_notification_events_no_truncate
  BEFORE TRUNCATE ON outbound_notification_events
  FOR EACH STATEMENT EXECUTE FUNCTION outbound_notification_history_reject_mutation();--> statement-breakpoint

ALTER TABLE outbound_notification_events ENABLE ALWAYS TRIGGER outbound_notification_events_no_update_or_delete;--> statement-breakpoint
ALTER TABLE outbound_notification_events ENABLE ALWAYS TRIGGER outbound_notification_events_no_truncate;--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION outbound_notification_history_reject_mutation() FROM PUBLIC;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON outbound_notification_events FROM helloreview_app;
