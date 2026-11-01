import { beforeEach, describe, expect, test, vi } from 'vitest';

const { registeredHandlers } = vi.hoisted(() => ({
  registeredHandlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, handler);
    }),
  },
}));

import { AsrIpcChannel } from '../../../shared/asr/constants';
import { registerAsrIpcHandlers } from './handlers';

const OK_BODY = {
  code: 0,
  data: {
    requestId: 'r1',
    wsUrl: 'wss://example.test/api/asr/realtime?ticket=t',
    expiresInSeconds: 60,
    chunkIntervalMillis: 200,
    maxSessionSeconds: 60,
    maxConcurrentSessions: 1,
    usedSecondsToday: 0,
    remainingSecondsToday: 600,
    limitSecondsToday: 600,
  },
};

describe('AsrIpcChannel.CreateRealtimeSession handler', () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  let jwt: string | null = 'enterprise-jwt';
  let response: Response;

  beforeEach(() => {
    registeredHandlers.clear();
    seen.length = 0;
    jwt = 'enterprise-jwt';
    response = new Response(JSON.stringify(OK_BODY), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    registerAsrIpcHandlers({
      getEnterpriseJwt: () => jwt,
      fetchWithAuth: async (url, init) => {
        seen.push({ url, init });
        return response;
      },
      getServerApiBaseUrl: () => 'https://enterprise.test',
    });
  });

  const call = () =>
    (registeredHandlers.get(AsrIpcChannel.CreateRealtimeSession) as (
      _e: unknown,
      opts: unknown,
    ) => Promise<unknown>)({}, { langType: 'zh-CHS' });

  test('用企业 org JWT 发起会话请求', async () => {
    const result = (await call()) as { success: boolean; data?: { wsUrl: string } };
    expect(result.success).toBe(true);
    expect(result.data?.wsUrl).toContain('/api/asr/realtime');
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://enterprise.test/api/asr/realtime/sessions');
    expect(seen[0].init?.method).toBe('POST');
  });

  test('没有企业会话时返回 Unauthorized，而不是抛出异常', async () => {
    jwt = null;
    const result = (await call()) as { success: boolean; code?: number; error?: string };
    // A thrown error would surface as an unhandled rejection in the renderer.
    expect(result.success).toBe(false);
    expect(result.code).toBe(401);
    expect(seen).toHaveLength(0);
  });

  test('服务端的失败码原样透出（含数字 41602 撤销）', async () => {
    response = new Response(
      JSON.stringify({ error: 'not_member', code: 41602 }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    );
    const result = (await call()) as { success: boolean; code?: number };
    expect(result.success).toBe(false);
    expect(result.code).toBe(41602);
  });

  test('服务端的其它失败码（如配额耗尽 41404）原样透出', async () => {
    response = new Response(JSON.stringify({ code: 41404, message: 'quota' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const result = (await call()) as { success: boolean; code?: number };
    expect(result.success).toBe(false);
    expect(result.code).toBe(41404);
  });
});
