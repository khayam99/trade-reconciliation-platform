import { describe, expect, it } from 'vitest';
import {
  MAX_CSV_DATA_RECORDS,
  MAX_CSV_FILE_BYTES,
  MAX_CSV_RECORD_SIZE,
  CsvParseError,
  parseTradeCsv,
} from './csv.js';
import { validateTradeCsv } from './validation.js';

const ALPHA_HEADER = 'trade_id,trade_date,instrument,side,currency,quantity,price';
const BRAVO_HEADER = 'execution_id,trade_date,symbol,direction,currency,units,unit_price';
const ALPHA_VALID = 'ALPHA-9001,2026-10-01,ACME,BUY,USD,100.0000000000,24.5000000000';
const BRAVO_VALID = 'BRAVO-5001,2026-10-01,ACME,BUY,USD,100.0000000000,24.5000000000';

function parseAlpha(dataRows: string[], header = ALPHA_HEADER) {
  return parseTradeCsv([header, ...dataRows].join('\n'), 'ALPHA');
}

function validateAlpha(dataRows: string[]) {
  return validateTradeCsv(parseAlpha(dataRows));
}

function alphaRow(overrides: Partial<Record<string, string>> = {}): string {
  const values: Record<string, string> = {
    trade_id: 'ALPHA-9001',
    trade_date: '2026-10-01',
    instrument: 'ACME',
    side: 'BUY',
    currency: 'USD',
    quantity: '100.0000000000',
    price: '24.5000000000',
    ...overrides,
  };
  return [
    values.trade_id!,
    values.trade_date!,
    values.instrument!,
    values.side!,
    values.currency!,
    values.quantity!,
    values.price!,
  ]
    .map((value) =>
      value.includes(',') || value.includes('"') || value.includes('\r') || value.includes('\n')
        ? `"${value.replaceAll('"', '""')}"`
        : value,
    )
    .join(',');
}

