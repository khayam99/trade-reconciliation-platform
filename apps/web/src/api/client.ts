import type { ApiErrorResponse } from './types';

export type ApiQueryValue = string | number | boolean | null | undefined;
export type ApiQuery = Record<string, ApiQueryValue> | URLSearchParams;

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: ApiQuery;
  body?: unknown;
  signal?: AbortSignal;
}

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

function appendQuery(path: string, query?: ApiQuery): string {
  if (!query) return path;

  const parameters = new URLSearchParams(query instanceof URLSearchParams ? query : undefined);
  if (!(query instanceof URLSearchParams)) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== null && value !== undefined) parameters.set(key, String(value));
    }
  }

  const serialized = parameters.toString();
  if (!serialized) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${serialized}`;
}

function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  if (!value || typeof value !== 'object' || !('error' in value)) return false;
  const error = value.error;
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    'message' in error &&
    typeof error.message === 'string'
  );
}

/** Fetch JSON from the same-origin API while retaining its response envelope. */
export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const headers = new Headers({ Accept: 'application/json' });
  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    if (typeof FormData !== 'undefined' && options.body instanceof FormData) {
      // Let fetch set multipart/form-data and its boundary for FormData requests.
      body = options.body;
    } else {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(options.body);
    }
  }

  const response = await fetch(appendQuery(path, options.query), {
    method: options.method ?? 'GET',
    headers,
    body,
    signal: options.signal,
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    if (!response.ok) {
      throw new ApiClientError(
        response.status,
        `HTTP_${response.status}`,
        `The request failed with status ${response.status}.`,
      );
    }
    throw new ApiClientError(
      response.status,
      'INVALID_RESPONSE',
      'The server returned invalid JSON.',
    );
  }

  if (!response.ok) {
    if (isApiErrorResponse(payload)) {
      throw new ApiClientError(response.status, payload.error.code, payload.error.message);
    }
    throw new ApiClientError(
      response.status,
      `HTTP_${response.status}`,
      `The request failed with status ${response.status}.`,
    );
  }

  return payload as T;
}
