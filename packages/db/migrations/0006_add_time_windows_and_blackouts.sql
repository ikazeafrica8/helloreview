CREATE TYPE "public"."weekday" AS ENUM('1', '2', '3', '4', '5', '6', '7');--> statement-breakpoint
CREATE TABLE "campaign_blackouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_rule_id" uuid NOT NULL,
	"blackout_date" date NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_blackouts_date_key" UNIQUE("campaign_rule_id","blackout_date")
);
--> statement-breakpoint
CREATE TABLE "campaign_time_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_rule_id" uuid NOT NULL,
	"weekday" "weekday" NOT NULL,
	"starts_at" time NOT NULL,
	"ends_at" time NOT NULL,
	"start_inclusive" boolean DEFAULT true NOT NULL,
	"end_inclusive" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_time_windows_no_duplicate_key" UNIQUE("campaign_rule_id","weekday","starts_at","ends_at")
);
--> statement-breakpoint
ALTER TABLE "campaign_blackouts" ADD CONSTRAINT "campaign_blackouts_campaign_rule_id_campaign_rules_id_fk" FOREIGN KEY ("campaign_rule_id") REFERENCES "public"."campaign_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_time_windows" ADD CONSTRAINT "campaign_time_windows_campaign_rule_id_campaign_rules_id_fk" FOREIGN KEY ("campaign_rule_id") REFERENCES "public"."campaign_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_blackouts_lookup_idx" ON "campaign_blackouts" USING btree ("campaign_rule_id","blackout_date");--> statement-breakpoint
CREATE INDEX "campaign_time_windows_lookup_idx" ON "campaign_time_windows" USING btree ("campaign_rule_id","weekday");