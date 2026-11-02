import type { Pool } from 'pg';
import { parseTradeCsv, type ImportSourceSystem } from './csv.js';
import { completeImportBatch, createProcessingBatch, insertImportTradeRows } from './repository.js';
import { validateTradeCsv } from './validation.js';

export interface ImportTradeCsvInput {
  sourceSystem: ImportSourceSystem;
  originalFilename: string;
  content: string | Uint8Array;
}

/** Parse, validate, and persist one CSV import atomically. */
export async function importTradeCsv(pool: Pool, input: ImportTradeCsvInput) {
  if (!input.originalFilename.trim()) {
    throw new Error('Original filename must not be empty.');
  }

  // Parse and validate before opening a transaction; malformed files write nothing.
  const validated = validateTradeCsv(parseTradeCsv(input.content, input.sourceSystem));
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query('BEGIN');
    transactionOpen = true;

    const batchId = await createProcessingBatch(client, input.sourceSystem, input.originalFilename);
    const counts = await insertImportTradeRows(client, batchId, validated.rows);
    if (counts.totalRows !== validated.totalRows) {
      throw new Error('Persisted import row count does not match the parsed CSV.');
    }
    const batch = await completeImportBatch(client, batchId, counts);

    await client.query('COMMIT');
    transactionOpen = false;
    return {
      batch,
      invalidRows: validated.rows.flatMap((row) =>
        row.validationStatus === 'invalid'
          ? [
              {
                rowNumber: row.rowNumber,
                sourceTradeId: row.sourceTradeId,
                errors: row.validationErrors,
              },
            ]
          : [],
      ),
    };
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Import failed and transaction rollback also failed.',
        );
      }
    }
    throw error;
  } finally {
    client.release();
  }
}
