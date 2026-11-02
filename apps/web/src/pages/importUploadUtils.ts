import { ApiClientError } from '../api/client';

export const MAX_CSV_UPLOAD_BYTES = 5 * 1024 * 1024;

const ACCEPTED_CSV_TYPES = new Set(['text/csv', 'application/csv', 'application/vnd.ms-excel']);

export function validateCsvUploadFile(file: Pick<File, 'name' | 'size' | 'type'>): string | null {
  if (file.size === 0)
    return 'The selected file is empty. Choose a CSV with a header and data rows.';
  if (file.size > MAX_CSV_UPLOAD_BYTES) return 'CSV files must be 5 MiB or smaller.';
  if (!file.name.toLowerCase().endsWith('.csv')) return 'Choose a file with the .csv extension.';
  if (file.type && !ACCEPTED_CSV_TYPES.has(file.type.toLowerCase())) {
    return 'Choose a CSV file. This file type is not supported.';
  }
  return null;
}

export function safeImportErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (
      error.status === 413 ||
      error.code === 'LIMIT_FILE_SIZE' ||
      error.code === 'FILE_TOO_LARGE'
    ) {
      return 'This CSV is larger than the 5 MiB upload limit.';
    }
    if (error.status === 415 || error.code === 'UNSUPPORTED_FILE_TYPE') {
      return 'Choose a CSV file in a supported format.';
    }
    if (error.code === 'EMPTY_FILE' || error.code === 'HEADER_ONLY') {
      return 'The CSV must contain a header row and at least one data row.';
    }
    if (error.code === 'MALFORMED_CSV' || error.code === 'MALFORMED_MULTIPART') {
      return 'The file could not be read. Check that it is a well-formed CSV and try again.';
    }
    if (error.code === 'MISSING_HEADERS' || error.code === 'DUPLICATE_HEADERS') {
      return 'The CSV headers do not match the selected source format.';
    }
    if (error.status === 400 || error.code === 'VALIDATION_ERROR') {
      return 'The upload was not accepted. Check the selected source and CSV format.';
    }
    if (error.status === 404 || error.code === 'RESOURCE_NOT_FOUND') {
      return 'This batch could not be found. Refresh the batch list and try again.';
    }
    return 'The server could not complete the request. Try again in a moment.';
  }
  return 'Could not reach the server. Check your connection and try again.';
}
