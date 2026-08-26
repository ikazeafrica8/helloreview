CREATE TYPE "public"."human_review_task_event_type" AS ENUM('created', 'holding_queued', 'assigned', 'released', 'resolution_recorded', 'resume_rejected', 'returned_to_automation', 'cancelled', 'sla_escalated');--> statement-breakpoint
CREATE TABLE "human_review_holding_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"template_version" integer NOT NULL,
	"outbound_notification_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "human_review_holding_messages_task_template_key" UNIQUE("task_id","template_version"),
	CONSTRAINT "human_review_holding_messages_notification_key" UNIQUE("outbound_notification_id"),
	CONSTRAINT "human_review_holding_messages_positive_template" CHECK ("human_review_holding_messages"."template_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "human_review_task_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"event_type" "human_review_task_event_type" NOT NULL,
	"from_status" "human_review_status",
	"to_status" "human_review_status",
	"actor_id" text NOT NULL,
	"reason_code" text NOT NULL,
	"correlation_id" text NOT NULL,
	"detail" jsonb NOT NULL,
	"deduplication_key" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "human_review_task_events_dedupe_key" UNIQUE("deduplication_key"),
	CONSTRAINT "human_review_task_events_reason_code" CHECK ("human_review_task_events"."reason_code" ~ '^[A-Z][A-Z0-9_]*$'),
	CONSTRAINT "human_review_task_events_correlation" CHECK (char_length("human_review_task_events"."correlation_id") between 1 and 200)
);
--> statement-breakpoint
DROP INDEX "human_review_tasks_queue_idx";--> statement-breakpoint
ALTER TABLE "human_review_tasks" ADD COLUMN "workflow_id" uuid;--> statement-breakpoint
ALTER TABLE "human_review_tasks" ADD COLUMN "campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "human_review_tasks" ADD COLUMN "episode_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "human_review_tasks" ADD COLUMN "case_packet_version" text DEFAULT 'legacy-case-packet-v0' NOT NULL;--> statement-breakpoint
ALTER TABLE "human_review_tasks" ADD COLUMN "assignee_id" text;--> statement-breakpoint
ALTER TABLE "human_review_tasks" ADD COLUMN "assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "human_review_tasks" ADD COLUMN "sla_policy_version" text;--> statement-breakpoint
ALTER TABLE "human_review_tasks" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "human_review_tasks" ADD COLUMN "escalation_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "human_review_tasks" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "human_review_tasks" ADD COLUMN "resolved_by" text;--> statement-breakpoint
ALTER TABLE "human_review_tasks" ADD COLUMN "resolution_code" text;--> statement-breakpoint
ALTER TABLE "human_review_tasks" ADD COLUMN "resolution_reason" text;--> statement-breakpoint
ALTER TABLE "human_review_tasks" ADD COLUMN "returned_to_automation_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "human_review_holding_messages" ADD CONSTRAINT "human_review_holding_messages_task_id_human_review_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."human_review_tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_review_holding_messages" ADD CONSTRAINT "human_review_holding_messages_outbound_notification_id_outbound_notifications_id_fk" FOREIGN KEY ("outbound_notification_id") REFERENCES "public"."outbound_notifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_review_task_events" ADD CONSTRAINT "human_review_task_events_task_id_human_review_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."human_review_tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "human_review_task_events_timeline_idx" ON "human_review_task_events" USING btree ("task_id","occurred_at");--> statement-breakpoint
ALTER TABLE "human_review_tasks" ADD CONSTRAINT "human_review_tasks_workflow_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_review_tasks" ADD CONSTRAINT "human_review_tasks_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "human_review_tasks_workflow_episode_key" ON "human_review_tasks" USING btree ("workflow_id","episode_number") WHERE "human_review_tasks"."workflow_id" is not null;--> statement-breakpoint
CREATE INDEX "human_review_tasks_workflow_idx" ON "human_review_tasks" USING btree ("workflow_id","created_at");--> statement-breakpoint
CREATE INDEX "human_review_tasks_queue_idx" ON "human_review_tasks" USING btree ("status","priority","due_at","campaign_id","assignee_id","created_at");--> statement-breakpoint
ALTER TABLE "human_review_tasks" ADD CONSTRAINT "human_review_tasks_positive_episode" CHECK ("human_review_tasks"."episode_number" > 0);--> statement-breakpoint
ALTER TABLE "human_review_tasks" ADD CONSTRAINT "human_review_tasks_case_packet_version" CHECK ("human_review_tasks"."case_packet_version" ~ '^[a-z][a-z0-9-]*-v[0-9]+$');--> statement-breakpoint
ALTER TABLE "human_review_tasks" ADD CONSTRAINT "human_review_tasks_assignment_coherence" CHECK (("human_review_tasks"."assignee_id" is null and "human_review_tasks"."assigned_at" is null) or ("human_review_tasks"."assignee_id" is not null and "human_review_tasks"."assigned_at" is not null));--> statement-breakpoint
ALTER TABLE "human_review_tasks" ADD CONSTRAINT "human_review_tasks_sla_coherence" CHECK (("human_review_tasks"."sla_policy_version" is null and "human_review_tasks"."due_at" is null and "human_review_tasks"."escalation_at" is null) or ("human_review_tasks"."sla_policy_version" is not null and "human_review_tasks"."due_at" is not null and "human_review_tasks"."escalation_at" is not null and "human_review_tasks"."escalation_at" >= "human_review_tasks"."due_at"));--> statement-breakpoint

