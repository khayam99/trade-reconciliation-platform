import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { Client, Pool } from 'pg';
import { runner } from 'node-pg-migrate';
import { seedSyntheticData } from '../../db/seed.mjs';
import { createApp } from '../../apps/api/src/app.ts';
import { runReconciliation } from '../../apps/api/src/modules/reconciliation/service.ts';
import { importTradeCsv } from '../../apps/api/src/modules/imports/service.ts';

const databaseConfig = {
  host: process.env.PGHOST?.trim() || '127.0.0.1',
  port: Number(process.env.PGPORT ?? '5432'),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  application_name: 'ledgerline-db-tests',
  connectionTimeoutMillis: 5_000,
};

for (const variableName of ['PGDATABASE', 'PGUSER', 'PGPASSWORD']) {
  if (!process.env[variableName]?.trim()) {
    throw new Error(`Set ${variableName} in the root .env file before running database tests.`);
  }
}

if (
  !Number.isInteger(databaseConfig.port) ||
  databaseConfig.port < 1 ||
  databaseConfig.port > 65_535
) {
  throw new Error('PGPORT must be an integer between 1 and 65535.');
}

const schemaName = `ledgerline_test_${randomUUID().replaceAll('-', '')}`;
const schemaIdentifier = `"${schemaName}"`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let pool;
let apiServer;
let apiBaseUrl;
let httpRunId;

function migrationOptions() {
  return {
    databaseUrl: databaseConfig,
    dir: 'db/migrations',
    migrationsTable: 'pgmigrations',
    schema: schemaName,
    migrationsSchema: schemaName,
    singleTransaction: true,
    verbose: false,
  };
}

async function createCompletedBatch(source, trades) {
  const batchId = randomUUID();
  const validRows = trades.filter((trade) => trade.validationStatus !== 'invalid').length;
  const invalidRows = trades.length - validRows;
  await pool.query(
    `INSERT INTO import_batches
       (id, source_system, original_filename, status, total_rows, valid_rows, invalid_rows, completed_at)
     VALUES ($1, $2, $3, 'completed', $4, $5, $6, now())`,
    [
      batchId,
      source,
      `${source.toLowerCase()}-integration.csv`,
      trades.length,
      validRows,
      invalidRows,
    ],
  );

  for (const [index, trade] of trades.entries()) {
    const isInvalid = trade.validationStatus === 'invalid';
    await pool.query(
      `INSERT INTO imported_trades
         (import_batch_id, row_number, source_trade_id, trade_date, instrument, side,
          currency, quantity, price, validation_status, validation_errors, raw_record)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, '{}'::jsonb)`,
      [
        batchId,
        index + 1,
        trade.sourceTradeId ?? `${source}-${index + 1}`,
        isInvalid ? null : (trade.tradeDate ?? '2026-10-15'),
        isInvalid ? null : (trade.instrument ?? 'TESTCO'),
        isInvalid ? null : (trade.side ?? 'BUY'),
        isInvalid ? null : (trade.currency ?? 'USD'),
        isInvalid ? null : (trade.quantity ?? '2.0000000000'),
        isInvalid ? null : (trade.price ?? '3.1250000000'),
        isInvalid ? 'invalid' : 'valid',
        JSON.stringify(isInvalid ? (trade.validationErrors ?? ['synthetic invalid row']) : []),
      ],
    );
  }
  return batchId;
}

async function countsForBatches(batchAId, batchBId) {
  const result = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM reconciliation_runs WHERE batch_a_id = $1 AND batch_b_id = $2) AS runs,
       (SELECT count(*)::int FROM reconciliation_results r
          JOIN reconciliation_runs run ON run.id = r.reconciliation_run_id
          WHERE run.batch_a_id = $1 AND run.batch_b_id = $2) AS results,
       (SELECT count(*)::int FROM reconciliation_result_trades link
          JOIN reconciliation_runs run ON run.id = link.reconciliation_run_id
          WHERE run.batch_a_id = $1 AND run.batch_b_id = $2) AS links,
       (SELECT count(*)::int FROM exceptions e
          JOIN reconciliation_results r ON r.id = e.reconciliation_result_id
          JOIN reconciliation_runs run ON run.id = r.reconciliation_run_id
          WHERE run.batch_a_id = $1 AND run.batch_b_id = $2) AS exceptions,
       (SELECT count(*)::int FROM audit_events event
          JOIN exceptions e ON e.id = event.exception_id
          JOIN reconciliation_results r ON r.id = e.reconciliation_result_id
          JOIN reconciliation_runs run ON run.id = r.reconciliation_run_id
          WHERE run.batch_a_id = $1 AND run.batch_b_id = $2) AS audit_events`,
    [batchAId, batchBId],
  );
  return result.rows[0];
}

async function importCounts() {
  const result = await pool.query(
    `SELECT (SELECT count(*)::int FROM import_batches) AS batches,
            (SELECT count(*)::int FROM imported_trades) AS trades`,
  );
  return result.rows[0];
}

async function createExceptionFixture(status = 'open', includeCreationAudit = true) {
  const batchAId = await createCompletedBatch('ALPHA', []);
  const batchBId = await createCompletedBatch('BRAVO', []);
  const runId = randomUUID();
  const resultId = randomUUID();
  const exceptionId = randomUUID();
  await pool.query(
    `INSERT INTO reconciliation_runs
       (id, batch_a_id, batch_b_id, status, rules_version, completed_at)
     VALUES ($1, $2, $3, 'completed', 'exception-resolution-test', now())`,
    [runId, batchAId, batchBId],
  );
  await pool.query(
    `INSERT INTO reconciliation_results (id, reconciliation_run_id, outcome)
     VALUES ($1, $2, 'field_mismatch')`,
    [resultId, runId],
  );
  await pool.query(
    `INSERT INTO exceptions (id, reconciliation_result_id, status, resolution_reason, resolved_at)
     VALUES ($1, $2, $3, CASE WHEN $3 = 'resolved' THEN 'Earlier resolution' ELSE NULL END,
             CASE WHEN $3 = 'resolved' THEN now() ELSE NULL END)`,
    [exceptionId, resultId, status],
  );
  if (includeCreationAudit) {
    await pool.query(
      `INSERT INTO audit_events (exception_id, event_type, actor, reason, details)
       VALUES ($1, 'exception_created', 'reconciliation-engine', NULL, '{}'::jsonb)`,
      [exceptionId],
    );
  }
  if (status === 'resolved') {
    await pool.query(
      `INSERT INTO audit_events (exception_id, event_type, actor, reason, details)
       VALUES ($1, 'exception_resolved', 'anonymous-operator', 'Earlier resolution',
               '{"previousStatus":"open","newStatus":"resolved"}'::jsonb)`,
      [exceptionId],
    );
  }
  return exceptionId;
}

function postExceptionAction(exceptionId, action, body) {
  return fetch(`${apiBaseUrl}/api/exceptions/${exceptionId}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function csvForm(source, content, filename = 'upload.csv', mimeType = 'text/csv') {
  const form = new FormData();
  if (source !== undefined) form.append('source', source);
  if (content !== undefined) form.append('file', new Blob([content], { type: mimeType }), filename);
  return form;
}

