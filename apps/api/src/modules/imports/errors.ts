export class ImportApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: 400 | 413 | 415,
  ) {
    super(message);
    this.name = 'ImportApiError';
  }
}
