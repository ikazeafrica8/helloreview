CREATE TABLE "admin_retry_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_reference" text NOT NULL,
	"target_event_id" uuid NOT NULL,
	"input_digest" text NOT NULL,
	"prior_status" text NOT NULL,
	"outcome_code" text NOT NULL,
	"actor_reference" text NOT NULL,
	"reason_code" text NOT NULL,
	"correlation_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "admin_retry_operations_reference_key" UNIQUE("operation_reference"),
	CONSTRAINT "admin_retry_operations_digest" CHECK ("admin_retry_operations"."input_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "admin_retry_operations_reason_code" CHECK ("admin_retry_operations"."reason_code" ~ '^[A-Z][A-Z0-9_]*$'),
	CONSTRAINT "admin_retry_operations_outcome_code" CHECK ("admin_retry_operations"."outcome_code" ~ '^[A-Z][A-Z0-9_]*$')
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_retry_operations" ADD CONSTRAINT "admin_retry_operations_target_event_id_event_inbox_id_fk" FOREIGN KEY ("target_event_id") REFERENCES "public"."event_inbox"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_retry_operations_target_idx" ON "admin_retry_operations" USING btree ("target_event_id","occurred_at");--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_positive_version" CHECK ("campaigns"."version" > 0);

-- T108: retry receipts are service-internal, append-only operational evidence. Direct Supabase
-- client roles receive no access; the application role can read and append but never rewrite.
ALTER TABLE admin_retry_operations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY admin_retry_operations_app_select ON admin_retry_operations
  FOR SELECT TO helloreview_app USING (true);--> statement-breakpoint
CREATE POLICY admin_retry_operations_app_insert ON admin_retry_operations
  FOR INSERT TO helloreview_app WITH CHECK (true);--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON admin_retry_operations FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON admin_retry_operations FROM authenticated;
  END IF;
END
$$;--> statement-breakpoint

CREATE TRIGGER admin_retry_operations_append_only
BEFORE UPDATE OR DELETE ON admin_retry_operations
FOR EACH STATEMENT EXECUTE FUNCTION privacy_request_history_reject_mutation();--> statement-breakpoint
ALTER TABLE admin_retry_operations ENABLE ALWAYS TRIGGER admin_retry_operations_append_only;--> statement-breakpoint
CREATE TRIGGER admin_retry_operations_no_truncate
BEFORE TRUNCATE ON admin_retry_operations
FOR EACH STATEMENT EXECUTE FUNCTION privacy_request_history_reject_mutation();--> statement-breakpoint
ALTER TABLE admin_retry_operations ENABLE ALWAYS TRIGGER admin_retry_operations_no_truncate;--> statement-breakpoint

REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON admin_retry_operations FROM helloreview_app;
