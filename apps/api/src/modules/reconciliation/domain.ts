export type TradeSide = 'A' | 'B';
export type TradeDirection = 'BUY' | 'SELL';

export interface TradeFields {
  tradeDate: string;
  instrument: string;
  side: TradeDirection;
  currency: string;
  quantity: string;
  price: string;
}

export interface ValidTrade extends TradeFields {
  id: string;
  sourceTradeId: string | null;
  validationStatus: 'valid';
}

export interface InvalidTrade {
  id: string;
  sourceTradeId: string | null;
  validationStatus: 'invalid';
  validationErrors: string[];
}

export type ImportedTrade = ValidTrade | InvalidTrade;

export interface TradeInput {
  sourceSide: TradeSide;
  trades: ImportedTrade[];
}

export type ReconciliationOutcome =
  'exact_match' | 'field_mismatch' | 'missing_in_a' | 'missing_in_b' | 'duplicate' | 'invalid';

export interface FieldDifference {
  field: 'currency' | 'quantity' | 'price';
  valueA: string;
  valueB: string;
}

export interface ReconciliationResult {
  outcome: ReconciliationOutcome;
  tradeIdsA: string[];
  tradeIdsB: string[];
  details: {
    differences?: FieldDifference[];
    duplicateReasons?: Array<
      'duplicate_source_id' | 'duplicate_candidate_group' | 'identical_record'
    >;
    validationErrors?: string[];
  };
}

const DECIMAL_SCALE = 10n;
const DECIMAL_FACTOR = 10n ** DECIMAL_SCALE;
const DECIMAL_PATTERN = /^([+-]?)(\d+)(?:\.(\d+))?$/;

/** Convert a database NUMERIC(24,10) string into exact scaled integer units. */
export function decimalToScaledInteger(value: string): bigint {
  const match = DECIMAL_PATTERN.exec(value.trim());

  if (!match) {
    throw new Error(`Invalid decimal value: ${value}`);
  }

  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > Number(DECIMAL_SCALE)) {
    throw new Error(`Decimal value exceeds scale 10: ${value}`);
  }

  const scaled = BigInt(whole!) * DECIMAL_FACTOR + BigInt(fraction.padEnd(10, '0') || '0');
  return sign === '-' ? -scaled : scaled;
}

