-- Published guideline versions and approved message templates are immutable (PRD §13.12, §21.9,
-- FR-CAM-005, FR-GDL-003, T24).
--
-- WHY TRIGGERS AND NOT CONVENTION, for the third time in this schema and for the same reason as
-- 0005 and 0008: the application could simply never issue the UPDATE, and that holds right up until
-- the first admin script or well-meaning production fix. A version number that names content which
-- can still change is not evidence of anything.
--
-- THE TWO TABLES FREEZE AT DIFFERENT MOMENTS, and that is the substantive difference between them.
--
--   guideline_versions freezes at PUBLISHED, exactly like campaign_rules, because publishing and
--   taking effect are one event.
--
--   message_templates freezes at APPROVED, which is EARLIER than taking effect. §21.9 review is of
--   exact bytes: the classification, the consent requirement and the quiet-hour rule all describe a
--   specific text, and the text submitted to the provider for Alimtalk approval must be the text
--   that was reviewed. If content could still change between approval and activation, every one of
--   those determinations would describe something that no longer exists.

-- 1. Guideline versions. Same shape as campaign_rules_freeze_published in 0005.
CREATE OR REPLACE FUNCTION guideline_versions_freeze_published()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('published', 'superseded') THEN
      RAISE EXCEPTION 'guideline_versions version % of campaign % is published and cannot be deleted',
        OLD.version, OLD.campaign_id
        USING HINT = 'Publish a superseding version instead; deliveries cite this one (PRD 13.12).';
    END IF;
    RETURN OLD;
  END IF;

  -- A draft is editable, but the only way it leaves draft is by being published.
  IF OLD.status = 'draft' THEN
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'published' THEN
      RAISE EXCEPTION 'guideline_versions version % cannot move from draft to %',
        OLD.version, NEW.status
        USING HINT = 'A guideline must be published before it can ever be superseded.';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.body_text IS DISTINCT FROM OLD.body_text
     OR NEW.content_uri IS DISTINCT FROM OLD.content_uri
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.published_by IS DISTINCT FROM OLD.published_by
     OR NEW.published_at IS DISTINCT FROM OLD.published_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'guideline_versions version % of campaign % is published and cannot be modified',
      OLD.version, OLD.campaign_id
      USING HINT = 'Create a new version. Past deliveries cite this content (PRD 21.2).';
  END IF;

  -- effective_to may be SET once, to close this version. Never changed, never cleared.
  IF OLD.effective_to IS NOT NULL AND NEW.effective_to IS DISTINCT FROM OLD.effective_to THEN
    RAISE EXCEPTION 'guideline_versions version % already ended at %; its end cannot be moved',
      OLD.version, OLD.effective_to
      USING HINT = 'Moving the end of a closed version silently rewrites which guideline applied when.';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'published' AND NEW.status = 'superseded') THEN
    RAISE EXCEPTION 'guideline_versions version % cannot move from % to %',
      OLD.version, OLD.status, NEW.status
      USING HINT = 'A published version may only be superseded; it can never return to draft.';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER guideline_versions_no_update
  BEFORE UPDATE ON guideline_versions
  FOR EACH ROW EXECUTE FUNCTION guideline_versions_freeze_published();--> statement-breakpoint

CREATE TRIGGER guideline_versions_no_delete
  BEFORE DELETE ON guideline_versions
  FOR EACH ROW EXECUTE FUNCTION guideline_versions_freeze_published();--> statement-breakpoint

-- ENABLE ALWAYS: a trigger left at the default 'O' is silently skipped by any session that sets
-- session_replication_role = replica, which needs no DDL and no ownership. Measured against
-- audit_logs before 0002 closed it.
ALTER TABLE guideline_versions ENABLE ALWAYS TRIGGER guideline_versions_no_update;--> statement-breakpoint
ALTER TABLE guideline_versions ENABLE ALWAYS TRIGGER guideline_versions_no_delete;--> statement-breakpoint

