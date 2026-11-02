import { describe, expect, it } from 'vitest';
import {
  decimalToScaledInteger,
  reconcileTrades,
  type ImportedTrade,
  type ValidTrade,
} from './domain.js';

function trade(id: string, overrides: Partial<ValidTrade> = {}): ValidTrade {
  return {
    id,
    sourceTradeId: `SRC-${id}`,
    validationStatus: 'valid',
    tradeDate: '2026-01-12',
    instrument: 'ACME',
    side: 'BUY',
    currency: 'USD',
    quantity: '10.0000000000',
    price: '25.5000000000',
    ...overrides,
  };
}

function run(a: ImportedTrade[], b: ImportedTrade[]) {
  return reconcileTrades([
    { sourceSide: 'A', trades: a },
    { sourceSide: 'B', trades: b },
  ]);
}

describe('reconcileTrades', () => {
  it('recognizes exact records with different source-local identifiers', () => {
    expect(run([trade('a1')], [trade('b1')])).toEqual([
      { outcome: 'exact_match', tradeIdsA: ['a1'], tradeIdsB: ['b1'], details: {} },
    ]);
  });

  it('compares financial values as exact scaled integers', () => {
    expect(decimalToScaledInteger('9007199254740993.0000000001')).toBe(90071992547409930000000001n);
    expect(run([trade('a1', { price: '25.5000000001' })], [trade('b1')])[0]).toMatchObject({
      outcome: 'field_mismatch',
      details: {
        differences: [{ field: 'price', valueA: '25.5000000001', valueB: '25.5000000000' }],
      },
    });
  });

  it('reports differences in comparable business fields', () => {
    expect(
      run([trade('a1')], [trade('b1', { currency: 'CAD', quantity: '11', price: '26' })])[0],
    ).toMatchObject({
      outcome: 'field_mismatch',
      details: { differences: [{ field: 'currency' }, { field: 'quantity' }, { field: 'price' }] },
    });
  });

  it('marks ambiguous candidate groups as duplicates without arbitrary pairing', () => {
    const result = run([trade('a1'), trade('a2')], [trade('b1')]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      outcome: 'duplicate',
      tradeIdsA: ['a1', 'a2'],
      tradeIdsB: ['b1'],
      details: { duplicateReasons: ['duplicate_candidate_group', 'identical_record'] },
    });
  });

  it('distinguishes repeated source identifiers from identical records', () => {
    const result = run(
      [
        trade('a1', { sourceTradeId: 'REUSED', instrument: 'ACME' }),
        trade('a2', { sourceTradeId: 'REUSED', instrument: 'OTHER' }),
      ],
      [],
    );
    expect(result).toEqual([
      {
        outcome: 'duplicate',
        tradeIdsA: ['a1', 'a2'],
        tradeIdsB: [],
        details: { duplicateReasons: ['duplicate_source_id'] },
      },
    ]);
  });

  it('distinguishes repeated identical rows with unique source identifiers', () => {
    expect(run([trade('a1'), trade('a2')], [])).toMatchObject([
      {
        outcome: 'duplicate',
        details: { duplicateReasons: ['duplicate_candidate_group', 'identical_record'] },
      },
    ]);
  });

  it('reports missing trades and excludes invalid rows from matching', () => {
    const invalid: ImportedTrade = {
      id: 'bad-a',
      sourceTradeId: null,
      validationStatus: 'invalid',
      validationErrors: ['invalid price'],
    };
    expect(run([trade('only-a'), invalid], [trade('only-b', { instrument: 'OTHER' })])).toEqual([
      {
        outcome: 'invalid',
        tradeIdsA: ['bad-a'],
        tradeIdsB: [],
        details: { validationErrors: ['invalid price'] },
      },
      { outcome: 'missing_in_a', tradeIdsA: [], tradeIdsB: ['only-b'], details: {} },
      { outcome: 'missing_in_b', tradeIdsA: ['only-a'], tradeIdsB: [], details: {} },
    ]);
  });

  it('is deterministic when input order changes', () => {
    const a = [trade('a3', { instrument: 'OTHER' }), trade('a1'), trade('a2')];
    const b = [trade('b2', { instrument: 'OTHER' }), trade('b1')];
    expect(run(a, b)).toEqual(run([...a].reverse(), [...b].reverse()));
  });

  it('handles large duplicate groups with stable sorted trade relationships', () => {
    const a = Array.from({ length: 1_200 }, (_, index) => trade(`a-${index}`));
    const b = Array.from({ length: 1_200 }, (_, index) => trade(`b-${index}`));
    const result = run(a, b);
    const reordered = run([...a].reverse(), [...b].reverse());

    expect(result).toEqual(reordered);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      outcome: 'duplicate',
      tradeIdsA: [...a.map(({ id }) => id)].sort(),
      tradeIdsB: [...b.map(({ id }) => id)].sort(),
      details: { duplicateReasons: ['duplicate_candidate_group', 'identical_record'] },
    });
  });

  it('rejects malformed or over-scale decimal input', () => {
    expect(() => decimalToScaledInteger('1.00000000001')).toThrow(/scale 10/);
    expect(() => decimalToScaledInteger('not-a-number')).toThrow(/Invalid decimal/);
  });
});
