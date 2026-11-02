import { exceptionValidationError, invalidExceptionTransitionError } from './errors.js';

export type ExceptionStatus = 'open' | 'investigating' | 'resolved' | 'ignored';
export type ExceptionAction = 'resolve' | 'reopen';

export function validateReason(reason: unknown): string {
  if (typeof reason !== 'string') {
    throw exceptionValidationError('reason must be a string.');
  }
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    throw exceptionValidationError('reason must not be blank.');
  }
  if (trimmed.length > 1_000) {
    throw exceptionValidationError('reason must not exceed 1000 characters.');
  }
  return trimmed;
}

export function assertExceptionTransition(status: ExceptionStatus, action: ExceptionAction): void {
  const allowed =
    action === 'resolve' ? status === 'open' || status === 'investigating' : status === 'resolved';
  if (!allowed)
    throw invalidExceptionTransitionError(status, action === 'resolve' ? 'resolved' : 'reopened');
}
