-- Up Migration

ALTER TABLE reconciliation_results
  DROP CONSTRAINT reconciliation_results_outcome_check;

ALTER TABLE reconciliation_results
  ADD CONSTRAINT reconciliation_results_outcome_check
  CHECK (outcome IN (
    'exact_match', 'field_mismatch', 'missing_in_a', 'missing_in_b', 'duplicate', 'invalid'
  ));

-- Carry the run identity on each link so the database can enforce one result
-- per imported trade per run and ensure each link points to a result in that run.
ALTER TABLE reconciliation_result_trades
  ADD COLUMN reconciliation_run_id uuid;

UPDATE reconciliation_result_trades AS trade_link
SET reconciliation_run_id = result.reconciliation_run_id
FROM reconciliation_results AS result
WHERE result.id = trade_link.reconciliation_result_id;

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM reconciliation_result_trades
    WHERE reconciliation_run_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot backfill reconciliation run IDs for all existing trade links';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM reconciliation_result_trades
    GROUP BY reconciliation_run_id, imported_trade_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Existing reconciliation links assign a trade to multiple results in one run';
  END IF;
END;
$migration$;

ALTER TABLE reconciliation_result_trades
  ALTER COLUMN reconciliation_run_id SET NOT NULL;

ALTER TABLE reconciliation_results
  ADD CONSTRAINT reconciliation_results_id_run_unique
  UNIQUE (id, reconciliation_run_id);

ALTER TABLE reconciliation_result_trades
  ADD CONSTRAINT reconciliation_result_trades_result_run_fk
  FOREIGN KEY (reconciliation_result_id, reconciliation_run_id)
  REFERENCES reconciliation_results (id, reconciliation_run_id)
  ON DELETE RESTRICT;

ALTER TABLE reconciliation_result_trades
  ADD CONSTRAINT reconciliation_result_trades_trade_once_per_run
  UNIQUE (reconciliation_run_id, imported_trade_id);

-- Down Migration

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM reconciliation_results WHERE outcome = 'invalid') THEN
    RAISE EXCEPTION 'Cannot remove invalid outcome support while invalid results exist';
  END IF;
END;
$migration$;

ALTER TABLE reconciliation_result_trades
  DROP CONSTRAINT reconciliation_result_trades_trade_once_per_run;

ALTER TABLE reconciliation_result_trades
  DROP CONSTRAINT reconciliation_result_trades_result_run_fk;

ALTER TABLE reconciliation_results
  DROP CONSTRAINT reconciliation_results_id_run_unique;

ALTER TABLE reconciliation_result_trades
  DROP COLUMN reconciliation_run_id;

ALTER TABLE reconciliation_results
  DROP CONSTRAINT reconciliation_results_outcome_check;

ALTER TABLE reconciliation_results
  ADD CONSTRAINT reconciliation_results_outcome_check
  CHECK (outcome IN (
    'exact_match', 'field_mismatch', 'missing_in_a', 'missing_in_b', 'duplicate'
  ));
