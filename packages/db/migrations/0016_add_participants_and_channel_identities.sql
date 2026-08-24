CREATE TYPE "public"."channel_identity_verification_state" AS ENUM('unverified', 'verified', 'revoked');--> statement-breakpoint
CREATE TABLE "channel_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_user_id" text NOT NULL,
	"verification_state" "channel_identity_verification_state" DEFAULT 'unverified' NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_identities_provider_external_user_key" UNIQUE("provider","external_user_id"),
	CONSTRAINT "channel_identities_valid_provider" CHECK ("channel_identities"."provider" ~ '^[a-z][a-z0-9_.-]{2,63}$'),
	CONSTRAINT "channel_identities_valid_external_user_id" CHECK (char_length("channel_identities"."external_user_id") between 1 and 512),
	CONSTRAINT "channel_identities_verified_at_required" CHECK ("channel_identities"."verification_state" <> 'verified' or "channel_identities"."verified_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"phone_normalized" text,
	"blog_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "participants_valid_name" CHECK ("participants"."name" is null or char_length("participants"."name") between 1 and 200),
	CONSTRAINT "participants_normalized_korean_mobile" CHECK ("participants"."phone_normalized" is null or "participants"."phone_normalized" ~ '^[+]8210[0-9]{8}$'),
	CONSTRAINT "participants_http_blog_url" CHECK ("participants"."blog_url" is null or "participants"."blog_url" ~ '^https?://')
);
--> statement-breakpoint
ALTER TABLE "channel_identities" ADD CONSTRAINT "channel_identities_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_identities_participant_idx" ON "channel_identities" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "participants_phone_idx" ON "participants" USING btree ("phone_normalized");--> statement-breakpoint
CREATE INDEX "participants_blog_url_idx" ON "participants" USING btree ("blog_url");
