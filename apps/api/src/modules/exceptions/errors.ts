export type ExceptionServiceErrorCode =
  'VALIDATION_ERROR' | 'RESOURCE_NOT_FOUND' | 'INVALID_EXCEPTION_TRANSITION';

export class ExceptionServiceError extends Error {
  constructor(
    readonly code: ExceptionServiceErrorCode,
    message: string,
    readonly statusCode: 400 | 404 | 409,
  ) {
    super(message);
    this.name = 'ExceptionServiceError';
  }
}

export function exceptionValidationError(message: string): ExceptionServiceError {
  return new ExceptionServiceError('VALIDATION_ERROR', message, 400);
}

export function exceptionNotFoundError(): ExceptionServiceError {
  return new ExceptionServiceError('RESOURCE_NOT_FOUND', 'Exception was not found.', 404);
}

export function invalidExceptionTransitionError(
  status: string,
  action: string,
): ExceptionServiceError {
  return new ExceptionServiceError(
    'INVALID_EXCEPTION_TRANSITION',
    `An exception with status '${status}' cannot be ${action}.`,
    409,
  );
}
