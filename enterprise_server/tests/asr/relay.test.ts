import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { WebSocket } from 'ws';

import { createAsrRelay } from '../../src/asr/relay';
import { _resetAsrTicketsForTest,issueAsrTicket } from '../../src/asr/ticket';
import type { AsrRecognitionEnvelope } from '../../src/asr/types';
import { type AsrWsServer,startAsrWebSocketServer } from '../../src/asr/wsServer';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { AsrApiCode } from '../../src/shared/asr/constants';
import { FakeAsrStream } from '../helpers/fakeAsrStream';

const CFG = {
  id: 'pk1', protocol: 'realtime-asr', provider: 'minimax',
  endpoint: 'https://x', apiKey: 'k', config: {}, sampleRate: 16000,
};

interface Harness {
  srv: AsrWsServer;
  port: number;
  stream: FakeAsrStream;
  added: number[];
  sent: string[];
  /** The config the adapter was opened with. */
  opened: { current: { config: Record<string, unknown> } | null };
  close: () => Promise<void>;
}

async function harness(opts: {
  quotaRemaining?: number;
  container?: 'wav' | 'raw-pcm';
  usedSecondsToday?: number;
  limitSecondsToday?: number;
  /**
   * How long the relay takes to finish its setup (opening the upstream).
   * In production that window is real I/O — a vault decrypt, a DB read, an
   * upstream connect — and the client starts streaming the moment the
   * handshake completes.
   */
  setupDelayMs?: number;
} = {}): Promise<Harness> {
  const stream = new FakeAsrStream();
  const added: number[] = [];
  const sent: string[] = [];
  const opened: { current: { config: Record<string, unknown> } | null } = { current: null };
  const relay = createAsrRelay({
    getProvider: () => ({
      container: opts.container ?? 'raw-pcm',
      openStream: async (cfg: { config: Record<string, unknown> }) => {
        opened.current = cfg;
        if (opts.setupDelayMs) {
          await new Promise((r) => setTimeout(r, opts.setupDelayMs));
        }
        return stream;
      },
    } as never),
    resolveConfig: async () => CFG,
    addSeconds: async (_o, _u, s) => {
      added.push(s);
    },
    getQuota: async () => ({
      usedSecondsToday: opts.usedSecondsToday ?? 0,
      remainingSecondsToday: opts.quotaRemaining ?? 600,
      limitSecondsToday: opts.limitSecondsToday ?? 600,
    }),
    isMemberActive: async () => true,
    flushIntervalMs: 30,
  });
  const srv = await startAsrWebSocketServer((ws, req) => relay.handleConnection(ws, req));
  return {
    srv, port: srv.port, stream, added, sent, opened,
    close: () => srv.close(),
  };
}

async function ticket(extra: { model?: string } = {}): Promise<string> {
  return issueAsrTicket({
    orgId: 'o1', userId: 'u1', requestId: 'r1', langType: 'zh-CHS',
    providerKeyId: 'pk1', protocol: 'realtime-asr',
    ...extra,
  });
}

