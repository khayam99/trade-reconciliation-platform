import type { Pool } from 'pg';

export interface ImportErrorPagination {
  limit: number;
  offset: number;
}

export interface StoredImportErrorRow {
  rowNumber: number;
  sourceTradeId: string | null;
  validationErrors: unknown[];
  rawRecord: Record<string, string | null>;
}

export async function getImportBatchValidationErrors(
  pool: Pool,
  batchId: string,
  pagination: ImportErrorPagination,
): Promise<{ rows: StoredImportErrorRow[]; total: number } | null> {
  const batch = await pool.query<{ id: string }>(
    'SELECT id FROM import_batches WHERE id = $1::uuid',
    [batchId],
  );
  if (!batch.rows[0]) return null;

  const count = await pool.query<{ total: string }>(
    `SELECT count(*)::text AS total
     FROM imported_trades
     WHERE import_batch_id = $1::uuid AND validation_status = 'invalid'`,
    [batchId],
  );
  const result = await pool.query<StoredImportErrorRow>(
    `SELECT row_number AS "rowNumber", source_trade_id AS "sourceTradeId",
            validation_errors AS "validationErrors", raw_record AS "rawRecord"
     FROM imported_trades
     WHERE import_batch_id = $1::uuid AND validation_status = 'invalid'
     ORDER BY row_number, id
     LIMIT $2 OFFSET $3`,
    [batchId, pagination.limit, pagination.offset],
  );
  return { rows: result.rows, total: Number(count.rows[0]?.total ?? '0') };
}
