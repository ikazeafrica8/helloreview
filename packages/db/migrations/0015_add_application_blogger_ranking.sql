ALTER TABLE "applications" ADD COLUMN "blogger_level" integer;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "blog_daily_visitors" integer;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "blogger_region" text;--> statement-breakpoint
CREATE INDEX "applications_campaign_blogger_ranking_idx" ON "applications" USING btree ("campaign_id","blogger_level","blog_daily_visitors");--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_positive_blogger_level" CHECK ("applications"."blogger_level" is null or "applications"."blogger_level" > 0);--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_nonnegative_blog_daily_visitors" CHECK ("applications"."blog_daily_visitors" is null or "applications"."blog_daily_visitors" >= 0);--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_valid_blogger_region" CHECK ("applications"."blogger_region" is null or char_length("applications"."blogger_region") between 1 and 100);