describe('asr relay', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    _resetAsrTicketsForTest();
    await testPool.query(`INSERT INTO orgs(id,name,timezone) VALUES ('o1','T','UTC')`);
    await testPool.query(
      `INSERT INTO users(id,org_id,username,password_hash,status) VALUES ('u1','o1','u1','x','active')`,
    );
  });

  test('raw-pcm 上游：首帧剥掉 44 字节 WAV 头', async () => {
    const h = await harness({ container: 'raw-pcm' });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${h.port}/api/asr/realtime?ticket=${await ticket()}`);
      await once(ws, 'open');
      const wav = Buffer.concat([wavHeader(), Buffer.from([1, 2, 3, 4])]);
      ws.send(wav, { binary: true });
      await waitFor(() => h.stream.received.length === 1);
      expect(h.stream.received[0]).toEqual(Buffer.from([1, 2, 3, 4]));
      ws.close();
    } finally {
      await h.close();
    }
  });

  test('wav 上游：首帧的 WAV 头是容器，必须保留', async () => {
    // Minimax decodes WAV. Stripping the header there would send 44 bytes of
    // container as if they were audio.
    const h = await harness({ container: 'wav' });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${h.port}/api/asr/realtime?ticket=${await ticket()}`);
      await once(ws, 'open');
      const wav = Buffer.concat([wavHeader(), Buffer.from([1, 2, 3, 4])]);
      ws.send(wav, { binary: true });
      await waitFor(() => h.stream.received.length === 1);
      expect(h.stream.received[0]).toEqual(wav);
      ws.close();
    } finally {
      await h.close();
    }
  });

  test('没有 WAV 魔数时不剥（裸 PCM 客户端不能丢 44 字节）', async () => {
    const h = await harness({ container: 'raw-pcm' });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${h.port}/api/asr/realtime?ticket=${await ticket()}`);
      await once(ws, 'open');
      ws.send(Buffer.from([9, 9, 9, 9, 9, 9]), { binary: true });
      await waitFor(() => h.stream.received.length === 1);
      expect(h.stream.received[0]).toHaveLength(6);
      ws.close();
    } finally {
      await h.close();
    }
  });

  test('第二帧不剥头（只有首帧带 WAV 头）', async () => {
    const h = await harness({ container: 'raw-pcm' });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${h.port}/api/asr/realtime?ticket=${await ticket()}`);
      await once(ws, 'open');
      ws.send(Buffer.concat([wavHeader(), Buffer.from([1, 2])]), { binary: true });
      ws.send(Buffer.from([3, 4]), { binary: true });
      await waitFor(() => h.stream.received.length === 2);
      expect(h.stream.received[0]).toHaveLength(2);
      expect(h.stream.received[1]).toEqual(Buffer.from([3, 4]));
      ws.close();
    } finally {
      await h.close();
    }
  });

  test('文本帧 {"end":"true"} 触发 adapter.finish()（与 close 是不同的动作）', async () => {
    const h = await harness();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${h.port}/api/asr/realtime?ticket=${await ticket()}`);
      await once(ws, 'open');
      ws.send(JSON.stringify({ end: 'true' }));
      await waitFor(() => h.stream.finished);
      expect(h.stream.finished).toBe(true);
      expect(h.stream.closed).toBe(false);
      ws.close();
    } finally {
      await h.close();
    }
  });

  test('adapter 的 recognition 事件透传给客户端（youdao 信封原样）', async () => {
    const h = await harness();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${h.port}/api/asr/realtime?ticket=${await ticket()}`);
      await once(ws, 'open');
      const got: string[] = [];
      ws.on('message', (d) => got.push(d.toString()));
      const envelope: AsrRecognitionEnvelope = {
        type: 'recognition',
        raw: { result: [{ seg_id: 1, st: { sentence: '你好', partial: false } }] },
      };
      h.stream.emitRecognition(envelope);
      await waitFor(() => got.length === 1);
      expect(JSON.parse(got[0]).raw.result[0].st.sentence).toBe('你好');
      ws.close();
    } finally {
      await h.close();
    }
  });

  test('adapter 的 error 事件先发 error 再关流', async () => {
    const h = await harness();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${h.port}/api/asr/realtime?ticket=${await ticket()}`);
      await once(ws, 'open');
      const got: string[] = [];
      ws.on('message', (d) => got.push(d.toString()));
      // Register the close listener BEFORE triggering: the server closes as
      // soon as it has sent the error, so waiting on 'close' afterwards can
      // miss the event entirely.
      const closed = once(ws, 'close');
      h.stream.emitError(AsrApiCode.UpstreamAuthFailed, 'upstream auth failed');
      await waitFor(() => got.length === 1);
      expect(JSON.parse(got[0]).code).toBe(AsrApiCode.UpstreamAuthFailed);
      await closed;
      ws.close();
    } finally {
      await h.close();
    }
  });

  test('非法 ticket：握手后立刻收到 error 并被关闭', async () => {
    const h = await harness();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${h.port}/api/asr/realtime?ticket=bogus`);
      const got: string[] = [];
      ws.on('message', (d) => got.push(d.toString()));
      await once(ws, 'close');
      expect(got.length).toBeGreaterThan(0);
      expect(JSON.parse(got[0]).code).toBe(AsrApiCode.Unauthorized);
    } finally {
      await h.close();
    }
  });

  test('ticket 单次使用：同一张票第二次被拒', async () => {
    const h = await harness();
    try {
      const t = await ticket();
      const ws1 = new WebSocket(`ws://127.0.0.1:${h.port}/api/asr/realtime?ticket=${t}`);
      await once(ws1, 'open');
      const ws2 = new WebSocket(`ws://127.0.0.1:${h.port}/api/asr/realtime?ticket=${t}`);
      const got: string[] = [];
      ws2.on('message', (d) => got.push(d.toString()));
      await once(ws2, 'close');
      expect(JSON.parse(got[0]).code).toBe(AsrApiCode.Unauthorized);
      ws1.close();
    } finally {
      await h.close();
    }
  });

  test('配额耗尽：握手后直接 error DailyLimitExceeded', async () => {
    const h = await harness({ quotaRemaining: 0 });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${h.port}/api/asr/realtime?ticket=${await ticket()}`);
      const got: string[] = [];
      ws.on('message', (d) => got.push(d.toString()));
      await once(ws, 'close');
      expect(JSON.parse(got[0]).code).toBe(AsrApiCode.DailyLimitExceeded);
    } finally {
      await h.close();
    }
  });

  test('转发字节按 16kHz PCM16 折算成秒并落库', async () => {
    const h = await harness();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${h.port}/api/asr/realtime?ticket=${await ticket()}`);
      await once(ws, 'open');
      // 16000 Hz × 2 bytes/sample = 32000 bytes per second.
      ws.send(Buffer.alloc(32000, 1), { binary: true });
      await waitFor(() => h.added.length > 0);
      expect(h.added[0]).toBeCloseTo(1, 3);
      ws.close();
    } finally {
      await h.close();
    }
  });
});

