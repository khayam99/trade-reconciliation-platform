import type { Pool } from 'pg';
import {
  assertExceptionTransition,
  validateReason,
  type ExceptionAction,
  type ExceptionStatus,
} from './domain.js';
import { exceptionNotFoundError, exceptionValidationError } from './errors.js';
import {
  getExceptionDetails as loadExceptionDetails,
  insertExceptionAuditEvent,
  listExceptionAuditEvents,
  lockException,
  updateExceptionStatus,
} from './repository.js';
import { validatePagination } from '../reconciliation/query-service.js';
import type { Pagination } from '../reconciliation/read-repository.js';

const AUDIT_ACTOR = 'anonymous-operator';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function changeExceptionStatus(
  pool: Pool,
  exceptionId: string,
  action: ExceptionAction,
  inputReason: unknown,
) {
  if (!UUID_PATTERN.test(exceptionId)) {
    throw exceptionValidationError('exceptionId must be a valid UUID.');
  }
  const reason = validateReason(inputReason);
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query('BEGIN');
    transactionOpen = true;

    const exception = await lockException(client, exceptionId.toLowerCase());
    if (!exception) throw exceptionNotFoundError();
    assertExceptionTransition(exception.status, action);

    const newStatus: ExceptionStatus = action === 'resolve' ? 'resolved' : 'open';
    const updatedException = await updateExceptionStatus(client, exception.id, newStatus, reason);
    const auditEvent = await insertExceptionAuditEvent(
      client,
      exception.id,
      action === 'resolve' ? 'exception_resolved' : 'exception_reopened',
      reason,
      { previousStatus: exception.status, newStatus },
    );

    await client.query('COMMIT');
    transactionOpen = false;
    return {
      exception: updatedException,
      action: {
        id: auditEvent.id,
        type: auditEvent.eventType,
        actor: AUDIT_ACTOR,
        reason: auditEvent.reason,
        previousStatus: auditEvent.details.previousStatus,
        newStatus: auditEvent.details.newStatus,
        createdAt: auditEvent.createdAt,
      },
    };
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Exception status change failed and transaction rollback also failed.',
        );
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function getExceptionDetails(pool: Pool, exceptionId: string) {
  validateExceptionId(exceptionId);
  const exception = await loadExceptionDetails(pool, exceptionId.toLowerCase());
  if (!exception) throw exceptionNotFoundError();
  return exception;
}

export async function getExceptionAuditEventPage(
  pool: Pool,
  exceptionId: string,
  input: Partial<Pagination> = {},
) {
  validateExceptionId(exceptionId);
  const pagination = validatePagination(input);
  const page = await listExceptionAuditEvents(pool, exceptionId.toLowerCase(), pagination);
  if (!page.exceptionExists) throw exceptionNotFoundError();
  return { items: page.items, total: page.total, ...pagination };
}

function validateExceptionId(exceptionId: string): void {
  if (!UUID_PATTERN.test(exceptionId)) {
    throw exceptionValidationError('exceptionId must be a valid UUID.');
  }
}
