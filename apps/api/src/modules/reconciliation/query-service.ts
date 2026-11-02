import type { Pool } from 'pg';
import { notFoundError, validationError } from './errors.js';
import { getImportBatchValidationErrors } from '../imports/read-repository.js';
import {
  getReconciliationRun,
  listExceptions,
  listImportBatches,
  listReconciliationRuns,
  type ExceptionFilters,
  type ImportBatchFilters,
  type Pagination,
  type ReconciliationRunFilters,
} from './read-repository.js';

const MAX_LIMIT = 100;
const MAX_OFFSET = 10_000;
const DEFAULT_LIMIT = 25;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export function validatePagination(input: Partial<Pagination> = {}): Pagination {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const offset = input.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw validationError(`limit must be an integer between 1 and ${MAX_LIMIT}.`);
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw validationError('offset must be a non-negative integer.');
  }
  if (offset > MAX_OFFSET) {
    throw validationError(`offset must not exceed ${MAX_OFFSET}.`);
  }
  return { limit, offset };
}

export async function getImportBatchErrorPage(
  pool: Pool,
  batchId: string,
  input: Partial<Pagination> = {},
) {
  const validBatchId = validateUuid(batchId, 'batchId');
  const pagination = validatePagination(input);
  const page = await getImportBatchValidationErrors(pool, validBatchId!, pagination);
  if (!page) throw notFoundError('Import batch');

  return {
    items: page.rows.map((row) => ({
      rowNumber: row.rowNumber,
      sourceTradeId: row.sourceTradeId,
      errors: row.validationErrors.map(toValidationIssue),
      rawRecord: row.rawRecord,
    })),
    total: page.total,
    ...pagination,
  };
}

function toValidationIssue(value: unknown): {
  code: string;
  field: string | null;
  message: string;
} {
  if (typeof value === 'string') {
    return { code: 'LEGACY_VALIDATION_ERROR', field: null, message: value };
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const issue = value as { code?: unknown; field?: unknown; message?: unknown };
    if (typeof issue.code === 'string' && typeof issue.message === 'string') {
      return {
        code: issue.code,
        field: typeof issue.field === 'string' ? issue.field : null,
        message: issue.message,
      };
    }
  }
  return {
    code: 'VALIDATION_DETAILS_UNAVAILABLE',
    field: null,
    message: 'Validation details are unavailable.',
  };
}

function validateUuid(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (!UUID_PATTERN.test(value)) throw validationError(`${name} must be a valid UUID.`);
  return value.toLowerCase();
}

function validateEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  name: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) {
    throw validationError(`${name} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

const BATCH_SOURCES = ['ALPHA', 'BRAVO'] as const;
const BATCH_STATUSES = ['processing', 'completed', 'failed'] as const;
const RUN_STATUSES = ['processing', 'completed', 'failed'] as const;
const EXCEPTION_STATUSES = ['open', 'investigating', 'resolved', 'ignored'] as const;
const OUTCOMES = [
  'exact_match',
  'field_mismatch',
  'missing_in_a',
  'missing_in_b',
  'duplicate',
  'invalid',
] as const;

export async function getImportBatchPage(
  pool: Pool,
  input: ImportBatchFilters & Partial<Pagination> = {},
): Promise<Page<Awaited<ReturnType<typeof listImportBatches>>['items'][number]>> {
  const pagination = validatePagination(input);
  const filters = {
    source: validateEnum(input.source, BATCH_SOURCES, 'source'),
    status: validateEnum(input.status, BATCH_STATUSES, 'status'),
  };
  const result = await listImportBatches(pool, filters, pagination);
  return { ...result, ...pagination };
}

export async function getReconciliationRunPage(
  pool: Pool,
  input: ReconciliationRunFilters & Partial<Pagination> = {},
): Promise<Page<Awaited<ReturnType<typeof listReconciliationRuns>>['items'][number]>> {
  const pagination = validatePagination(input);
  const filters = {
    status: validateEnum(input.status, RUN_STATUSES, 'status'),
    batchAId: validateUuid(input.batchAId, 'batchAId'),
    batchBId: validateUuid(input.batchBId, 'batchBId'),
  };
  const result = await listReconciliationRuns(pool, filters, pagination);
  return { ...result, ...pagination };
}

export async function getReconciliationRunDetails(
  pool: Pool,
  runId: string,
  input: Partial<Pagination> = {},
) {
  const validRunId = validateUuid(runId, 'runId');
  const pagination = validatePagination(input);
  const run = await getReconciliationRun(pool, validRunId!, pagination);
  if (!run) throw notFoundError('Reconciliation run');
  return { ...run, pagination: { ...pagination, total: run.run.resultCount } };
}

export async function getExceptionPage(
  pool: Pool,
  input: ExceptionFilters & Partial<Pagination> = {},
): Promise<Page<Awaited<ReturnType<typeof listExceptions>>['items'][number]>> {
  const pagination = validatePagination(input);
  const filters = {
    status: validateEnum(input.status, EXCEPTION_STATUSES, 'status'),
    outcome: validateEnum(input.outcome, OUTCOMES, 'outcome'),
    runId: validateUuid(input.runId, 'runId'),
  };
  const result = await listExceptions(pool, filters, pagination);
  return { ...result, ...pagination };
}

export { validationError };
