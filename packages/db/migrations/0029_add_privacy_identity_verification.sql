-- PostgreSQL requires ALTER TYPE ... ADD VALUE to commit before later migrations can use the new
-- labels. IF NOT EXISTS makes recovery safe if the following storage migration fails after this
-- intentional enum-only commit boundary.
ALTER TYPE "public"."automation_pause_kind" ADD VALUE IF NOT EXISTS 'privacy_request';--> statement-breakpoint
ALTER TYPE "public"."automation_pause_scope" ADD VALUE IF NOT EXISTS 'participant_campaign';--> statement-breakpoint
ALTER TYPE "public"."automation_pause_scope" ADD VALUE IF NOT EXISTS 'workflow';--> statement-breakpoint
COMMIT;--> statement-breakpoint
BEGIN;
