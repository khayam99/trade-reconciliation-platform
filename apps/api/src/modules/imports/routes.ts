import { Router, type NextFunction, type Request, type Response } from 'express';
import multer, { MulterError } from 'multer';
import type { Pool } from 'pg';
import { MAX_CSV_FILE_BYTES } from './csv.js';
import { ImportApiError } from './errors.js';
import { importTradeCsv } from './service.js';
import { getImportBatchErrorPage, validationError } from '../reconciliation/query-service.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 25;

const upload = multer({
  storage: multer.memoryStorage(),
  preservePath: false,
  limits: {
    fileSize: MAX_CSV_FILE_BYTES,
    files: 1,
    fields: 2,
    parts: 3,
    fieldNameSize: 100,
    fieldSize: 32,
    headerPairs: 100,
  },
  fileFilter: (_request, file, callback) => {
    const acceptedMimeTypes = new Set(['text/csv', 'application/csv', 'application/vnd.ms-excel']);
    if (
      !file.originalname.toLowerCase().endsWith('.csv') ||
      !acceptedMimeTypes.has(file.mimetype)
    ) {
      callback(new ImportApiError('UNSUPPORTED_FILE_TYPE', 'Upload a CSV file.', 415));
      return;
    }
    callback(null, true);
  },
});

function multipartUpload(request: Request, response: Response, next: NextFunction): void {
  upload.single('file')(request, response, (error: unknown) => {
    if (!error) {
      next();
      return;
    }
    if (error instanceof ImportApiError) {
      next(error);
      return;
    }
    if (error instanceof MulterError) {
      const sizeError = error.code === 'LIMIT_FILE_SIZE' || error.code === 'LIMIT_FIELD_VALUE';
      const code = error.code === 'LIMIT_UNEXPECTED_FILE' ? 'UNEXPECTED_FILE' : error.code;
      next(
        new ImportApiError(
          code,
          sizeError
            ? 'Uploaded content exceeds the allowed size.'
            : error.code === 'LIMIT_UNEXPECTED_FILE'
              ? 'Only one file with the field name "file" is accepted.'
              : 'Multipart request contains too many fields, files, or parts.',
          sizeError ? 413 : 400,
        ),
      );
      return;
    }
    next(new ImportApiError('MALFORMED_MULTIPART', 'Multipart request is malformed.', 400));
  });
}

function requireMultipart(request: Request, _response: Response, next: NextFunction): void {
  if (!request.is('multipart/form-data')) {
    next(
      new ImportApiError('UNSUPPORTED_MEDIA_TYPE', 'Request must use multipart/form-data.', 415),
    );
    return;
  }
  next();
}

function singleFormField(request: Request, name: string): string | undefined {
  const value: unknown = request.body?.[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw validationError(`${name} must be a single text field.`);
  return value;
}

function parsePageValue(request: Request, name: 'limit' | 'offset'): number | undefined {
  const value: unknown = request.query[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw validationError(`${name} must be an integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw validationError(`${name} must be a safe integer.`);
  return parsed;
}

function assertOnlyPaginationParameters(request: Request): void {
  const unexpected = Object.keys(request.query).filter(
    (key) => key !== 'limit' && key !== 'offset',
  );
  if (unexpected.length)
    throw validationError(`Unsupported query parameter: ${unexpected.sort()[0]}.`);
}

function safeUploadedFilename(filename: string): string {
  return filename.split(/[\\/]/).at(-1)?.trim() ?? '';
}

export function createImportRouter(pool: Pool): Router {
  const router = Router();

  router.post('/import-batches', requireMultipart, multipartUpload, async (request, response) => {
    const fields = Object.keys(request.body ?? {});
    if (
      fields.some((field) => field !== 'source') ||
      fields.filter((field) => field === 'source').length !== 1
    ) {
      throw validationError(
        'Multipart form must contain only one source field and one file field.',
      );
    }
    const source = singleFormField(request, 'source');
    if (source !== 'ALPHA' && source !== 'BRAVO') {
      throw validationError('source must be one of: ALPHA, BRAVO.');
    }
    const file = request.file;
    if (!file)
      throw new ImportApiError('FILE_REQUIRED', 'A CSV file is required in the file field.', 400);

    const result = await importTradeCsv(pool, {
      sourceSystem: source,
      originalFilename: safeUploadedFilename(file.originalname),
      content: file.buffer,
    });
    response.status(201).json({ data: result.batch });
  });

  router.get('/import-batches/:batchId/errors', async (request, response) => {
    assertOnlyPaginationParameters(request);
    const batchId = request.params.batchId;
    if (!UUID_PATTERN.test(batchId)) throw validationError('batchId must be a valid UUID.');
    const page = await getImportBatchErrorPage(pool, batchId, {
      limit: parsePageValue(request, 'limit') ?? DEFAULT_LIMIT,
      offset: parsePageValue(request, 'offset') ?? 0,
    });
    response.status(200).json({
      data: page.items,
      pagination: { limit: page.limit, offset: page.offset, total: page.total },
    });
  });

  return router;
}
