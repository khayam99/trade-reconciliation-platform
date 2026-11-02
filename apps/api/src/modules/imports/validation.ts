import type { CanonicalCsvField, ImportSourceSystem, ParsedCsvRow, ParsedTradeCsv } from './csv.js';

export type TradeDirection = 'BUY' | 'SELL';

export type TradeRowIssueCode =
  | 'FIELD_COUNT'
  | 'SOURCE_TRADE_ID_REQUIRED'
  | 'INVALID_TRADE_DATE'
  | 'INSTRUMENT_REQUIRED'
  | 'INVALID_SIDE'
  | 'INVALID_CURRENCY'
  | 'INVALID_DECIMAL'
  | 'DECIMAL_SCALE_EXCEEDED'
  | 'DECIMAL_OUT_OF_RANGE'
  | 'QUANTITY_NOT_POSITIVE'
  | 'PRICE_NEGATIVE';

export interface TradeRowIssue {
  code: TradeRowIssueCode;
  field: CanonicalCsvField | null;
  message: string;
}

interface ImportTradeRowBase {
  /** One-based logical data-record number, excluding headers and blank lines. */
  rowNumber: number;
  sourceTradeId: string | null;
  tradeDate: string | null;
  instrument: string | null;
  side: TradeDirection | null;
  currency: string | null;
  /** Decimal text remains exact; the persistence layer can pass it to PostgreSQL NUMERIC. */
  quantity: string | null;
  /** Decimal text remains exact; the persistence layer can pass it to PostgreSQL NUMERIC. */
  price: string | null;
  validationErrors: string[];
  issues: TradeRowIssue[];
  rawRecord: Record<string, string | null>;
}

export interface ValidImportTradeRow extends ImportTradeRowBase {
  validationStatus: 'valid';
  sourceTradeId: string;
  tradeDate: string;
  instrument: string;
  side: TradeDirection;
  currency: string;
  quantity: string;
  price: string;
  validationErrors: [];
  issues: [];
}

export interface InvalidImportTradeRow extends ImportTradeRowBase {
  validationStatus: 'invalid';
  validationErrors: string[];
  issues: TradeRowIssue[];
}

export type ValidatedImportTradeRow = ValidImportTradeRow | InvalidImportTradeRow;

export interface ValidatedTradeCsv {
  sourceSystem: ImportSourceSystem;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  rows: ValidatedImportTradeRow[];
}

const DECIMAL_PATTERN = /^([+-]?)(\d+)(?:\.(\d+))?$/;
const MAX_NUMERIC_SCALED = 10n ** 24n;
const DECIMAL_FACTOR = 10n ** 10n;

interface DecimalCheck {
  scaled: bigint | null;
  normalizedText: string | null;
  issue: TradeRowIssue | null;
}

function issue(
  code: TradeRowIssueCode,
  field: CanonicalCsvField | null,
  message: string,
): TradeRowIssue {
  return { code, field, message };
}

function checkDecimal(value: string | null, field: 'quantity' | 'price'): DecimalCheck {
  if (value === null || value.trim().length === 0) {
    return {
      scaled: null,
      normalizedText: null,
      issue: issue('INVALID_DECIMAL', field, `${field} is required and must be a decimal value.`),
    };
  }

  const normalizedText = value.trim();
  const match = DECIMAL_PATTERN.exec(normalizedText);
  if (!match) {
    return {
      scaled: null,
      normalizedText: null,
      issue: issue(
        'INVALID_DECIMAL',
        field,
        `${field} must use plain decimal notation without exponent or grouping separators.`,
      ),
    };
  }

  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > 10) {
    return {
      scaled: null,
      normalizedText: null,
      issue: issue(
        'DECIMAL_SCALE_EXCEEDED',
        field,
        `${field} may have no more than 10 digits after the decimal point.`,
      ),
    };
  }

  const significantWhole = whole!.replace(/^0+(?=\d)/, '');
  if (significantWhole.length > 14) {
    return {
      scaled: null,
      normalizedText: null,
      issue: issue(
        'DECIMAL_OUT_OF_RANGE',
        field,
        `${field} exceeds PostgreSQL numeric(24,10) range.`,
      ),
    };
  }

  const unsignedScaled =
    BigInt(significantWhole) * DECIMAL_FACTOR + BigInt(fraction.padEnd(10, '0') || '0');
  const scaled = sign === '-' ? -unsignedScaled : unsignedScaled;
  if (scaled <= -MAX_NUMERIC_SCALED || scaled >= MAX_NUMERIC_SCALED) {
    return {
      scaled: null,
      normalizedText: null,
      issue: issue(
        'DECIMAL_OUT_OF_RANGE',
        field,
        `${field} exceeds PostgreSQL numeric(24,10) range.`,
      ),
    };
  }

  return { scaled, normalizedText, issue: null };
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1]!;
}

