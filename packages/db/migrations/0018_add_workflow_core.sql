CREATE TYPE "public"."automation_pause_kind" AS ENUM('standard', 'emergency_kill_switch');--> statement-breakpoint
CREATE TYPE "public"."automation_pause_scope" AS ENUM('global', 'campaign', 'workflow_type', 'participant');--> statement-breakpoint
CREATE TYPE "public"."workflow_application_state" AS ENUM('not_applied', 'application_requested', 'application_pending', 'application_completed', 'application_matched', 'match_ambiguous', 'application_cancelled');--> statement-breakpoint
CREATE TYPE "public"."workflow_automation_mode_state" AS ENUM('active', 'paused_by_rule', 'paused_for_human', 'human_owned', 'campaign_paused', 'globally_paused', 'closed');--> statement-breakpoint
CREATE TYPE "public"."workflow_business_approval_state" AS ENUM('not_required', 'not_requested', 'pending', 'approved', 'rejected', 'expired', 'revoked', 'human_review_required');--> statement-breakpoint
CREATE TYPE "public"."workflow_dimension" AS ENUM('application', 'selection', 'campaign_type', 'visit_method', 'secret_comment', 'payback_consent', 'business_approval', 'shipping', 'reservation', 'guideline', 'human_handoff', 'automation_mode');--> statement-breakpoint
CREATE TYPE "public"."workflow_event_kind" AS ENUM('initialized', 'transition', 'transition_rejected', 'stale_event_rejected', 'correction');--> statement-breakpoint
CREATE TYPE "public"."workflow_event_result" AS ENUM('success', 'rejected', 'corrected');--> statement-breakpoint
CREATE TYPE "public"."workflow_guideline_state" AS ENUM('not_ready', 'ready', 'delivery_queued', 'delivered', 'delivery_failed', 'suppressed_as_duplicate', 'redelivery_authorized');--> statement-breakpoint
CREATE TYPE "public"."workflow_human_handoff_state" AS ENUM('not_required', 'requested', 'queued', 'assigned', 'in_progress', 'resolved', 'returned_to_automation', 'closed');--> statement-breakpoint
CREATE TYPE "public"."workflow_incident_severity" AS ENUM('critical');--> statement-breakpoint
CREATE TYPE "public"."workflow_incident_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."workflow_payback_consent_state" AS ENUM('not_applicable', 'not_requested', 'awaiting_response', 'agreed', 'declined', 'withdrawn', 'human_review_required');--> statement-breakpoint
CREATE TYPE "public"."workflow_reservation_state" AS ENUM('not_applicable', 'not_started', 'instructions_sent', 'awaiting_participant', 'information_received', 'screenshot_received', 'extraction_pending', 'validation_pending', 'valid', 'correction_required', 'cancelled', 'rescheduled', 'human_review_required');--> statement-breakpoint
CREATE TYPE "public"."workflow_secret_comment_state" AS ENUM('not_claimed', 'claimed', 'screenshot_requested', 'screenshot_received', 'verified', 'rejected', 'human_review_required');--> statement-breakpoint
CREATE TYPE "public"."workflow_selection_state" AS ENUM('not_reviewed', 'review_pending', 'auto_selected', 'manually_selected', 'not_selected', 'human_review_required');--> statement-breakpoint
CREATE TYPE "public"."workflow_shipping_state" AS ENUM('not_applicable', 'address_requested', 'address_received', 'address_incomplete', 'address_valid', 'address_change_requested', 'locked');--> statement-breakpoint
CREATE TYPE "public"."workflow_side_effect_status" AS ENUM('pending', 'completed', 'cancelled', 'suppressed');--> statement-breakpoint
CREATE TABLE "automation_pauses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" "automation_pause_scope" NOT NULL,
	"kind" "automation_pause_kind" DEFAULT 'standard' NOT NULL,
	"campaign_id" uuid,
	"workflow_type" "campaign_type",
	"participant_id" uuid,
	"reason_code" text NOT NULL,
	"activated_by_type" "audit_actor_type" NOT NULL,
	"activated_by_id" text NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	"deactivated_by_type" "audit_actor_type",
	"deactivated_by_id" text,
	"deactivation_reason_code" text,
	"deactivated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_pauses_scope_target" CHECK (("automation_pauses"."scope" = 'global' and "automation_pauses"."campaign_id" is null and "automation_pauses"."workflow_type" is null and "automation_pauses"."participant_id" is null)
          or ("automation_pauses"."scope" = 'campaign' and "automation_pauses"."campaign_id" is not null and "automation_pauses"."workflow_type" is null and "automation_pauses"."participant_id" is null)
          or ("automation_pauses"."scope" = 'workflow_type' and "automation_pauses"."campaign_id" is null and "automation_pauses"."workflow_type" is not null and "automation_pauses"."participant_id" is null)
          or ("automation_pauses"."scope" = 'participant' and "automation_pauses"."campaign_id" is null and "automation_pauses"."workflow_type" is null and "automation_pauses"."participant_id" is not null)),
	CONSTRAINT "automation_pauses_emergency_global_only" CHECK ("automation_pauses"."kind" <> 'emergency_kill_switch' or "automation_pauses"."scope" = 'global'),
	CONSTRAINT "automation_pauses_reason_code" CHECK ("automation_pauses"."reason_code" ~ '^[A-Z][A-Z0-9_]*$'),
	CONSTRAINT "automation_pauses_valid_deactivation" CHECK ("automation_pauses"."deactivated_at" is null or ("automation_pauses"."deactivated_at" >= "automation_pauses"."activated_at" and "automation_pauses"."deactivated_by_type" is not null and "automation_pauses"."deactivated_by_id" is not null and "automation_pauses"."deactivation_reason_code" is not null))
);
--> statement-breakpoint
CREATE TABLE "workflow_event_supersessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"prior_event_id" uuid NOT NULL,
	"correction_event_id" uuid NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" text NOT NULL,
	"reason_code" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"correlation_id" text NOT NULL,
	CONSTRAINT "workflow_event_supersessions_prior_key" UNIQUE("prior_event_id"),
	CONSTRAINT "workflow_event_supersessions_correction_key" UNIQUE("correction_event_id"),
	CONSTRAINT "workflow_event_supersessions_reason_code" CHECK ("workflow_event_supersessions"."reason_code" ~ '^[A-Z][A-Z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE "workflow_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"expected_version" integer NOT NULL,
	"workflow_version" integer NOT NULL,
	"dimension" "workflow_dimension" NOT NULL,
	"event_kind" "workflow_event_kind" NOT NULL,
	"current_state" text NOT NULL,
	"requested_target_state" text NOT NULL,
	"trigger_code" text NOT NULL,
	"triggering_event_id" text NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" text NOT NULL,
	"preconditions" jsonb NOT NULL,
	"rule_version" text,
	"decision_reason" text NOT NULL,
	"side_effects" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"correlation_id" text NOT NULL,
	"result" "workflow_event_result" NOT NULL,
	"retained_for_replay" boolean DEFAULT false NOT NULL,
	CONSTRAINT "workflow_events_nonnegative_expected_version" CHECK ("workflow_events"."expected_version" >= 0),
	CONSTRAINT "workflow_events_nonnegative_workflow_version" CHECK ("workflow_events"."workflow_version" >= 0),
	CONSTRAINT "workflow_events_trigger_code" CHECK ("workflow_events"."trigger_code" ~ '^[A-Z][A-Z0-9_]*$'),
	CONSTRAINT "workflow_events_decision_reason" CHECK ("workflow_events"."decision_reason" ~ '^[A-Z][A-Z0-9_]*$'),
	CONSTRAINT "workflow_events_nonempty_correlation_id" CHECK (char_length("workflow_events"."correlation_id") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "workflow_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"workflow_event_id" uuid NOT NULL,
	"severity" "workflow_incident_severity" DEFAULT 'critical' NOT NULL,
	"reason_code" text NOT NULL,
	"status" "workflow_incident_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "workflow_incidents_reason_code" CHECK ("workflow_incidents"."reason_code" ~ '^[A-Z][A-Z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE "workflow_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participant_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"application_state" "workflow_application_state" DEFAULT 'not_applied' NOT NULL,
	"selection_state" "workflow_selection_state" DEFAULT 'not_reviewed' NOT NULL,
	"campaign_type" "campaign_type" NOT NULL,
	"visit_method" "visit_method" DEFAULT 'not_applicable' NOT NULL,
	"secret_comment_state" "workflow_secret_comment_state" DEFAULT 'not_claimed' NOT NULL,
	"payback_consent_state" "workflow_payback_consent_state" DEFAULT 'not_applicable' NOT NULL,
	"business_approval_state" "workflow_business_approval_state" DEFAULT 'not_required' NOT NULL,
	"shipping_state" "workflow_shipping_state" DEFAULT 'not_applicable' NOT NULL,
	"reservation_state" "workflow_reservation_state" DEFAULT 'not_applicable' NOT NULL,
	"guideline_state" "workflow_guideline_state" DEFAULT 'not_ready' NOT NULL,
	"human_handoff_state" "workflow_human_handoff_state" DEFAULT 'not_required' NOT NULL,
	"automation_mode_state" "workflow_automation_mode_state" DEFAULT 'active' NOT NULL,
	"application_origin_at" timestamp with time zone NOT NULL,
	"selection_origin_at" timestamp with time zone NOT NULL,
	"secret_comment_origin_at" timestamp with time zone NOT NULL,
	"payback_consent_origin_at" timestamp with time zone NOT NULL,
	"business_approval_origin_at" timestamp with time zone NOT NULL,
	"shipping_origin_at" timestamp with time zone NOT NULL,
	"reservation_origin_at" timestamp with time zone NOT NULL,
	"guideline_origin_at" timestamp with time zone NOT NULL,
	"human_handoff_origin_at" timestamp with time zone NOT NULL,
	"automation_mode_origin_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_instances_application_campaign_key" UNIQUE("application_id","campaign_id"),
	CONSTRAINT "workflow_instances_nonnegative_version" CHECK ("workflow_instances"."version" >= 0),
	CONSTRAINT "workflow_instances_visit_method_coherent" CHECK (("workflow_instances"."campaign_type" = 'visit' and "workflow_instances"."visit_method" <> 'not_applicable') or ("workflow_instances"."campaign_type" <> 'visit' and "workflow_instances"."visit_method" = 'not_applicable'))
);
--> statement-breakpoint
CREATE TABLE "workflow_side_effects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"workflow_event_id" uuid NOT NULL,
	"dimension" "workflow_dimension" NOT NULL,
	"effect_code" text NOT NULL,
	"status" "workflow_side_effect_status" DEFAULT 'pending' NOT NULL,
	"cancellation_reason" text,
	"invalidated_by_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "workflow_side_effects_event_effect_key" UNIQUE("workflow_event_id","effect_code"),
	CONSTRAINT "workflow_side_effects_effect_code" CHECK ("workflow_side_effects"."effect_code" ~ '^[A-Z][A-Z0-9_]*$')
);
--> statement-breakpoint
ALTER TABLE "automation_pauses" ADD CONSTRAINT "automation_pauses_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_pauses" ADD CONSTRAINT "automation_pauses_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_event_supersessions" ADD CONSTRAINT "workflow_event_supersessions_workflow_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_event_supersessions" ADD CONSTRAINT "workflow_event_supersessions_prior_event_id_workflow_events_id_fk" FOREIGN KEY ("prior_event_id") REFERENCES "public"."workflow_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_event_supersessions" ADD CONSTRAINT "workflow_event_supersessions_correction_event_id_workflow_events_id_fk" FOREIGN KEY ("correction_event_id") REFERENCES "public"."workflow_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_workflow_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_incidents" ADD CONSTRAINT "workflow_incidents_workflow_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_incidents" ADD CONSTRAINT "workflow_incidents_workflow_event_id_workflow_events_id_fk" FOREIGN KEY ("workflow_event_id") REFERENCES "public"."workflow_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_instances" ADD CONSTRAINT "workflow_instances_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_instances" ADD CONSTRAINT "workflow_instances_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_instances" ADD CONSTRAINT "workflow_instances_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_side_effects" ADD CONSTRAINT "workflow_side_effects_workflow_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_side_effects" ADD CONSTRAINT "workflow_side_effects_workflow_event_id_workflow_events_id_fk" FOREIGN KEY ("workflow_event_id") REFERENCES "public"."workflow_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_side_effects" ADD CONSTRAINT "workflow_side_effects_invalidated_by_event_id_workflow_events_id_fk" FOREIGN KEY ("invalidated_by_event_id") REFERENCES "public"."workflow_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_pauses_active_global_key" ON "automation_pauses" USING btree ("kind") WHERE "automation_pauses"."scope" = 'global' and "automation_pauses"."deactivated_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_pauses_active_campaign_key" ON "automation_pauses" USING btree ("campaign_id","kind") WHERE "automation_pauses"."scope" = 'campaign' and "automation_pauses"."deactivated_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_pauses_active_workflow_type_key" ON "automation_pauses" USING btree ("workflow_type","kind") WHERE "automation_pauses"."scope" = 'workflow_type' and "automation_pauses"."deactivated_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_pauses_active_participant_key" ON "automation_pauses" USING btree ("participant_id","kind") WHERE "automation_pauses"."scope" = 'participant' and "automation_pauses"."deactivated_at" is null;--> statement-breakpoint
CREATE INDEX "automation_pauses_active_lookup_idx" ON "automation_pauses" USING btree ("scope","kind","deactivated_at");--> statement-breakpoint
CREATE INDEX "workflow_event_supersessions_workflow_idx" ON "workflow_event_supersessions" USING btree ("workflow_id","occurred_at");--> statement-breakpoint
CREATE INDEX "workflow_events_timeline_idx" ON "workflow_events" USING btree ("workflow_id","recorded_at");--> statement-breakpoint
CREATE INDEX "workflow_events_trigger_idx" ON "workflow_events" USING btree ("triggering_event_id");--> statement-breakpoint
CREATE INDEX "workflow_events_dimension_result_idx" ON "workflow_events" USING btree ("dimension","result","recorded_at");--> statement-breakpoint
CREATE INDEX "workflow_incidents_open_idx" ON "workflow_incidents" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "workflow_instances_participant_idx" ON "workflow_instances" USING btree ("participant_id","created_at");--> statement-breakpoint
CREATE INDEX "workflow_instances_campaign_idx" ON "workflow_instances" USING btree ("campaign_id","created_at");--> statement-breakpoint
CREATE INDEX "workflow_side_effects_pending_idx" ON "workflow_side_effects" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "workflow_side_effects_workflow_idx" ON "workflow_side_effects" USING btree ("workflow_id","created_at");