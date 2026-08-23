CREATE TYPE "public"."campaign_rule_status" AS ENUM('draft', 'published', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."campaign_rule_type" AS ENUM('selection', 'reservation', 'guideline', 'payback', 'shipping');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'active', 'paused', 'closed');--> statement-breakpoint
CREATE TABLE "campaign_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"rule_type" "campaign_rule_type" NOT NULL,
	"version" integer NOT NULL,
	"status" "campaign_rule_status" DEFAULT 'draft' NOT NULL,
	"configuration" jsonb NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"published_by" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_rules_version_key" UNIQUE("campaign_id","rule_type","version")
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" "campaign_type" NOT NULL,
	"visit_method" "visit_method" DEFAULT 'not_applicable' NOT NULL,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaigns_code_key" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "campaign_rules" ADD CONSTRAINT "campaign_rules_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_rules_effective_idx" ON "campaign_rules" USING btree ("campaign_id","rule_type","effective_from");--> statement-breakpoint
CREATE INDEX "campaign_rules_status_idx" ON "campaign_rules" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_rules_one_current_idx" ON "campaign_rules" USING btree ("campaign_id","rule_type") WHERE "campaign_rules"."effective_to" is null and "campaign_rules"."status" = 'published';--> statement-breakpoint
CREATE INDEX "campaigns_status_idx" ON "campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "campaigns_period_idx" ON "campaigns" USING btree ("starts_at","ends_at");