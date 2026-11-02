import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { getReconciliationRun } from './read-repository.js';

interface LinkedTradeFixture {
  id: string;
  sourceSide: 'A' | 'B';
  rowNumber: number;
}

const runRow = {
  id: 'run-1',
  status: 'completed',
  rulesVersion: 'candidate-key-v1',
  startedAt: '2026-10-01T12:00:00.000Z',
  completedAt: '2026-10-01T12:00:01.000Z',
  batchA: { id: 'batch-a', sourceSystem: 'ALPHA', originalFilename: 'alpha.csv' },
  batchB: { id: 'batch-b', sourceSystem: 'BRAVO', originalFilename: 'bravo.csv' },
  resultCount: 2,
  exceptionCount: 1,
};

function makeResult(id: string, outcome: string) {
  return {
    id,
    outcome,
    details: {},
    createdAt: '2026-10-01T12:00:01.000Z',
    exceptionId: null,
    exceptionStatus: null,
    exceptionCreatedAt: null,
  };
}

function makeTradeRow(resultId: string, sourceSide: 'A' | 'B', rowNumber: number) {
  return {
    resultId,
    sourceSide,
    id: `${sourceSide}-${rowNumber}`,
    rowNumber,
    sourceTradeId: `${sourceSide}-TRADE-${rowNumber}`,
    tradeDate: '2026-10-01',
    instrument: 'ACME',
    side: 'BUY',
    currency: 'USD',
    quantity: '1.0000000000',
    price: '2.0000000000',
    validationStatus: 'valid',
    validationErrors: [],
  };
}

function makePool(resultRows: unknown[], tradeRows: unknown[]) {
  const query = vi
    .fn<(...args: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>>()
    .mockResolvedValueOnce({ rows: [runRow], rowCount: 1 })
    .mockResolvedValueOnce({ rows: resultRows, rowCount: resultRows.length })
    .mockResolvedValueOnce({ rows: tradeRows, rowCount: tradeRows.length });
  return { pool: { query } as unknown as Pool, query };
}

describe('getReconciliationRun linked-trade grouping', () => {
  it('groups trades under their result and preserves database ordering', async () => {
    const resultRows = [
      makeResult('result-a', 'duplicate'),
      makeResult('result-b', 'missing_in_b'),
    ];
    const tradeRows = [
      makeTradeRow('result-a', 'A', 1),
      makeTradeRow('result-a', 'A', 4),
      makeTradeRow('result-a', 'B', 2),
      makeTradeRow('result-b', 'B', 3),
    ];
    const { pool } = makePool(resultRows, tradeRows);

    const response = await getReconciliationRun(pool, 'run-1', { limit: 25, offset: 0 });

    expect(response?.results.map((result) => result.id)).toEqual(['result-a', 'result-b']);
    const resultATrades = response?.results[0]?.trades as LinkedTradeFixture[];
    const resultBTrades = response?.results[1]?.trades as LinkedTradeFixture[];
    expect(resultATrades.map((trade) => trade.id)).toEqual(['A-1', 'A-4', 'B-2']);
    expect(resultBTrades.map((trade) => trade.id)).toEqual(['B-3']);
    expect(response?.run).toEqual(runRow);
  });

  it('groups a maximum-size duplicate result without losing trade order', async () => {
    const tradeCountPerSide = 10_000;
    const resultRows = [makeResult('large-duplicate', 'duplicate')];
    const tradeRows = [
      ...Array.from({ length: tradeCountPerSide }, (_, index) =>
        makeTradeRow('large-duplicate', 'A', index + 1),
      ),
      ...Array.from({ length: tradeCountPerSide }, (_, index) =>
        makeTradeRow('large-duplicate', 'B', index + 1),
      ),
    ];
    const { pool } = makePool(resultRows, tradeRows);

    const response = await getReconciliationRun(pool, 'run-1', { limit: 25, offset: 0 });

    const trades = response?.results[0]?.trades as LinkedTradeFixture[] | undefined;
    expect(trades).toHaveLength(tradeCountPerSide * 2);
    expect(trades?.[0]).toMatchObject({ id: 'A-1', sourceSide: 'A', rowNumber: 1 });
    expect(trades?.[tradeCountPerSide - 1]).toMatchObject({
      id: `A-${tradeCountPerSide}`,
      sourceSide: 'A',
      rowNumber: tradeCountPerSide,
    });
    expect(trades?.[tradeCountPerSide]).toMatchObject({ id: 'B-1', sourceSide: 'B', rowNumber: 1 });
    expect(trades?.at(-1)).toMatchObject({
      id: `B-${tradeCountPerSide}`,
      sourceSide: 'B',
      rowNumber: tradeCountPerSide,
    });
  });
});
