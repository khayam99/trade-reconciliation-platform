import express, { type ErrorRequestHandler, type Express } from 'express';
import type { Pool } from 'pg';
import { ReconciliationServiceError } from './modules/reconciliation/errors.js';
import { createReconciliationRouter } from './modules/reconciliation/routes.js';
import { CsvParseError } from './modules/imports/csv.js';
import { ImportApiError } from './modules/imports/errors.js';
import { createImportRouter } from './modules/imports/routes.js';
import { ExceptionServiceError } from './modules/exceptions/errors.js';
import { createExceptionRouter } from './modules/exceptions/routes.js';

const bodyParserErrors: Record<string, { status: number; code: string; message: string }> = {
  'entity.parse.failed': {
    status: 400,
    code: 'INVALID_JSON',
    message: 'Request body contains invalid JSON.',
  },
  'entity.too.large': {
    status: 413,
    code: 'REQUEST_TOO_LARGE',
    message: 'Request body exceeds the 100 KB limit.',
  },
  'request.aborted': {
    status: 400,
    code: 'REQUEST_BODY_ABORTED',
    message: 'Request body was not received completely.',
  },
  'request.size.invalid': {
    status: 400,
    code: 'INVALID_REQUEST_SIZE',
    message: 'Request body size does not match its content length.',
  },
  'charset.unsupported': {
    status: 415,
    code: 'UNSUPPORTED_CHARSET',
    message: 'Request body charset is not supported.',
  },
  'encoding.unsupported': {
    status: 415,
    code: 'UNSUPPORTED_ENCODING',
    message: 'Request body encoding is not supported.',
  },
  'entity.verify.failed': {
    status: 403,
    code: 'BODY_VERIFICATION_FAILED',
    message: 'Request body failed verification.',
  },
};

export function createApp(pool: Pool): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', (_request, response) => {
    response.status(200).json({ data: { status: 'ok' } });
  });
  app.use('/api', createImportRouter(pool));
  app.use('/api', createExceptionRouter(pool));
  app.use('/api', createReconciliationRouter(pool));
  app.use((_request, response) => {
    response.status(404).json({
      error: { code: 'ROUTE_NOT_FOUND', message: 'Endpoint was not found.' },
    });
  });

  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, next) => {
    void next;
    if (error instanceof ReconciliationServiceError) {
      response.status(error.statusCode).json({
        error: { code: error.code, message: error.message },
      });
      return;
    }
    if (error instanceof ImportApiError) {
      response.status(error.statusCode).json({
        error: { code: error.code, message: error.message },
      });
      return;
    }
    if (error instanceof ExceptionServiceError) {
      response.status(error.statusCode).json({
        error: { code: error.code, message: error.message },
      });
      return;
    }
    if (error instanceof CsvParseError) {
      response.status(400).json({ error: { code: error.code, message: error.message } });
      return;
    }

    const parserError = error as { type?: string };
    const clientError = parserError?.type ? bodyParserErrors[parserError.type] : undefined;
    if (clientError) {
      response.status(clientError.status).json({
        error: { code: clientError.code, message: clientError.message },
      });
      return;
    }

    console.error('Unhandled API error.', error);
    response.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected server error occurred.' },
    });
  };
  app.use(errorHandler);

  return app;
}
