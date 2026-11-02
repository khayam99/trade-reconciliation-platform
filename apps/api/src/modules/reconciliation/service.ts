import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { reconcileTrades } from './domain.js';
import {
  batchNotCompletedError,
  batchHasNoValidTradesError,
  invalidBatchPairError,
  notFoundError,
  validationError,
} from './errors.js';
import { loadBatchTradeInputs, lockImportBatches } from './repository.js';

const RULES_VERSION = 'candidate-key-v1';
const AUDIT_ACTOR = 'reconciliation-engine';
const INSERT_CHUNK_SIZE = 250;

export interface ReconciliationRunSummary {
  runId: string;
  resultCount: number;
  exceptionCount: number;
}

/** Reconcile and persist all related records as one atomic PostgreSQL transaction. */
export async function runReconciliation(
  pool: Pool,
  batchAId: string,
  batchBId: string,
): Promise<ReconciliationRunSummary> {
  if (!isUuid(batchAId) || !isUuid(batchBId)) {
    throw validationError('batchAId and batchBId must be valid UUIDs.');
  }
  if (batchAId.toLowerCase() === batchBId.toLowerCase()) {
    throw invalidBatchPairError();
  }

  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query('BEGIN');
    transactionOpen = true;

    const batches = await lockImportBatches(client, [batchAId, batchBId]);
    if (batches.length !== 2) throw notFoundError('Import batch');
    const batchById = new Map(batches.map((batch) => [batch.id.toLowerCase(), batch]));
    const batchA = batchById.get(batchAId.toLowerCase());
    const batchB = batchById.get(batchBId.toLowerCase());
    if (!batchA || !batchB) throw notFoundError('Import batch');
    if (batchA.source_system !== 'ALPHA' || batchB.source_system !== 'BRAVO') {
      throw invalidBatchPairError();
    }
    if (batchA.status !== 'completed' || batchB.status !== 'completed') {
      throw batchNotCompletedError();
    }
    if (batchA.valid_rows === 0 || batchB.valid_rows === 0) {
      throw batchHasNoValidTradesError();
    }

    const trades = await loadBatchTradeInputs(client, batchAId, batchBId);
    const results = reconcileTrades(trades);
    const runId = randomUUID();
    await client.query(
      `INSERT INTO reconciliation_runs
         (id, batch_a_id, batch_b_id, status, rules_version)
       VALUES ($1, $2, $3, 'processing', $4)`,
      [runId, batchAId, batchBId, RULES_VERSION],
    );

    const resultRows: unknown[][] = [];
    const tradeLinkRows: unknown[][] = [];
    const exceptionRows: unknown[][] = [];
    const auditRows: unknown[][] = [];

    for (const result of results) {
      const resultId = randomUUID();
      resultRows.push([resultId, runId, result.outcome, JSON.stringify(result.details)]);

      for (const tradeId of result.tradeIdsA) {
        tradeLinkRows.push([resultId, runId, tradeId, 'A']);
      }
      for (const tradeId of result.tradeIdsB) {
        tradeLinkRows.push([resultId, runId, tradeId, 'B']);
      }

      if (result.outcome !== 'exact_match') {
        const exceptionId = randomUUID();
        exceptionRows.push([exceptionId, resultId, 'open']);
        auditRows.push([
          exceptionId,
          'exception_created',
          AUDIT_ACTOR,
          JSON.stringify({ runId, resultId, outcome: result.outcome }),
        ]);
      }
    }

    await insertRowsInChunks(
      client,
      'reconciliation_results',
      ['id', 'reconciliation_run_id', 'outcome', 'details'],
      resultRows,
      new Set([3]),
    );
    await insertRowsInChunks(
      client,
      'reconciliation_result_trades',
      ['reconciliation_result_id', 'reconciliation_run_id', 'imported_trade_id', 'source_side'],
      tradeLinkRows,
    );
    await insertRowsInChunks(
      client,
      'exceptions',
      ['id', 'reconciliation_result_id', 'status'],
      exceptionRows,
    );
    await insertRowsInChunks(
      client,
      'audit_events',
      ['exception_id', 'event_type', 'actor', 'details'],
      auditRows,
      new Set([3]),
    );

    // A completed status is visible only after every result, link, exception,
    // and audit event has been written successfully in this transaction.
    await client.query(
      `UPDATE reconciliation_runs
       SET status = 'completed', completed_at = now()
       WHERE id = $1`,
      [runId],
    );
    await client.query('COMMIT');
    transactionOpen = false;

    return { runId, resultCount: results.length, exceptionCount: exceptionRows.length };
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Reconciliation failed and transaction rollback also failed.',
        );
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function insertRowsInChunks(
  client: PoolClient,
  table: string,
  columns: string[],
  rows: unknown[][],
  jsonColumnIndexes: ReadonlySet<number> = new Set(),
): Promise<void> {
  for (let start = 0; start < rows.length; start += INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(start, start + INSERT_CHUNK_SIZE);
    const values: unknown[] = [];
    const valueGroups = chunk.map((row) => {
      if (row.length !== columns.length) throw new Error(`Invalid ${table} insert row.`);
      const placeholders = row.map((value, columnIndex) => {
        values.push(value);
        const placeholder = `$${values.length}`;
        return jsonColumnIndexes.has(columnIndex) ? `${placeholder}::jsonb` : placeholder;
      });
      return `(${placeholders.join(', ')})`;
    });

    await client.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${valueGroups.join(', ')}`,
      values,
    );
  }
}
