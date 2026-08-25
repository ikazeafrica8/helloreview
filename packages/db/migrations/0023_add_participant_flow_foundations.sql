CREATE TYPE "public"."payback_consent_actor_type" AS ENUM('system', 'operator', 'participant');--> statement-breakpoint
CREATE TYPE "public"."payback_consent_state" AS ENUM('not_requested', 'awaiting_response', 'agreed', 'declined', 'withdrawn', 'human_review_required');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('pending', 'confirmed', 'cancelled', 'rescheduled');--> statement-breakpoint
CREATE TYPE "public"."reservation_validation_authority" AS ENUM('none', 'deterministic_rules');--> statement-breakpoint
CREATE TYPE "public"."reservation_validation_state" AS ENUM('pending', 'valid', 'invalid', 'human_review');--> statement-breakpoint
CREATE TYPE "public"."reservation_version_source" AS ENUM('participant', 'operator', 'ai_assisted', 'imported');--> statement-breakpoint
CREATE TYPE "public"."selection_manual_decision_result" AS ENUM('selected', 'not_selected', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."selection_recommendation_result" AS ENUM('recommend_select', 'recommend_not_select', 'human_review');--> statement-breakpoint
CREATE TYPE "public"."selection_shadow_outcome" AS ENUM('matched', 'differed', 'not_comparable');--> statement-breakpoint
CREATE TYPE "public"."shipping_address_change_source" AS ENUM('participant_form', 'authorized_operator');--> statement-breakpoint
CREATE TYPE "public"."shipping_address_validation_state" AS ENUM('incomplete', 'valid');--> statement-breakpoint
CREATE TABLE "payback_consent_aggregates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payback_consent_aggregates_workflow_id_unique" UNIQUE("workflow_id")
);
--> statement-breakpoint
CREATE TABLE "payback_consent_heads" (
	"aggregate_id" uuid PRIMARY KEY NOT NULL,
	"version_id" uuid NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payback_consent_heads_version_id_unique" UNIQUE("version_id")
);
--> statement-breakpoint
CREATE TABLE "payback_consent_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"terms_rule_id" uuid NOT NULL,
	"terms_version" integer NOT NULL,
	"outbound_notification_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payback_consent_requests_request_id_unique" UNIQUE("request_id"),
	CONSTRAINT "payback_consent_requests_aggregate_terms_key" UNIQUE("aggregate_id","terms_version"),
	CONSTRAINT "payback_consent_requests_positive_terms_version" CHECK ("payback_consent_requests"."terms_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "payback_consent_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"state" "payback_consent_state" NOT NULL,
	"terms_version" integer,
	"request_id" text,
	"evidence_message_id" text,
	"channel" text,
	"classification" text,
	"actor_type" "payback_consent_actor_type" NOT NULL,
	"actor_reference" text NOT NULL,
	"reason_code" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payback_consent_versions_aggregate_version_key" UNIQUE("aggregate_id","version"),
	CONSTRAINT "payback_consent_versions_positive_version" CHECK ("payback_consent_versions"."version" > 0),
	CONSTRAINT "payback_consent_versions_reason_code" CHECK ("payback_consent_versions"."reason_code" ~ '^[A-Z][A-Z0-9_]*$'),
	CONSTRAINT "payback_consent_versions_request_correlation" CHECK ("payback_consent_versions"."state" = 'not_requested' or ("payback_consent_versions"."terms_version" is not null and "payback_consent_versions"."request_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "reservation_heads" (
	"reservation_id" uuid PRIMARY KEY NOT NULL,
	"version_id" uuid NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reservation_heads_version_id_unique" UNIQUE("version_id")
);
--> statement-breakpoint
CREATE TABLE "reservation_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"source" "reservation_version_source" NOT NULL,
	"source_reference" text NOT NULL,
	"extraction_provenance" jsonb NOT NULL,
	"reserved_date" text,
	"reserved_time" text,
	"timezone" text,
	"business_reference" text,
	"visit_method" text,
	"status" "reservation_status" NOT NULL,
	"cancellation_reason" text,
	"validation_state" "reservation_validation_state" NOT NULL,
	"validation_authority" "reservation_validation_authority" NOT NULL,
	"rule_version" text,
	"validation_evidence" jsonb NOT NULL,
	"supersedes_version_id" uuid,
	"actor_reference" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reservation_versions_reservation_version_key" UNIQUE("reservation_id","version"),
	CONSTRAINT "reservation_versions_reservation_source_key" UNIQUE("reservation_id","source_reference"),
	CONSTRAINT "reservation_versions_supersedes_key" UNIQUE("supersedes_version_id"),
	CONSTRAINT "reservation_versions_positive_version" CHECK ("reservation_versions"."version" > 0),
	CONSTRAINT "reservation_versions_valid_authority" CHECK ("reservation_versions"."validation_state" <> 'valid' or ("reservation_versions"."validation_authority" = 'deterministic_rules' and "reservation_versions"."rule_version" is not null)),
	CONSTRAINT "reservation_versions_cancel_reason" CHECK ("reservation_versions"."status" <> 'cancelled' or "reservation_versions"."cancellation_reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reservations_workflow_id_unique" UNIQUE("workflow_id")
);
--> statement-breakpoint
CREATE TABLE "selection_decision_heads" (
	"workflow_id" uuid PRIMARY KEY NOT NULL,
	"decision_id" uuid NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "selection_decision_heads_decision_id_unique" UNIQUE("decision_id")
);
--> statement-breakpoint
CREATE TABLE "selection_manual_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"recommendation_id" uuid,
	"version" integer NOT NULL,
	"decision" "selection_manual_decision_result" NOT NULL,
	"prior_workflow_state" text NOT NULL,
	"reason_code" text NOT NULL,
	"actor_reference" text NOT NULL,
	"deduplication_key" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "selection_manual_decisions_workflow_version_key" UNIQUE("workflow_id","version"),
	CONSTRAINT "selection_manual_decisions_dedupe_key" UNIQUE("deduplication_key"),
	CONSTRAINT "selection_manual_decisions_positive_version" CHECK ("selection_manual_decisions"."version" > 0),
	CONSTRAINT "selection_manual_decisions_reason_code" CHECK ("selection_manual_decisions"."reason_code" ~ '^[A-Z][A-Z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE "selection_recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"result" "selection_recommendation_result" NOT NULL,
	"reason_code" text NOT NULL,
	"policy_version" text,
	"input_facts" jsonb NOT NULL,
	"component_outcomes" jsonb NOT NULL,
	"source_freshness_at" timestamp with time zone NOT NULL,
	"actor_reference" text NOT NULL,
	"deduplication_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "selection_recommendations_workflow_version_key" UNIQUE("workflow_id","version"),
	CONSTRAINT "selection_recommendations_dedupe_key" UNIQUE("deduplication_key"),
	CONSTRAINT "selection_recommendations_positive_version" CHECK ("selection_recommendations"."version" > 0),
	CONSTRAINT "selection_recommendations_reason_code" CHECK ("selection_recommendations"."reason_code" ~ '^[A-Z][A-Z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE "selection_shadow_comparisons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recommendation_id" uuid NOT NULL,
	"manual_decision_id" uuid NOT NULL,
	"outcome" "selection_shadow_outcome" NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "selection_shadow_comparisons_pair_key" UNIQUE("recommendation_id","manual_decision_id")
);
--> statement-breakpoint
CREATE TABLE "shipping_address_heads" (
	"workflow_id" uuid PRIMARY KEY NOT NULL,
	"address_id" uuid NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "shipping_address_heads_address_id_unique" UNIQUE("address_id")
);
--> statement-breakpoint
CREATE TABLE "shipping_address_reveals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"actor_reference" text NOT NULL,
	"reason_code" text NOT NULL,
	"correlation_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "shipping_address_reveals_reason_code" CHECK ("shipping_address_reveals"."reason_code" ~ '^[A-Z][A-Z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE "shipping_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"encrypted_payload" text NOT NULL,
	"address_fingerprint" text NOT NULL,
	"masked_summary" text NOT NULL,
	"validation_state" "shipping_address_validation_state" NOT NULL,
	"validation_evidence" jsonb NOT NULL,
	"policy_version" text NOT NULL,
	"change_source" "shipping_address_change_source" NOT NULL,
	"actor_reference" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "shipping_addresses_workflow_version_key" UNIQUE("workflow_id","version"),
	CONSTRAINT "shipping_addresses_positive_version" CHECK ("shipping_addresses"."version" > 0),
	CONSTRAINT "shipping_addresses_fingerprint" CHECK ("shipping_addresses"."address_fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "shipping_form_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"token_digest" text NOT NULL,
	"deduplication_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"outbound_notification_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "shipping_form_grants_token_digest_unique" UNIQUE("token_digest"),
	CONSTRAINT "shipping_form_grants_deduplication_key_unique" UNIQUE("deduplication_key"),
	CONSTRAINT "shipping_form_grants_token_digest" CHECK ("shipping_form_grants"."token_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "shipping_form_grants_valid_expiry" CHECK ("shipping_form_grants"."expires_at" > "shipping_form_grants"."created_at"),
	CONSTRAINT "shipping_form_grants_single_terminal_state" CHECK ("shipping_form_grants"."consumed_at" is null or "shipping_form_grants"."revoked_at" is null)
);
--> statement-breakpoint
ALTER TABLE "payback_consent_aggregates" ADD CONSTRAINT "payback_consent_aggregates_workflow_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payback_consent_aggregates" ADD CONSTRAINT "payback_consent_aggregates_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payback_consent_aggregates" ADD CONSTRAINT "payback_consent_aggregates_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payback_consent_heads" ADD CONSTRAINT "payback_consent_heads_aggregate_id_payback_consent_aggregates_id_fk" FOREIGN KEY ("aggregate_id") REFERENCES "public"."payback_consent_aggregates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payback_consent_heads" ADD CONSTRAINT "payback_consent_heads_version_id_payback_consent_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."payback_consent_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payback_consent_requests" ADD CONSTRAINT "payback_consent_requests_aggregate_id_payback_consent_aggregates_id_fk" FOREIGN KEY ("aggregate_id") REFERENCES "public"."payback_consent_aggregates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payback_consent_requests" ADD CONSTRAINT "payback_consent_requests_workflow_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payback_consent_requests" ADD CONSTRAINT "payback_consent_requests_terms_rule_id_campaign_rules_id_fk" FOREIGN KEY ("terms_rule_id") REFERENCES "public"."campaign_rules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payback_consent_requests" ADD CONSTRAINT "payback_consent_requests_outbound_notification_id_outbound_notifications_id_fk" FOREIGN KEY ("outbound_notification_id") REFERENCES "public"."outbound_notifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payback_consent_versions" ADD CONSTRAINT "payback_consent_versions_aggregate_id_payback_consent_aggregates_id_fk" FOREIGN KEY ("aggregate_id") REFERENCES "public"."payback_consent_aggregates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payback_consent_versions" ADD CONSTRAINT "payback_consent_versions_workflow_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_heads" ADD CONSTRAINT "reservation_heads_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_heads" ADD CONSTRAINT "reservation_heads_version_id_reservation_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."reservation_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_versions" ADD CONSTRAINT "reservation_versions_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_versions" ADD CONSTRAINT "reservation_versions_workflow_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_versions" ADD CONSTRAINT "reservation_versions_supersedes_version_id_reservation_versions_id_fk" FOREIGN KEY ("supersedes_version_id") REFERENCES "public"."reservation_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_workflow_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "selection_decision_heads" ADD CONSTRAINT "selection_decision_heads_workflow_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "selection_decision_heads" ADD CONSTRAINT "selection_decision_heads_decision_id_selection_manual_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."selection_manual_decisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "selection_manual_decisions" ADD CONSTRAINT "selection_manual_decisions_workflow_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "selection_manual_decisions" ADD CONSTRAINT "selection_manual_decisions_recommendation_id_selection_recommendations_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."selection_recommendations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "selection_recommendations" ADD CONSTRAINT "selection_recommendations_workflow_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "selection_recommendations" ADD CONSTRAINT "selection_recommendations_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "selection_recommendations" ADD CONSTRAINT "selection_recommendations_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "selection_shadow_comparisons" ADD CONSTRAINT "selection_shadow_comparisons_recommendation_id_selection_recommendations_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."selection_recommendations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "selection_shadow_comparisons" ADD CONSTRAINT "selection_shadow_comparisons_manual_decision_id_selection_manual_decisions_id_fk" FOREIGN KEY ("manual_decision_id") REFERENCES "public"."selection_manual_decisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_address_heads" ADD CONSTRAINT "shipping_address_heads_workflow_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_address_heads" ADD CONSTRAINT "shipping_address_heads_address_id_shipping_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."shipping_addresses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_address_reveals" ADD CONSTRAINT "shipping_address_reveals_address_id_shipping_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."shipping_addresses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_address_reveals" ADD CONSTRAINT "shipping_address_reveals_workflow_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_addresses" ADD CONSTRAINT "shipping_addresses_workflow_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_addresses" ADD CONSTRAINT "shipping_addresses_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_addresses" ADD CONSTRAINT "shipping_addresses_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_form_grants" ADD CONSTRAINT "shipping_form_grants_workflow_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_form_grants" ADD CONSTRAINT "shipping_form_grants_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payback_consent_aggregates_participant_idx" ON "payback_consent_aggregates" USING btree ("participant_id","created_at");--> statement-breakpoint
CREATE INDEX "payback_consent_requests_workflow_idx" ON "payback_consent_requests" USING btree ("workflow_id","created_at");--> statement-breakpoint
CREATE INDEX "payback_consent_versions_workflow_timeline_idx" ON "payback_consent_versions" USING btree ("workflow_id","occurred_at");--> statement-breakpoint
CREATE INDEX "reservation_versions_workflow_timeline_idx" ON "reservation_versions" USING btree ("workflow_id","occurred_at");--> statement-breakpoint
CREATE INDEX "reservations_participant_idx" ON "reservations" USING btree ("participant_id","created_at");--> statement-breakpoint
CREATE INDEX "selection_manual_decisions_workflow_timeline_idx" ON "selection_manual_decisions" USING btree ("workflow_id","occurred_at");--> statement-breakpoint
CREATE INDEX "selection_recommendations_application_idx" ON "selection_recommendations" USING btree ("application_id","created_at");--> statement-breakpoint
CREATE INDEX "selection_recommendations_campaign_result_idx" ON "selection_recommendations" USING btree ("campaign_id","result","created_at");--> statement-breakpoint
CREATE INDEX "shipping_address_reveals_address_idx" ON "shipping_address_reveals" USING btree ("address_id","occurred_at");--> statement-breakpoint
CREATE INDEX "shipping_addresses_workflow_timeline_idx" ON "shipping_addresses" USING btree ("workflow_id","created_at");--> statement-breakpoint
CREATE INDEX "shipping_form_grants_workflow_idx" ON "shipping_form_grants" USING btree ("workflow_id","created_at");

-- T67/T71/T73/T78/T83: decision, protected-data, consent, and reservation facts are append-only.
-- Mutable current-head and one-time grant tables are intentionally excluded.
CREATE OR REPLACE FUNCTION reject_participant_flow_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint

CREATE TRIGGER selection_recommendations_append_only
BEFORE UPDATE OR DELETE ON selection_recommendations
FOR EACH ROW EXECUTE FUNCTION reject_participant_flow_history_mutation();--> statement-breakpoint
ALTER TABLE selection_recommendations ENABLE ALWAYS TRIGGER selection_recommendations_append_only;--> statement-breakpoint
CREATE TRIGGER selection_manual_decisions_append_only
BEFORE UPDATE OR DELETE ON selection_manual_decisions
FOR EACH ROW EXECUTE FUNCTION reject_participant_flow_history_mutation();--> statement-breakpoint
ALTER TABLE selection_manual_decisions ENABLE ALWAYS TRIGGER selection_manual_decisions_append_only;--> statement-breakpoint
CREATE TRIGGER selection_shadow_comparisons_append_only
BEFORE UPDATE OR DELETE ON selection_shadow_comparisons
FOR EACH ROW EXECUTE FUNCTION reject_participant_flow_history_mutation();--> statement-breakpoint
ALTER TABLE selection_shadow_comparisons ENABLE ALWAYS TRIGGER selection_shadow_comparisons_append_only;--> statement-breakpoint
CREATE TRIGGER shipping_addresses_append_only
BEFORE UPDATE OR DELETE ON shipping_addresses
FOR EACH ROW EXECUTE FUNCTION reject_participant_flow_history_mutation();--> statement-breakpoint
ALTER TABLE shipping_addresses ENABLE ALWAYS TRIGGER shipping_addresses_append_only;--> statement-breakpoint
CREATE TRIGGER shipping_address_reveals_append_only
BEFORE UPDATE OR DELETE ON shipping_address_reveals
FOR EACH ROW EXECUTE FUNCTION reject_participant_flow_history_mutation();--> statement-breakpoint
ALTER TABLE shipping_address_reveals ENABLE ALWAYS TRIGGER shipping_address_reveals_append_only;--> statement-breakpoint
CREATE TRIGGER payback_consent_aggregates_append_only
BEFORE UPDATE OR DELETE ON payback_consent_aggregates
FOR EACH ROW EXECUTE FUNCTION reject_participant_flow_history_mutation();--> statement-breakpoint
ALTER TABLE payback_consent_aggregates ENABLE ALWAYS TRIGGER payback_consent_aggregates_append_only;--> statement-breakpoint
CREATE TRIGGER payback_consent_versions_append_only
BEFORE UPDATE OR DELETE ON payback_consent_versions
FOR EACH ROW EXECUTE FUNCTION reject_participant_flow_history_mutation();--> statement-breakpoint
ALTER TABLE payback_consent_versions ENABLE ALWAYS TRIGGER payback_consent_versions_append_only;--> statement-breakpoint
CREATE TRIGGER payback_consent_requests_append_only
BEFORE UPDATE OR DELETE ON payback_consent_requests
FOR EACH ROW EXECUTE FUNCTION reject_participant_flow_history_mutation();--> statement-breakpoint
ALTER TABLE payback_consent_requests ENABLE ALWAYS TRIGGER payback_consent_requests_append_only;--> statement-breakpoint
CREATE TRIGGER reservations_append_only
BEFORE UPDATE OR DELETE ON reservations
FOR EACH ROW EXECUTE FUNCTION reject_participant_flow_history_mutation();--> statement-breakpoint
ALTER TABLE reservations ENABLE ALWAYS TRIGGER reservations_append_only;--> statement-breakpoint
CREATE TRIGGER reservation_versions_append_only
BEFORE UPDATE OR DELETE ON reservation_versions
FOR EACH ROW EXECUTE FUNCTION reject_participant_flow_history_mutation();--> statement-breakpoint
ALTER TABLE reservation_versions ENABLE ALWAYS TRIGGER reservation_versions_append_only;--> statement-breakpoint

REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON selection_recommendations, selection_manual_decisions, selection_shadow_comparisons,
     shipping_addresses, shipping_address_reveals,
     payback_consent_aggregates, payback_consent_versions, payback_consent_requests,
     reservations, reservation_versions
  FROM helloreview_app;--> statement-breakpoint
GRANT SELECT, INSERT
  ON selection_recommendations, selection_manual_decisions, selection_shadow_comparisons,
     shipping_addresses, shipping_address_reveals,
     payback_consent_aggregates, payback_consent_versions, payback_consent_requests,
     reservations, reservation_versions
  TO helloreview_app;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION reject_participant_flow_history_mutation() FROM PUBLIC;--> statement-breakpoint
