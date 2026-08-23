CREATE TYPE "public"."event_inbox_status" AS ENUM('received', 'processing', 'processed', 'failed', 'dead_lettered');--> statement-breakpoint
CREATE TABLE "event_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"external_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload_hash" text NOT NULL,
	"payload" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"status" "event_inbox_status" DEFAULT 'received' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_reason" text,
	"correlation_id" text,
	CONSTRAINT "event_inbox_source_external_id_key" UNIQUE("source","external_event_id")
);
--> statement-breakpoint
CREATE INDEX "event_inbox_status_idx" ON "event_inbox" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "event_inbox_source_idx" ON "event_inbox" USING btree ("source","received_at");--> statement-breakpoint
CREATE INDEX "event_inbox_correlation_idx" ON "event_inbox" USING btree ("correlation_id");