function validateRow(row: ParsedCsvRow): ValidatedImportTradeRow {
  const errors: TradeRowIssue[] = [];
  if (row.actualFieldCount !== row.expectedFieldCount) {
    errors.push(
      issue(
        'FIELD_COUNT',
        null,
        `Expected ${row.expectedFieldCount} fields but found ${row.actualFieldCount}.`,
      ),
    );
  }

  const sourceTradeId = row.fields.sourceTradeId?.trim() || null;
  if (sourceTradeId === null) {
    errors.push(issue('SOURCE_TRADE_ID_REQUIRED', 'sourceTradeId', 'Source trade ID is required.'));
  }

  const dateText = row.fields.tradeDate?.trim() ?? '';
  const tradeDate = isCalendarDate(dateText) ? dateText : null;
  if (tradeDate === null) {
    errors.push(
      issue(
        'INVALID_TRADE_DATE',
        'tradeDate',
        'Trade date must be a valid ISO calendar date (YYYY-MM-DD).',
      ),
    );
  }

  const instrument = row.fields.instrument?.trim() || null;
  if (instrument === null) {
    errors.push(issue('INSTRUMENT_REQUIRED', 'instrument', 'Instrument must not be empty.'));
  }

  const sideText = row.fields.side?.trim().toUpperCase() ?? '';
  const side: TradeDirection | null = sideText === 'BUY' || sideText === 'SELL' ? sideText : null;
  if (side === null) {
    errors.push(issue('INVALID_SIDE', 'side', 'Side must be BUY or SELL.'));
  }

  const currencyText = row.fields.currency?.trim() ?? '';
  const currency = /^[A-Za-z]{3}$/.test(currencyText) ? currencyText.toUpperCase() : null;
  if (currency === null) {
    errors.push(issue('INVALID_CURRENCY', 'currency', 'Currency must be a three-letter code.'));
  }

  const quantityCheck = checkDecimal(row.fields.quantity, 'quantity');
  if (quantityCheck.issue) errors.push(quantityCheck.issue);
  else if (quantityCheck.scaled! <= 0n) {
    errors.push(issue('QUANTITY_NOT_POSITIVE', 'quantity', 'Quantity must be greater than zero.'));
  }

  const priceCheck = checkDecimal(row.fields.price, 'price');
  if (priceCheck.issue) errors.push(priceCheck.issue);
  else if (priceCheck.scaled! < 0n) {
    errors.push(issue('PRICE_NEGATIVE', 'price', 'Price must be zero or greater.'));
  }

  const base = {
    rowNumber: row.rowNumber,
    sourceTradeId,
    tradeDate,
    instrument,
    side,
    currency,
    quantity: quantityCheck.issue ? null : quantityCheck.normalizedText,
    price: priceCheck.issue ? null : priceCheck.normalizedText,
    rawRecord: row.rawRecord,
  };

  if (errors.length > 0) {
    return {
      ...base,
      validationStatus: 'invalid',
      validationErrors: errors.map((entry) => entry.message),
      issues: errors,
    };
  }

  return {
    ...base,
    validationStatus: 'valid',
    sourceTradeId: sourceTradeId!,
    tradeDate: tradeDate!,
    instrument: instrument!,
    side: side!,
    currency: currency!,
    quantity: quantityCheck.normalizedText!,
    price: priceCheck.normalizedText!,
    validationErrors: [],
    issues: [],
  };
}

/** Validate parsed rows without I/O; invalid records are returned, not discarded. */
export function validateTradeCsv(parsed: ParsedTradeCsv): ValidatedTradeCsv {
  const rows = parsed.rows.map(validateRow);
  const validRows = rows.filter((row) => row.validationStatus === 'valid').length;
  return {
    sourceSystem: parsed.sourceSystem,
    totalRows: rows.length,
    validRows,
    invalidRows: rows.length - validRows,
    rows,
  };
}
