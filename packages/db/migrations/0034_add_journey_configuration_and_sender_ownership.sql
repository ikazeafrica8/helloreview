CREATE TYPE "public"."message_authoritative_sender" AS ENUM('website_legacy_trigger', 'helloreview_platform', 'operator_manual');--> statement-breakpoint
CREATE TYPE "public"."message_trigger_audit_status" AS ENUM('not_audited', 'audited_no_legacy_trigger', 'audited_legacy_trigger_exists');--> statement-breakpoint
CREATE TABLE "campaign_journey_configurations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "campaign_rule_status" DEFAULT 'draft' NOT NULL,
	"application_url" text,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"published_by" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_journey_configurations_version_key" UNIQUE("campaign_id","version"),
	CONSTRAINT "campaign_journey_configurations_positive_version" CHECK ("campaign_journey_configurations"."version" > 0),
	CONSTRAINT "campaign_journey_configurations_https_application_url" CHECK ("campaign_journey_configurations"."application_url" is null or "campaign_journey_configurations"."application_url" ~ '^https://[A-Za-z0-9.-]+(/[^[:space:]]*)?$'),
	CONSTRAINT "campaign_journey_configurations_credential_free_url" CHECK ("campaign_journey_configurations"."application_url" is null
          or ("campaign_journey_configurations"."application_url" !~ '@' and "campaign_journey_configurations"."application_url" !~ '\?' and "campaign_journey_configurations"."application_url" !~ '#')),
	CONSTRAINT "campaign_journey_configurations_url_length" CHECK ("campaign_journey_configurations"."application_url" is null or char_length("campaign_journey_configurations"."application_url") between 12 and 500),
	CONSTRAINT "campaign_journey_configurations_effective_order" CHECK ("campaign_journey_configurations"."effective_to" is null or "campaign_journey_configurations"."effective_to" > "campaign_journey_configurations"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "message_purpose_ownership" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"purpose_stem" text NOT NULL,
	"authoritative_sender" "message_authoritative_sender" NOT NULL,
	"trigger_audit_status" "message_trigger_audit_status" DEFAULT 'not_audited' NOT NULL,
	"legacy_trigger_reference" text,
	"platform_suppression_required" boolean DEFAULT false NOT NULL,
	"version" integer NOT NULL,
	"status" "campaign_rule_status" DEFAULT 'draft' NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_purpose_ownership_version_key" UNIQUE("campaign_id","purpose_stem","version"),
	CONSTRAINT "message_purpose_ownership_positive_version" CHECK ("message_purpose_ownership"."version" > 0),
	CONSTRAINT "message_purpose_ownership_purpose_stem" CHECK ("message_purpose_ownership"."purpose_stem" ~ '^[A-Z][A-Z0-9_]*$'),
	CONSTRAINT "message_purpose_ownership_audit_before_platform" CHECK ("message_purpose_ownership"."authoritative_sender" <> 'helloreview_platform' or "message_purpose_ownership"."trigger_audit_status" <> 'not_audited'),
	CONSTRAINT "message_purpose_ownership_suppression_coherence" CHECK (not "message_purpose_ownership"."platform_suppression_required" or "message_purpose_ownership"."authoritative_sender" <> 'helloreview_platform'),
	CONSTRAINT "message_purpose_ownership_legacy_reference" CHECK ("message_purpose_ownership"."authoritative_sender" <> 'website_legacy_trigger' or "message_purpose_ownership"."legacy_trigger_reference" is not null),
	CONSTRAINT "message_purpose_ownership_reference_shape" CHECK ("message_purpose_ownership"."legacy_trigger_reference" is null
          or (char_length("message_purpose_ownership"."legacy_trigger_reference") between 1 and 200
              and "message_purpose_ownership"."legacy_trigger_reference" ~ '^[A-Za-z0-9][A-Za-z0-9:._/-]*$')),
	CONSTRAINT "message_purpose_ownership_effective_order" CHECK ("message_purpose_ownership"."effective_to" is null or "message_purpose_ownership"."effective_to" > "message_purpose_ownership"."effective_from")
);
--> statement-breakpoint
ALTER TABLE "campaign_journey_configurations" ADD CONSTRAINT "campaign_journey_configurations_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_purpose_ownership" ADD CONSTRAINT "message_purpose_ownership_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_journey_configurations_lookup_idx" ON "campaign_journey_configurations" USING btree ("campaign_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_journey_configurations_one_current_idx" ON "campaign_journey_configurations" USING btree ("campaign_id") WHERE "campaign_journey_configurations"."effective_to" is null and "campaign_journey_configurations"."status" = 'published';--> statement-breakpoint
CREATE INDEX "message_purpose_ownership_lookup_idx" ON "message_purpose_ownership" USING btree ("campaign_id","purpose_stem","effective_from");--> statement-breakpoint
CREATE INDEX "message_purpose_ownership_audit_idx" ON "message_purpose_ownership" USING btree ("trigger_audit_status","campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_purpose_ownership_one_current_idx" ON "message_purpose_ownership" USING btree ("campaign_id","purpose_stem") WHERE "message_purpose_ownership"."effective_to" is null and "message_purpose_ownership"."status" = 'published';--> statement-breakpoint

-- Published journey and ownership versions are immutable (T136).
--
-- The same guarantee migrations 0005 and 0008 give campaign_rules and campaign_businesses, for the
-- same reason: a participant told to apply at one URL, or a message suppressed because the legacy
-- website trigger owned its purpose, must remain explicable against the configuration that was
-- current then. Editing a published version rewrites which configuration applied when.
--
-- The one legitimate write to a published row is closing it — setting effective_to as a superseding
-- version takes over — and moving an already-closed end is refused for the same reason.
CREATE OR REPLACE FUNCTION campaign_journey_configurations_freeze_published()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('published', 'superseded') THEN
      RAISE EXCEPTION 'campaign_journey_configurations version % is published and cannot be deleted', OLD.version
        USING HINT = 'Publish a superseding version instead; sent messages cite this one.';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  IF NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.application_url IS DISTINCT FROM OLD.application_url
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'campaign_journey_configurations version % is published and cannot be modified', OLD.version
      USING HINT = 'Create a new version. Messages already sent cite this URL.';
  END IF;

  IF OLD.effective_to IS NOT NULL AND NEW.effective_to IS DISTINCT FROM OLD.effective_to THEN
    RAISE EXCEPTION 'campaign_journey_configurations version % already ended at %; its end cannot be moved',
      OLD.version, OLD.effective_to;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'published' AND NEW.status = 'superseded') THEN
    RAISE EXCEPTION 'campaign_journey_configurations version % cannot move from % to %',
      OLD.version, OLD.status, NEW.status
      USING HINT = 'A published version may only be superseded; it can never return to draft.';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION message_purpose_ownership_freeze_published()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('published', 'superseded') THEN
      RAISE EXCEPTION 'message_purpose_ownership version % is published and cannot be deleted', OLD.version
        USING HINT = 'Publish a superseding version instead; suppression decisions cite this one.';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  IF NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
     OR NEW.purpose_stem IS DISTINCT FROM OLD.purpose_stem
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.authoritative_sender IS DISTINCT FROM OLD.authoritative_sender
     OR NEW.trigger_audit_status IS DISTINCT FROM OLD.trigger_audit_status
     OR NEW.legacy_trigger_reference IS DISTINCT FROM OLD.legacy_trigger_reference
     OR NEW.platform_suppression_required IS DISTINCT FROM OLD.platform_suppression_required
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'message_purpose_ownership version % is published and cannot be modified', OLD.version
      USING HINT = 'Create a new version. Whether a message was suppressed cites this one.';
  END IF;

  IF OLD.effective_to IS NOT NULL AND NEW.effective_to IS DISTINCT FROM OLD.effective_to THEN
    RAISE EXCEPTION 'message_purpose_ownership version % already ended at %; its end cannot be moved',
      OLD.version, OLD.effective_to;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'published' AND NEW.status = 'superseded') THEN
    RAISE EXCEPTION 'message_purpose_ownership version % cannot move from % to %',
      OLD.version, OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

