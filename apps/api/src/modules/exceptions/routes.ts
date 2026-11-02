import { Router, type Request } from 'express';
import type { Pool } from 'pg';
import { exceptionValidationError } from './errors.js';
import {
  changeExceptionStatus,
  getExceptionAuditEventPage,
  getExceptionDetails,
} from './service.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function exceptionId(request: Request): string {
  const value = request.params.exceptionId;
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw exceptionValidationError('exceptionId must be a valid UUID.');
  }
  return value.toLowerCase();
}

function queryString(request: Request, name: string): string | undefined {
  const value: unknown = request.query[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw exceptionValidationError(`${name} must be a single string value.`);
  }
  return value;
}

function pagination(request: Request): { limit?: number; offset?: number } {
  const parse = (name: 'limit' | 'offset'): number | undefined => {
    const raw = queryString(request, name);
    if (raw === undefined) return undefined;
    if (!/^\d+$/.test(raw)) throw exceptionValidationError(`${name} must be an integer.`);
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) {
      throw exceptionValidationError(`${name} must be a safe integer.`);
    }
    return parsed;
  };
  return { limit: parse('limit'), offset: parse('offset') };
}

function reasonBody(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw exceptionValidationError('Request body must be a JSON object containing only reason.');
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Object.hasOwn(record, 'reason')) {
    throw exceptionValidationError('Request body must contain only reason.');
  }
  return record.reason;
}

export function createExceptionRouter(pool: Pool): Router {
  const router = Router();

  router.get('/exceptions/:exceptionId', async (request, response) => {
    const exception = await getExceptionDetails(pool, exceptionId(request));
    response.status(200).json({ data: exception });
  });

  router.get('/exceptions/:exceptionId/audit-events', async (request, response) => {
    const unexpected = Object.keys(request.query).filter(
      (key) => key !== 'limit' && key !== 'offset',
    );
    if (unexpected.length) {
      throw exceptionValidationError(`Unsupported query parameter: ${unexpected.sort()[0]}.`);
    }
    const page = await getExceptionAuditEventPage(pool, exceptionId(request), pagination(request));
    response.status(200).json({
      data: page.items,
      pagination: { limit: page.limit, offset: page.offset, total: page.total },
    });
  });

  router.post('/exceptions/:exceptionId/resolve', async (request, response) => {
    const result = await changeExceptionStatus(
      pool,
      exceptionId(request),
      'resolve',
      reasonBody(request.body),
    );
    response.status(200).json({ data: result });
  });

  router.post('/exceptions/:exceptionId/reopen', async (request, response) => {
    const result = await changeExceptionStatus(
      pool,
      exceptionId(request),
      'reopen',
      reasonBody(request.body),
    );
    response.status(200).json({ data: result });
  });

  return router;
}
