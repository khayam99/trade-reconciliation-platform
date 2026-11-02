import { Router, type Request } from 'express';
import type { Pool } from 'pg';
import {
  getExceptionPage,
  getImportBatchPage,
  getReconciliationRunDetails,
  getReconciliationRunPage,
} from './query-service.js';
import { validationError } from './errors.js';
import { runReconciliation } from './service.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function queryString(request: Request, name: string): string | undefined {
  const value: unknown = request.query[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw validationError(`${name} must be a single string value.`);
  return value;
}

function assertAllowedQueryParameters(request: Request, allowed: string[]): void {
  const unexpected = Object.keys(request.query).filter((key) => !allowed.includes(key));
  if (unexpected.length) {
    throw validationError(`Unsupported query parameter: ${unexpected.sort()[0]}.`);
  }
}

function optionalUuid(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (!UUID_PATTERN.test(value)) throw validationError(`${name} must be a valid UUID.`);
  return value.toLowerCase();
}

function pathUuid(value: string, name: string): string {
  return optionalUuid(value, name)!;
}

function pagination(request: Request): { limit?: number; offset?: number } {
  const parse = (name: 'limit' | 'offset'): number | undefined => {
    const raw = queryString(request, name);
    if (raw === undefined) return undefined;
    if (!/^\d+$/.test(raw)) throw validationError(`${name} must be an integer.`);
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) throw validationError(`${name} must be a safe integer.`);
    return parsed;
  };
  return { limit: parse('limit'), offset: parse('offset') };
}

function paginationEnvelope(page: { limit: number; offset: number; total: number }) {
  return { limit: page.limit, offset: page.offset, total: page.total };
}

export function createReconciliationRouter(pool: Pool): Router {
  const router = Router();

  router.get('/import-batches', async (request, response) => {
    assertAllowedQueryParameters(request, ['source', 'status', 'limit', 'offset']);
    const page = await getImportBatchPage(pool, {
      ...pagination(request),
      source: queryString(request, 'source') as 'ALPHA' | 'BRAVO' | undefined,
      status: queryString(request, 'status') as 'processing' | 'completed' | 'failed' | undefined,
    });
    response.status(200).json({ data: page.items, pagination: paginationEnvelope(page) });
  });

  router.post('/reconciliation-runs', async (request, response) => {
    const body: unknown = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw validationError('Request body must be a JSON object.');
    }
    const record = body as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length !== 2 || keys[0] !== 'batchAId' || keys[1] !== 'batchBId') {
      throw validationError('Request body must contain only batchAId and batchBId.');
    }
    if (typeof record.batchAId !== 'string' || typeof record.batchBId !== 'string') {
      throw validationError('batchAId and batchBId must be UUID strings.');
    }
    const batchAId = pathUuid(record.batchAId, 'batchAId');
    const batchBId = pathUuid(record.batchBId, 'batchBId');
    const summary = await runReconciliation(pool, batchAId, batchBId);
    response.status(201).json({ data: { ...summary, status: 'completed' } });
  });

  router.get('/reconciliation-runs', async (request, response) => {
    assertAllowedQueryParameters(request, ['status', 'batchAId', 'batchBId', 'limit', 'offset']);
    const page = await getReconciliationRunPage(pool, {
      ...pagination(request),
      status: queryString(request, 'status') as 'processing' | 'completed' | 'failed' | undefined,
      batchAId: optionalUuid(queryString(request, 'batchAId'), 'batchAId'),
      batchBId: optionalUuid(queryString(request, 'batchBId'), 'batchBId'),
    });
    response.status(200).json({ data: page.items, pagination: paginationEnvelope(page) });
  });

  router.get('/reconciliation-runs/:runId', async (request, response) => {
    assertAllowedQueryParameters(request, ['limit', 'offset']);
    const run = await getReconciliationRunDetails(
      pool,
      pathUuid(request.params.runId, 'runId'),
      pagination(request),
    );
    response.status(200).json({ data: run });
  });

  router.get('/exceptions', async (request, response) => {
    assertAllowedQueryParameters(request, ['status', 'outcome', 'runId', 'limit', 'offset']);
    const page = await getExceptionPage(pool, {
      ...pagination(request),
      status: queryString(request, 'status') as
        'open' | 'investigating' | 'resolved' | 'ignored' | undefined,
      outcome: queryString(request, 'outcome') as
        | 'exact_match'
        | 'field_mismatch'
        | 'missing_in_a'
        | 'missing_in_b'
        | 'duplicate'
        | 'invalid'
        | undefined,
      runId: optionalUuid(queryString(request, 'runId'), 'runId'),
    });
    response.status(200).json({ data: page.items, pagination: paginationEnvelope(page) });
  });

  return router;
}
