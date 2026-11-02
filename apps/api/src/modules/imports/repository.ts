import type { PoolClient } from 'pg';
import type { ImportSourceSystem } from './csv.js';
import type { ValidatedImportTradeRow } from './validation.js';

const INSERT_CHUNK_SIZE = 250;

export interface ImportBatchSummary {
  id: string;
  sourceSystem: ImportSourceSystem;
  originalFilename: string;
  status: 'completed';
  totalRows: number;
  validRows: number;
  invalidRows: number;
  createdAt: Date;
  completedAt: Date;
}

interface InsertedTradeStatus {
  validationStatus: 'valid' | 'invalid';
}

export async function createProcessingBatch(
  client: PoolClient,
  sourceSystem: ImportSourceSystem,
  originalFilename: string,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO import_batches
       (source_system, original_filename, status, total_rows, valid_rows, invalid_rows)
     VALUES ($1, $2, 'processing', 0, 0, 0)
     RETURNING id`,
    [sourceSystem, originalFilename],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('Database did not return the created import batch ID.');
  return id;
}

/** Insert every validated row in bounded, parameterized chunks and count persisted statuses. */
export async function insertImportTradeRows(
  client: PoolClient,
  batchId: string,
  rows: ValidatedImportTradeRow[],
): Promise<{ totalRows: number; validRows: number; invalidRows: number }> {
  let totalRows = 0;
  let validRows = 0;
  let invalidRows = 0;

  for (let start = 0; start < rows.length; start += INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(start, start + INSERT_CHUNK_SIZE);
    const values: unknown[] = [];
    const placeholders = chunk.map((row, index) => {
      const parameter = index * 12;
      values.push(
        batchId,
        row.rowNumber,
        row.sourceTradeId,
        row.tradeDate,
        row.instrument,
        row.side,
        row.currency,
        row.quantity,
        row.price,
        row.validationStatus,
        JSON.stringify(row.issues),
        JSON.stringify(row.rawRecord),
      );
      return `($${parameter + 1}, $${parameter + 2}, $${parameter + 3}, $${parameter + 4},
        $${parameter + 5}, $${parameter + 6}, $${parameter + 7}, $${parameter + 8},
        $${parameter + 9}, $${parameter + 10}, $${parameter + 11}::jsonb, $${parameter + 12}::jsonb)`;
    });

    const inserted = await client.query<InsertedTradeStatus>(
      `INSERT INTO imported_trades
         (import_batch_id, row_number, source_trade_id, trade_date, instrument, side,
          currency, quantity, price, validation_status, validation_errors, raw_record)
       VALUES ${placeholders.join(', ')}
       RETURNING validation_status AS "validationStatus"`,
      values,
    );

    totalRows += inserted.rows.length;
    for (const row of inserted.rows) {
      if (row.validationStatus === 'valid') validRows += 1;
      else if (row.validationStatus === 'invalid') invalidRows += 1;
      else throw new Error('Database returned an unknown imported trade validation status.');
    }

    if (inserted.rows.length !== chunk.length) {
      throw new Error('Database did not persist every row in the import chunk.');
    }
  }

  return { totalRows, validRows, invalidRows };
}

export async function completeImportBatch(
  client: PoolClient,
  batchId: string,
  counts: { totalRows: number; validRows: number; invalidRows: number },
): Promise<ImportBatchSummary> {
  const result = await client.query<ImportBatchSummary>(
    `UPDATE import_batches
     SET total_rows = $2,
         valid_rows = $3,
         invalid_rows = $4,
         status = 'completed',
         completed_at = now()
     WHERE id = $1 AND status = 'processing'
     RETURNING id, source_system AS "sourceSystem", original_filename AS "originalFilename",
               status, total_rows AS "totalRows", valid_rows AS "validRows",
               invalid_rows AS "invalidRows", created_at AS "createdAt",
               completed_at AS "completedAt"`,
    [batchId, counts.totalRows, counts.validRows, counts.invalidRows],
  );
  const batch = result.rows[0];
  if (!batch) throw new Error('Import batch could not be marked completed.');
  return batch;
}
