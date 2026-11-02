import { describe, expect, it } from 'vitest';
import { partitionReconciliationBatches } from './reconcileEligibility';

describe('reconciliation batch eligibility', () => {
  it('keeps only completed batches with a positive valid-row count', () => {
    const batches = [
      { id: 'valid', validRows: 3 },
      { id: 'empty', validRows: 0 },
      { id: 'negative', validRows: -1 },
    ];

    expect(partitionReconciliationBatches(batches)).toEqual({
      eligible: [{ id: 'valid', validRows: 3 }],
      excludedCount: 2,
    });
  });

  it('safely excludes missing, nullable, and non-finite counts', () => {
    const batches: Array<{ id: string; validRows?: unknown }> = [
      { id: 'missing' },
      { id: 'null', validRows: null },
      { id: 'nan', validRows: Number.NaN },
    ];

    expect(partitionReconciliationBatches(batches)).toEqual({ eligible: [], excludedCount: 3 });
  });
});