describe('PostgreSQL schema integration', { concurrency: false }, () => {
  before(async () => {
    const admin = new Client(databaseConfig);
    await admin.connect();

    try {
      await admin.query(`CREATE SCHEMA ${schemaIdentifier}`);
    } finally {
      await admin.end();
    }

    await runner({ ...migrationOptions(), direction: 'up' });
    pool = new Pool({ ...databaseConfig, options: `-c search_path=${schemaName}` });
    apiServer = createApp(pool).listen(0, '127.0.0.1');
    await new Promise((resolve) => apiServer.once('listening', resolve));
    apiBaseUrl = `http://127.0.0.1:${apiServer.address().port}`;
  });

  after(async () => {
    if (apiServer) {
      await new Promise((resolve, reject) =>
        apiServer.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await pool?.end();

    const admin = new Client(databaseConfig);
    await admin.connect();

    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaIdentifier} CASCADE`);
    } finally {
      await admin.end();
    }
  });

  it('seeds repeatably without adding duplicate rows or updating existing records', async () => {
    const first = await seedSyntheticData(pool);
    assert.deepEqual(first, { batchesInserted: 2, tradesInserted: 6 });

    const beforeRepeat = await pool.query(
      `SELECT md5(coalesce(string_agg(to_jsonb(t)::text, chr(10) ORDER BY id), '')) AS fingerprint
       FROM imported_trades t`,
    );
    const second = await seedSyntheticData(pool);
    const afterRepeat = await pool.query(
      `SELECT md5(coalesce(string_agg(to_jsonb(t)::text, chr(10) ORDER BY id), '')) AS fingerprint
       FROM imported_trades t`,
    );
    const counts = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM import_batches) AS batches,
         (SELECT count(*)::int FROM imported_trades) AS trades`,
    );

    assert.deepEqual(second, { batchesInserted: 0, tradesInserted: 0 });
    assert.deepEqual(afterRepeat.rows[0], beforeRepeat.rows[0]);
    assert.deepEqual(counts.rows[0], { batches: 2, trades: 6 });
  });

  it('preserves duplicate source trade references as separate imported rows', async () => {
    const duplicates = await pool.query(
      `SELECT count(*)::int AS occurrences
       FROM imported_trades
       WHERE import_batch_id = $1 AND source_trade_id = $2`,
      ['10000000-0000-4000-8000-000000000001', 'ALPHA-1002'],
    );

    assert.equal(duplicates.rows[0].occurrences, 2);
  });

  it('stores numeric values as exact decimal strings', async () => {
    const result = await pool.query(
      `SELECT quantity, price
       FROM imported_trades
       WHERE import_batch_id = $1 AND source_trade_id = $2
       ORDER BY row_number
       LIMIT 1`,
      ['10000000-0000-4000-8000-000000000001', 'ALPHA-1002'],
    );

    assert.deepEqual(result.rows[0], {
      quantity: '20.0000000000',
      price: '51.1250000000',
    });
    assert.equal(typeof result.rows[0].quantity, 'string');
    assert.equal(typeof result.rows[0].price, 'string');
  });

  it('rejects completed batches whose row counts do not add up', async () => {
    await assert.rejects(
      pool.query(
        `INSERT INTO import_batches
          (id, source_system, original_filename, status, total_rows, valid_rows, invalid_rows, completed_at)
         VALUES ($1, 'ALPHA', 'bad-counts.csv', 'completed', 2, 1, 0, now())`,
        [randomUUID()],
      ),
      (error) =>
        error.code === '23514' && error.constraint === 'import_batches_completed_row_counts_check',
    );

    await assert.rejects(
      pool.query(
        `INSERT INTO imported_trades (import_batch_id, row_number, validation_status, raw_record)
         VALUES ($1, 1, 'invalid', '{}'::jsonb)`,
        [randomUUID()],
      ),
      (error) => error.code === '23503',
    );
  });

  it('indexes both batch foreign keys on reconciliation runs', async () => {
    const result = await pool.query(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = $1
         AND indexname IN ('reconciliation_runs_batch_a_idx', 'reconciliation_runs_batch_b_idx')
       ORDER BY indexname`,
      [schemaName],
    );

    assert.deepEqual(
      result.rows.map((row) => row.indexname),
      ['reconciliation_runs_batch_a_idx', 'reconciliation_runs_batch_b_idx'],
    );
  });

  it('persists a complete run, duplicate group, links, exceptions, and audit events', async () => {
    const summary = await runReconciliation(
      pool,
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
    );
    assert.deepEqual(summary, { runId: summary.runId, resultCount: 3, exceptionCount: 2 });

    const outcomes = await pool.query(
      `SELECT outcome, count(*)::int AS count
       FROM reconciliation_results WHERE reconciliation_run_id = $1
       GROUP BY outcome ORDER BY outcome`,
      [summary.runId],
    );
    assert.deepEqual(outcomes.rows, [
      { outcome: 'duplicate', count: 1 },
      { outcome: 'exact_match', count: 1 },
      { outcome: 'missing_in_a', count: 1 },
    ]);

    const run = await pool.query(
      'SELECT status, completed_at FROM reconciliation_runs WHERE id = $1',
      [summary.runId],
    );
    assert.equal(run.rows[0].status, 'completed');
    assert.ok(run.rows[0].completed_at);

    const links = await pool.query(
      `SELECT imported_trade_id, count(*)::int AS count
       FROM reconciliation_result_trades WHERE reconciliation_run_id = $1
       GROUP BY imported_trade_id ORDER BY imported_trade_id`,
      [summary.runId],
    );
    assert.equal(links.rows.length, 6);
    assert.ok(links.rows.every((row) => row.count === 1));

    const tradeId = links.rows[0].imported_trade_id;
    const conflictingResultId = randomUUID();
    await pool.query(
      `INSERT INTO reconciliation_results (id, reconciliation_run_id, outcome)
       VALUES ($1, $2, 'duplicate')`,
      [conflictingResultId, summary.runId],
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO reconciliation_result_trades
           (reconciliation_result_id, reconciliation_run_id, imported_trade_id, source_side)
         VALUES ($1, $2, $3, 'A')`,
        [conflictingResultId, summary.runId, tradeId],
      ),
      (error) => error.code === '23505',
    );
    await pool.query('DELETE FROM reconciliation_results WHERE id = $1', [conflictingResultId]);

    const auditCount = await pool.query(
      `SELECT count(*)::int AS count
       FROM audit_events event
       JOIN exceptions exception ON exception.id = event.exception_id
       JOIN reconciliation_results result ON result.id = exception.reconciliation_result_id
       WHERE result.reconciliation_run_id = $1`,
      [summary.runId],
    );
    assert.equal(auditCount.rows[0].count, 2);
  });

  it('bulk persists large runs in bounded statements with every trade linked once', async () => {
    const count = 260;
    const makeTrades = (source) =>
      Array.from({ length: count }, (_, index) => ({
        sourceTradeId: `${source}-${index}`,
        instrument: `INSTRUMENT-${index}`,
      }));
    const batchAId = await createCompletedBatch('ALPHA', makeTrades('A'));
    const batchBId = await createCompletedBatch('BRAVO', makeTrades('B'));
    const inserts = [];
    const instrumentedPool = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (sql, values) => {
            if (typeof sql === 'string' && sql.startsWith('INSERT INTO')) {
              inserts.push({ sql, parameterCount: values?.length ?? 0 });
            }
            return client.query(sql, values);
          },
          release: () => client.release(),
        };
      },
    };

    const summary = await runReconciliation(instrumentedPool, batchAId, batchBId);
    assert.deepEqual(
      { resultCount: summary.resultCount, exceptionCount: summary.exceptionCount },
      { resultCount: count, exceptionCount: 0 },
    );
    assert.equal(inserts.length, 6);
    assert.ok(inserts.every(({ parameterCount }) => parameterCount <= 1_000));
    assert.deepEqual(
      inserts.map(({ sql }) => {
        if (sql.includes('INSERT INTO reconciliation_runs')) return 'run';
        if (sql.includes('INSERT INTO reconciliation_results')) return 'results';
        if (sql.includes('INSERT INTO reconciliation_result_trades')) return 'links';
        return 'unexpected';
      }),
      ['run', 'results', 'results', 'links', 'links', 'links'],
    );

    const persisted = await pool.query(
      `SELECT count(DISTINCT result.id)::int AS results,
              count(link.imported_trade_id)::int AS links,
              count(DISTINCT link.imported_trade_id)::int AS distinct_trades
       FROM reconciliation_results result
       LEFT JOIN reconciliation_result_trades link
         ON link.reconciliation_result_id = result.id
       WHERE result.reconciliation_run_id = $1`,
      [summary.runId],
    );
    assert.deepEqual(persisted.rows[0], {
      results: count,
      links: count * 2,
      distinct_trades: count * 2,
    });
  });

  it('rejects incomplete or wrongly sourced batches without creating a run', async () => {
    const processingId = randomUUID();
    const bravoId = await createCompletedBatch('BRAVO', []);
    await pool.query(
      `INSERT INTO import_batches (id, source_system, original_filename, status)
       VALUES ($1, 'ALPHA', 'processing.csv', 'processing')`,
      [processingId],
    );
    await assert.rejects(runReconciliation(pool, processingId, bravoId), /must be completed/);

    const completedAlphaId = await createCompletedBatch('ALPHA', []);
    await assert.rejects(
      runReconciliation(pool, bravoId, completedAlphaId),
      /Batch A must be ALPHA and batch B must be BRAVO/,
    );
    assert.equal((await countsForBatches(processingId, bravoId)).runs, 0);
  });

  it('persists invalid rows as invalid results without matching them as missing trades', async () => {
    const batchAId = await createCompletedBatch('ALPHA', [
      { validationStatus: 'invalid', validationErrors: ['invalid price'] },
      { instrument: 'OTHER', price: '9.0000000000' },
    ]);
    const batchBId = await createCompletedBatch('BRAVO', [
      { instrument: 'OTHER', price: '9.0000000000' },
    ]);
    const summary = await runReconciliation(pool, batchAId, batchBId);
    const results = await pool.query(
      `SELECT outcome, details
       FROM reconciliation_results WHERE reconciliation_run_id = $1 ORDER BY outcome`,
      [summary.runId],
    );

    assert.deepEqual(
      results.rows.map((row) => row.outcome),
      ['exact_match', 'invalid'],
    );
    const invalid = results.rows.find((row) => row.outcome === 'invalid');
    assert.deepEqual(invalid.details, { validationErrors: ['invalid price'] });
    assert.equal(summary.exceptionCount, 1);
    assert.equal((await countsForBatches(batchAId, batchBId)).audit_events, 1);
  });

  it('imports ALPHA and BRAVO rows with exact decimals and original raw values', async () => {
    const alpha = await importTradeCsv(pool, {
      sourceSystem: 'ALPHA',
      originalFilename: 'alpha-upload.csv',
      content:
        'trade_id,trade_date,instrument,side,currency,quantity,price\r\n A-1 ,2026-10-01, ACME ,BUY,usd,0001.2300000000,0.0000000001\r\n',
    });
    const bravo = await importTradeCsv(pool, {
      sourceSystem: 'BRAVO',
      originalFilename: 'bravo-upload.csv',
      content:
        'execution_id,trade_date,symbol,direction,currency,units,unit_price\nB-1,2026-10-01,ACME,BUY,USD,1.2300000000,0.0000000001\n',
    });

    assert.equal(alpha.batch.sourceSystem, 'ALPHA');
    assert.equal(bravo.batch.sourceSystem, 'BRAVO');
    assert.deepEqual(
      [alpha.batch.status, alpha.batch.totalRows, alpha.batch.validRows, alpha.batch.invalidRows],
      ['completed', 1, 1, 0],
    );
    assert.deepEqual(alpha.invalidRows, []);

    const stored = await pool.query(
      `SELECT source_trade_id, quantity, price, raw_record
       FROM imported_trades WHERE import_batch_id = $1`,
      [alpha.batch.id],
    );
    assert.deepEqual(stored.rows[0], {
      source_trade_id: 'A-1',
      quantity: '1.2300000000',
      price: '0.0000000001',
      raw_record: {
        trade_id: ' A-1 ',
        trade_date: '2026-10-01',
        instrument: ' ACME ',
        side: 'BUY',
        currency: 'usd',
        quantity: '0001.2300000000',
        price: '0.0000000001',
      },
    });

    const run = await runReconciliation(pool, alpha.batch.id, bravo.batch.id);
    assert.equal(run.resultCount, 1);
    assert.equal(run.exceptionCount, 0);
  });

  it('persists mixed valid and invalid rows and preserves duplicate source IDs', async () => {
    const result = await importTradeCsv(pool, {
      sourceSystem: 'ALPHA',
      originalFilename: 'mixed.csv',
      content: [
        'trade_id,trade_date,instrument,side,currency,quantity,price,desk',
        'DUP-1,2026-10-01,ACME,BUY,USD,2.0000000000,3.1250000000,  raw  ',
        'DUP-1,2026-02-30,ACME,BUY,USD,0,3.1250000000,broken-date-and-quantity',
        'DUP-1,2026-10-01,ACME,BUY,USD,2.0000000000,3.1250000000,  raw  ',
      ].join('\n'),
    });

    assert.deepEqual(
      [result.batch.totalRows, result.batch.validRows, result.batch.invalidRows],
      [3, 2, 1],
    );
    assert.equal(result.invalidRows.length, 1);
    assert.deepEqual(result.invalidRows[0].errors, [
      'Trade date must be a valid ISO calendar date (YYYY-MM-DD).',
      'Quantity must be greater than zero.',
    ]);
    const rows = await pool.query(
      `SELECT source_trade_id, validation_status, validation_errors, raw_record
       FROM imported_trades WHERE import_batch_id = $1 ORDER BY row_number`,
      [result.batch.id],
    );
    assert.equal(rows.rows.length, 3);
    assert.ok(rows.rows.every((row) => row.source_trade_id === 'DUP-1'));
    assert.equal(rows.rows[0].raw_record.desk, '  raw  ');
    assert.equal(rows.rows[1].validation_status, 'invalid');
    assert.deepEqual(
      rows.rows[1].validation_errors.map((issue) => issue.message),
      result.invalidRows[0].errors,
    );
  });

  it('stores an all-invalid batch as completed but refuses reconciliation eligibility', async () => {
    const alpha = await importTradeCsv(pool, {
      sourceSystem: 'ALPHA',
      originalFilename: 'all-invalid.csv',
      content:
        'trade_id,trade_date,instrument,side,currency,quantity,price\nBAD,not-a-date,,HOLD,US,0,-1\n',
    });
    const bravo = await importTradeCsv(pool, {
      sourceSystem: 'BRAVO',
      originalFilename: 'valid-bravo.csv',
      content:
        'execution_id,trade_date,symbol,direction,currency,units,unit_price\nB-1,2026-10-01,ACME,BUY,USD,1,1\n',
    });
    assert.deepEqual(
      [alpha.batch.status, alpha.batch.totalRows, alpha.batch.validRows, alpha.batch.invalidRows],
      ['completed', 1, 0, 1],
    );
    await assert.rejects(
      runReconciliation(pool, alpha.batch.id, bravo.batch.id),
      (error) => error.code === 'BATCH_HAS_NO_VALID_TRADES' && error.statusCode === 409,
    );
    assert.equal((await countsForBatches(alpha.batch.id, bravo.batch.id)).runs, 0);
  });

  it('rolls back the batch and earlier chunks when a later row insert fails', async () => {
    const before = await pool.query(
      `SELECT (SELECT count(*)::int FROM import_batches) AS batches,
              (SELECT count(*)::int FROM imported_trades) AS trades`,
    );
    const content = [
      'trade_id,trade_date,instrument,side,currency,quantity,price',
      ...Array.from(
        { length: 251 },
        (_, index) => `A-${index + 1},2026-10-01,ACME,BUY,USD,1.0000000000,2.0000000000`,
      ),
    ].join('\n');
    await pool.query(`
      CREATE FUNCTION ${schemaIdentifier}.reject_test_import_row()
      RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        IF NEW.row_number = 251 THEN RAISE EXCEPTION 'forced import row failure'; END IF;
        RETURN NEW;
      END;
      $function$`);
    await pool.query(`
      CREATE TRIGGER reject_test_import_row BEFORE INSERT ON imported_trades
      FOR EACH ROW EXECUTE FUNCTION ${schemaIdentifier}.reject_test_import_row()`);
    try {
      await assert.rejects(
        importTradeCsv(pool, { sourceSystem: 'ALPHA', originalFilename: 'fail-row.csv', content }),
        /forced import row failure/,
      );
    } finally {
      await pool.query('DROP TRIGGER reject_test_import_row ON imported_trades');
      await pool.query(`DROP FUNCTION ${schemaIdentifier}.reject_test_import_row()`);
    }
    const after = await pool.query(
      `SELECT (SELECT count(*)::int FROM import_batches) AS batches,
              (SELECT count(*)::int FROM imported_trades) AS trades`,
    );
    assert.deepEqual(after.rows[0], before.rows[0]);
  });

  it('rolls back batch and trades when batch completion fails', async () => {
    const before = await pool.query(
      `SELECT (SELECT count(*)::int FROM import_batches) AS batches,
              (SELECT count(*)::int FROM imported_trades) AS trades`,
    );
    await pool.query(`
      CREATE FUNCTION ${schemaIdentifier}.reject_test_batch_completion()
      RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        IF NEW.status = 'completed' THEN RAISE EXCEPTION 'forced batch completion failure'; END IF;
        RETURN NEW;
      END;
      $function$`);
    await pool.query(`
      CREATE TRIGGER reject_test_batch_completion BEFORE UPDATE ON import_batches
      FOR EACH ROW EXECUTE FUNCTION ${schemaIdentifier}.reject_test_batch_completion()`);
    try {
      await assert.rejects(
        importTradeCsv(pool, {
          sourceSystem: 'BRAVO',
          originalFilename: 'fail-completion.csv',
          content:
            'execution_id,trade_date,symbol,direction,currency,units,unit_price\nB-1,2026-10-01,ACME,BUY,USD,1.0000000000,2.0000000000\n',
        }),
        /forced batch completion failure/,
      );
    } finally {
      await pool.query('DROP TRIGGER reject_test_batch_completion ON import_batches');
      await pool.query(`DROP FUNCTION ${schemaIdentifier}.reject_test_batch_completion()`);
    }
    const after = await pool.query(
      `SELECT (SELECT count(*)::int FROM import_batches) AS batches,
              (SELECT count(*)::int FROM imported_trades) AS trades`,
    );
    assert.deepEqual(after.rows[0], before.rows[0]);
  });

  it('does not allow tests to use or modify the public schema', async () => {
    const result = await pool.query('SELECT current_schema() AS schema');
    assert.equal(result.rows[0].schema, schemaName);
    assert.match(schemaName, /^ledgerline_test_[0-9a-f]{32}$/);
  });

  it('uploads ALPHA and BRAVO CSV files through the REST API', async () => {
    const alphaResponse = await fetch(`${apiBaseUrl}/api/import-batches`, {
      method: 'POST',
      body: csvForm(
        'ALPHA',
        'trade_id,trade_date,instrument,side,currency,quantity,price\nA-HTTP,2026-10-01,ACME,BUY,USD,12.0000000000,4.2500000000\n',
      ),
    });
    assert.equal(alphaResponse.status, 201);
    const alpha = (await alphaResponse.json()).data;
    assert.equal(alpha.sourceSystem, 'ALPHA');
    assert.equal(alpha.status, 'completed');
    assert.deepEqual([alpha.totalRows, alpha.validRows, alpha.invalidRows], [1, 1, 0]);

    const bravoResponse = await fetch(`${apiBaseUrl}/api/import-batches`, {
      method: 'POST',
      body: csvForm(
        'BRAVO',
        'execution_id,trade_date,symbol,direction,currency,units,unit_price\nB-HTTP,2026-10-01,ACME,BUY,USD,12.0000000000,4.2500000000\nBAD,2026-02-30,ACME,BUY,USD,0,4.2500000000\n',
      ),
    });
    assert.equal(bravoResponse.status, 201);
    const bravo = (await bravoResponse.json()).data;
    assert.equal(bravo.sourceSystem, 'BRAVO');
    assert.deepEqual([bravo.totalRows, bravo.validRows, bravo.invalidRows], [2, 1, 1]);
    assert.equal(typeof bravo.id, 'string');

    const reconcile = await fetch(`${apiBaseUrl}/api/reconciliation-runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batchAId: alpha.id, batchBId: bravo.id }),
    });
    assert.equal(reconcile.status, 201);
    const run = (await reconcile.json()).data;
    assert.equal(run.resultCount, 2);
    const runDetails = await fetch(`${apiBaseUrl}/api/reconciliation-runs/${run.runId}`);
    const invalidResult = (await runDetails.json()).data.results.find(
      (result) => result.outcome === 'invalid',
    );
    assert.deepEqual(invalidResult.trades[0].validationErrors, [
      'Trade date must be a valid ISO calendar date (YYYY-MM-DD).',
      'Quantity must be greater than zero.',
    ]);
  });

  it('stores all-invalid HTTP uploads as completed batches', async () => {
    const response = await fetch(`${apiBaseUrl}/api/import-batches`, {
      method: 'POST',
      body: csvForm(
        'ALPHA',
        'trade_id,trade_date,instrument,side,currency,quantity,price\nBAD,not-date,,HOLD,US,0,-1\n',
      ),
    });
    assert.equal(response.status, 201);
    const batch = (await response.json()).data;
    assert.deepEqual(
      [batch.status, batch.totalRows, batch.validRows, batch.invalidRows],
      ['completed', 1, 0, 1],
    );
    const bravoResponse = await fetch(`${apiBaseUrl}/api/import-batches`, {
      method: 'POST',
      body: csvForm(
        'BRAVO',
        'execution_id,trade_date,symbol,direction,currency,units,unit_price\nB-VALID,2026-10-01,ACME,BUY,USD,1,1\n',
      ),
    });
    const bravo = (await bravoResponse.json()).data;
    const reconcile = await fetch(`${apiBaseUrl}/api/reconciliation-runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batchAId: batch.id, batchBId: bravo.id }),
    });
    assert.equal(reconcile.status, 409);
    assert.equal((await reconcile.json()).error.code, 'BATCH_HAS_NO_VALID_TRADES');
  });

  it('rejects missing file, unsupported source, multiple files, and unsupported media types without writes', async () => {
    const before = await importCounts();
    const missingFileForm = new FormData();
    missingFileForm.append('source', 'ALPHA');
    const missingFile = await fetch(`${apiBaseUrl}/api/import-batches`, {
      method: 'POST',
      body: missingFileForm,
    });
    assert.equal(missingFile.status, 400);
    assert.equal((await missingFile.json()).error.code, 'FILE_REQUIRED');

    const unsupportedSource = await fetch(`${apiBaseUrl}/api/import-batches`, {
      method: 'POST',
      body: csvForm('OMEGA', 'header\nvalue\n'),
    });
    assert.equal(unsupportedSource.status, 400);
    assert.equal((await unsupportedSource.json()).error.code, 'VALIDATION_ERROR');

    const multipleFiles = csvForm(
      'ALPHA',
      'trade_id,trade_date,instrument,side,currency,quantity,price\nA,2026-10-01,ACME,BUY,USD,1,1\n',
    );
    multipleFiles.append('file', new Blob(['second'], { type: 'text/csv' }), 'second.csv');
    const multipleResponse = await fetch(`${apiBaseUrl}/api/import-batches`, {
      method: 'POST',
      body: multipleFiles,
    });
    assert.equal(multipleResponse.status, 400);

    const unsupportedType = await fetch(`${apiBaseUrl}/api/import-batches`, {
      method: 'POST',
      body: csvForm('ALPHA', 'not a csv', 'upload.txt', 'text/plain'),
    });
    assert.equal(unsupportedType.status, 415);
    assert.equal((await unsupportedType.json()).error.code, 'UNSUPPORTED_FILE_TYPE');

    const unexpectedField = csvForm(
      'ALPHA',
      'trade_id,trade_date,instrument,side,currency,quantity,price\nA,2026-10-01,ACME,BUY,USD,1,1\n',
    );
    unexpectedField.append('note', 'should not be accepted');
    const unexpectedFieldResponse = await fetch(`${apiBaseUrl}/api/import-batches`, {
      method: 'POST',
      body: unexpectedField,
    });
    assert.equal(unexpectedFieldResponse.status, 400);
    assert.equal((await unexpectedFieldResponse.json()).error.code, 'VALIDATION_ERROR');

    const unsupportedContentType = await fetch(`${apiBaseUrl}/api/import-batches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'ALPHA' }),
    });
    assert.equal(unsupportedContentType.status, 415);
    assert.equal((await unsupportedContentType.json()).error.code, 'UNSUPPORTED_MEDIA_TYPE');

    assert.deepEqual(await importCounts(), before);
  });

  it('rejects malformed CSV, malformed multipart, and uploads larger than 5 MiB', async () => {
    const before = await importCounts();
    const malformedCsv = await fetch(`${apiBaseUrl}/api/import-batches`, {
      method: 'POST',
      body: csvForm(
        'ALPHA',
        'trade_id,trade_date,instrument,side,currency,quantity,price\n"unclosed,2026-10-01,ACME,BUY,USD,1,1\n',
      ),
    });
    assert.equal(malformedCsv.status, 400);
    assert.equal((await malformedCsv.json()).error.code, 'MALFORMED_CSV');

    const malformedMultipart = await fetch(`${apiBaseUrl}/api/import-batches`, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=broken-boundary' },
      body: '--broken-boundary\r\nContent-Disposition: form-data; name="source"\r\n\r\nALPHA\r\n--broken-boundary',
    });
    assert.equal(malformedMultipart.status, 400);
    assert.equal((await malformedMultipart.json()).error.code, 'MALFORMED_MULTIPART');

    const oversized = await fetch(`${apiBaseUrl}/api/import-batches`, {
      method: 'POST',
      body: csvForm('ALPHA', `trade_id\n${'x'.repeat(5 * 1024 * 1024)}`),
    });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).error.code, 'LIMIT_FILE_SIZE');
    assert.deepEqual(await importCounts(), before);
  });

  it('returns paginated validation issues and validates batch IDs', async () => {
    const response = await fetch(`${apiBaseUrl}/api/import-batches`, {
      method: 'POST',
      body: csvForm(
        'ALPHA',
        [
          'trade_id,trade_date,instrument,side,currency,quantity,price',
          'GOOD,2026-10-01,ACME,BUY,USD,1,1',
          'BAD-DATE,2026-02-30,ACME,BUY,USD,1,1',
          'BAD-QTY,2026-10-01,ACME,BUY,USD,0,1',
          'BAD-SIDE,2026-10-01,ACME,HOLD,USD,1,1',
        ].join('\n'),
      ),
    });
    const batch = (await response.json()).data;
    const firstPage = await fetch(
      `${apiBaseUrl}/api/import-batches/${batch.id}/errors?limit=1&offset=0`,
    );
    assert.equal(firstPage.status, 200);
    const pageOne = await firstPage.json();
    assert.deepEqual(pageOne.pagination, { limit: 1, offset: 0, total: 3 });
    assert.equal(pageOne.data[0].rowNumber, 2);
    assert.equal(pageOne.data[0].errors[0].code, 'INVALID_TRADE_DATE');
    assert.equal(
      pageOne.data[0].errors[0].message,
      'Trade date must be a valid ISO calendar date (YYYY-MM-DD).',
    );
    assert.equal(pageOne.data[0].rawRecord.trade_id, 'BAD-DATE');

    const secondPage = await fetch(
      `${apiBaseUrl}/api/import-batches/${batch.id}/errors?limit=1&offset=1`,
    );
    const pageTwo = await secondPage.json();
    assert.equal(pageTwo.data[0].rowNumber, 3);
    assert.equal(pageTwo.data[0].errors[0].code, 'QUANTITY_NOT_POSITIVE');

    const invalidUuid = await fetch(`${apiBaseUrl}/api/import-batches/not-a-uuid/errors`);
    assert.equal(invalidUuid.status, 400);
    assert.equal((await invalidUuid.json()).error.code, 'VALIDATION_ERROR');
    const missing = await fetch(
      `${apiBaseUrl}/api/import-batches/30000000-0000-4000-8000-000000000099/errors`,
    );
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'RESOURCE_NOT_FOUND');
  });

  it('rolls back an HTTP import after a database failure and hides internal details', async () => {
    const before = await importCounts();
    await pool.query(`
      CREATE FUNCTION ${schemaIdentifier}.reject_test_http_import()
      RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN RAISE EXCEPTION 'forced private database failure'; END;
      $function$`);
    await pool.query(`
      CREATE TRIGGER reject_test_http_import BEFORE INSERT ON imported_trades
      FOR EACH ROW EXECUTE FUNCTION ${schemaIdentifier}.reject_test_http_import()`);
    let response;
    try {
      response = await fetch(`${apiBaseUrl}/api/import-batches`, {
        method: 'POST',
        body: csvForm(
          'ALPHA',
          'trade_id,trade_date,instrument,side,currency,quantity,price\nFAIL,2026-10-01,ACME,BUY,USD,1,1\n',
        ),
      });
    } finally {
      await pool.query('DROP TRIGGER reject_test_http_import ON imported_trades');
      await pool.query(`DROP FUNCTION ${schemaIdentifier}.reject_test_http_import()`);
    }
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.deepEqual(body.error, {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected server error occurred.',
    });
    assert.equal(JSON.stringify(body).includes('forced private database failure'), false);
    assert.deepEqual(await importCounts(), before);
  });

  it('lists batches and validates query filters and pagination over HTTP', async () => {
    const response = await fetch(
      `${apiBaseUrl}/api/import-batches?source=ALPHA&status=completed&limit=1`,
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].sourceSystem, 'ALPHA');
    assert.equal(body.pagination.limit, 1);
    assert.equal(body.pagination.offset, 0);
    assert.ok(body.pagination.total >= 1);

    const invalid = await fetch(`${apiBaseUrl}/api/import-batches?source=OMEGA`);
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), {
      error: { code: 'VALIDATION_ERROR', message: 'source must be one of: ALPHA, BRAVO.' },
    });

    const invalidPage = await fetch(`${apiBaseUrl}/api/import-batches?limit=101`);
    assert.equal(invalidPage.status, 400);
    const overOffset = await fetch(`${apiBaseUrl}/api/import-batches?offset=10001`);
    assert.equal(overOffset.status, 400);
    const boundaryOffset = await fetch(
      `${apiBaseUrl}/api/import-batches?source=ALPHA&status=completed&offset=10000`,
    );
    assert.equal(boundaryOffset.status, 200);
    const boundaryBody = await boundaryOffset.json();
    assert.equal(boundaryBody.data.length, 0);
    assert.ok(boundaryBody.pagination.total >= 1);
    const unexpected = await fetch(`${apiBaseUrl}/api/import-batches?unexpected=1`);
    assert.equal(unexpected.status, 400);
  });

  it('validates run request bodies and creates a run through the API', async () => {
    const invalid = await fetch(`${apiBaseUrl}/api/reconciliation-runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batchAId: 'not-a-uuid', batchBId: 'also-invalid', extra: true }),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, 'VALIDATION_ERROR');

    const wrongPair = await fetch(`${apiBaseUrl}/api/reconciliation-runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        batchAId: '10000000-0000-4000-8000-000000000002',
        batchBId: '10000000-0000-4000-8000-000000000001',
      }),
    });
    assert.equal(wrongPair.status, 409);
    assert.equal((await wrongPair.json()).error.code, 'INVALID_BATCH_PAIR');

    const processingId = randomUUID();
    const completedBravoId = await createCompletedBatch('BRAVO', []);
    await pool.query(
      `INSERT INTO import_batches (id, source_system, original_filename, status)
       VALUES ($1, 'ALPHA', 'processing-api.csv', 'processing')`,
      [processingId],
    );
    const unfinished = await fetch(`${apiBaseUrl}/api/reconciliation-runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batchAId: processingId, batchBId: completedBravoId }),
    });
    assert.equal(unfinished.status, 409);
    assert.equal((await unfinished.json()).error.code, 'BATCH_NOT_COMPLETED');

    const response = await fetch(`${apiBaseUrl}/api/reconciliation-runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        batchAId: '10000000-0000-4000-8000-000000000001',
        batchBId: '10000000-0000-4000-8000-000000000002',
      }),
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    httpRunId = body.data.runId;
    assert.match(httpRunId, UUID_PATTERN);
    assert.equal(body.data.status, 'completed');
    assert.equal(body.data.resultCount, 3);
    assert.equal(body.data.exceptionCount, 2);
  });

  it('lists runs, returns linked result details, and filters exceptions', async () => {
    const runs = await fetch(
      `${apiBaseUrl}/api/reconciliation-runs?batchAId=10000000-0000-4000-8000-000000000001&status=completed`,
    );
    assert.equal(runs.status, 200);
    const runBody = await runs.json();
    assert.ok(runBody.data.some((run) => run.id === httpRunId));

    const detailResponse = await fetch(
      `${apiBaseUrl}/api/reconciliation-runs/${httpRunId}?limit=2&offset=0`,
    );
    assert.equal(detailResponse.status, 200);
    const detail = (await detailResponse.json()).data;
    assert.equal(detail.run.id, httpRunId);
    assert.equal(detail.results.length, 2);
    assert.equal(detail.run.resultCount, 3);
    assert.equal(detail.run.exceptionCount, 2);
    assert.deepEqual(detail.pagination, { limit: 2, offset: 0, total: 3 });
    const duplicate = detail.results.find((result) => result.outcome === 'duplicate');
    assert.equal(duplicate.trades.length, 3);
    assert.equal(duplicate.exception.status, 'open');
    const exact = detail.results.find((result) => result.outcome === 'exact_match');
    assert.equal(exact.trades[0].quantity, '100.0000000000');
    assert.equal(exact.trades[0].price, '24.5000000000');

    const nextPage = await fetch(
      `${apiBaseUrl}/api/reconciliation-runs/${httpRunId}?limit=2&offset=2`,
    );
    const nextPageBody = (await nextPage.json()).data;
    assert.equal(nextPageBody.results.length, 1);
    assert.equal(nextPageBody.pagination.total, 3);

    const emptyPage = await fetch(
      `${apiBaseUrl}/api/reconciliation-runs/${httpRunId}?limit=2&offset=3`,
    );
    assert.equal(emptyPage.status, 200);
    const emptyPageBody = (await emptyPage.json()).data;
    assert.deepEqual(emptyPageBody.results, []);
    assert.equal(emptyPageBody.pagination.total, 3);
    assert.equal(emptyPageBody.run.resultCount, 3);
    assert.equal(emptyPageBody.run.exceptionCount, 2);

    const invalidLimit = await fetch(`${apiBaseUrl}/api/reconciliation-runs/${httpRunId}?limit=0`);
    assert.equal(invalidLimit.status, 400);

    const exceptions = await fetch(
      `${apiBaseUrl}/api/exceptions?runId=${httpRunId}&status=open&outcome=duplicate`,
    );
    assert.equal(exceptions.status, 200);
    const exceptionBody = await exceptions.json();
    assert.equal(exceptionBody.data.length, 1);
    assert.equal(exceptionBody.data[0].outcome, 'duplicate');
    assert.equal(exceptionBody.data[0].runId, httpRunId);
  });

  it('resolves open and investigating exceptions with trimmed reasons and audit metadata', async () => {
    for (const status of ['open', 'investigating']) {
      const exceptionId = await createExceptionFixture(status);
      const response = await postExceptionAction(exceptionId, 'resolve', {
        reason: '  Confirmed against the approved source record.  ',
      });
      assert.equal(response.status, 200);
      const { data } = await response.json();
      assert.equal(data.exception.id, exceptionId);
      assert.equal(data.exception.status, 'resolved');
      assert.equal(
        data.exception.resolutionReason,
        'Confirmed against the approved source record.',
      );
      assert.ok(data.exception.resolvedAt);
      assert.equal(data.action.type, 'exception_resolved');
      assert.equal(data.action.actor, 'anonymous-operator');
      assert.equal(data.action.reason, 'Confirmed against the approved source record.');
      assert.equal(data.action.previousStatus, status);
      assert.equal(data.action.newStatus, 'resolved');

      const events = await pool.query(
        `SELECT event_type, actor, reason, details
         FROM audit_events
         WHERE exception_id = $1 AND event_type = 'exception_resolved'`,
        [exceptionId],
      );
      assert.deepEqual(events.rows[0], {
        event_type: 'exception_resolved',
        actor: 'anonymous-operator',
        reason: 'Confirmed against the approved source record.',
        details: { previousStatus: status, newStatus: 'resolved' },
      });
    }
  });

  it('reopens resolved exceptions and preserves earlier resolution events', async () => {
    const exceptionId = await createExceptionFixture('resolved');
    const response = await postExceptionAction(exceptionId, 'reopen', {
      reason: '  Supporting source data was corrected.  ',
    });
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data.exception.status, 'open');
    assert.equal(data.exception.resolutionReason, null);
    assert.equal(data.exception.resolvedAt, null);
    assert.equal(data.action.type, 'exception_reopened');
    assert.equal(data.action.actor, 'anonymous-operator');
    assert.equal(data.action.reason, 'Supporting source data was corrected.');
    assert.equal(data.action.previousStatus, 'resolved');
    assert.equal(data.action.newStatus, 'open');

    const events = await pool.query(
      `SELECT event_type, reason, details
       FROM audit_events
       WHERE exception_id = $1 AND event_type <> 'exception_created'
       ORDER BY created_at, id`,
      [exceptionId],
    );
    assert.equal(events.rows.length, 2);
    assert.equal(events.rows[0].event_type, 'exception_resolved');
    assert.equal(events.rows[0].reason, 'Earlier resolution');
    assert.deepEqual(events.rows[0].details, { previousStatus: 'open', newStatus: 'resolved' });
    assert.equal(events.rows[1].event_type, 'exception_reopened');
    assert.equal(events.rows[1].reason, 'Supporting source data was corrected.');
    assert.deepEqual(events.rows[1].details, { previousStatus: 'resolved', newStatus: 'open' });
  });

  it('rejects invalid resolution transitions, reasons, UUIDs, and missing exceptions', async () => {
    const resolvedId = await createExceptionFixture('resolved');
    const ignoredId = await createExceptionFixture('ignored');
    const openId = await createExceptionFixture('open');

    for (const [id, action] of [
      [resolvedId, 'resolve'],
      [ignoredId, 'resolve'],
      [openId, 'reopen'],
    ]) {
      const response = await postExceptionAction(id, action, { reason: 'A valid reason.' });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error.code, 'INVALID_EXCEPTION_TRANSITION');
    }

    const invalidBodies = [
      undefined,
      {},
      { reason: null },
      { reason: 1 },
      { reason: '' },
      { reason: ' \n ' },
      { reason: 'x'.repeat(1_001) },
      { reason: 'Valid', actor: 'spoofed' },
    ];
    for (const body of invalidBodies) {
      const response = await postExceptionAction(openId, 'resolve', body);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, 'VALIDATION_ERROR');
    }

    const malformed = await postExceptionAction('not-a-uuid', 'resolve', { reason: 'valid' });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, 'VALIDATION_ERROR');
    const missing = await postExceptionAction('30000000-0000-4000-8000-000000000099', 'resolve', {
      reason: 'valid',
    });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'RESOURCE_NOT_FOUND');
  });

  it('rolls back exception changes if audit insertion fails', async () => {
    const exceptionId = await createExceptionFixture('open');
    await pool.query(`
      CREATE FUNCTION ${schemaIdentifier}.reject_exception_resolution_audit()
      RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        IF NEW.event_type = 'exception_resolved' THEN
          RAISE EXCEPTION 'forced exception audit failure';
        END IF;
        RETURN NEW;
      END;
      $function$`);
    await pool.query(`
      CREATE TRIGGER reject_exception_resolution_audit
      BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION ${schemaIdentifier}.reject_exception_resolution_audit()`);
    try {
      const response = await postExceptionAction(exceptionId, 'resolve', {
        reason: 'valid reason',
      });
      assert.equal(response.status, 500);
      assert.deepEqual((await response.json()).error, {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected server error occurred.',
      });
    } finally {
      await pool.query('DROP TRIGGER reject_exception_resolution_audit ON audit_events');
      await pool.query(`DROP FUNCTION ${schemaIdentifier}.reject_exception_resolution_audit()`);
    }

    const state = await pool.query(
      `SELECT status, resolution_reason, resolved_at FROM exceptions WHERE id = $1`,
      [exceptionId],
    );
    const eventCount = await pool.query(
      `SELECT count(*)::int AS count FROM audit_events
       WHERE exception_id = $1 AND event_type = 'exception_resolved'`,
      [exceptionId],
    );
    assert.deepEqual(state.rows[0], { status: 'open', resolution_reason: null, resolved_at: null });
    assert.equal(eventCount.rows[0].count, 0);
  });

  it('serializes concurrent resolution requests and records one successful transition', async () => {
    const exceptionId = await createExceptionFixture('open');
    const responses = await Promise.all([
      postExceptionAction(exceptionId, 'resolve', { reason: 'first request' }),
      postExceptionAction(exceptionId, 'resolve', { reason: 'second request' }),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    const events = await pool.query(
      `SELECT count(*)::int AS count FROM audit_events
       WHERE exception_id = $1 AND event_type = 'exception_resolved'`,
      [exceptionId],
    );
    assert.equal(events.rows[0].count, 1);
  });

  it('returns full exception inspection details for duplicate and invalid outcomes', async () => {
    const duplicateLookup = await pool.query(
      `SELECT exception.id
       FROM exceptions exception
       JOIN reconciliation_results result
         ON result.id = exception.reconciliation_result_id
       WHERE result.reconciliation_run_id = $1 AND result.outcome = 'duplicate'`,
      [httpRunId],
    );
    const duplicateId = duplicateLookup.rows[0].id;
    const duplicateResponse = await fetch(`${apiBaseUrl}/api/exceptions/${duplicateId}`);
    assert.equal(duplicateResponse.status, 200);
    const duplicate = (await duplicateResponse.json()).data;
    assert.equal(duplicate.id, duplicateId);
    assert.equal(duplicate.outcome, 'duplicate');
    assert.equal(duplicate.run.id, httpRunId);
    assert.equal(duplicate.batchA.sourceSystem, 'ALPHA');
    assert.equal(duplicate.batchB.sourceSystem, 'BRAVO');
    assert.equal(duplicate.trades.length, 3);
    assert.ok(duplicate.trades.every((trade) => typeof trade.quantity === 'string'));
    assert.ok(duplicate.trades.every((trade) => typeof trade.price === 'string'));

    const invalidBatchA = await createCompletedBatch('ALPHA', [
      { validationStatus: 'invalid', validationErrors: ['invalid price'] },
      { instrument: 'VALID' },
    ]);
    const invalidBatchB = await createCompletedBatch('BRAVO', [{ instrument: 'VALID' }]);
    const invalidRun = await runReconciliation(pool, invalidBatchA, invalidBatchB);
    const invalidLookup = await pool.query(
      `SELECT exception.id
       FROM exceptions exception
       JOIN reconciliation_results result
         ON result.id = exception.reconciliation_result_id
       WHERE result.reconciliation_run_id = $1 AND result.outcome = 'invalid'
       ORDER BY exception.created_at DESC, exception.id
       LIMIT 1`,
      [invalidRun.runId],
    );
    const invalidId = invalidLookup.rows[0].id;
    const invalidResponse = await fetch(`${apiBaseUrl}/api/exceptions/${invalidId}`);
    assert.equal(invalidResponse.status, 200);
    const invalid = (await invalidResponse.json()).data;
    assert.equal(invalid.outcome, 'invalid');
    const invalidTrade = invalid.trades.find((trade) => trade.validationStatus === 'invalid');
    assert.equal(invalidTrade.tradeDate, null);
    assert.equal(invalidTrade.instrument, null);
    assert.equal(invalidTrade.quantity, null);
    assert.deepEqual(invalidTrade.validationErrors, ['invalid price']);
    assert.deepEqual(invalidTrade.rawRecord, {});
  });

  it('returns current resolution details after resolving an exception', async () => {
    const exceptionId = await createExceptionFixture('open');
    const resolvedResponse = await postExceptionAction(exceptionId, 'resolve', {
      reason: 'Reviewed and accepted.',
    });
    assert.equal(resolvedResponse.status, 200);

    const response = await fetch(`${apiBaseUrl}/api/exceptions/${exceptionId}`);
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data.status, 'resolved');
    assert.equal(data.resolutionReason, 'Reviewed and accepted.');
    assert.ok(data.resolvedAt);
    assert.ok(data.createdAt);
  });

  it('returns 400 for malformed detail UUIDs and 404 for missing exceptions', async () => {
    const malformed = await fetch(`${apiBaseUrl}/api/exceptions/not-a-uuid`);
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, 'VALIDATION_ERROR');
    const missing = await fetch(
      `${apiBaseUrl}/api/exceptions/30000000-0000-4000-8000-000000000098`,
    );
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'RESOURCE_NOT_FOUND');
  });

  it('lists an exception audit history in deterministic order with pagination', async () => {
    const exceptionId = await createExceptionFixture('open', false);
    const fixedTimestamp = '2000-01-01T00:00:00.000Z';
    const lowerId = '10000000-0000-4000-8000-000000000001';
    const higherId = '20000000-0000-4000-8000-000000000001';
    await pool.query(
      `INSERT INTO audit_events (id, exception_id, event_type, actor, reason, details, created_at)
       VALUES ($1, $3, 'test_first', 'test-actor', 'first', '{}'::jsonb, $4),
              ($2, $3, 'test_second', 'test-actor', 'second', '{}'::jsonb, $4)`,
      [lowerId, higherId, exceptionId, fixedTimestamp],
    );
    const otherExceptionId = await createExceptionFixture();

    const firstPageResponse = await fetch(
      `${apiBaseUrl}/api/exceptions/${exceptionId}/audit-events?limit=2&offset=0`,
    );
    assert.equal(firstPageResponse.status, 200);
    const firstPage = await firstPageResponse.json();
    assert.deepEqual(firstPage.pagination, { limit: 2, offset: 0, total: 2 });
    assert.deepEqual(
      firstPage.data.map((event) => event.id),
      [lowerId, higherId],
    );
    assert.equal(firstPage.data[0].actor, 'test-actor');
    assert.equal(firstPage.data[0].reason, 'first');
    assert.deepEqual(firstPage.data[0].details, {});
    assert.ok(firstPage.data[0].createdAt);
    const nextPageResponse = await fetch(
      `${apiBaseUrl}/api/exceptions/${exceptionId}/audit-events?limit=2&offset=2`,
    );
    const nextPage = await nextPageResponse.json();
    assert.deepEqual(nextPage.pagination, { limit: 2, offset: 2, total: 2 });
    assert.deepEqual(nextPage.data, []);

    const defaultPageResponse = await fetch(
      `${apiBaseUrl}/api/exceptions/${otherExceptionId}/audit-events`,
    );
    assert.equal(defaultPageResponse.status, 200);
    const defaultPage = await defaultPageResponse.json();
    assert.equal(defaultPage.pagination.limit, 25);
    assert.equal(defaultPage.pagination.offset, 0);
    assert.equal(defaultPage.pagination.total, 1);
    assert.equal(defaultPage.data[0].eventType, 'exception_created');
    const otherEvent = await pool.query('SELECT id FROM audit_events WHERE exception_id = $1', [
      otherExceptionId,
    ]);
    assert.ok(firstPage.data.every((event) => event.id !== otherEvent.rows[0].id));

    const empty = await createExceptionFixture('open', false);
    const emptyResponse = await fetch(`${apiBaseUrl}/api/exceptions/${empty}/audit-events`);
    assert.equal(emptyResponse.status, 200);
    assert.deepEqual(await emptyResponse.json(), {
      data: [],
      pagination: { limit: 25, offset: 0, total: 0 },
    });
  });

  it('returns creation, resolution, and reopening audit events without leaking other events', async () => {
    const exceptionId = await createExceptionFixture('open');
    const otherExceptionId = await createExceptionFixture('open');
    await postExceptionAction(exceptionId, 'resolve', { reason: 'First resolution.' });
    await postExceptionAction(exceptionId, 'reopen', { reason: 'Review again.' });

    const response = await fetch(`${apiBaseUrl}/api/exceptions/${exceptionId}/audit-events`);
    assert.equal(response.status, 200);
    const { data, pagination: page } = await response.json();
    assert.equal(page.total, 3);
    assert.deepEqual(
      data.map((event) => event.eventType),
      ['exception_created', 'exception_resolved', 'exception_reopened'],
    );
    assert.equal(data[1].reason, 'First resolution.');
    assert.deepEqual(data[1].details, { previousStatus: 'open', newStatus: 'resolved' });
    assert.equal(data[2].reason, 'Review again.');
    assert.deepEqual(data[2].details, { previousStatus: 'resolved', newStatus: 'open' });
    const otherEvent = await pool.query('SELECT id FROM audit_events WHERE exception_id = $1', [
      otherExceptionId,
    ]);
    assert.ok(data.every((event) => event.id !== otherEvent.rows[0].id));
    assert.ok(data.every((event) => event.actor));
    const secondPageResponse = await fetch(
      `${apiBaseUrl}/api/exceptions/${exceptionId}/audit-events?limit=2&offset=2`,
    );
    const secondPage = await secondPageResponse.json();
    assert.equal(secondPage.pagination.total, 3);
    assert.deepEqual(
      secondPage.data.map((event) => event.eventType),
      ['exception_reopened'],
    );
  });

  it('validates audit UUIDs and pagination and returns 404 for unknown exceptions', async () => {
    const exceptionId = await createExceptionFixture();
    const invalidRequests = [
      `${apiBaseUrl}/api/exceptions/not-a-uuid/audit-events`,
      `${apiBaseUrl}/api/exceptions/${exceptionId}/audit-events?limit=0`,
      `${apiBaseUrl}/api/exceptions/${exceptionId}/audit-events?limit=101`,
      `${apiBaseUrl}/api/exceptions/${exceptionId}/audit-events?offset=-1`,
      `${apiBaseUrl}/api/exceptions/${exceptionId}/audit-events?offset=10001`,
      `${apiBaseUrl}/api/exceptions/${exceptionId}/audit-events?limit=2.5`,
    ];
    for (const url of invalidRequests) {
      const response = await fetch(url);
      assert.equal(response.status, 400, url);
      assert.equal((await response.json()).error.code, 'VALIDATION_ERROR');
    }
    const missing = await fetch(
      `${apiBaseUrl}/api/exceptions/30000000-0000-4000-8000-000000000097/audit-events`,
    );
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'RESOURCE_NOT_FOUND');
  });

  it('returns consistent 400 and 404 envelopes for run lookup errors', async () => {
    const malformed = await fetch(`${apiBaseUrl}/api/reconciliation-runs/not-a-uuid`);
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, 'VALIDATION_ERROR');

    const missing = await fetch(
      `${apiBaseUrl}/api/reconciliation-runs/30000000-0000-4000-8000-000000000099`,
    );
    assert.equal(missing.status, 404);
    assert.deepEqual((await missing.json()).error, {
      code: 'RESOURCE_NOT_FOUND',
      message: 'Reconciliation run was not found.',
    });
  });

  it('maps recognized body-parser failures to appropriate 4xx errors', async () => {
    const invalidJson = await fetch(`${apiBaseUrl}/api/reconciliation-runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"batchAId":',
    });
    assert.equal(invalidJson.status, 400);
    assert.equal((await invalidJson.json()).error.code, 'INVALID_JSON');

    const unsupportedEncoding = await fetch(`${apiBaseUrl}/api/reconciliation-runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'compress' },
      body: '{}',
    });
    assert.equal(unsupportedEncoding.status, 415);
    assert.equal((await unsupportedEncoding.json()).error.code, 'UNSUPPORTED_ENCODING');

    const oversizedBody = await fetch(`${apiBaseUrl}/api/reconciliation-runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: 'x'.repeat(110_000) }),
    });
    assert.equal(oversizedBody.status, 413);
    assert.equal((await oversizedBody.json()).error.code, 'REQUEST_TOO_LARGE');
  });

  it('rolls back run, results, links, exceptions, and audits if an audit insert fails', async () => {
    const batchAId = await createCompletedBatch('ALPHA', [{ price: '3.1250000000' }]);
    const batchBId = await createCompletedBatch('BRAVO', [{ price: '8.0000000000' }]);
    await pool.query(`
      CREATE FUNCTION ${schemaIdentifier}.reject_test_audit_insert()
      RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN RAISE EXCEPTION 'forced audit insert failure'; END;
      $function$`);
    await pool.query(`
      CREATE TRIGGER reject_test_audit_insert
      BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION ${schemaIdentifier}.reject_test_audit_insert()`);

    try {
      await assert.rejects(
        runReconciliation(pool, batchAId, batchBId),
        /forced audit insert failure/,
      );
    } finally {
      await pool.query('DROP TRIGGER reject_test_audit_insert ON audit_events');
      await pool.query(`DROP FUNCTION ${schemaIdentifier}.reject_test_audit_insert()`);
    }

    assert.deepEqual(await countsForBatches(batchAId, batchBId), {
      runs: 0,
      results: 0,
      links: 0,
      exceptions: 0,
      audit_events: 0,
    });
  });

  it('rejects audit event updates, deletes, and truncation', async () => {
    const runId = randomUUID();
    const resultId = randomUUID();
    const exceptionId = randomUUID();
    const auditEventId = randomUUID();

    await pool.query(
      `INSERT INTO reconciliation_runs (id, batch_a_id, batch_b_id, status, rules_version)
       VALUES ($1, $2, $3, 'processing', 'test-1')`,
      [runId, '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'],
    );
    await pool.query(
      `INSERT INTO reconciliation_results (id, reconciliation_run_id, outcome)
       VALUES ($1, $2, 'field_mismatch')`,
      [resultId, runId],
    );
    await pool.query(`INSERT INTO exceptions (id, reconciliation_result_id) VALUES ($1, $2)`, [
      exceptionId,
      resultId,
    ]);
    await pool.query(
      `INSERT INTO audit_events (id, exception_id, event_type, actor)
       VALUES ($1, $2, 'opened', 'integration-test')`,
      [auditEventId, exceptionId],
    );

    await assert.rejects(
      pool.query('UPDATE audit_events SET reason = $1 WHERE id = $2', ['changed', auditEventId]),
      (error) => error.code === '55000',
    );
    await assert.rejects(
      pool.query('DELETE FROM audit_events WHERE id = $1', [auditEventId]),
      (error) => error.code === '55000',
    );
    await assert.rejects(pool.query('TRUNCATE audit_events'), (error) => error.code === '55000');

    const stillPresent = await pool.query(
      'SELECT count(*)::int AS rows FROM audit_events WHERE id = $1',
      [auditEventId],
    );
    assert.equal(stillPresent.rows[0].rows, 1);
  });

  it('refuses to remove invalid outcome support and preserves existing data', async () => {
    const before = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM import_batches) AS batches,
         (SELECT count(*)::int FROM imported_trades) AS trades`,
    );
    const runId = randomUUID();
    const resultId = randomUUID();
    await pool.query(
      `INSERT INTO reconciliation_runs (id, batch_a_id, batch_b_id, status, rules_version)
       VALUES ($1, $2, $3, 'processing', 'migration-down-test')`,
      [runId, '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'],
    );
    await pool.query(
      `INSERT INTO reconciliation_results (id, reconciliation_run_id, outcome)
       VALUES ($1, $2, 'invalid')`,
      [resultId, runId],
    );

    await assert.rejects(
      runner({ ...migrationOptions(), direction: 'down', count: 1 }),
      /Cannot remove invalid outcome support/,
    );

    const counts = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM import_batches) AS batches,
         (SELECT count(*)::int FROM imported_trades) AS trades`,
    );
    const constraint = await pool.query(
      `SELECT count(*)::int AS matches
       FROM pg_constraint
       JOIN pg_namespace ON pg_namespace.oid = pg_constraint.connamespace
       WHERE pg_namespace.nspname = $1
         AND conname = 'import_batches_completed_row_counts_check'`,
      [schemaName],
    );

    assert.deepEqual(counts.rows[0], before.rows[0]);
    assert.equal(constraint.rows[0].matches, 1);
    const invalidResult = await pool.query(
      'SELECT count(*)::int AS count FROM reconciliation_results WHERE id = $1',
      [resultId],
    );
    assert.equal(invalidResult.rows[0].count, 1);
  });
});
