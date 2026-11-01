import { beforeEach, describe, expect, test, vi } from 'vitest';

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

import { auditApi } from '../../src/api/audit';
import { apiClient } from '../../src/api/client';
import { usageApi } from '../../src/api/usage';

/** The path+query of the Nth fetch, as sent. */
function urlOf(index = 0): string {
  return String(fetchMock.mock.calls[index][0]);
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 });
}

describe('api/analytics clients', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    apiClient.setBaseUrl('http://test');
    apiClient.setTokenProvider(() => 'jwt-1');
    apiClient.setRefresh(null);
  });

  test('usage.models sends the range key verbatim and no orgId', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [] }));
    await usageApi.models({ range: 'this_month', page: 2, pageSize: 50 });
    const url = new URL(urlOf());
    expect(url.pathname).toBe('/admin/usage/models');
    expect(url.searchParams.get('range')).toBe('this_month');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('pageSize')).toBe('50');
    expect(url.search).not.toContain('orgId');
    // The client never computes dates: the server resolves the window.
    expect(url.searchParams.has('from')).toBe(false);
    expect(url.searchParams.has('to')).toBe(false);
  });

  test('usage.users forwards q/sort and drops absent filters', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [] }));
    await usageApi.users({ range: '30d', q: 'ada', sort: 'asc', pageSize: 8 });
    const url = new URL(urlOf());
    expect(url.pathname).toBe('/admin/usage/users');
    expect(url.searchParams.get('range')).toBe('30d');
    expect(url.searchParams.get('q')).toBe('ada');
    expect(url.searchParams.get('sort')).toBe('asc');
    expect(url.searchParams.has('orgId')).toBe(false);
    expect(url.searchParams.has('page')).toBe(false);
  });

  test('usage.exportCsv hits the export route, not the table', async () => {
    fetchMock.mockResolvedValueOnce(new Response('a,b\n', { status: 200 }));
    await usageApi.exportCsv('7d', 'users');
    const url = new URL(urlOf());
    expect(url.pathname).toBe('/admin/usage/export.csv');
    expect(url.searchParams.get('range')).toBe('7d');
    expect(url.searchParams.get('tab')).toBe('users');
  });

  test('usage.userDetail puts the range on the per-user route', async () => {
    fetchMock.mockResolvedValueOnce(json({ daily: [] }));
    await usageApi.userDetail('user 1/x', 'today');
    const url = new URL(urlOf());
    expect(url.pathname).toBe('/admin/usage/users/user%201%2Fx');
    expect(url.searchParams.get('range')).toBe('today');
  });

  test('audit.list sends the range key and the four filters', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [], facets: {} }));
    await auditApi.list({
      range: 'custom',
      from: '2026-01-01',
      to: '2026-01-31',
      userId: 'u1',
      action: 'user_disable',
      targetType: 'dept',
      targetId: 'd1',
      page: 3,
      pageSize: 15,
    });
    const url = new URL(urlOf());
    expect(url.pathname).toBe('/admin/audit');
    expect(url.searchParams.get('range')).toBe('custom');
    expect(url.searchParams.get('from')).toBe('2026-01-01');
    expect(url.searchParams.get('to')).toBe('2026-01-31');
    expect(url.searchParams.get('userId')).toBe('u1');
    expect(url.searchParams.get('action')).toBe('user_disable');
    expect(url.searchParams.get('targetType')).toBe('dept');
    expect(url.searchParams.get('targetId')).toBe('d1');
    expect(url.searchParams.has('orgId')).toBe(false);
    // The old client asked the LIST route for a CSV; that spelling is gone.
    expect(url.searchParams.has('format')).toBe(false);
  });

  test('audit.exportCsv hits /admin/audit/export.csv without paging', async () => {
    fetchMock.mockResolvedValueOnce(new Response('a,b\n', { status: 200 }));
    await auditApi.exportCsv({ range: '7d', targetType: 'dept', targetId: 'd1' });
    const url = new URL(urlOf());
    expect(url.pathname).toBe('/admin/audit/export.csv');
    expect(url.searchParams.get('range')).toBe('7d');
    expect(url.searchParams.get('targetType')).toBe('dept');
    expect(url.searchParams.has('page')).toBe(false);
    expect(url.searchParams.has('format')).toBe(false);
  });

  test('getRawWithHeaders surfaces x-export-count, getRaw keeps the body', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('统计范围：近 7 天\n', { status: 200, headers: { 'x-export-count': '42' } })
    );
    const raw = await usageApi.exportCsv('7d', 'models');
    expect(raw.text).toContain('近 7 天');
    expect(raw.headers.get('x-export-count')).toBe('42');

    fetchMock.mockResolvedValueOnce(
      new Response('plain', { status: 200, headers: { 'x-export-count': '7' } })
    );
    await expect(apiClient.getRaw('/admin/usage/export.csv?range=7d')).resolves.toBe('plain');
  });
});
