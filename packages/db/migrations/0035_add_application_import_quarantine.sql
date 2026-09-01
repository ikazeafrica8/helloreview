CREATE TYPE "public"."application_import_batch_status" AS ENUM('completed', 'quarantined');--> statement-breakpoint
ALTER TABLE "application_import_batches" DROP CONSTRAINT "application_import_batches_counts_sum";--> statement-breakpoint
ALTER TABLE "application_import_batches" ADD COLUMN "status" "application_import_batch_status" DEFAULT 'completed' NOT NULL;--> statement-breakpoint
ALTER TABLE "application_import_batches" ADD COLUMN "quarantine_reason_code" text;--> statement-breakpoint
ALTER TABLE "application_import_batches" ADD COLUMN "quarantine_row_number" integer;--> statement-breakpoint
CREATE INDEX "application_import_batches_status_imported_idx" ON "application_import_batches" USING btree ("status","imported_at");--> statement-breakpoint
ALTER TABLE "application_import_batches" ADD CONSTRAINT "application_import_batches_outcome_evidence" CHECK ((
        "application_import_batches"."status" = 'completed'
        and "application_import_batches"."quarantine_reason_code" is null
        and "application_import_batches"."quarantine_row_number" is null
        and "application_import_batches"."row_count" = "application_import_batches"."applied_count" + "application_import_batches"."duplicate_count" + "application_import_batches"."stale_count"
      ) or (
        "application_import_batches"."status" = 'quarantined'
        and "application_import_batches"."quarantine_reason_code" is not null
        and ("application_import_batches"."quarantine_row_number" is null or "application_import_batches"."quarantine_row_number" > 1)
        and "application_import_batches"."applied_count" = 0
        and "application_import_batches"."duplicate_count" = 0
        and "application_import_batches"."stale_count" = 0
      ));