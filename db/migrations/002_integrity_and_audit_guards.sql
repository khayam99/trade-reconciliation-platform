-- Up Migration

CREATE INDEX reconciliation_runs_batch_a_idx ON reconciliation_runs (batch_a_id);
CREATE INDEX reconciliation_runs_batch_b_idx ON reconciliation_runs (batch_b_id);

ALTER TABLE import_batches
  ADD CONSTRAINT import_batches_completed_row_counts_check
  CHECK (status <> 'completed' OR valid_rows + invalid_rows = total_rows) NOT VALID;

ALTER TABLE import_batches
  VALIDATE CONSTRAINT import_batches_completed_row_counts_check;

CREATE FUNCTION prevent_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only; % is not permitted', TG_OP
    USING ERRCODE = '55000';
  RETURN NULL;
END;
$function$;

CREATE TRIGGER audit_events_immutable
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_event_mutation();

CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_audit_event_mutation();

-- Down Migration

DROP TRIGGER audit_events_no_truncate ON audit_events;
DROP TRIGGER audit_events_immutable ON audit_events;
DROP FUNCTION prevent_audit_event_mutation();

ALTER TABLE import_batches
  DROP CONSTRAINT import_batches_completed_row_counts_check;

DROP INDEX reconciliation_runs_batch_a_idx;
DROP INDEX reconciliation_runs_batch_b_idx;