describe('parseTradeCsv', () => {
  it('maps valid ALPHA records into normalized fields', () => {
    const parsed = parseTradeCsv(`${ALPHA_HEADER}\n${ALPHA_VALID}\n`, 'ALPHA');
    const validated = validateTradeCsv(parsed);

    expect(parsed.rows).toHaveLength(1);
    expect(validated).toMatchObject({
      sourceSystem: 'ALPHA',
      totalRows: 1,
      validRows: 1,
      invalidRows: 0,
    });
    expect(validated.rows[0]).toMatchObject({
      rowNumber: 1,
      sourceTradeId: 'ALPHA-9001',
      tradeDate: '2026-10-01',
      instrument: 'ACME',
      side: 'BUY',
      currency: 'USD',
      quantity: '100.0000000000',
      price: '24.5000000000',
      validationStatus: 'valid',
    });
  });

  it('maps valid BRAVO source-specific headers into normalized fields', () => {
    const validated = validateTradeCsv(parseTradeCsv(`${BRAVO_HEADER}\n${BRAVO_VALID}`, 'BRAVO'));
    expect(validated.rows[0]).toMatchObject({
      sourceTradeId: 'BRAVO-5001',
      instrument: 'ACME',
      side: 'BUY',
      quantity: '100.0000000000',
      price: '24.5000000000',
      validationStatus: 'valid',
    });
  });

  it('rejects missing required headers with a typed error', () => {
    expect(() => parseTradeCsv('trade_id,trade_date\nx,2026-01-01', 'ALPHA')).toThrowError(
      expect.objectContaining({ code: 'MISSING_HEADERS' }),
    );
  });

  it('rejects duplicate headers after trimming and case normalization', () => {
    const header = `${ALPHA_HEADER}, TRADE_ID `;
    expect(() => parseAlpha([ALPHA_VALID], header)).toThrowError(
      expect.objectContaining({ code: 'DUPLICATE_HEADERS' }),
    );
  });

  it('allows additional unique headers and retains their original values', () => {
    const parsed = parseAlpha(
      ['ALPHA-9001,2026-10-01,ACME,BUY,USD,100,24.5," desk 7 "'],
      `${ALPHA_HEADER},source_note`,
    );
    const validated = validateTradeCsv(parsed);

    expect(validated.rows[0]?.validationStatus).toBe('valid');
    expect(validated.rows[0]?.rawRecord.source_note).toBe(' desk 7 ');
  });

  it('retains extra row cells under stable non-colliding raw-record keys', () => {
    const parsed = parseAlpha([`${ALPHA_VALID},extra value`]);
    expect(parsed.rows[0]?.actualFieldCount).toBe(8);
    expect(parsed.rows[0]?.rawRecord.__extra_column_1).toBe('extra value');
    expect(validateTradeCsv(parsed).rows[0]).toMatchObject({
      validationStatus: 'invalid',
      validationErrors: ['Expected 7 fields but found 8.'],
    });
  });

  it('handles UTF-8 BOMs and both Windows and Unix line endings', () => {
    const windows = Buffer.from(`\uFEFF${ALPHA_HEADER}\r\n${ALPHA_VALID}\r\n`, 'utf8');
    const unix = `${ALPHA_HEADER}\n${ALPHA_VALID}\n${ALPHA_VALID.replace('9001', '9002')}`;
    expect(validateTradeCsv(parseTradeCsv(windows, 'ALPHA')).validRows).toBe(1);
    const unixParsed = parseTradeCsv(unix, 'ALPHA');
    expect(unixParsed.rows.map((row) => row.rowNumber)).toEqual([1, 2]);
  });

  it('rejects empty and header-only files', () => {
    expect(() => parseTradeCsv('', 'ALPHA')).toThrowError(
      expect.objectContaining({ code: 'EMPTY_FILE' }),
    );
    expect(() => parseTradeCsv(`${ALPHA_HEADER}\r\n`, 'ALPHA')).toThrowError(
      expect.objectContaining({ code: 'HEADER_ONLY' }),
    );
  });

  it('rejects malformed quoting instead of silently recovering the file', () => {
    expect(() => parseAlpha(['ALPHA-1,2026-10-01,"unterminated,BUY,USD,1,2'])).toThrowError(
      expect.objectContaining({ code: 'MALFORMED_CSV' }),
    );
  });

  it('rejects invalid UTF-8 and NUL bytes', () => {
    expect(() => parseTradeCsv(Buffer.from([0xff, 0xfe]), 'ALPHA')).toThrowError(
      expect.objectContaining({ code: 'INVALID_UTF8' }),
    );
    expect(() => parseTradeCsv(`${ALPHA_HEADER}\n${ALPHA_VALID}\0`, 'ALPHA')).toThrowError(
      expect.objectContaining({ code: 'NUL_BYTE' }),
    );
  });

  it('enforces file, record, and data-record limits', () => {
    expect(() => parseTradeCsv(Buffer.alloc(MAX_CSV_FILE_BYTES + 1), 'ALPHA')).toThrowError(
      expect.objectContaining({ code: 'FILE_TOO_LARGE' }),
    );
    expect(() =>
      parseAlpha([`x,${'a'.repeat(MAX_CSV_RECORD_SIZE)},ACME,BUY,USD,1,2`]),
    ).toThrowError(expect.objectContaining({ code: 'RECORD_TOO_LARGE' }));
    const atLimit = Array.from({ length: MAX_CSV_DATA_RECORDS }, (_, index) =>
      alphaRow({ trade_id: `ALPHA-${index}` }),
    );
    expect(parseAlpha(atLimit).rows).toHaveLength(MAX_CSV_DATA_RECORDS);
    const tooManyRows = [...atLimit, alphaRow({ trade_id: 'ALPHA-OVER-LIMIT' })];
    expect(() => parseAlpha(tooManyRows)).toThrowError(
      expect.objectContaining({ code: 'TOO_MANY_RECORDS' }),
    );
  });

  it('uses logical data-record numbering, excluding headers and blank lines', () => {
    const parsed = parseTradeCsv(
      `${ALPHA_HEADER}\r\n\r\n${ALPHA_VALID}\r\n\r\n${alphaRow({ trade_id: 'A2' })}`,
      'ALPHA',
    );
    expect(parsed.rows.map((row) => row.rowNumber)).toEqual([1, 2]);
  });

  it('throws CsvParseError instances for file-level parsing failures', () => {
    try {
      parseTradeCsv('', 'ALPHA');
    } catch (error) {
      expect(error).toBeInstanceOf(CsvParseError);
      return;
    }
    throw new Error('Expected parsing to fail.');
  });
});

