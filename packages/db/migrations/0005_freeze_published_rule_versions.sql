-- Published campaign rule versions are immutable (PRD §13.5, FR-CAM-005/007, T21).
--
-- WHY A TRIGGER AND NOT A CONVENTION. The application could simply never issue an UPDATE against a
-- published row, and that would hold right up until the first migration, admin script, or
-- well-meaning production fix. §18.7's selection payload carries `rule_version` so a past decision
-- can be explained by reading the rules that produced it; if a version can be edited afterwards,
-- that number names something that no longer exists and every historical decision becomes
-- unauditable at once. Same reasoning as the audit_logs triggers in 0001/0002.
--
-- WHAT IS FROZEN, PRECISELY. Only rows whose status is `published` or `superseded`. A `draft` is
-- still being written and must remain freely editable — freezing it would make the table unusable
-- for the thing it exists to do.
--
-- THE ONE PERMITTED WRITE. Publishing a new version has to close the previous one, which means
-- setting `effective_to` on a published row and moving it to `superseded`. That is the only
-- transition allowed, and it is allowed only in that direction: `effective_to` may go from NULL to
-- a value, never from a value to a different one, and status may go published -> superseded but
-- never back. Everything else on a published row is rejected.
--
-- DELETE IS REJECTED OUTRIGHT. There is no legitimate reason to remove a version that a decision
-- may cite. SPEC.md §8 lists deleting business history under "Never".

CREATE OR REPLACE FUNCTION campaign_rules_freeze_published()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('published', 'superseded') THEN
      RAISE EXCEPTION 'campaign_rules version % of % is published and cannot be deleted',
        OLD.version, OLD.rule_type
        USING HINT = 'Publish a superseding version instead; decisions cite this one (PRD 21.2).';
    END IF;
    RETURN OLD;
  END IF;

  -- INSERT and updates to a draft are unrestricted.
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  -- From here OLD is published or superseded. Every immutable column must be unchanged.
  IF NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
     OR NEW.rule_type IS DISTINCT FROM OLD.rule_type
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.configuration IS DISTINCT FROM OLD.configuration
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.published_by IS DISTINCT FROM OLD.published_by
     OR NEW.published_at IS DISTINCT FROM OLD.published_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'campaign_rules version % of % is published and cannot be modified',
      OLD.version, OLD.rule_type
      USING HINT = 'Create a new version. A published version is cited by past decisions (PRD 21.2).';
  END IF;

  -- effective_to may be SET once, to close this version. It may not be changed or cleared.
  IF OLD.effective_to IS NOT NULL AND NEW.effective_to IS DISTINCT FROM OLD.effective_to THEN
    RAISE EXCEPTION 'campaign_rules version % of % already ended at %; its end cannot be moved',
      OLD.version, OLD.rule_type, OLD.effective_to
      USING HINT = 'Moving the end of a closed version silently rewrites which rules applied when.';
  END IF;

  -- Status may only advance published -> superseded.
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'published' AND NEW.status = 'superseded') THEN
    RAISE EXCEPTION 'campaign_rules version % of % cannot move from % to %',
      OLD.version, OLD.rule_type, OLD.status, NEW.status
      USING HINT = 'A published version may only be superseded; it can never return to draft.';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

-- FOR EACH ROW, unlike the audit_logs triggers, because this one has to compare OLD against NEW.
CREATE TRIGGER campaign_rules_no_update
  BEFORE UPDATE ON campaign_rules
  FOR EACH ROW EXECUTE FUNCTION campaign_rules_freeze_published();--> statement-breakpoint

CREATE TRIGGER campaign_rules_no_delete
  BEFORE DELETE ON campaign_rules
  FOR EACH ROW EXECUTE FUNCTION campaign_rules_freeze_published();--> statement-breakpoint

-- ENABLE ALWAYS, for the reason migration 0002 records: a trigger left at the default 'O' (origin)
-- is silently skipped by any session that sets `session_replication_role = replica`, which needs no
-- DDL and no ownership. Measured against audit_logs before 0002 closed it.
ALTER TABLE campaign_rules ENABLE ALWAYS TRIGGER campaign_rules_no_update;--> statement-breakpoint
ALTER TABLE campaign_rules ENABLE ALWAYS TRIGGER campaign_rules_no_delete;
