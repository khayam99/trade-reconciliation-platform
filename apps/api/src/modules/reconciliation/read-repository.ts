import type { Pool, QueryResultRow } from 'pg';

export interface Pagination {
  limit: number;
  offset: number;
}

export interface ImportBatchFilters {
  source?: 'ALPHA' | 'BRAVO';
  status?: 'processing' | 'completed' | 'failed';
}

export interface ReconciliationRunFilters {
  status?: 'processing' | 'completed' | 'failed';
  batchAId?: string;
  batchBId?: string;
}

export interface ExceptionFilters {
  status?: 'open' | 'investigating' | 'resolved' | 'ignored';
  outcome?:
    'exact_match' | 'field_mismatch' | 'missing_in_a' | 'missing_in_b' | 'duplicate' | 'invalid';
  runId?: string;
}

interface PageResult<T> {
  items: T[];
  total: number;
}

function addFilter(
  clauses: string[],
  values: unknown[],
  column: string,
  value: unknown,
  cast = '',
): void {
  if (value === undefined) return;
  values.push(value);
  clauses.push(`${column} = $${values.length}${cast}`);
}

async function listPage<T extends QueryResultRow>(
  pool: Pool,
  fromAndJoins: string,
  filters: Array<{ column: string; value: unknown; cast?: string }>,
  pagination: Pagination,
  select: string,
  orderBy: string,
): Promise<PageResult<T>> {
  const values: unknown[] = [];
  const clauses: string[] = [];
  for (const filter of filters) {
    addFilter(clauses, values, filter.column, filter.value, filter.cast);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const count = await pool.query<{ total: string }>(
    `SELECT count(*)::text AS total ${fromAndJoins} ${where}`,
    values,
  );
  const pageValues = [...values, pagination.limit, pagination.offset];
  const rows = await pool.query<T>(
    `SELECT ${select} ${fromAndJoins} ${where}
     ${orderBy}
     LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
    pageValues,
  );
  return { items: rows.rows, total: Number(count.rows[0]?.total ?? '0') };
}

export async function listImportBatches(
  pool: Pool,
  filters: ImportBatchFilters,
  pagination: Pagination,
) {
  return listPage(
    pool,
    'FROM import_batches batch',
    [
      { column: 'batch.source_system', value: filters.source },
      { column: 'batch.status', value: filters.status },
    ],
    pagination,
    `batch.id, batch.source_system AS "sourceSystem", batch.original_filename AS "originalFilename",
     batch.status, batch.total_rows AS "totalRows", batch.valid_rows AS "validRows",
     batch.invalid_rows AS "invalidRows", batch.created_at AS "createdAt", batch.completed_at AS "completedAt"`,
    'ORDER BY batch.created_at DESC, batch.id',
  );
}

export async function listReconciliationRuns(
  pool: Pool,
  filters: ReconciliationRunFilters,
  pagination: Pagination,
) {
  return listPage(
    pool,
    `FROM reconciliation_runs run
     JOIN import_batches batch_a ON batch_a.id = run.batch_a_id
     JOIN import_batches batch_b ON batch_b.id = run.batch_b_id`,
    [
      { column: 'run.status', value: filters.status },
      { column: 'run.batch_a_id', value: filters.batchAId, cast: '::uuid' },
      { column: 'run.batch_b_id', value: filters.batchBId, cast: '::uuid' },
    ],
    pagination,
    `run.id, run.status, run.rules_version AS "rulesVersion", run.started_at AS "startedAt",
     run.completed_at AS "completedAt",
     jsonb_build_object('id', batch_a.id, 'sourceSystem', batch_a.source_system) AS "batchA",
     jsonb_build_object('id', batch_b.id, 'sourceSystem', batch_b.source_system) AS "batchB",
     (SELECT count(*)::int FROM reconciliation_results result WHERE result.reconciliation_run_id = run.id) AS "resultCount",
     (SELECT count(*)::int FROM exceptions exception
       JOIN reconciliation_results result ON result.id = exception.reconciliation_result_id
       WHERE result.reconciliation_run_id = run.id) AS "exceptionCount"`,
    'ORDER BY run.started_at DESC, run.id',
  );
}

export async function getReconciliationRun(pool: Pool, runId: string, pagination: Pagination) {
  const runResult = await pool.query(
    `SELECT run.id, run.status, run.rules_version AS "rulesVersion",
            run.started_at AS "startedAt", run.completed_at AS "completedAt",
            jsonb_build_object('id', batch_a.id, 'sourceSystem', batch_a.source_system,
                               'originalFilename', batch_a.original_filename) AS "batchA",
            jsonb_build_object('id', batch_b.id, 'sourceSystem', batch_b.source_system,
                               'originalFilename', batch_b.original_filename) AS "batchB",
            (SELECT count(*)::int FROM reconciliation_results result
             WHERE result.reconciliation_run_id = run.id) AS "resultCount",
            (SELECT count(*)::int FROM exceptions exception
             JOIN reconciliation_results result ON result.id = exception.reconciliation_result_id
             WHERE result.reconciliation_run_id = run.id) AS "exceptionCount"
     FROM reconciliation_runs run
     JOIN import_batches batch_a ON batch_a.id = run.batch_a_id
     JOIN import_batches batch_b ON batch_b.id = run.batch_b_id
     WHERE run.id = $1::uuid`,
    [runId],
  );
  if (runResult.rowCount === 0) return null;

  const resultRows = await pool.query(
    `SELECT result.id, result.outcome, result.details, result.created_at AS "createdAt",
            exception.id AS "exceptionId", exception.status AS "exceptionStatus",
            exception.created_at AS "exceptionCreatedAt"
     FROM reconciliation_results result
     LEFT JOIN exceptions exception ON exception.reconciliation_result_id = result.id
     WHERE result.reconciliation_run_id = $1::uuid
     ORDER BY result.outcome, result.id
     LIMIT $2 OFFSET $3`,
    [runId, pagination.limit, pagination.offset],
  );
  const tradeRows = await pool.query(
    `SELECT link.reconciliation_result_id AS "resultId", link.source_side AS "sourceSide",
            trade.id, trade.row_number AS "rowNumber", trade.source_trade_id AS "sourceTradeId",
            trade.trade_date::text AS "tradeDate", trade.instrument, trade.side,
            trade.currency, trade.quantity::text AS quantity, trade.price::text AS price,
            trade.validation_status AS "validationStatus", trade.validation_errors AS "validationErrors"
     FROM reconciliation_result_trades link
     JOIN imported_trades trade ON trade.id = link.imported_trade_id
     WHERE link.reconciliation_result_id = ANY($1::uuid[])
     ORDER BY link.reconciliation_result_id, link.source_side, trade.row_number, trade.id`,
    [resultRows.rows.map((row) => row.id)],
  );

  const tradesByResult = new Map<string, unknown[]>();
  for (const row of tradeRows.rows) {
    const { resultId, ...trade } = row;
    const normalizedTrade = {
      ...trade,
      validationErrors: validationMessages(trade.validationErrors),
    };
    tradesByResult.set(resultId, [...(tradesByResult.get(resultId) ?? []), normalizedTrade]);
  }
  const results = resultRows.rows.map((row) => {
    const exception = row.exceptionId
      ? {
          id: row.exceptionId,
          status: row.exceptionStatus,
          createdAt: row.exceptionCreatedAt,
        }
      : null;
    return {
      id: row.id,
      outcome: row.outcome,
      details: row.details,
      createdAt: row.createdAt,
      trades: tradesByResult.get(row.id) ?? [],
      exception,
    };
  });

  return { run: runResult.rows[0], results };
}

function validationMessages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (typeof entry === 'string') return [entry];
    if (
      entry &&
      typeof entry === 'object' &&
      'message' in entry &&
      typeof entry.message === 'string'
    ) {
      return [entry.message];
    }
    return [];
  });
}

export async function listExceptions(
  pool: Pool,
  filters: ExceptionFilters,
  pagination: Pagination,
) {
  return listPage(
    pool,
    `FROM exceptions exception
     JOIN reconciliation_results result ON result.id = exception.reconciliation_result_id
     JOIN reconciliation_runs run ON run.id = result.reconciliation_run_id
     JOIN import_batches batch_a ON batch_a.id = run.batch_a_id
     JOIN import_batches batch_b ON batch_b.id = run.batch_b_id`,
    [
      { column: 'exception.status', value: filters.status },
      { column: 'result.outcome', value: filters.outcome },
      { column: 'run.id', value: filters.runId, cast: '::uuid' },
    ],
    pagination,
    `exception.id, exception.status, exception.resolution_reason AS "resolutionReason",
     exception.created_at AS "createdAt", exception.resolved_at AS "resolvedAt",
     result.id AS "resultId", result.outcome, result.details,
     run.id AS "runId", run.started_at AS "runStartedAt",
     jsonb_build_object('id', batch_a.id, 'sourceSystem', batch_a.source_system) AS "batchA",
     jsonb_build_object('id', batch_b.id, 'sourceSystem', batch_b.source_system) AS "batchB"`,
    'ORDER BY exception.created_at DESC, exception.id',
  );
}
