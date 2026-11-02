import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from './client';

describe('apiRequest multipart bodies', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends FormData without setting multipart Content-Type itself', async () => {
    const form = new FormData();
    form.append('source', 'ALPHA');
    form.append('file', new Blob(['trade data'], { type: 'text/csv' }), 'trades.csv');
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: { id: 'batch-1' } }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await apiRequest<{ data: { id: string } }>('/api/import-batches', {
      method: 'POST',
      body: form,
    });

    expect(response.data.id).toBe('batch-1');
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.body).toBe(form);
    expect(new Headers(init?.headers).get('Content-Type')).toBeNull();
    expect(new Headers(init?.headers).get('Accept')).toBe('application/json');
  });

  it('retains JSON request behavior for existing API calls', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: { status: 'ok' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await apiRequest('/api/reconciliation-runs', {
      method: 'POST',
      body: { batchAId: 'a', batchBId: 'b' },
    });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
    expect(init?.body).toBe(JSON.stringify({ batchAId: 'a', batchBId: 'b' }));
  });
});
