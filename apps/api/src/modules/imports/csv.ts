import { CsvError } from 'csv-parse';
import { parse } from 'csv-parse/sync';

export type ImportSourceSystem = 'ALPHA' | 'BRAVO';
export type CanonicalCsvField =
  'sourceTradeId' | 'tradeDate' | 'instrument' | 'side' | 'currency' | 'quantity' | 'price';

export const MAX_CSV_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_CSV_DATA_RECORDS = 10_000;
export const MAX_CSV_RECORD_SIZE = 64 * 1024;

const SOURCE_COLUMNS: Record<ImportSourceSystem, Record<CanonicalCsvField, string>> = {
  ALPHA: {
    sourceTradeId: 'trade_id',
    tradeDate: 'trade_date',
    instrument: 'instrument',
    side: 'side',
    currency: 'currency',
    quantity: 'quantity',
    price: 'price',
  },
  BRAVO: {
    sourceTradeId: 'execution_id',
    tradeDate: 'trade_date',
    instrument: 'symbol',
    side: 'direction',
    currency: 'currency',
    quantity: 'units',
    price: 'unit_price',
  },
};

export interface ParsedCsvRow {
  /** One-based logical data-record number; the header and blank lines are excluded. */
  rowNumber: number;
  /** CSV cells under their original header names. Missing cells are null. */
  rawRecord: Record<string, string | null>;
  /** Source-specific cells mapped to the application's normalized trade fields. */
  fields: Record<CanonicalCsvField, string | null>;
  expectedFieldCount: number;
  actualFieldCount: number;
}

export interface ParsedTradeCsv {
  sourceSystem: ImportSourceSystem;
  headers: string[];
  rows: ParsedCsvRow[];
}

export type CsvParseErrorCode =
  | 'EMPTY_FILE'
  | 'HEADER_ONLY'
  | 'INVALID_UTF8'
  | 'MALFORMED_CSV'
  | 'FILE_TOO_LARGE'
  | 'TOO_MANY_RECORDS'
  | 'RECORD_TOO_LARGE'
  | 'NUL_BYTE'
  | 'INVALID_HEADERS'
  | 'DUPLICATE_HEADERS'
  | 'MISSING_HEADERS';

export class CsvParseError extends Error {
  constructor(
    readonly code: CsvParseErrorCode,
    message: string,
    readonly details?: string[],
  ) {
    super(message);
    this.name = 'CsvParseError';
  }
}

function decodeCsv(input: string | Uint8Array): string {
  const byteLength =
    typeof input === 'string' ? Buffer.byteLength(input, 'utf8') : input.byteLength;
  if (byteLength > MAX_CSV_FILE_BYTES) {
    throw new CsvParseError(
      'FILE_TOO_LARGE',
      `CSV file exceeds the ${MAX_CSV_FILE_BYTES}-byte limit.`,
    );
  }
  if (byteLength === 0) throw new CsvParseError('EMPTY_FILE', 'CSV file is empty.');

  let text: string;
  try {
    text =
      typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch {
    throw new CsvParseError('INVALID_UTF8', 'CSV file must contain valid UTF-8 text.');
  }

  if (text.trim().length === 0) throw new CsvParseError('EMPTY_FILE', 'CSV file is empty.');
  if (text.includes('\0')) {
    throw new CsvParseError('NUL_BYTE', 'CSV file contains a NUL character that cannot be stored.');
  }
  return text;
}

function parseRecords(text: string): string[][] {
  try {
    return parse(text, {
      bom: true,
      cast: false,
      columns: false,
      max_record_size: MAX_CSV_RECORD_SIZE,
      relax_column_count: true,
      skip_empty_lines: true,
      trim: false,
    });
  } catch (error) {
    if (error instanceof CsvError && error.code === 'CSV_MAX_RECORD_SIZE') {
      throw new CsvParseError(
        'RECORD_TOO_LARGE',
        `A CSV record exceeds the ${MAX_CSV_RECORD_SIZE}-character limit.`,
      );
    }
    throw new CsvParseError(
      'MALFORMED_CSV',
      'CSV structure is malformed. Check quoting, escaping, and record separators.',
    );
  }
}

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase();
}

