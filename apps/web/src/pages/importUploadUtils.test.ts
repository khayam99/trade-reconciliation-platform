import { describe, expect, it } from 'vitest';
import { ApiClientError } from '../api/client';
import {
  MAX_CSV_UPLOAD_BYTES,
  safeImportErrorMessage,
  validateCsvUploadFile,
} from './importUploadUtils';

describe('CSV upload helpers', () => {
  it('accepts supported CSV files up to the 5 MiB boundary', () => {
    expect(
      validateCsvUploadFile({ name: 'alpha.CSV', size: MAX_CSV_UPLOAD_BYTES, type: 'text/csv' }),
    ).toBeNull();
    expect(
      validateCsvUploadFile({ name: 'trades.csv', size: 100, type: 'application/vnd.ms-excel' }),
    ).toBeNull();
  });

  it('rejects empty, oversized, unsupported extension, and unsupported MIME files', () => {
    expect(validateCsvUploadFile({ name: 'empty.csv', size: 0, type: 'text/csv' })).toMatch(
      /empty/,
    );
    expect(
      validateCsvUploadFile({
        name: 'large.csv',
        size: MAX_CSV_UPLOAD_BYTES + 1,
        type: 'text/csv',
      }),
    ).toMatch(/5 MiB/);
    expect(validateCsvUploadFile({ name: 'trades.txt', size: 100, type: 'text/csv' })).toMatch(
      /\.csv/,
    );
    expect(validateCsvUploadFile({ name: 'trades.csv', size: 100, type: 'text/plain' })).toMatch(
      /supported/,
    );
  });

  it('shows friendly messages without forwarding raw API or network errors', () => {
    expect(
      safeImportErrorMessage(new ApiClientError(400, 'MALFORMED_CSV', 'raw parser internals')),
    ).toMatch(/well-formed CSV/);
    expect(
      safeImportErrorMessage(new ApiClientError(500, 'INTERNAL_ERROR', 'private SQL details')),
    ).not.toContain('private SQL details');
    expect(safeImportErrorMessage(new TypeError('fetch failed'))).not.toContain('fetch failed');
  });
});
