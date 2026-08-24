CREATE TYPE "public"."application_status" AS ENUM('received', 'completed', 'matched', 'ambiguous', 'cancelled', 'synchronized_late');--> statement-breakpoint
CREATE TYPE "public"."application_sync_method" AS ENUM('event', 'reconciliation');--> statement-breakpoint
CREATE TYPE "public"."application_reconciliation_status" AS ENUM('pending', 'resolved', 'no_match', 'failed');--> statement-breakpoint
CREATE TABLE "application_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"source_system" text NOT NULL,
	"source_event_id" text NOT NULL,
	"source_occurred_at" timestamp with time zone NOT NULL,
	"source_version" integer NOT NULL,
	"application_status" "application_status" NOT NULL,
	"source_status" "application_status" NOT NULL,
	"synchronization_method" "application_sync_method" NOT NULL,
	"changed_fields" jsonb NOT NULL,
	"synchronized_at" timestamp with time zone NOT NULL,
	CONSTRAINT "application_changes_source_event_key" UNIQUE("source_system","source_event_id"),
	CONSTRAINT "application_changes_source_version_key" UNIQUE("application_id","source_version"),
	CONSTRAINT "application_changes_positive_source_version" CHECK ("application_changes"."source_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "application_reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_system" text NOT NULL,
	"campaign_id" uuid NOT NULL,
	"status" "application_reconciliation_status" DEFAULT 'pending' NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"retry_deadline_at" timestamp with time zone NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_failure_reason" text,
	"resolved_application_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_reconciliations_valid_window" CHECK ("application_reconciliations"."retry_deadline_at" > "application_reconciliations"."claimed_at"),
	CONSTRAINT "application_reconciliations_nonnegative_attempts" CHECK ("application_reconciliations"."attempt_count" >= 0),
	CONSTRAINT "application_reconciliations_resolution_evidence" CHECK ("application_reconciliations"."status" <> 'resolved' or "application_reconciliations"."resolved_application_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "application_source_freshness" (
	"source_system" text PRIMARY KEY NOT NULL,
	"last_attempted_at" timestamp with time zone,
	"last_successful_reconciliation_at" timestamp with time zone,
	"consecutive_failure_count" integer DEFAULT 0 NOT NULL,
	"last_failure_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_source_freshness_nonnegative_failures" CHECK ("application_source_freshness"."consecutive_failure_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_system" text NOT NULL,
	"source_application_id" text NOT NULL,
	"campaign_id" uuid NOT NULL,
	"status" "application_status" NOT NULL,
	"source_status" "application_status" NOT NULL,
	"applicant_name" text NOT NULL,
	"phone_normalized" text NOT NULL,
	"blog_url" text,
	"source_version" integer NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"last_source_event_id" text NOT NULL,
	"last_source_occurred_at" timestamp with time zone NOT NULL,
	"last_synchronized_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applications_source_id_key" UNIQUE("source_system","source_application_id"),
	CONSTRAINT "applications_positive_source_version" CHECK ("applications"."source_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "application_changes" ADD CONSTRAINT "application_changes_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_reconciliations" ADD CONSTRAINT "application_reconciliations_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_reconciliations" ADD CONSTRAINT "application_reconciliations_resolved_application_id_applications_id_fk" FOREIGN KEY ("resolved_application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_changes_timeline_idx" ON "application_changes" USING btree ("application_id","source_version");--> statement-breakpoint
CREATE INDEX "application_reconciliations_due_idx" ON "application_reconciliations" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "application_reconciliations_campaign_idx" ON "application_reconciliations" USING btree ("campaign_id","claimed_at");--> statement-breakpoint
CREATE INDEX "applications_campaign_status_idx" ON "applications" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE INDEX "applications_phone_campaign_idx" ON "applications" USING btree ("phone_normalized","campaign_id");--> statement-breakpoint
CREATE INDEX "applications_source_freshness_idx" ON "applications" USING btree ("source_system","last_synchronized_at");