function getHeaderIndexes(
  sourceSystem: ImportSourceSystem,
  headers: string[],
): Map<CanonicalCsvField, number> {
  const normalizedHeaders = headers.map(normalizeHeader);
  if (normalizedHeaders.some((header) => header.length === 0)) {
    throw new CsvParseError('INVALID_HEADERS', 'CSV headers must not be empty.');
  }

  const seenHeaders = new Set<string>();
  const duplicates = new Set<string>();
  for (const header of normalizedHeaders) {
    if (seenHeaders.has(header)) duplicates.add(header);
    seenHeaders.add(header);
  }
  if (duplicates.size > 0) {
    const names = [...duplicates].sort();
    throw new CsvParseError(
      'DUPLICATE_HEADERS',
      `CSV contains duplicate headers: ${names.join(', ')}.`,
      names,
    );
  }

  const indexes = new Map<CanonicalCsvField, number>();
  const missing: string[] = [];
  for (const [field, expectedHeader] of Object.entries(SOURCE_COLUMNS[sourceSystem]) as Array<
    [CanonicalCsvField, string]
  >) {
    const index = normalizedHeaders.indexOf(expectedHeader);
    if (index === -1) missing.push(expectedHeader);
    else indexes.set(field, index);
  }
  if (missing.length > 0) {
    throw new CsvParseError(
      'MISSING_HEADERS',
      `CSV is missing required ${sourceSystem} headers: ${missing.join(', ')}.`,
      missing,
    );
  }
  return indexes;
}

function uniqueExtraKey(headers: string[], suffix: number): string {
  let key = `__extra_column_${suffix}`;
  while (headers.includes(key)) key = `_${key}`;
  return key;
}

/** Parse a CSV file and map the ALPHA/BRAVO source headers to normalized fields. */
export function parseTradeCsv(
  input: string | Uint8Array,
  sourceSystem: ImportSourceSystem,
): ParsedTradeCsv {
  const text = decodeCsv(input);
  const records = parseRecords(text);
  if (records.length === 0) throw new CsvParseError('EMPTY_FILE', 'CSV file has no header row.');

  const headers = records[0]!.map((header) => header);
  const headerIndexes = getHeaderIndexes(sourceSystem, headers);
  const dataRows = records.slice(1);
  if (dataRows.length === 0) {
    throw new CsvParseError('HEADER_ONLY', 'CSV file contains headers but no data records.');
  }
  if (dataRows.length > MAX_CSV_DATA_RECORDS) {
    throw new CsvParseError(
      'TOO_MANY_RECORDS',
      `CSV file exceeds the ${MAX_CSV_DATA_RECORDS}-data-record limit.`,
    );
  }

  const rows = dataRows.map((cells, index): ParsedCsvRow => {
    const rawRecord: Record<string, string | null> = {};
    headers.forEach((header, columnIndex) => {
      rawRecord[header] = cells[columnIndex] ?? null;
    });
    for (let columnIndex = headers.length; columnIndex < cells.length; columnIndex += 1) {
      rawRecord[uniqueExtraKey(Object.keys(rawRecord), columnIndex - headers.length + 1)] =
        cells[columnIndex] ?? null;
    }

    const fields = {} as Record<CanonicalCsvField, string | null>;
    for (const [field, columnIndex] of headerIndexes) {
      fields[field] = cells[columnIndex] ?? null;
    }

    return {
      rowNumber: index + 1,
      rawRecord,
      fields,
      expectedFieldCount: headers.length,
      actualFieldCount: cells.length,
    };
  });

  return { sourceSystem, headers, rows };
}
