CREATE TYPE "public"."conversation_event_type" AS ENUM('observed', 'participant_bound', 'participant_rebound', 'workflow_bound', 'workflow_rebound', 'closed_by_provider', 'deleted_by_provider', 'marked_ambiguous', 'ambiguity_resolved');--> statement-breakpoint
CREATE TYPE "public"."conversation_state" AS ENUM('active', 'closed_by_provider', 'deleted_by_provider', 'ambiguous');--> statement-breakpoint
CREATE TYPE "public"."inbound_message_kind" AS ENUM('text', 'attachment', 'mixed', 'unsupported');--> statement-breakpoint
CREATE TYPE "public"."secret_comment_evidence_status" AS ENUM('claimed', 'screenshot_received', 'superseded', 'rejected');--> statement-breakpoint
CREATE TABLE "conversation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"event_type" "conversation_event_type" NOT NULL,
	"reason_code" text NOT NULL,
	"from_participant_id" uuid,
	"to_participant_id" uuid,
	"from_workflow_id" uuid,
	"to_workflow_id" uuid,
	"evidence_category" text NOT NULL,
	"actor_reference" text NOT NULL,
	"deduplication_key" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "conversation_events_deduplication_key" UNIQUE("deduplication_key"),
	CONSTRAINT "conversation_events_reason_code" CHECK ("conversation_events"."reason_code" ~ '^[A-Z][A-Z0-9_]*$'),
	CONSTRAINT "conversation_events_evidence_category" CHECK ("conversation_events"."evidence_category" ~ '^[A-Z][A-Z0-9_]*$'),
	CONSTRAINT "conversation_events_actor_length" CHECK (char_length("conversation_events"."actor_reference") between 1 and 200),
	CONSTRAINT "conversation_events_participant_rebind_evidence" CHECK ("conversation_events"."event_type" <> 'participant_rebound'
          or ("conversation_events"."from_participant_id" is not null and "conversation_events"."to_participant_id" is not null
              and "conversation_events"."from_participant_id" <> "conversation_events"."to_participant_id")),
	CONSTRAINT "conversation_events_workflow_rebind_evidence" CHECK ("conversation_events"."event_type" <> 'workflow_rebound'
          or ("conversation_events"."from_workflow_id" is not null and "conversation_events"."to_workflow_id" is not null
              and "conversation_events"."from_workflow_id" <> "conversation_events"."to_workflow_id"))
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_conversation_id" text NOT NULL,
	"channel_identity_id" uuid,
	"participant_id" uuid,
	"campaign_id" uuid,
	"workflow_id" uuid,
	"state" "conversation_state" DEFAULT 'active' NOT NULL,
	"first_observed_at" timestamp with time zone NOT NULL,
	"last_observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_provider_thread_key" UNIQUE("provider","provider_conversation_id"),
	CONSTRAINT "conversations_valid_provider" CHECK ("conversations"."provider" ~ '^[a-z][a-z0-9_.-]{2,63}$'),
	CONSTRAINT "conversations_valid_thread_id" CHECK (char_length("conversations"."provider_conversation_id") between 1 and 512),
	CONSTRAINT "conversations_observation_order" CHECK ("conversations"."last_observed_at" >= "conversations"."first_observed_at"),
	CONSTRAINT "conversations_binding_coherence" CHECK (("conversations"."workflow_id" is null or "conversations"."participant_id" is not null)
          and ("conversations"."channel_identity_id" is null or "conversations"."participant_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "inbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"provider_message_id" text NOT NULL,
	"event_inbox_id" uuid,
	"participant_id" uuid,
	"workflow_id" uuid,
	"message_kind" "inbound_message_kind" NOT NULL,
	"classified_purpose_code" text,
	"body_text" text,
	"content_digest" varchar(64) NOT NULL,
	"provider_sent_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"supersedes_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_messages_conversation_provider_key" UNIQUE("conversation_id","provider_message_id"),
	CONSTRAINT "inbound_messages_provider_message_id" CHECK (char_length("inbound_messages"."provider_message_id") between 1 and 512),
	CONSTRAINT "inbound_messages_content_digest" CHECK ("inbound_messages"."content_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "inbound_messages_purpose_code" CHECK ("inbound_messages"."classified_purpose_code" is null or "inbound_messages"."classified_purpose_code" ~ '^[A-Z][A-Z0-9_:]*$'),
	CONSTRAINT "inbound_messages_body_length" CHECK ("inbound_messages"."body_text" is null or char_length("inbound_messages"."body_text") between 1 and 8000),
	CONSTRAINT "inbound_messages_text_needs_body" CHECK ("inbound_messages"."message_kind" <> 'text' or "inbound_messages"."body_text" is not null),
	CONSTRAINT "inbound_messages_no_self_supersession" CHECK ("inbound_messages"."supersedes_message_id" is distinct from "inbound_messages"."id")
);
--> statement-breakpoint
CREATE TABLE "secret_comment_evidence_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "secret_comment_evidence_status" NOT NULL,
	"inbound_message_id" uuid,
	"attachment_id" uuid,
	"reason_code" text NOT NULL,
	"supporting_only" boolean DEFAULT true NOT NULL,
	"supersedes_version_id" uuid,
	"actor_reference" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secret_comment_evidence_versions_workflow_version_key" UNIQUE("workflow_id","version"),
	CONSTRAINT "secret_comment_evidence_versions_positive_version" CHECK ("secret_comment_evidence_versions"."version" > 0),
	CONSTRAINT "secret_comment_evidence_versions_reason_code" CHECK ("secret_comment_evidence_versions"."reason_code" ~ '^[A-Z][A-Z0-9_]*$'),
	CONSTRAINT "secret_comment_evidence_versions_actor_length" CHECK (char_length("secret_comment_evidence_versions"."actor_reference") between 1 and 200),
	CONSTRAINT "secret_comment_evidence_versions_screenshot_evidence" CHECK ("secret_comment_evidence_versions"."status" <> 'screenshot_received' or "secret_comment_evidence_versions"."attachment_id" is not null),
	CONSTRAINT "secret_comment_evidence_versions_no_self_supersession" CHECK ("secret_comment_evidence_versions"."supersedes_version_id" is distinct from "secret_comment_evidence_versions"."id"),
	CONSTRAINT "secret_comment_evidence_versions_supporting_only" CHECK ("secret_comment_evidence_versions"."supporting_only")
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "inbound_message_id" uuid;--> statement-breakpoint
ALTER TABLE "outbound_notifications" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_from_participant_id_participants_id_fk" FOREIGN KEY ("from_participant_id") REFERENCES "public"."participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_to_participant_id_participants_id_fk" FOREIGN KEY ("to_participant_id") REFERENCES "public"."participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_from_workflow_id_workflow_instances_id_fk" FOREIGN KEY ("from_workflow_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_to_workflow_id_workflow_instances_id_fk" FOREIGN KEY ("to_workflow_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_channel_identity_id_channel_identities_id_fk" FOREIGN KEY ("channel_identity_id") REFERENCES "public"."channel_identities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workflow_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_event_inbox_id_event_inbox_id_fk" FOREIGN KEY ("event_inbox_id") REFERENCES "public"."event_inbox"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_workflow_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_supersedes_fk" FOREIGN KEY ("supersedes_message_id") REFERENCES "public"."inbound_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_comment_evidence_versions" ADD CONSTRAINT "secret_comment_evidence_versions_workflow_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_comment_evidence_versions" ADD CONSTRAINT "secret_comment_evidence_versions_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_comment_evidence_versions" ADD CONSTRAINT "secret_comment_evidence_versions_inbound_message_id_inbound_messages_id_fk" FOREIGN KEY ("inbound_message_id") REFERENCES "public"."inbound_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_comment_evidence_versions" ADD CONSTRAINT "secret_comment_evidence_versions_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_comment_evidence_versions" ADD CONSTRAINT "secret_comment_evidence_versions_supersedes_fk" FOREIGN KEY ("supersedes_version_id") REFERENCES "public"."secret_comment_evidence_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_events_timeline_idx" ON "conversation_events" USING btree ("conversation_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "conversations_participant_idx" ON "conversations" USING btree ("participant_id","last_observed_at");--> statement-breakpoint
CREATE INDEX "conversations_workflow_idx" ON "conversations" USING btree ("workflow_id","last_observed_at");--> statement-breakpoint
CREATE INDEX "conversations_state_idx" ON "conversations" USING btree ("state","last_observed_at");--> statement-breakpoint
CREATE INDEX "inbound_messages_thread_idx" ON "inbound_messages" USING btree ("conversation_id","provider_sent_at","id");--> statement-breakpoint
CREATE INDEX "inbound_messages_workflow_idx" ON "inbound_messages" USING btree ("workflow_id","provider_sent_at");--> statement-breakpoint
CREATE INDEX "inbound_messages_content_digest_idx" ON "inbound_messages" USING btree ("content_digest");--> statement-breakpoint
CREATE INDEX "secret_comment_evidence_versions_timeline_idx" ON "secret_comment_evidence_versions" USING btree ("workflow_id","occurred_at","id");--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_inbound_message_id_inbound_messages_id_fk" FOREIGN KEY ("inbound_message_id") REFERENCES "public"."inbound_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_notifications" ADD CONSTRAINT "outbound_notifications_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_inbound_message_idx" ON "attachments" USING btree ("inbound_message_id");--> statement-breakpoint
CREATE INDEX "outbound_notifications_conversation_idx" ON "outbound_notifications" USING btree ("conversation_id","created_at");--> statement-breakpoint

-- APPEND-ONLY CONVERSATION HISTORY (T135).
--
-- Two mechanisms, because they fail differently. The REVOKE below stops the application role from
-- issuing UPDATE or DELETE at all; the ENABLE ALWAYS triggers stop the table OWNER and anything
-- running as it, which a REVOKE cannot. Migration 0009 records the same reasoning for audit_logs:
-- a guarantee that depends on everyone remembering is not a guarantee.
--
-- `conversations` is deliberately NOT here. It is a mutable head — bindings, state, and
-- last_observed_at legitimately change — and every one of those changes is written to
-- conversation_events, which is frozen.
CREATE OR REPLACE FUNCTION conversation_history_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'conversation history is append-only: % on % is not permitted', TG_OP, TG_TABLE_NAME
    USING HINT = 'Record a new row instead. Correcting history would make an identity dispute unanswerable.';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- Migration 0009's REVOKE loop already ran, so a function created here keeps PUBLIC EXECUTE unless
-- it revokes for itself. Migrations 0027 and 0028 carry the same line for the same reason.
REVOKE EXECUTE ON FUNCTION conversation_history_reject_mutation() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER conversation_events_append_only
BEFORE UPDATE OR DELETE ON conversation_events
FOR EACH STATEMENT EXECUTE FUNCTION conversation_history_reject_mutation();--> statement-breakpoint
ALTER TABLE conversation_events ENABLE ALWAYS TRIGGER conversation_events_append_only;--> statement-breakpoint
CREATE TRIGGER conversation_events_no_truncate
BEFORE TRUNCATE ON conversation_events
FOR EACH STATEMENT EXECUTE FUNCTION conversation_history_reject_mutation();--> statement-breakpoint
ALTER TABLE conversation_events ENABLE ALWAYS TRIGGER conversation_events_no_truncate;--> statement-breakpoint

CREATE TRIGGER inbound_messages_append_only
BEFORE UPDATE OR DELETE ON inbound_messages
FOR EACH STATEMENT EXECUTE FUNCTION conversation_history_reject_mutation();--> statement-breakpoint
ALTER TABLE inbound_messages ENABLE ALWAYS TRIGGER inbound_messages_append_only;--> statement-breakpoint
CREATE TRIGGER inbound_messages_no_truncate
BEFORE TRUNCATE ON inbound_messages
FOR EACH STATEMENT EXECUTE FUNCTION conversation_history_reject_mutation();--> statement-breakpoint
ALTER TABLE inbound_messages ENABLE ALWAYS TRIGGER inbound_messages_no_truncate;--> statement-breakpoint

CREATE TRIGGER secret_comment_evidence_versions_append_only
BEFORE UPDATE OR DELETE ON secret_comment_evidence_versions
FOR EACH STATEMENT EXECUTE FUNCTION conversation_history_reject_mutation();--> statement-breakpoint
ALTER TABLE secret_comment_evidence_versions ENABLE ALWAYS TRIGGER secret_comment_evidence_versions_append_only;--> statement-breakpoint
CREATE TRIGGER secret_comment_evidence_versions_no_truncate
BEFORE TRUNCATE ON secret_comment_evidence_versions
FOR EACH STATEMENT EXECUTE FUNCTION conversation_history_reject_mutation();--> statement-breakpoint
ALTER TABLE secret_comment_evidence_versions ENABLE ALWAYS TRIGGER secret_comment_evidence_versions_no_truncate;--> statement-breakpoint

REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON conversation_events, inbound_messages, secret_comment_evidence_versions
  FROM helloreview_app;