/** A 44-byte WAV header, as the desktop prefixes to its first frame. */
function wavHeader(): Buffer {
  const h = Buffer.alloc(44, 0);
  h.write('RIFF', 0, 'ascii');
  h.write('WAVE', 8, 'ascii');
  return h;
}

function once(emitter: any, event: string): Promise<any[]> {
  return new Promise((resolve) => emitter.once(event, (...args: any[]) => resolve(args)));
}

async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('asr relay — 配额与生命周期', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    _resetAsrTicketsForTest();
    await testPool.query(`INSERT INTO orgs(id,name,timezone) VALUES ('o1','T','UTC')`);
    await testPool.query(
      `INSERT INTO users(id,org_id,username,password_hash,status) VALUES ('u1','o1','u1','x','active')`,
    );
  });

  const open = async (port: number, t: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/asr/realtime?ticket=${t}`);
    await once(ws, 'open');
    return ws;
  };

  test('日上限是"今天已用 + 本次会话"，不是本次会话自己（C2）', async () => {
    // 已用 590 / 上限 600 → 只剩 10 秒。本次会话再传 10 秒就该被拒；
    // 只看"本次会话"的旧逻辑会一直放到 600 秒才停。
    const h = await harness({
      quotaRemaining: 10,
      usedSecondsToday: 590,
      limitSecondsToday: 600,
    });
    try {
      const ws = await open(h.port, await ticket());
      const events: string[] = [];
      ws.on('message', (m) => events.push(m.toString()));
      ws.send(Buffer.alloc(32000 * 10, 1), { binary: true });
      await waitFor(() => events.length > 0);
      expect(JSON.parse(events[0]).code).toBe(AsrApiCode.DailyLimitExceeded);
      ws.close();
    } finally {
      await h.close();
    }
  });

  test('会话中途触发配额上限时，上游流也被关闭（否则上游连接泄漏并继续计费）（I4）', async () => {
    // 599/600 → 再传 1 秒就超限；此时上游流已经开着，必须被关掉。
    const h = await harness({
      quotaRemaining: 1, usedSecondsToday: 599, limitSecondsToday: 600,
    });
    try {
      const ws = await open(h.port, await ticket());
      ws.send(Buffer.alloc(32000, 1), { binary: true });
      await waitFor(() => h.stream.closed);
      expect(h.stream.closed).toBe(true);
      ws.close();
    } finally {
      await h.close();
    }
  });

  test('同一用户第二个并发会话被拒（maxConcurrentSessions 要是真的）（I8）', async () => {
    const h = await harness();
    try {
      const ws1 = await open(h.port, await ticket());
      await waitFor(() => h.stream.received.length >= 0);
      const second = new WebSocket(`ws://127.0.0.1:${h.port}/api/asr/realtime?ticket=${await ticket()}`);
      const events: string[] = [];
      second.on('message', (m) => events.push(m.toString()));
      await once(second, 'close');
      expect(events.length).toBeGreaterThan(0);
      ws1.close();
    } finally {
      await h.close();
    }
  });

  test('relay 内部抛错不会变成 unhandledRejection（C3）', async () => {
    // The quota lookup throws (a user row archived mid-session). The socket must
    // close cleanly and the process must keep running.
    {
      const relay = createAsrRelay({
        getProvider: () => ({ container: 'raw-pcm', openStream: async () => { throw new Error('boom'); } } as never),
        resolveConfig: async () => ({
          id: 'pk1', protocol: 'realtime-asr', provider: 'minimax',
          endpoint: null, apiKey: 'k', config: {}, sampleRate: 16000,
        }),
        getQuota: async () => { throw new Error('user not found'); },
        isMemberActive: async () => true,
      });
      // `startAsrWebSocketServer` already listens on an ephemeral port.
      const server = await startAsrWebSocketServer((ws, req) => relay.handleConnection(ws, req));
      const port = server.port;
      const t = await ticket();
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/asr/realtime?ticket=${t}`);
      await once(ws, 'close');
      ws.close();
      await server.close();
    }
  });
});

describe('asr relay — 建连窗口', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    _resetAsrTicketsForTest();
    await testPool.query(`INSERT INTO orgs(id,name,timezone) VALUES ('o1','T','UTC')`);
    await testPool.query(
      `INSERT INTO users(id,org_id,username,password_hash,status) VALUES ('u1','o1','u1','x','active')`,
    );
  });

  test('握手后立即发来的音频帧不会被丢掉', async () => {
    // 客户端在握手完成的那一刻就开始推流，而 relay 还要做票据兑换、成员校验、
    // provider 解析、配额读取，最后才打开上游连接——这些是真实 I/O。窗口内
    // 到达的帧以前是被直接丢弃的（`ws` 无论有没有监听者都会 emit 'message'），
    // 跟着丢的还有那一帧里的 WAV 头。
    const h = await harness({ setupDelayMs: 60 });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${h.port}/api/asr/realtime?ticket=${await ticket()}`);
      await once(ws, 'open');
      const wav = Buffer.concat([wavHeader(), Buffer.from([1, 2, 3, 4])]);
      ws.send(wav, { binary: true });
      await waitFor(() => h.stream.received.length === 1);
      expect(h.stream.received[0]).toEqual(Buffer.from([1, 2, 3, 4]));
      ws.close();
    } finally {
      await h.close();
    }
  });

  test('建连窗口内到达的控制帧也会被送达（{"end":"true"}）', async () => {
    const h = await harness({ setupDelayMs: 60 });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${h.port}/api/asr/realtime?ticket=${await ticket()}`);
      await once(ws, 'open');
      ws.send(Buffer.concat([wavHeader(), Buffer.from([1, 2, 3, 4])]), { binary: true });
      ws.send(JSON.stringify({ end: 'true' }));
      await waitFor(() => h.stream.finished);
      expect(h.stream.finished).toBe(true);
      ws.close();
    } finally {
      await h.close();
    }
  });

  test('客户端在建连窗口内断开不会永久占用并发名额', async () => {
    // 否则：用户取消一次语音输入，之后 maxConcurrentSessions=1 就把这个人
    // 的语音输入永久锁死（要重启服务端才恢复）。
    const h = await harness({ setupDelayMs: 80 });
    try {
      const first = new WebSocket(`ws://127.0.0.1:${h.port}/api/asr/realtime?ticket=${await ticket()}`);
      await once(first, 'open');
      first.close();
      await new Promise((r) => setTimeout(r, 250));

      const second = new WebSocket(`ws://127.0.0.1:${h.port}/api/asr/realtime?ticket=${await ticket()}`);
      const events: string[] = [];
      second.on('message', (m) => events.push(m.toString()));
      await once(second, 'open');
      await new Promise((r) => setTimeout(r, 250));
      expect(events.filter((e) => e.includes('"error"'))).toEqual([]);
      expect(second.readyState).toBe(WebSocket.OPEN);
      second.close();
    } finally {
      await h.close();
    }
  });
});

  test('建连窗口内堆积的音频帧有上限', async () => {
    // 缓冲是客户端可控的：没有上限的话，一个坏客户端可以在 setup 窗口里
    // 无限制地塞数据，把服务端内存吃光。
    const h = await harness({ setupDelayMs: 200 });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${h.port}/api/asr/realtime?ticket=${await ticket()}`);
      const events: string[] = [];
      ws.on('message', (m) => events.push(m.toString()));
      await once(ws, 'open');
      for (let i = 0; i < 200; i++) {
        ws.send(Buffer.alloc(6400, 1), { binary: true });
      }
      await once(ws, 'close');
      expect(events.some((e) => e.includes('"error"'))).toBe(true);
    } finally {
      await h.close();
    }
  });

describe('asr relay — 票据里的模型', () => {
  // The session route builds a config the relay never sees: the relay re-reads
  // the provider row when the socket opens. So the catalog's model travels on
  // the ticket, and the relay puts it into the config the adapter reads. A
  // stale `provider_keys.config.model` must not win.
  test('票据里的模型进入 adapter 的配置', async () => {
    const h = await harness();
    try {
      const ws = new WebSocket(
        `ws://127.0.0.1:${h.port}/api/asr/realtime?ticket=${await ticket({ model: 'kimi-asr' })}`,
      );
      await once(ws, 'open');
      ws.send(JSON.stringify({ end: 'true' }));
      await waitFor(() => h.stream.finished);
      expect(h.opened.current?.config.model).toBe('kimi-asr');
      // The caller's object is not mutated: a shared config constant would
      // leak one session's model into the next.
      expect(CFG.config).toEqual({});
      ws.close();
    } finally {
      await h.close();
    }
  });

  test('票据没有模型时 adapter 用解析出来的配置', async () => {
    const h = await harness();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${h.port}/api/asr/realtime?ticket=${await ticket()}`);
      await once(ws, 'open');
      ws.send(JSON.stringify({ end: 'true' }));
      await waitFor(() => h.stream.finished);
      expect(h.opened.current?.config).toEqual({});
      ws.close();
    } finally {
      await h.close();
    }
  });
});