-- A pre-Milestone-3 database may contain a manually resolved projection even though the old schema
-- had nowhere to retain resolution evidence. Preserve the status, label the gap explicitly, and
-- create a reconstructable migration event; never invent the original actor or reason.
UPDATE human_review_tasks
   SET resolved_at = updated_at,
       resolved_by = 'legacy-migration',
       resolution_code = 'LEGACY_RESOLUTION_UNRECORDED',
       resolution_reason = 'Migration backfill: original resolution evidence was not stored by the legacy schema.'
 WHERE status = 'resolved'
   AND resolved_at IS NULL;--> statement-breakpoint
INSERT INTO human_review_task_events (
  task_id, event_type, from_status, to_status, actor_id, reason_code,
  correlation_id, detail, deduplication_key, occurred_at
)
SELECT id, 'resolution_recorded', 'in_progress', 'resolved', 'legacy-migration',
       'LEGACY_RESOLUTION_UNRECORDED', 'migration-0027',
       '{"migration_backfill":true,"original_evidence_available":false}'::jsonb,
       id::text || ':legacy-resolution-backfill', updated_at
  FROM human_review_tasks
 WHERE status = 'resolved';--> statement-breakpoint
ALTER TABLE "human_review_tasks" ADD CONSTRAINT "human_review_tasks_resolution_coherence" CHECK (("human_review_tasks"."status" = 'resolved') = ("human_review_tasks"."resolved_at" is not null and "human_review_tasks"."resolved_by" is not null and "human_review_tasks"."resolution_code" is not null and "human_review_tasks"."resolution_reason" is not null));--> statement-breakpoint
ALTER TABLE "human_review_tasks" ADD CONSTRAINT "human_review_tasks_resolution_code" CHECK ("human_review_tasks"."resolution_code" is null or "human_review_tasks"."resolution_code" ~ '^[A-Z][A-Z0-9_]*$');--> statement-breakpoint

-- T89-T92: holding-message linkage and every operational decision are immutable evidence.
CREATE OR REPLACE FUNCTION human_review_history_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION human_review_history_reject_mutation() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER human_review_task_events_append_only
BEFORE UPDATE OR DELETE ON human_review_task_events
FOR EACH STATEMENT EXECUTE FUNCTION human_review_history_reject_mutation();--> statement-breakpoint
ALTER TABLE human_review_task_events ENABLE ALWAYS TRIGGER human_review_task_events_append_only;--> statement-breakpoint
CREATE TRIGGER human_review_holding_messages_append_only
BEFORE UPDATE OR DELETE ON human_review_holding_messages
FOR EACH STATEMENT EXECUTE FUNCTION human_review_history_reject_mutation();--> statement-breakpoint
ALTER TABLE human_review_holding_messages ENABLE ALWAYS TRIGGER human_review_holding_messages_append_only;--> statement-breakpoint

REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON human_review_task_events, human_review_holding_messages FROM helloreview_app;
