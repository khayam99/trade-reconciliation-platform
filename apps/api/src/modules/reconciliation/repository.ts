import type { PoolClient } from 'pg';
import type { ImportedTrade, TradeDirection, TradeInput, TradeSide } from './domain.js';

export interface BatchRow {
  id: string;
  source_system: 'ALPHA' | 'BRAVO';
  status: string;
  valid_rows: number;
}

interface ImportedTradeRow {
  id: string;
  import_batch_id: string;
  source_trade_id: string | null;
  trade_date: string | null;
  instrument: string | null;
  side: string | null;
  currency: string | null;
  quantity: string | null;
  price: string | null;
  validation_status: 'valid' | 'invalid';
  validation_errors: unknown[];
}

/** Lock selected batch rows in a stable order; the caller owns the transaction. */
export async function lockImportBatches(
  client: PoolClient,
  batchIds: string[],
): Promise<BatchRow[]> {
  const locked = await client.query<BatchRow>(
    `SELECT id, source_system, status, valid_rows
     FROM import_batches
     WHERE id = ANY($1::uuid[])
     ORDER BY id
     FOR UPDATE`,
    [batchIds],
  );
  return locked.rows;
}

/** Load exact source records once the service has checked the locked batches. */
export async function loadBatchTradeInputs(
  client: PoolClient,
  batchAId: string,
  batchBId: string,
): Promise<TradeInput[]> {
  const tradeRows = await client.query<ImportedTradeRow>(
    `SELECT id, import_batch_id, source_trade_id, trade_date::text AS trade_date,
            instrument, side, currency, quantity::text AS quantity, price::text AS price,
            validation_status, validation_errors
     FROM imported_trades
     WHERE import_batch_id = ANY($1::uuid[])
     ORDER BY import_batch_id, row_number, id`,
    [[batchAId, batchBId]],
  );

  const tradesA: ImportedTrade[] = [];
  const tradesB: ImportedTrade[] = [];
  for (const row of tradeRows.rows) {
    const target = row.import_batch_id === batchAId ? tradesA : tradesB;
    if (row.validation_status === 'invalid') {
      target.push({
        id: row.id,
        sourceTradeId: row.source_trade_id,
        validationStatus: 'invalid',
        validationErrors: validationMessages(row.validation_errors),
      });
      continue;
    }

    if (
      row.trade_date === null ||
      row.instrument === null ||
      (row.side !== 'BUY' && row.side !== 'SELL') ||
      row.currency === null ||
      row.quantity === null ||
      row.price === null
    ) {
      throw new Error(`Valid imported trade ${row.id} is missing a required field.`);
    }

    target.push({
      id: row.id,
      sourceTradeId: row.source_trade_id,
      validationStatus: 'valid',
      tradeDate: row.trade_date,
      instrument: row.instrument,
      side: row.side as TradeDirection,
      currency: row.currency,
      // PostgreSQL NUMERIC values remain decimal strings all the way to domain logic.
      quantity: row.quantity,
      price: row.price,
    });
  }

  const sourceSideA: TradeSide = 'A';
  const sourceSideB: TradeSide = 'B';
  return [
    { sourceSide: sourceSideA, trades: tradesA },
    { sourceSide: sourceSideB, trades: tradesB },
  ];
}

function validationMessages(errors: unknown[]): string[] {
  return errors.flatMap((error) => {
    if (typeof error === 'string') return [error];
    if (
      error &&
      typeof error === 'object' &&
      'message' in error &&
      typeof error.message === 'string'
    ) {
      return [error.message];
    }
    return [];
  });
}
