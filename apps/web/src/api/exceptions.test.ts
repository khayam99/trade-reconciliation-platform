import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getExceptionAuditEvents,
  getExceptionDetails,
  reopenException,
  resolveException,
} from './exceptions';
import { ApiClientError } from './client';

describe('exception API methods', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('requests encoded exception details and passes cancellation', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: { id: 'exception-1' } }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await getExceptionDetails('id/with space', controller.signal);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/exceptions/id%2Fwith%20space');
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it.each([
    ['resolve', resolveException],
    ['reopen', reopenException],
  ] as const)('posts the reason for %s', async (action, method) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            action: {
              type: action === 'resolve' ? 'exception_resolved' : 'exception_reopened',
            },
          },
        }),
        {
          status: 200,
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await method('exception-1', { reason: 'reviewed' });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/exceptions/exception-1/${action}`);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ reason: 'reviewed' }));
    expect(response.data.action.type).toBe(
      action === 'resolve' ? 'exception_resolved' : 'exception_reopened',
    );
  });

  it('preserves the backend error envelope for failed mutations', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: 'INVALID_EXCEPTION_TRANSITION', message: 'Already resolved.' },
          }),
          { status: 409 },
        ),
      ),
    );

    await expect(resolveException('exception-1', { reason: 'again' })).rejects.toMatchObject({
      status: 409,
      code: 'INVALID_EXCEPTION_TRANSITION',
      message: 'Already resolved.',
    } satisfies Partial<ApiClientError>);
  });

  it('requests audit events with pagination and cancellation', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [], pagination: { limit: 25, offset: 50, total: 60 } }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const response = await getExceptionAuditEvents(
      'exception-1',
      { limit: 25, offset: 50 },
      controller.signal,
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/exceptions/exception-1/audit-events?limit=25&offset=50',
    );
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    expect(response.pagination.total).toBe(60);
  });
});
