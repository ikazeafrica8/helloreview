-- Published business versions are immutable (FR-CAM-004, T23).
--
-- The same guarantee migration 0005 gives campaign_rules, for the same reason and by the same
-- mechanism. §16.7's Business check validates a booking against the approved name, aliases and
-- branch; a reservation validated last month must remain explicable against the details that were
-- approved then, which is only true if those details cannot be edited afterwards.
--
-- This also makes the CASCADE on campaign_business_aliases safe. That cascade is only defensible
-- because a published business version can never be deleted — so the only cascade that can ever
-- fire is from discarding a draft, which is exactly when discarding its aliases is correct. Without
-- this trigger the schema comment saying so would be false.
--
-- ALIASES ARE FROZEN WITH THEIR VERSION. An alias is an AUTHORIZATION: §16.7 validates against an
-- "approved alias", so adding one to a published version would retroactively authorize bookings at
-- a name nobody approved at the time. Adding an alias means publishing a new business version.

CREATE OR REPLACE FUNCTION campaign_businesses_freeze_published()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('published', 'superseded') THEN
      RAISE EXCEPTION 'campaign_businesses version % is published and cannot be deleted', OLD.version
        USING HINT = 'Publish a superseding version instead; past validations cite this one.';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  IF NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.normalized_name IS DISTINCT FROM OLD.normalized_name
     OR NEW.branch IS DISTINCT FROM OLD.branch
     OR NEW.normalized_branch IS DISTINCT FROM OLD.normalized_branch
     OR NEW.phone IS DISTINCT FROM OLD.phone
     OR NEW.booking_url IS DISTINCT FROM OLD.booking_url
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'campaign_businesses version % is published and cannot be modified', OLD.version
      USING HINT = 'Create a new version. Past reservation validations cite this one (PRD 16.7).';
  END IF;

  IF OLD.effective_to IS NOT NULL AND NEW.effective_to IS DISTINCT FROM OLD.effective_to THEN
    RAISE EXCEPTION 'campaign_businesses version % already ended at %; its end cannot be moved',
      OLD.version, OLD.effective_to
      USING HINT = 'Moving the end of a closed version rewrites which details applied when.';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'published' AND NEW.status = 'superseded') THEN
    RAISE EXCEPTION 'campaign_businesses version % cannot move from % to %', OLD.version, OLD.status, NEW.status
      USING HINT = 'A published version may only be superseded; it can never return to draft.';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER campaign_businesses_no_update
  BEFORE UPDATE ON campaign_businesses
  FOR EACH ROW EXECUTE FUNCTION campaign_businesses_freeze_published();--> statement-breakpoint

CREATE TRIGGER campaign_businesses_no_delete
  BEFORE DELETE ON campaign_businesses
  FOR EACH ROW EXECUTE FUNCTION campaign_businesses_freeze_published();--> statement-breakpoint

ALTER TABLE campaign_businesses ENABLE ALWAYS TRIGGER campaign_businesses_no_update;--> statement-breakpoint
ALTER TABLE campaign_businesses ENABLE ALWAYS TRIGGER campaign_businesses_no_delete;--> statement-breakpoint

-- Aliases of a published version are frozen too. Without this the alias list would be an
-- unversioned back door into a versioned record: the business details would be immutable while the
-- set of names that validate against them stayed editable.
CREATE OR REPLACE FUNCTION campaign_business_aliases_freeze_published()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  owner_status text;
  owner_id uuid;
BEGIN
  -- OLD and NEW are records of different provenance; plpgsql will not let a CASE expression yield
  -- one or the other, so the branch is written out.
  IF TG_OP = 'DELETE' THEN
    owner_id := OLD.campaign_business_id;
  ELSE
    owner_id := NEW.campaign_business_id;
  END IF;

  SELECT status INTO owner_status FROM campaign_businesses WHERE id = owner_id;

  -- A missing owner means the cascade is removing it, which the trigger above already permitted
  -- (and which can only happen for a draft). A draft owner is freely editable.
  IF owner_status IS NULL OR owner_status = 'draft' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'the alias list of a published business version cannot be changed'
    USING HINT = 'An alias authorizes a booking name (PRD 16.7). Publish a new business version.';
END;
$$;--> statement-breakpoint

CREATE TRIGGER campaign_business_aliases_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON campaign_business_aliases
  FOR EACH ROW EXECUTE FUNCTION campaign_business_aliases_freeze_published();--> statement-breakpoint

ALTER TABLE campaign_business_aliases ENABLE ALWAYS TRIGGER campaign_business_aliases_frozen;
