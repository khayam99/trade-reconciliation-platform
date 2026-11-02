-- Up Migration

CREATE TABLE import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_system text NOT NULL CHECK (source_system IN ('ALPHA', 'BRAVO')),
  original_filename text NOT NULL CHECK (length(btrim(original_filename)) > 0),
  status text NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  total_rows integer NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
  valid_rows integer NOT NULL DEFAULT 0 CHECK (valid_rows >= 0),
  invalid_rows integer NOT NULL DEFAULT 0 CHECK (invalid_rows >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT import_batches_row_counts_check
    CHECK (valid_rows + invalid_rows <= total_rows),
  CONSTRAINT import_batches_completion_check
    CHECK (status <> 'completed' OR completed_at IS NOT NULL)
);

CREATE TABLE imported_trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_batch_id uuid NOT NULL REFERENCES import_batches(id) ON DELETE RESTRICT,
  row_number integer NOT NULL CHECK (row_number > 0),
  source_trade_id text,
  trade_date date,
  instrument text,
  side text,
  currency varchar(3),
  quantity numeric(24, 10),
  price numeric(24, 10),
  validation_status text NOT NULL CHECK (validation_status IN ('valid', 'invalid')),
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(validation_errors) = 'array'),
  raw_record jsonb NOT NULL CHECK (jsonb_typeof(raw_record) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT imported_trades_batch_row_unique UNIQUE (import_batch_id, row_number),
  CONSTRAINT imported_trades_valid_values_check CHECK (
    validation_status <> 'valid'
    OR (
      trade_date IS NOT NULL
      AND instrument IS NOT NULL AND length(btrim(instrument)) > 0
      AND side IS NOT NULL AND side IN ('BUY', 'SELL')
      AND currency IS NOT NULL AND currency ~ '^[A-Z]{3}$'
      AND quantity IS NOT NULL AND quantity > 0
      AND price IS NOT NULL AND price >= 0
    )
  )
);

CREATE TABLE reconciliation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_a_id uuid NOT NULL REFERENCES import_batches(id) ON DELETE RESTRICT,
  batch_b_id uuid NOT NULL REFERENCES import_batches(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  rules_version text NOT NULL CHECK (length(btrim(rules_version)) > 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT reconciliation_runs_different_batches_check CHECK (batch_a_id <> batch_b_id),
  CONSTRAINT reconciliation_runs_completion_check
    CHECK (status <> 'completed' OR completed_at IS NOT NULL)
);

CREATE TABLE reconciliation_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_run_id uuid NOT NULL REFERENCES reconciliation_runs(id) ON DELETE RESTRICT,
  outcome text NOT NULL CHECK (
    outcome IN ('exact_match', 'field_mismatch', 'missing_in_a', 'missing_in_b', 'duplicate')
  ),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reconciliation_result_trades (
  reconciliation_result_id uuid NOT NULL
    REFERENCES reconciliation_results(id) ON DELETE RESTRICT,
  imported_trade_id uuid NOT NULL REFERENCES imported_trades(id) ON DELETE RESTRICT,
  source_side text NOT NULL CHECK (source_side IN ('A', 'B')),
  PRIMARY KEY (reconciliation_result_id, imported_trade_id)
);

CREATE TABLE exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_result_id uuid NOT NULL UNIQUE
    REFERENCES reconciliation_results(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'investigating', 'resolved', 'ignored')),
  resolution_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT exceptions_resolution_check CHECK (
    (status = 'resolved' AND resolved_at IS NOT NULL AND length(btrim(resolution_reason)) > 0)
    OR
    (status <> 'resolved' AND resolved_at IS NULL AND resolution_reason IS NULL)
  )
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exception_id uuid NOT NULL REFERENCES exceptions(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (length(btrim(event_type)) > 0),
  actor text NOT NULL CHECK (length(btrim(actor)) > 0),
  reason text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX import_batches_source_created_idx
  ON import_batches (source_system, created_at DESC);
CREATE INDEX imported_trades_batch_status_idx
  ON imported_trades (import_batch_id, validation_status);
CREATE INDEX imported_trades_source_id_idx
  ON imported_trades (import_batch_id, source_trade_id)
  WHERE source_trade_id IS NOT NULL;
CREATE INDEX reconciliation_runs_started_idx
  ON reconciliation_runs (started_at DESC);
CREATE INDEX reconciliation_results_run_outcome_idx
  ON reconciliation_results (reconciliation_run_id, outcome);
CREATE INDEX reconciliation_result_trades_trade_idx
  ON reconciliation_result_trades (imported_trade_id);
CREATE INDEX exceptions_status_created_idx
  ON exceptions (status, created_at DESC);
CREATE INDEX audit_events_exception_created_idx
  ON audit_events (exception_id, created_at);

-- Down Migration

DROP TABLE audit_events;
DROP TABLE exceptions;
DROP TABLE reconciliation_result_trades;
DROP TABLE reconciliation_results;
DROP TABLE reconciliation_runs;
DROP TABLE imported_trades;
DROP TABLE import_batches;
