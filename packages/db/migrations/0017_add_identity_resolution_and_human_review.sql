CREATE TYPE "public"."human_review_priority" AS ENUM('normal', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."human_review_status" AS ENUM('open', 'in_progress', 'resolved', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."identity_match_category" AS ENUM('verified', 'strong_match', 'weak_match', 'ambiguous', 'no_match');--> statement-breakpoint
CREATE TYPE "public"."identity_resolution_status" AS ENUM('verified', 'strong_match', 'weak_match', 'ambiguous', 'no_match', 'campaign_disambiguation_required', 'security_review_required');--> statement-breakpoint
CREATE TABLE "human_review_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_reference" text NOT NULL,
	"identity_resolution_id" uuid,
	"reason_code" text NOT NULL,
	"priority" "human_review_priority" NOT NULL,
	"status" "human_review_status" DEFAULT 'open' NOT NULL,
	"case_packet" jsonb NOT NULL,
	"automation_paused" boolean DEFAULT true NOT NULL,
	"deduplication_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "human_review_tasks_deduplication_key" UNIQUE("deduplication_key"),
	CONSTRAINT "human_review_tasks_valid_workflow_reference" CHECK (char_length("human_review_tasks"."workflow_reference") between 1 and 200),
	CONSTRAINT "human_review_tasks_reason_code" CHECK ("human_review_tasks"."reason_code" ~ '^[A-Z][A-Z0-9_]*$'),
	CONSTRAINT "human_review_tasks_valid_deduplication_key" CHECK (char_length("human_review_tasks"."deduplication_key") between 1 and 256)
);
--> statement-breakpoint
CREATE TABLE "application_verification_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"token_digest" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_by_participant_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_verification_tokens_digest_key" UNIQUE("token_digest"),
	CONSTRAINT "application_verification_tokens_digest_shape" CHECK ("application_verification_tokens"."token_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "application_verification_tokens_valid_window" CHECK ("application_verification_tokens"."expires_at" > "application_verification_tokens"."issued_at"),
	CONSTRAINT "application_verification_tokens_valid_consumption" CHECK ("application_verification_tokens"."consumed_at" is null or ("application_verification_tokens"."consumed_at" >= "application_verification_tokens"."issued_at" and "application_verification_tokens"."consumed_by_participant_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "identity_resolution_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_key" text NOT NULL,
	"participant_id" uuid NOT NULL,
	"channel_identity_id" uuid,
	"campaign_id" uuid,
	"match_category" "identity_match_category" NOT NULL,
	"status" "identity_resolution_status" NOT NULL,
	"match_method" text NOT NULL,
	"evidence_category" text NOT NULL,
	"reason_code" text NOT NULL,
	"candidate_application_ids" jsonb NOT NULL,
	"campaign_specific_transitions_allowed" boolean DEFAULT false NOT NULL,
	"participant_message_purpose" text,
	"decided_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_resolution_cases_source_key" UNIQUE("source_key"),
	CONSTRAINT "identity_resolution_cases_reason_code" CHECK ("identity_resolution_cases"."reason_code" ~ '^[A-Z][A-Z0-9_]*$'),
	CONSTRAINT "identity_resolution_cases_valid_source_key" CHECK (char_length("identity_resolution_cases"."source_key") between 1 and 256),
	CONSTRAINT "identity_resolution_cases_transition_gate" CHECK (not "identity_resolution_cases"."campaign_specific_transitions_allowed" or "identity_resolution_cases"."status" in ('verified', 'strong_match'))
);
--> statement-breakpoint
ALTER TABLE "human_review_tasks" ADD CONSTRAINT "human_review_tasks_identity_resolution_id_identity_resolution_cases_id_fk" FOREIGN KEY ("identity_resolution_id") REFERENCES "public"."identity_resolution_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_verification_tokens" ADD CONSTRAINT "application_verification_tokens_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_verification_tokens" ADD CONSTRAINT "application_verification_tokens_consumed_by_participant_id_participants_id_fk" FOREIGN KEY ("consumed_by_participant_id") REFERENCES "public"."participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_resolution_cases" ADD CONSTRAINT "identity_resolution_cases_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_resolution_cases" ADD CONSTRAINT "identity_resolution_cases_channel_identity_id_channel_identities_id_fk" FOREIGN KEY ("channel_identity_id") REFERENCES "public"."channel_identities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_resolution_cases" ADD CONSTRAINT "identity_resolution_cases_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "human_review_tasks_queue_idx" ON "human_review_tasks" USING btree ("status","priority","created_at");--> statement-breakpoint
CREATE INDEX "human_review_tasks_identity_resolution_idx" ON "human_review_tasks" USING btree ("identity_resolution_id");--> statement-breakpoint
CREATE INDEX "application_verification_tokens_expiry_idx" ON "application_verification_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "application_verification_tokens_application_idx" ON "application_verification_tokens" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "identity_resolution_cases_participant_idx" ON "identity_resolution_cases" USING btree ("participant_id","decided_at");--> statement-breakpoint
CREATE INDEX "identity_resolution_cases_status_idx" ON "identity_resolution_cases" USING btree ("status","decided_at");--> statement-breakpoint
CREATE INDEX "identity_resolution_cases_campaign_idx" ON "identity_resolution_cases" USING btree ("campaign_id","decided_at");