-- 2. Message templates. Frozen from `approved` onward, with a four-state machine.
--
--    WHAT MAY STILL CHANGE AFTER APPROVAL, and why each one is not a hole:
--
--      status              — only forward, along the transitions below.
--      activated_at,
--      retired_at          — the timestamps of those transitions. Set once each.
--      provider_template_code
--                          — the Alimtalk code, which the PROVIDER issues after we submit the
--                            approved text. It cannot exist before approval, so freezing it at
--                            approval would make it unrecordable. Set once, never rewritten: a
--                            changed code would silently point an approved text at a different
--                            registered template.
--
--    Everything describing the content or the §21.9 determination is frozen.
CREATE OR REPLACE FUNCTION message_templates_freeze_approved()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'message_templates % version % is % and cannot be deleted',
        OLD.purpose_code, OLD.version, OLD.status
        USING HINT = 'Retire it instead. Sent messages cite this version (PRD 17.4).';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'draft' THEN
    -- A draft may be edited freely, but it may only LEAVE draft by being approved. Allowing
    -- draft -> active would put an unreviewed participant-facing message on the wire, which is the
    -- single thing this state machine exists to prevent.
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'approved' THEN
      RAISE EXCEPTION 'message_templates % version % cannot move from draft to %',
        OLD.purpose_code, OLD.version, NEW.status
        USING HINT = 'A template must be approved (PRD 21.9 legal review) before it can be activated.';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.purpose_code IS DISTINCT FROM OLD.purpose_code
     OR NEW.language IS DISTINCT FROM OLD.language
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.body IS DISTINCT FROM OLD.body
     OR NEW.legal_classification IS DISTINCT FROM OLD.legal_classification
     OR NEW.requires_prior_consent IS DISTINCT FROM OLD.requires_prior_consent
     OR NEW.respects_quiet_hours IS DISTINCT FROM OLD.respects_quiet_hours
     OR NEW.requires_opt_out_notice IS DISTINCT FROM OLD.requires_opt_out_notice
     OR NEW.requires_sender_identification IS DISTINCT FROM OLD.requires_sender_identification
     OR NEW.requires_provider_approval IS DISTINCT FROM OLD.requires_provider_approval
     OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
     OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'message_templates % version % is approved and cannot be modified',
      OLD.purpose_code, OLD.version
      USING HINT = 'Create a new version. The 21.9 classification describes THIS text exactly.';
  END IF;

  -- The provider code may be SET once, after the provider issues it.
  IF OLD.provider_template_code IS NOT NULL
     AND NEW.provider_template_code IS DISTINCT FROM OLD.provider_template_code THEN
    RAISE EXCEPTION 'message_templates % version % already has provider code %',
      OLD.purpose_code, OLD.version, OLD.provider_template_code
      USING HINT = 'Changing it points reviewed text at a different registered template.';
  END IF;

  -- Lifecycle timestamps are evidence of the transition. Each is set by that transition exactly
  -- once; allowing a later rewrite would make the recorded operational history fictional.
  IF NEW.activated_at IS DISTINCT FROM OLD.activated_at
     AND NOT (
       OLD.status = 'approved' AND NEW.status = 'active'
       AND OLD.activated_at IS NULL AND NEW.activated_at IS NOT NULL
     )
  THEN
    RAISE EXCEPTION 'message_templates % version % activation timestamp cannot be modified',
      OLD.purpose_code, OLD.version;
  END IF;

  IF NEW.retired_at IS DISTINCT FROM OLD.retired_at
     AND NOT (
       OLD.status IN ('approved', 'active') AND NEW.status = 'retired'
       AND OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL
     )
  THEN
    RAISE EXCEPTION 'message_templates % version % retirement timestamp cannot be modified',
      OLD.purpose_code, OLD.version;
  END IF;

  -- Forward only: approved -> active, approved -> retired (withdrawn before ever being used),
  -- active -> retired. Nothing returns to draft, and nothing un-retires.
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (
       (OLD.status = 'approved' AND NEW.status IN ('active', 'retired'))
       OR (OLD.status = 'active' AND NEW.status = 'retired')
     )
  THEN
    RAISE EXCEPTION 'message_templates % version % cannot move from % to %',
      OLD.purpose_code, OLD.version, OLD.status, NEW.status
      USING HINT = 'Legal transitions: draft->approved->active->retired, or approved->retired.';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER message_templates_no_update
  BEFORE UPDATE ON message_templates
  FOR EACH ROW EXECUTE FUNCTION message_templates_freeze_approved();--> statement-breakpoint

CREATE TRIGGER message_templates_no_delete
  BEFORE DELETE ON message_templates
  FOR EACH ROW EXECUTE FUNCTION message_templates_freeze_approved();--> statement-breakpoint

ALTER TABLE message_templates ENABLE ALWAYS TRIGGER message_templates_no_update;--> statement-breakpoint
ALTER TABLE message_templates ENABLE ALWAYS TRIGGER message_templates_no_delete;--> statement-breakpoint

-- 3. The new trigger functions must not be executable by the application role.
--
--    Migration 0009 revokes PUBLIC EXECUTE from every non-extension function in `public`, but it
--    ran BEFORE these functions existed and a migration is never replayed — so on an existing
--    database nothing here would be revoked. tools/db-provision-role.mjs re-runs that loop on every
--    `pnpm db:migrate`, which does cover them; this repeats it so that the guarantee does not
--    depend on the ordering of two commands.
--
--    Harmless for these two specifically (a trigger function called directly does nothing useful),
--    and the habit is what matters: the same omission around a SECURITY DEFINER function is a
--    complete bypass of the audit-log protections.
REVOKE EXECUTE ON FUNCTION guideline_versions_freeze_published() FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION message_templates_freeze_approved() FROM PUBLIC;
