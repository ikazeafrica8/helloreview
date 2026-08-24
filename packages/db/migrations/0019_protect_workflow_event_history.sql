-- Workflow transition and supersession evidence is append-only (PRD 14.4/14.7, T34/T39).
-- Corrections append a new event and a supersession link; they never rewrite the prior fact.
CREATE OR REPLACE FUNCTION workflow_history_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is forbidden', TG_TABLE_NAME, TG_OP
    USING HINT = 'Append a correction event and supersession record instead.';
END;
$$;--> statement-breakpoint

CREATE TRIGGER workflow_events_no_update_or_delete
  BEFORE UPDATE OR DELETE ON workflow_events
  FOR EACH ROW EXECUTE FUNCTION workflow_history_reject_mutation();--> statement-breakpoint

CREATE TRIGGER workflow_events_no_truncate
  BEFORE TRUNCATE ON workflow_events
  FOR EACH STATEMENT EXECUTE FUNCTION workflow_history_reject_mutation();--> statement-breakpoint

CREATE TRIGGER workflow_event_supersessions_no_update_or_delete
  BEFORE UPDATE OR DELETE ON workflow_event_supersessions
  FOR EACH ROW EXECUTE FUNCTION workflow_history_reject_mutation();--> statement-breakpoint

CREATE TRIGGER workflow_event_supersessions_no_truncate
  BEFORE TRUNCATE ON workflow_event_supersessions
  FOR EACH STATEMENT EXECUTE FUNCTION workflow_history_reject_mutation();--> statement-breakpoint

ALTER TABLE workflow_events ENABLE ALWAYS TRIGGER workflow_events_no_update_or_delete;--> statement-breakpoint
ALTER TABLE workflow_events ENABLE ALWAYS TRIGGER workflow_events_no_truncate;--> statement-breakpoint
ALTER TABLE workflow_event_supersessions ENABLE ALWAYS TRIGGER workflow_event_supersessions_no_update_or_delete;--> statement-breakpoint
ALTER TABLE workflow_event_supersessions ENABLE ALWAYS TRIGGER workflow_event_supersessions_no_truncate;--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION workflow_history_reject_mutation() FROM PUBLIC;