function canonicalDecimal(value: string): string {
  const scaled = decimalToScaledInteger(value);
  const negative = scaled < 0n;
  const absolute = negative ? -scaled : scaled;
  const whole = absolute / DECIMAL_FACTOR;
  const fraction = (absolute % DECIMAL_FACTOR).toString().padStart(10, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

function normalized(value: string): string {
  return value.trim().toUpperCase();
}

function candidateKey(trade: ValidTrade): string {
  return JSON.stringify([trade.tradeDate, normalized(trade.instrument), trade.side]);
}

function fingerprint(trade: ValidTrade): string {
  return JSON.stringify([
    trade.tradeDate,
    normalized(trade.instrument),
    trade.side,
    normalized(trade.currency),
    canonicalDecimal(trade.quantity),
    canonicalDecimal(trade.price),
  ]);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

class DisjointSet {
  private readonly parent = new Map<string, string>();

  add(id: string): void {
    this.parent.set(id, id);
  }

  find(id: string): string {
    const parent = this.parent.get(id);
    if (parent === undefined) throw new Error(`Unknown trade id: ${id}`);
    if (parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;
    // Stable root choice makes component identity independent of input ordering.
    const [first, second] = [rootA, rootB].sort(compareStrings);
    this.parent.set(second!, first!);
  }
}

/**
 * Reconcile valid rows by candidate groups. Candidate fields are not treated as
 * proof of identity when a group is ambiguous; every row in that group becomes
 * one duplicate result. Invalid rows are emitted separately and never enter
 * candidate matching, so they cannot cause missing-trade outcomes.
 */
export function reconcileTrades(input: TradeInput[]): ReconciliationResult[] {
  const sides = new Map<TradeSide, ImportedTrade[]>([
    ['A', input.filter((item) => item.sourceSide === 'A').flatMap((item) => item.trades)],
    ['B', input.filter((item) => item.sourceSide === 'B').flatMap((item) => item.trades)],
  ]);

  const allIds = new Set<string>();
  for (const trades of sides.values()) {
    for (const trade of trades) {
      if (allIds.has(trade.id)) throw new Error(`Trade id occurs more than once: ${trade.id}`);
      allIds.add(trade.id);
    }
  }

  const validById = new Map<string, { side: TradeSide; trade: ValidTrade }>();
  const invalidResults: ReconciliationResult[] = [];
  for (const [side, trades] of sides) {
    for (const trade of trades) {
      if (trade.validationStatus === 'invalid') {
        invalidResults.push({
          outcome: 'invalid',
          tradeIdsA: side === 'A' ? [trade.id] : [],
          tradeIdsB: side === 'B' ? [trade.id] : [],
          details: { validationErrors: [...trade.validationErrors].sort(compareStrings) },
        });
      } else {
        // Validate decimal syntax before grouping, including rows that will be single-sided.
        decimalToScaledInteger(trade.quantity);
        decimalToScaledInteger(trade.price);
        validById.set(trade.id, { side, trade });
      }
    }
  }

  const sets = new DisjointSet();
  for (const id of validById.keys()) sets.add(id);
  const duplicateReasons = new Map<
    string,
    Set<'duplicate_source_id' | 'duplicate_candidate_group' | 'identical_record'>
  >();
  const addReason = (
    id: string,
    reason: 'duplicate_source_id' | 'duplicate_candidate_group' | 'identical_record',
  ) => {
    const reasons = duplicateReasons.get(id) ?? new Set();
    reasons.add(reason);
    duplicateReasons.set(id, reasons);
  };

  const candidateGroups = new Map<string, string[]>();
  const sourceGroups = new Map<string, string[]>();
  const identicalGroups = new Map<string, string[]>();
  const addToGroup = (groups: Map<string, string[]>, key: string, id: string) => {
    const group = groups.get(key);
    if (group) group.push(id);
    else groups.set(key, [id]);
  };

  for (const { side, trade } of validById.values()) {
    const candidate = candidateKey(trade);
    addToGroup(candidateGroups, candidate, trade.id);

    const sourceId = trade.sourceTradeId?.trim();
    if (sourceId) {
      const key = JSON.stringify([side, sourceId]);
      addToGroup(sourceGroups, key, trade.id);
    }

    const identical = JSON.stringify([side, fingerprint(trade)]);
    addToGroup(identicalGroups, identical, trade.id);
  }

  const connectGroup = (ids: string[]) => {
    ids.sort(compareStrings);
    for (let index = 1; index < ids.length; index += 1) sets.union(ids[0]!, ids[index]!);
  };

  for (const ids of candidateGroups.values()) {
    const group = ids.map((id) => validById.get(id)!);
    const countA = group.filter((entry) => entry.side === 'A').length;
    const countB = group.length - countA;
    if (countA > 1 || countB > 1) {
      connectGroup(ids);
      ids.forEach((id) => addReason(id, 'duplicate_candidate_group'));
    } else if (countA === 1 && countB === 1) {
      connectGroup(ids);
    }
  }
  for (const ids of sourceGroups.values()) {
    if (ids.length > 1) {
      connectGroup(ids);
      ids.forEach((id) => addReason(id, 'duplicate_source_id'));
    }
  }
  for (const ids of identicalGroups.values()) {
    if (ids.length > 1) {
      connectGroup(ids);
      ids.forEach((id) => addReason(id, 'identical_record'));
    }
  }

  const components = new Map<string, string[]>();
  for (const id of validById.keys()) {
    const root = sets.find(id);
    addToGroup(components, root, id);
  }

  const results: ReconciliationResult[] = [];
  for (const component of components.values()) {
    const orderedIds = component.sort(compareStrings);
    const entries = orderedIds.map((id) => ({ id, ...validById.get(id)! }));
    const idsA = entries.filter((entry) => entry.side === 'A').map((entry) => entry.id);
    const idsB = entries.filter((entry) => entry.side === 'B').map((entry) => entry.id);
    const reasons = new Set(
      entries.flatMap((entry) => [...(duplicateReasons.get(entry.id) ?? [])]),
    );

    if (idsA.length > 1 || idsB.length > 1 || reasons.size > 0) {
      results.push({
        outcome: 'duplicate',
        tradeIdsA: idsA,
        tradeIdsB: idsB,
        details: { duplicateReasons: [...reasons].sort(compareStrings) },
      });
      continue;
    }

    if (idsA.length === 0 || idsB.length === 0) {
      results.push({
        outcome: idsA.length === 0 ? 'missing_in_a' : 'missing_in_b',
        tradeIdsA: idsA,
        tradeIdsB: idsB,
        details: {},
      });
      continue;
    }

    const tradeA = validById.get(idsA[0]!)!.trade;
    const tradeB = validById.get(idsB[0]!)!.trade;
    const differences: FieldDifference[] = [];
    const currencyA = normalized(tradeA.currency);
    const currencyB = normalized(tradeB.currency);
    if (currencyA !== currencyB)
      differences.push({ field: 'currency', valueA: currencyA, valueB: currencyB });
    const quantityA = canonicalDecimal(tradeA.quantity);
    const quantityB = canonicalDecimal(tradeB.quantity);
    if (decimalToScaledInteger(quantityA) !== decimalToScaledInteger(quantityB)) {
      differences.push({ field: 'quantity', valueA: quantityA, valueB: quantityB });
    }
    const priceA = canonicalDecimal(tradeA.price);
    const priceB = canonicalDecimal(tradeB.price);
    if (decimalToScaledInteger(priceA) !== decimalToScaledInteger(priceB)) {
      differences.push({ field: 'price', valueA: priceA, valueB: priceB });
    }
    results.push({
      outcome: differences.length === 0 ? 'exact_match' : 'field_mismatch',
      tradeIdsA: idsA,
      tradeIdsB: idsB,
      details: differences.length ? { differences } : {},
    });
  }

  const sortResult = (a: ReconciliationResult, b: ReconciliationResult) =>
    compareStrings(
      JSON.stringify([a.outcome, a.tradeIdsA, a.tradeIdsB, a.details]),
      JSON.stringify([b.outcome, b.tradeIdsA, b.tradeIdsB, b.details]),
    );
  return [...results, ...invalidResults].sort(sortResult);
}
