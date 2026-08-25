CREATE TYPE "public"."payback_consent_response_classification" AS ENUM('explicit_agreement', 'explicit_decline', 'ambiguous');--> statement-breakpoint
CREATE TYPE "public"."payback_consent_response_outcome" AS ENUM('agreed', 'declined', 'clarification_sent', 'human_review_required', 'current_request_required', 'ignored_no_active_request');--> statement-breakpoint
CREATE TABLE "payback_consent_response_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"linked_request_id" text NOT NULL,
	"linked_terms_version" integer NOT NULL,
	"evidence_message_id" text NOT NULL,
	"channel" text NOT NULL,
	"classification" "payback_consent_response_classification" NOT NULL,
	"outcome" "payback_consent_response_outcome" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payback_consent_response_events_evidence_key" UNIQUE("aggregate_id","evidence_message_id"),
	CONSTRAINT "payback_consent_response_events_positive_terms_version" CHECK ("payback_consent_response_events"."linked_terms_version" > 0),
	CONSTRAINT "payback_consent_response_events_nonempty_request" CHECK (char_length("payback_consent_response_events"."linked_request_id") > 0),
	CONSTRAINT "payback_consent_response_events_nonempty_evidence" CHECK (char_length("payback_consent_response_events"."evidence_message_id") > 0)
);
--> statement-breakpoint
ALTER TABLE "payback_consent_response_events" ADD CONSTRAINT "payback_consent_response_events_aggregate_id_payback_consent_aggregates_id_fk" FOREIGN KEY ("aggregate_id") REFERENCES "public"."payback_consent_aggregates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payback_consent_response_events" ADD CONSTRAINT "payback_consent_response_events_workflow_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payback_consent_response_events_workflow_timeline_idx" ON "payback_consent_response_events" USING btree ("workflow_id","occurred_at");--> statement-breakpoint

CREATE TRIGGER payback_consent_response_events_append_only
BEFORE UPDATE OR DELETE ON payback_consent_response_events
FOR EACH ROW EXECUTE FUNCTION reject_participant_flow_history_mutation();--> statement-breakpoint
ALTER TABLE payback_consent_response_events ENABLE ALWAYS TRIGGER payback_consent_response_events_append_only;--> statement-breakpoint

REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON payback_consent_response_events
  FROM helloreview_app;--> statement-breakpoint
GRANT SELECT, INSERT
  ON payback_consent_response_events
  TO helloreview_app;
