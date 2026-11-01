import { beforeEach, describe, expect, test, vi } from 'vitest';

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

import { apiClient, ApiError, SessionExpiredError } from '../../src/api/client';
import { t } from '../../src/i18n';

describe('api/client: session expiry', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    apiClient.setBaseUrl('http://test');
    apiClient.setTokenProvider(() => 'old');
    apiClient.setRefresh(null);
    apiClient.setSessionExpiredHandler(null);
  });

  test('401 → 刷新成功 → 重试并成功', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{"error":"unauthorized"}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    const refresh = vi.fn(async () => {});
    apiClient.setRefresh(refresh);

    await expect(apiClient.get('/me')).resolves.toEqual({ ok: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('401 → 刷新也 401 → 抛 SessionExpiredError 并触发会话失效回调', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{"error":"unauthorized"}', { status: 401 })
    );
    apiClient.setRefresh(async () => {
      throw new ApiError(401, { error: 'unauthorized' });
    });
    const onExpired = vi.fn();
    apiClient.setSessionExpiredHandler(onExpired);

    let err: unknown;
    try {
      await apiClient.get('/me');
      expect.fail('expected SessionExpiredError');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SessionExpiredError);
    // Still an ApiError, so every existing `e instanceof ApiError` /
    // `e.status === 401` check keeps working.
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    // The message a toast shows is words, not `http 401 unauthorized`.
    expect((err as Error).message).toBe(t('auth.session.expired'));
    expect((err as Error).message).not.toBe('http 401 unauthorized');
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  test('401 → 刷新因网络错误失败 → 仍然抛原始 401，不清会话', async () => {
    // A flaky network must NOT sign the admin out: the session may still be
    // perfectly good, the request just could not go out.
    fetchMock.mockResolvedValueOnce(
      new Response('{"error":"unauthorized"}', { status: 401 })
    );
    apiClient.setRefresh(async () => {
      throw new ApiError(0, { error: 'network' });
    });
    const onExpired = vi.fn();
    apiClient.setSessionExpiredHandler(onExpired);

    let err: unknown;
    try {
      await apiClient.get('/me');
      expect.fail('expected ApiError');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(SessionExpiredError);
    expect((err as ApiError).status).toBe(401);
    expect((err as Error).message).toBe('http 401 unauthorized');
    expect(onExpired).not.toHaveBeenCalled();
  });
});
