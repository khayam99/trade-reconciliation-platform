import { apiRequest } from './client';
import type {
  ApiDataResponse,
  ApiListResponse,
  ExceptionAuditEvent,
  ExceptionDetails,
  ExceptionMutationRequest,
  ExceptionMutationResult,
} from './types';

function exceptionPath(exceptionId: string): string {
  return `/api/exceptions/${encodeURIComponent(exceptionId)}`;
}

export function getExceptionDetails(exceptionId: string, signal?: AbortSignal) {
  return apiRequest<ApiDataResponse<ExceptionDetails>>(exceptionPath(exceptionId), { signal });
}

export function resolveException(
  exceptionId: string,
  request: ExceptionMutationRequest,
  signal?: AbortSignal,
) {
  return apiRequest<ApiDataResponse<ExceptionMutationResult>>(
    `${exceptionPath(exceptionId)}/resolve`,
    { method: 'POST', body: request, signal },
  );
}

export function reopenException(
  exceptionId: string,
  request: ExceptionMutationRequest,
  signal?: AbortSignal,
) {
  return apiRequest<ApiDataResponse<ExceptionMutationResult>>(
    `${exceptionPath(exceptionId)}/reopen`,
    { method: 'POST', body: request, signal },
  );
}

export function getExceptionAuditEvents(
  exceptionId: string,
  pagination: { limit: number; offset: number },
  signal?: AbortSignal,
) {
  return apiRequest<ApiListResponse<ExceptionAuditEvent>>(
    `${exceptionPath(exceptionId)}/audit-events`,
    { query: pagination, signal },
  );
}
