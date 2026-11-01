import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { WebSocket } from 'ws';

import { createAsrRelay } from '../../src/asr/relay';
import { _resetAsrTicketsForTest,issueAsrTicket } from '../../src/asr/ticket';
import { createAsrWebSocketServer } from '../../src/asr/wsServer';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { AsrApiCode } from '../../src/shared/asr/constants';
import { FakeAsrStream } from '../helpers/fakeAsrStream';

/**
 * The PRODUCTION wiring, not the test harness's.
 *
 * `ws`'s handleUpgrade does NOT emit 'connection' — that only happens for a
 * WebSocketServer built with `{ server }`. Wiring the relay to the event
 * therefore produced an upgraded socket that ignored every frame, while the
 * unit tests (which used the onConnection callback) stayed green. Only an
 * end-to-end connection catches that.
 *
 * So this test drives the same `handleUpgrade` the app's HTTP server uses.
 */
describe('asr ws production wiring', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    _resetAsrTicketsForTest();
    await testPool.query(`INSERT INTO orgs(id,name,timezone) VALUES ('o1','T','UTC')`);
    await testPool.query(
      `INSERT INTO users(id,org_id,username,password_hash,status) VALUES ('u1','o1','u1','x','active')`,
    );
  });

  test('经 handleUpgrade 建立的连接，relay 真的在跑（票据被消费 + 音频到达 adapter）', async () => {
    const stream = new FakeAsrStream();
    const relay = createAsrRelay({
      getProvider: () => ({ container: 'raw-pcm' as const, openStream: async () => stream }),
      resolveConfig: async () => ({
        id: 'pk1', protocol: 'realtime-asr', provider: 'minimax',
        endpoint: null, apiKey: 'k', config: {}, sampleRate: 16000,
      }),
      addSeconds: async () => {},
      getQuota: async () => ({
        usedSecondsToday: 0, remainingSecondsToday: 600, limitSecondsToday: 600,
      }),
      isMemberActive: async () => true,
      flushIntervalMs: 30,
    });

    // Exactly what src/server.ts does.
    const asrWs = createAsrWebSocketServer((socket, request) => {
      void relay.handleConnection(socket, request);
    });
    const httpServer = asrWs.httpServer;
    await new Promise<void>((resolve) => httpServer.listen(0, () => resolve()));
    const address = httpServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const ticket = await issueAsrTicket({
        orgId: 'o1', userId: 'u1', requestId: 'r1', langType: 'zh-CHS',
        providerKeyId: 'pk1', protocol: 'realtime-asr',
      });
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/asr/realtime?ticket=${ticket}`);
      await new Promise((resolve) => ws.once('open', resolve));
      ws.send(Buffer.from([1, 2, 3, 4]), { binary: true });

      // If the relay were not running, this would time out.
      await waitFor(() => stream.received.length === 1);
      expect(stream.received[0]).toEqual(Buffer.from([1, 2, 3, 4]));
      ws.close();
    } finally {
      await asrWs.close();
    }
  });

  test('同一张票第二次连接被拒（证明 relay 处理了第一次）', async () => {
    const relay = createAsrRelay({
      getProvider: () => ({ container: 'raw-pcm' as const, openStream: async () => new FakeAsrStream() }),
      resolveConfig: async () => ({
        id: 'pk1', protocol: 'realtime-asr', provider: 'minimax',
        endpoint: null, apiKey: 'k', config: {}, sampleRate: 16000,
      }),
      addSeconds: async () => {},
      getQuota: async () => ({
        usedSecondsToday: 0, remainingSecondsToday: 600, limitSecondsToday: 600,
      }),
      isMemberActive: async () => true,
    });
    const asrWs = createAsrWebSocketServer((socket, request) => {
      void relay.handleConnection(socket, request);
    });
    await new Promise<void>((resolve) => asrWs.httpServer.listen(0, () => resolve()));
    const address = asrWs.httpServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const ticket = await issueAsrTicket({
        orgId: 'o1', userId: 'u1', requestId: 'r1', langType: 'zh-CHS',
        providerKeyId: 'pk1', protocol: 'realtime-asr',
      });
      const first = new WebSocket(`ws://127.0.0.1:${port}/api/asr/realtime?ticket=${ticket}`);
      await new Promise((resolve) => first.once('open', resolve));
      first.close();

      const second = new WebSocket(`ws://127.0.0.1:${port}/api/asr/realtime?ticket=${ticket}`);
      const events: string[] = [];
      second.on('message', (m) => events.push(m.toString()));
      await new Promise((resolve) => second.once('close', resolve));
      expect(events.length).toBeGreaterThan(0);
      expect(JSON.parse(events[0]).code).toBe(AsrApiCode.Unauthorized);
    } finally {
      await asrWs.close();
    }
  });
});

async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
