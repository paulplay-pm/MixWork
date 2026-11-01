import { beforeEach, describe, expect, test, vi } from 'vitest';

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

import { apiClient } from '../../src/api/client';
import { dashboardApi } from '../../src/api/dashboard';

function urlOf(index = 0): string {
  return String(fetchMock.mock.calls[index][0]);
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 });
}

describe('api/dashboard', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    apiClient.setBaseUrl('http://test');
    apiClient.setTokenProvider(() => 'jwt-1');
    apiClient.setRefresh(null);
  });

  test('summary hits /admin/dashboard/summary and sends no query parameters', async () => {
    fetchMock.mockResolvedValueOnce(json({ updated_at: 'x' }));
    await dashboardApi.summary();
    const url = new URL(urlOf());
    expect(url.pathname).toBe('/admin/dashboard/summary');
    expect(url.search).toBe('');
    // Never a parameter: the org comes from the JWT, and honouring a query
    // string one would let any member read another org's board by editing a URL.
    expect(url.searchParams.has('orgId')).toBe(false);
  });

  test('usage sends the range key verbatim and never a date', async () => {
    fetchMock.mockResolvedValueOnce(json({ range: '30d' }));
    await dashboardApi.usage('30d');
    const url = new URL(urlOf());
    expect(url.pathname).toBe('/admin/dashboard/usage');
    expect(url.searchParams.get('range')).toBe('30d');
    expect(url.searchParams.has('from')).toBe(false);
    expect(url.searchParams.has('to')).toBe(false);
  });
});