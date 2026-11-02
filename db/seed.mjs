import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

const batches = [
  {
    id: '10000000-0000-4000-8000-000000000001',
    source: 'ALPHA',
    filename: 'alpha-trades-sample.csv',
    rows: 3,
  },
  {
    id: '10000000-0000-4000-8000-000000000002',
    source: 'BRAVO',
    filename: 'bravo-trades-sample.csv',
    rows: 3,
  },
];

const trades = [
  {
    id: '20000000-0000-4000-8000-000000000001',
    batchId: batches[0].id,
    row: 2,
    sourceTradeId: 'ALPHA-1001',
    date: '2026-10-01',
    instrument: 'ACME',
    side: 'BUY',
    currency: 'USD',
    quantity: '100.0000000000',
    price: '24.5000000000',
  },
  {
    id: '20000000-0000-4000-8000-000000000002',
    batchId: batches[0].id,
    row: 3,
    sourceTradeId: 'ALPHA-1002',
    date: '2026-10-02',
    instrument: 'NORTH',
    side: 'BUY',
    currency: 'CAD',
    quantity: '20.0000000000',
    price: '51.1250000000',
  },
  {
    id: '20000000-0000-4000-8000-000000000003',
    batchId: batches[0].id,
    row: 4,
    sourceTradeId: 'ALPHA-1002',
    date: '2026-10-02',
    instrument: 'NORTH',
    side: 'BUY',
    currency: 'CAD',
    quantity: '20.0000000000',
    price: '51.1250000000',
  },
  {
    id: '20000000-0000-4000-8000-000000000004',
    batchId: batches[1].id,
    row: 2,
    sourceTradeId: 'BRAVO-8101',
    date: '2026-10-01',
    instrument: 'ACME',
    side: 'BUY',
    currency: 'USD',
    quantity: '100.0000000000',
    price: '24.5000000000',
  },
  {
    id: '20000000-0000-4000-8000-000000000005',
    batchId: batches[1].id,
    row: 3,
    sourceTradeId: 'BRAVO-8102',
    date: '2026-10-02',
    instrument: 'NORTH',
    side: 'BUY',
    currency: 'CAD',
    quantity: '20.0000000000',
    price: '51.1250000000',
  },
  {
    id: '20000000-0000-4000-8000-000000000006',
    batchId: batches[1].id,
    row: 4,
    sourceTradeId: 'BRAVO-8103',
    date: '2026-10-03',
    instrument: 'WILLOW',
    side: 'SELL',
    currency: 'USD',
    quantity: '15.0000000000',
    price: '8.7500000000',
  },
];

export async function seedSyntheticData(pool) {
  const client = await pool.connect();
  let batchesInserted = 0;
  let tradesInserted = 0;

  try {
    await client.query('BEGIN');

    for (const batch of batches) {
      const result = await client.query(
        `INSERT INTO import_batches
        (id, source_system, original_filename, status, total_rows, valid_rows, invalid_rows, created_at, completed_at)
       VALUES ($1, $2, $3, 'completed', $4, $4, 0, '2026-10-05T09:00:00Z', '2026-10-05T09:00:02Z')
       ON CONFLICT (id) DO NOTHING`,
        [batch.id, batch.source, batch.filename, batch.rows],
      );
      batchesInserted += result.rowCount ?? 0;
    }

    for (const trade of trades) {
      const rawRecord = {
        sourceTradeId: trade.sourceTradeId,
        tradeDate: trade.date,
        instrument: trade.instrument,
        side: trade.side,
        currency: trade.currency,
        quantity: trade.quantity,
        price: trade.price,
      };

      const result = await client.query(
        `INSERT INTO imported_trades
        (id, import_batch_id, row_number, source_trade_id, trade_date, instrument, side,
         currency, quantity, price, validation_status, validation_errors, raw_record, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'valid', '[]'::jsonb, $11::jsonb,
         '2026-10-05T09:00:01Z')
       ON CONFLICT (id) DO NOTHING`,
        [
          trade.id,
          trade.batchId,
          trade.row,
          trade.sourceTradeId,
          trade.date,
          trade.instrument,
          trade.side,
          trade.currency,
          trade.quantity,
          trade.price,
          JSON.stringify(rawRecord),
        ],
      );
      tradesInserted += result.rowCount ?? 0;
    }

    await client.query('COMMIT');
    return { batchesInserted, tradesInserted };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Seed failed and its rollback also failed.');
    }

    throw error;
  } finally {
    client.release();
  }
}

function createSeedPool() {
  const port = Number(process.env.PGPORT ?? '5432');

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PGPORT must be an integer between 1 and 65535.');
  }

  for (const name of ['PGDATABASE', 'PGUSER', 'PGPASSWORD']) {
    if (!process.env[name]?.trim()) {
      throw new Error(
        `Missing ${name}. Copy .env.example to .env and set the local PostgreSQL connection.`,
      );
    }
  }

  return new Pool({
    host: process.env.PGHOST?.trim() || '127.0.0.1',
    port,
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    application_name: 'ledgerline-seed',
    connectionTimeoutMillis: 5_000,
  });
}

async function main() {
  const pool = createSeedPool();

  try {
    const { batchesInserted, tradesInserted } = await seedSyntheticData(pool);
    console.info(
      `Seed complete: inserted ${batchesInserted}/${batches.length} batches and ${tradesInserted}/${trades.length} trade rows; existing IDs were left unchanged.`,
    );
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