-- Migration 0009's REVOKE loop already ran, so functions created here revoke for themselves.
REVOKE EXECUTE ON FUNCTION campaign_journey_configurations_freeze_published() FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION message_purpose_ownership_freeze_published() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER campaign_journey_configurations_no_update
  BEFORE UPDATE ON campaign_journey_configurations
  FOR EACH ROW EXECUTE FUNCTION campaign_journey_configurations_freeze_published();--> statement-breakpoint
CREATE TRIGGER campaign_journey_configurations_no_delete
  BEFORE DELETE ON campaign_journey_configurations
  FOR EACH ROW EXECUTE FUNCTION campaign_journey_configurations_freeze_published();--> statement-breakpoint
ALTER TABLE campaign_journey_configurations ENABLE ALWAYS TRIGGER campaign_journey_configurations_no_update;--> statement-breakpoint
ALTER TABLE campaign_journey_configurations ENABLE ALWAYS TRIGGER campaign_journey_configurations_no_delete;--> statement-breakpoint

CREATE TRIGGER message_purpose_ownership_no_update
  BEFORE UPDATE ON message_purpose_ownership
  FOR EACH ROW EXECUTE FUNCTION message_purpose_ownership_freeze_published();--> statement-breakpoint
CREATE TRIGGER message_purpose_ownership_no_delete
  BEFORE DELETE ON message_purpose_ownership
  FOR EACH ROW EXECUTE FUNCTION message_purpose_ownership_freeze_published();--> statement-breakpoint
ALTER TABLE message_purpose_ownership ENABLE ALWAYS TRIGGER message_purpose_ownership_no_update;--> statement-breakpoint
ALTER TABLE message_purpose_ownership ENABLE ALWAYS TRIGGER message_purpose_ownership_no_delete;
