import type { ExceptionStatus } from '../api/types';
import { ApiClientError } from '../api/client';

export type ExceptionAction = 'resolve' | 'reopen';

export function availableExceptionAction(status: ExceptionStatus): ExceptionAction | null {
  if (status === 'open' || status === 'investigating') return 'resolve';
  if (status === 'resolved') return 'reopen';
  return null;
}

export function validateExceptionReason(value: string): { reason?: string; error?: string } {
  const reason = value.trim();
  if (!reason) return { error: 'Enter a reason before continuing.' };
  if (reason.length > 1_000) return { error: 'Reason must be 1,000 characters or fewer.' };
  return { reason };
}

export function auditStatusChange(details: Record<string, unknown>): string | null {
  const previousStatus = details.previousStatus;
  const newStatus = details.newStatus;
  if (typeof previousStatus !== 'string' || typeof newStatus !== 'string') return null;
  return `${previousStatus} → ${newStatus}`;
}

export function displayValidationError(
  value: string | { field: string | null; code: string; message: string },
): string {
  if (typeof value === 'string') return value;
  const field = value.field ? `${value.field}: ` : '';
  return `${field}${value.message} (${value.code})`;
}

export function exceptionMutationErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) return error.message;
  return 'Could not save this exception. Check your connection and try again.';
}
