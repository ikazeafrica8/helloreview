CREATE TYPE "public"."message_legal_classification" AS ENUM('operational_transactional', 'consent_related', 'service_notice', 'potentially_advertising', 'definitely_advertising');--> statement-breakpoint
CREATE TYPE "public"."message_template_status" AS ENUM('draft', 'approved', 'active', 'retired');--> statement-breakpoint
CREATE TABLE "guideline_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "campaign_rule_status" DEFAULT 'draft' NOT NULL,
	"body_text" text,
	"content_uri" text,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"published_by" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guideline_versions_version_key" UNIQUE("campaign_id","version"),
	CONSTRAINT "guideline_versions_has_content" CHECK ("guideline_versions"."body_text" is not null or "guideline_versions"."content_uri" is not null),
	CONSTRAINT "guideline_versions_positive_version" CHECK ("guideline_versions"."version" > 0),
	CONSTRAINT "guideline_versions_valid_window" CHECK ("guideline_versions"."effective_to" is null or "guideline_versions"."effective_to" > "guideline_versions"."effective_from"),
	CONSTRAINT "guideline_versions_publish_evidence" CHECK ("guideline_versions"."status" = 'draft' or ("guideline_versions"."published_by" is not null and "guideline_versions"."published_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "message_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose_code" text NOT NULL,
	"language" text DEFAULT 'ko' NOT NULL,
	"version" integer NOT NULL,
	"status" "message_template_status" DEFAULT 'draft' NOT NULL,
	"legal_classification" "message_legal_classification" NOT NULL,
	"body" text NOT NULL,
	"requires_prior_consent" boolean DEFAULT false NOT NULL,
	"respects_quiet_hours" boolean DEFAULT true NOT NULL,
	"requires_opt_out_notice" boolean DEFAULT false NOT NULL,
	"requires_sender_identification" boolean DEFAULT false NOT NULL,
	"requires_provider_approval" boolean DEFAULT false NOT NULL,
	"provider_template_code" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_templates_version_key" UNIQUE("purpose_code","version"),
	CONSTRAINT "message_templates_positive_version" CHECK ("message_templates"."version" > 0),
	CONSTRAINT "message_templates_nonempty_body" CHECK (length(btrim("message_templates"."body")) > 0),
	CONSTRAINT "message_templates_approval_evidence" CHECK ("message_templates"."status" = 'draft' or ("message_templates"."approved_by" is not null and "message_templates"."approved_at" is not null)),
	CONSTRAINT "message_templates_activation_evidence" CHECK ("message_templates"."status" <> 'active' or "message_templates"."activated_at" is not null),
	CONSTRAINT "message_templates_retirement_evidence" CHECK ("message_templates"."status" <> 'retired' or "message_templates"."retired_at" is not null),
	CONSTRAINT "message_templates_provider_approval" CHECK ("message_templates"."status" <> 'active' or not "message_templates"."requires_provider_approval" or "message_templates"."provider_template_code" is not null)
);
--> statement-breakpoint
ALTER TABLE "guideline_versions" ADD CONSTRAINT "guideline_versions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guideline_versions_effective_idx" ON "guideline_versions" USING btree ("campaign_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "guideline_versions_one_current_idx" ON "guideline_versions" USING btree ("campaign_id") WHERE "guideline_versions"."effective_to" is null and "guideline_versions"."status" = 'published';--> statement-breakpoint
CREATE UNIQUE INDEX "message_templates_one_active_idx" ON "message_templates" USING btree ("purpose_code") WHERE "message_templates"."status" = 'active';--> statement-breakpoint
CREATE INDEX "message_templates_status_idx" ON "message_templates" USING btree ("status");