describe('validateTradeCsv', () => {
  it('preserves original cell values while normalizing validated values', () => {
    const csv = `${ALPHA_HEADER}\n  ALPHA-9001 ,2024-02-29, ACME ,buy,usd,00100.2500,024.500`;
    const result = validateTradeCsv(parseTradeCsv(csv, 'ALPHA'));
    const row = result.rows[0]!;

    expect(row).toMatchObject({
      validationStatus: 'valid',
      sourceTradeId: 'ALPHA-9001',
      instrument: 'ACME',
      side: 'BUY',
      currency: 'USD',
      quantity: '00100.2500',
      price: '024.500',
    });
    expect(row.rawRecord).toMatchObject({
      trade_id: '  ALPHA-9001 ',
      instrument: ' ACME ',
      side: 'buy',
      currency: 'usd',
      quantity: '00100.2500',
      price: '024.500',
    });
  });

  it.each([
    ['2025-02-29', 'INVALID_TRADE_DATE'],
    ['2024-13-01', 'INVALID_TRADE_DATE'],
    ['2024-2-01', 'INVALID_TRADE_DATE'],
    ['0000-01-01', 'INVALID_TRADE_DATE'],
  ])('rejects invalid calendar date %s', (tradeDate, expectedCode) => {
    const row = validateAlpha([alphaRow({ trade_date: tradeDate })]).rows[0]!;
    expect(row.validationStatus).toBe('invalid');
    expect(row.issues.map((entry) => entry.code)).toContain(expectedCode);
  });

  it.each([
    ['side', 'HOLD', 'INVALID_SIDE'],
    ['currency', 'US', 'INVALID_CURRENCY'],
    ['currency', 'US1', 'INVALID_CURRENCY'],
    ['instrument', '   ', 'INSTRUMENT_REQUIRED'],
    ['trade_id', '', 'SOURCE_TRADE_ID_REQUIRED'],
  ])('rejects invalid %s values', (field, value, expectedCode) => {
    const row = validateAlpha([alphaRow({ [field]: value })]).rows[0]!;
    expect(row.validationStatus).toBe('invalid');
    expect(row.issues.map((entry) => entry.code)).toContain(expectedCode);
  });

  it.each([
    ['quantity', '0', 'QUANTITY_NOT_POSITIVE'],
    ['quantity', '-1', 'QUANTITY_NOT_POSITIVE'],
    ['price', '-0.01', 'PRICE_NEGATIVE'],
    ['quantity', '1e3', 'INVALID_DECIMAL'],
    ['price', '1,000.00', 'INVALID_DECIMAL'],
    ['quantity', '1.00000000001', 'DECIMAL_SCALE_EXCEEDED'],
    ['price', '1.00000000001', 'DECIMAL_SCALE_EXCEEDED'],
    ['quantity', '100000000000000', 'DECIMAL_OUT_OF_RANGE'],
    ['price', '100000000000000.0000000000', 'DECIMAL_OUT_OF_RANGE'],
  ])('rejects invalid %s value %s', (field, value, expectedCode) => {
    const row = validateAlpha([alphaRow({ [field]: value })]).rows[0]!;
    expect(row.validationStatus).toBe('invalid');
    expect(row.issues.map((entry) => entry.code)).toContain(expectedCode);
  });

  it('accepts numeric(24,10) range and scale boundaries without floating-point conversion', () => {
    const row = validateAlpha([
      alphaRow({ quantity: '0.0000000001', price: '99999999999999.9999999999' }),
    ]).rows[0]!;
    expect(row).toMatchObject({
      validationStatus: 'valid',
      quantity: '0.0000000001',
      price: '99999999999999.9999999999',
    });
    expect(typeof row.quantity).toBe('string');
    expect(typeof row.price).toBe('string');
  });

  it('accepts a zero price while keeping quantity strictly positive', () => {
    const row = validateAlpha([alphaRow({ quantity: '0.0000000001', price: '0' })]).rows[0]!;
    expect(row).toMatchObject({
      validationStatus: 'valid',
      quantity: '0.0000000001',
      price: '0',
    });
  });

  it('retains short rows as invalid and records missing cells as null in raw_record', () => {
    const result = validateAlpha(['ALPHA-1,2026-10-01,ACME,BUY,USD,1']);
    const row = result.rows[0]!;
    expect(result).toMatchObject({ totalRows: 1, validRows: 0, invalidRows: 1 });
    expect(row.validationStatus).toBe('invalid');
    expect(row.rawRecord.price).toBeNull();
    expect(row.issues[0]?.code).toBe('FIELD_COUNT');
  });

  it('preserves repeated source IDs and identical records as separate valid rows', () => {
    const duplicate = alphaRow();
    const result = validateAlpha([duplicate, duplicate]);
    expect(result.rows).toHaveLength(2);
    expect(result.validRows).toBe(2);
    expect(result.invalidRows).toBe(0);
    expect(result.rows.map((row) => row.rowNumber)).toEqual([1, 2]);
  });

  it('returns typed issues and schema-compatible nullable values for invalid rows', () => {
    const row = validateAlpha([alphaRow({ trade_date: 'not-a-date', price: 'bad' })]).rows[0]!;
    expect(row).toMatchObject({ validationStatus: 'invalid', tradeDate: null, price: null });
    expect(row.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'INVALID_TRADE_DATE', field: 'tradeDate' }),
        expect.objectContaining({ code: 'INVALID_DECIMAL', field: 'price' }),
      ]),
    );
    expect(row.validationErrors).toEqual(row.issues.map((entry) => entry.message));
  });
});
