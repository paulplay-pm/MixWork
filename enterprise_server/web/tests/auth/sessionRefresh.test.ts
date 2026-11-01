import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  _resetSessionRefreshForTest,
  refreshSessionIfDue,
  type SessionRefreshDeps,
  startSessionRefresh,
} from '../../src/auth/sessionRefresh';

// A fixed clock keeps the window math deterministic.
const NOW = 1_700_000_000_000;

/** A JWT whose payload carries only an `exp` claim (seconds, per RFC 7519). */
function jwtWithExp(expSec: number): string {
  const payload = btoa(JSON.stringify({ exp: expSec }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `h.${payload}.s`;
}

function makeDeps(overrides: Partial<SessionRefreshDeps> = {}): SessionRefreshDeps {
  return {
    getToken: () => jwtWithExp(NOW / 1000 + 1800),
    refresh: vi.fn(async () => 'new-token'),
    persist: vi.fn(),
    now: () => NOW,
    ...overrides,
  };
}

afterEach(() => {
  _resetSessionRefreshForTest();
  vi.useRealTimers();
});

describe('startSessionRefresh', () => {
  test('启动即轮换、按间隔轮换、回到前台再轮换，停止后不再轮换', async () => {
    vi.useFakeTimers();
    // Due: expires in five minutes, inside the ten-minute window.
    const deps = makeDeps({ getToken: () => jwtWithExp(NOW / 1000 + 300) });
    const stop = startSessionRefresh({ ...deps, intervalMs: 60_000 });

    await vi.advanceTimersByTimeAsync(0);
    expect(deps.refresh).toHaveBeenCalledTimes(1); // the immediate tick

    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.refresh).toHaveBeenCalledTimes(2); // the interval

    // A background tab's timers are throttled, so the tab may wake up long
    // after the window closed: coming back to the foreground rotates again.
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.refresh).toHaveBeenCalledTimes(3);

    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.refresh).toHaveBeenCalledTimes(3); // nothing after stop()
  });
});

describe('refreshSessionIfDue', () => {
  test('临近到期才轮换', async () => {
    const deps = makeDeps({ getToken: () => jwtWithExp(NOW / 1000 + 300) });
    const result = await refreshSessionIfDue(deps);
    expect(result.status).toBe('refreshed');
    expect(deps.refresh).toHaveBeenCalledTimes(1);
    expect(deps.persist).toHaveBeenCalledWith('new-token');
  });

  test('未到期不轮换', async () => {
    const deps = makeDeps();
    const result = await refreshSessionIfDue(deps);
    expect(result.status).toBe('not-due');
    expect(deps.refresh).not.toHaveBeenCalled();
    expect(deps.persist).not.toHaveBeenCalled();
  });

  test('已过期不发出请求', async () => {
    // The refresh endpoint re-verifies the CURRENT token, so an expired one
    // can never be renewed — asking would only produce another 401.
    const deps = makeDeps({ getToken: () => jwtWithExp(NOW / 1000 - 60) });
    const result = await refreshSessionIfDue(deps);
    expect(result.status).toBe('jwt-expired');
    expect(deps.refresh).not.toHaveBeenCalled();
  });

  test('没有会话', async () => {
    const deps = makeDeps({ getToken: () => null });
    const result = await refreshSessionIfDue(deps);
    expect(result.status).toBe('not-logged-in');
    expect(deps.refresh).not.toHaveBeenCalled();
  });

  test('刷新失败', async () => {
    const deps = makeDeps({
      getToken: () => jwtWithExp(NOW / 1000 + 300),
      refresh: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const result = await refreshSessionIfDue(deps);
    expect(result.status).toBe('refresh-failed');
    expect(deps.persist).not.toHaveBeenCalled();
  });

  test('并发调用只发一次请求', async () => {
    const refresh = vi.fn(async () => 'new-token');
    const deps = makeDeps({ getToken: () => jwtWithExp(NOW / 1000 + 300), refresh });
    const [a, b] = await Promise.all([
      refreshSessionIfDue(deps),
      refreshSessionIfDue(deps),
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(a.status).toBe('refreshed');
    expect(b.status).toBe('refreshed');
  });
});
