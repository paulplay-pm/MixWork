import { beforeEach, describe, expect, test, vi } from 'vitest';

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

import { apiClient, ApiError } from '../../src/api/client';

describe('api/client', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    apiClient.setBaseUrl('http://test');
    apiClient.setTokenProvider(() => null);
    apiClient.setRefresh(null);
  });

  test('GET attaches Bearer when token set', async () => {
    apiClient.setTokenProvider(() => 'jwt-1');
    fetchMock.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    await apiClient.get('/me');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer jwt-1');
  });

  test('401 triggers refresh + retry once', async () => {
    apiClient.setTokenProvider(() => 'old');
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{"token":"new"}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    let refreshCount = 0;
    apiClient.setRefresh(async () => {
      refreshCount++;
      const r = await fetch(`${apiClient.baseUrl()}/auth/refresh`, { method: 'POST' });
      const j = (await r.json()) as { token: string };
      apiClient.setTokenProvider(() => j.token);
    });
    await expect(apiClient.get('/me')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(refreshCount).toBe(1);
  });

  test('second 401 throws ApiError with status=401', async () => {
    apiClient.setTokenProvider(() => 'old');
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }));
    apiClient.setRefresh(async () => {
      // refresh also 401
      await fetch(`${apiClient.baseUrl()}/auth/refresh`, { method: 'POST' });
      throw new Error('refresh failed');
    });
    await expect(apiClient.get('/me')).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
    });
  });

  test('401 on /auth/login does NOT trigger /auth/refresh (no infinite storm)', async () => {
    // Regression: previously a failed login entered an infinite loop of
    // POST /auth/refresh 401s because the refresh-on-401 path fired for
    // /auth/login itself, even though no token existed yet. The fix skips
    // refresh on /auth/login and /auth/refresh.
    let refreshCalls = 0;
    apiClient.setRefresh(async () => {
      refreshCalls++;
    });
    fetchMock.mockResolvedValueOnce(
      new Response('{"error":"invalid"}', { status: 401 })
    );
    await expect(
      apiClient.post('/auth/login', { orgId: 'o1', username: 'a', password: 'b' })
    ).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refreshCalls).toBe(0);
  });

  test('ApiError preserves server body (status + error fields)', async () => {
    apiClient.setTokenProvider(() => 'jwt-1');
    fetchMock.mockResolvedValueOnce(
      new Response('{"error":"rate_limited"}', { status: 429 })
    );
    try {
      await apiClient.get('/admin/users?orgId=o1');
      expect.fail('expected ApiError');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      const err = e as ApiError;
      expect(err.status).toBe(429);
      expect(err.body).toEqual({ error: 'rate_limited' });
    }
  });

  test('getRaw returns raw text (CSV)', async () => {
    apiClient.setTokenProvider(() => 'jwt-1');
    fetchMock.mockResolvedValueOnce(new Response('a,b\n1,2', { status: 200 }));
    // The audit CSV lives on its own `/export.csv` route; the old
    // `?format=csv` spelling on `/admin/audit` was removed. What this case
    // pins is `getRaw`'s contract — text in, text out, no JSON parse — so the
    // path only has to be one the client would really send.
    const text = await apiClient.getRaw('/admin/audit/export.csv?range=7d');
    expect(text).toBe('a,b\n1,2');
  });
});
describe('api/client postRaw', () => {
  beforeEach(() => {
    // The outer beforeEach lives inside the other describe, so this block
    // needs its own reset — otherwise calls[0] is a request from an earlier test.
    fetchMock.mockReset();
    apiClient.setBaseUrl('http://test');
    apiClient.setTokenProvider(() => null);
    apiClient.setRefresh(null);
  });

  test('a FormData body keeps the browser-owned content type', async () => {
    // The regression this guards: forcing `application/octet-stream` dropped
    // the multipart boundary, the server found no fields, and every icon
    // upload came back as `missing_file` — reported to the admin as "only
    // PNG / JPEG / WEBP / SVG".
    fetchMock.mockResolvedValueOnce(new Response('{"icon":"/x.png"}', { status: 200 }));
    const form = new FormData();
    form.append('icon', new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }));
    await apiClient.postRaw('/admin/x/icon', form);
    const headers = new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('content-type')).toBeNull();
  });

  test('a raw body still carries the caller-provided content type', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await apiClient.postRaw('/admin/x/zip', new Uint8Array([1]), { 'content-type': 'application/zip' });
    const headers = new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('content-type')).toBe('application/zip');
  });
});
