-- Application synchronization evidence is append-only (PRD 17.2, T26/T27).
-- A source replay or a late webhook is handled by the unique source-event and source-version
-- constraints; existing evidence is never rewritten to make a replay appear current.
CREATE OR REPLACE FUNCTION application_changes_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'application_changes is append-only; % is forbidden', TG_OP
    USING HINT = 'Append a new source version through application synchronization.';
END;
$$;--> statement-breakpoint

CREATE TRIGGER application_changes_no_update_or_delete
  BEFORE UPDATE OR DELETE ON application_changes
  FOR EACH ROW EXECUTE FUNCTION application_changes_reject_mutation();--> statement-breakpoint

CREATE TRIGGER application_changes_no_truncate
  BEFORE TRUNCATE ON application_changes
  FOR EACH STATEMENT EXECUTE FUNCTION application_changes_reject_mutation();--> statement-breakpoint

ALTER TABLE application_changes ENABLE ALWAYS TRIGGER application_changes_no_update_or_delete;--> statement-breakpoint
ALTER TABLE application_changes ENABLE ALWAYS TRIGGER application_changes_no_truncate;--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION application_changes_reject_mutation() FROM PUBLIC;
