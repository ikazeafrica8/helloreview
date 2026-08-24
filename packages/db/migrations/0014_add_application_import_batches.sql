CREATE TABLE "application_import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_system" text NOT NULL,
	"file_digest" text NOT NULL,
	"exported_at" timestamp with time zone NOT NULL,
	"imported_at" timestamp with time zone NOT NULL,
	"row_count" integer NOT NULL,
	"applied_count" integer NOT NULL,
	"duplicate_count" integer NOT NULL,
	"stale_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_import_batches_source_file_key" UNIQUE("source_system","file_digest"),
	CONSTRAINT "application_import_batches_valid_digest" CHECK ("application_import_batches"."file_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "application_import_batches_nonnegative_counts" CHECK ("application_import_batches"."row_count" >= 0 and "application_import_batches"."applied_count" >= 0 and "application_import_batches"."duplicate_count" >= 0 and "application_import_batches"."stale_count" >= 0),
	CONSTRAINT "application_import_batches_counts_sum" CHECK ("application_import_batches"."row_count" = "application_import_batches"."applied_count" + "application_import_batches"."duplicate_count" + "application_import_batches"."stale_count")
);
--> statement-breakpoint
CREATE INDEX "application_import_batches_source_exported_idx" ON "application_import_batches" USING btree ("source_system","exported_at");