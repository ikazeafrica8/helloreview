CREATE TABLE "campaign_business_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_business_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"normalized_alias" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_business_aliases_key" UNIQUE("campaign_business_id","normalized_alias")
);
--> statement-breakpoint
CREATE TABLE "campaign_businesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "campaign_rule_status" DEFAULT 'draft' NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"branch" text,
	"normalized_branch" text,
	"phone" text,
	"booking_url" text,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_businesses_version_key" UNIQUE("campaign_id","version")
);
--> statement-breakpoint
ALTER TABLE "campaign_business_aliases" ADD CONSTRAINT "campaign_business_aliases_campaign_business_id_campaign_businesses_id_fk" FOREIGN KEY ("campaign_business_id") REFERENCES "public"."campaign_businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_businesses" ADD CONSTRAINT "campaign_businesses_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_business_aliases_normalized_idx" ON "campaign_business_aliases" USING btree ("normalized_alias");--> statement-breakpoint
CREATE INDEX "campaign_businesses_lookup_idx" ON "campaign_businesses" USING btree ("campaign_id","effective_from");--> statement-breakpoint
CREATE INDEX "campaign_businesses_normalized_idx" ON "campaign_businesses" USING btree ("normalized_name");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_businesses_one_current_idx" ON "campaign_businesses" USING btree ("campaign_id") WHERE "campaign_businesses"."effective_to" is null and "campaign_businesses"."status" = 'published';