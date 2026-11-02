export type ServiceErrorCode =
  | 'VALIDATION_ERROR'
  | 'RESOURCE_NOT_FOUND'
  | 'BATCH_NOT_COMPLETED'
  | 'INVALID_BATCH_PAIR'
  | 'BATCH_HAS_NO_VALID_TRADES';

export class ReconciliationServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
    readonly statusCode: 400 | 404 | 409,
  ) {
    super(message);
    this.name = 'ReconciliationServiceError';
  }
}

export function validationError(message: string): ReconciliationServiceError {
  return new ReconciliationServiceError('VALIDATION_ERROR', message, 400);
}

export function notFoundError(resource: string): ReconciliationServiceError {
  return new ReconciliationServiceError('RESOURCE_NOT_FOUND', `${resource} was not found.`, 404);
}

export function batchNotCompletedError(): ReconciliationServiceError {
  return new ReconciliationServiceError(
    'BATCH_NOT_COMPLETED',
    'Both import batches must be completed before reconciliation.',
    409,
  );
}

export function invalidBatchPairError(): ReconciliationServiceError {
  return new ReconciliationServiceError(
    'INVALID_BATCH_PAIR',
    'Batch A must be ALPHA and batch B must be BRAVO, using different batch IDs.',
    409,
  );
}

export function batchHasNoValidTradesError(): ReconciliationServiceError {
  return new ReconciliationServiceError(
    'BATCH_HAS_NO_VALID_TRADES',
    'Both import batches must contain at least one valid trade for reconciliation.',
    409,
  );
}
