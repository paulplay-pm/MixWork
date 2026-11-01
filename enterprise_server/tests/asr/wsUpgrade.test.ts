import '../helpers/setupEnv';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { WebSocket } from 'ws';

import { type AsrWsServer,startAsrWebSocketServer } from '../../src/asr/wsServer';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

describe('asr websocket upgrade', () => {
  let srv: AsrWsServer | null = null;
  let port = 0;

  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id,name,timezone) VALUES ('o1','T','UTC')`);
    await testPool.query(
      `INSERT INTO users(id,org_id,username,password_hash,status) VALUES ('u1','o1','u1','x','active')`,
    );
    srv = await startAsrWebSocketServer();
    port = srv.port;
  });

  afterEach(async () => {
    await srv?.close();
    srv = null;
  });

  test('/api/asr/realtime 升级成功（101）', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/asr/realtime?ticket=bogus`);
    // The client learns the status from the 'upgrade' event, not from 'open'.
    const [res] = await once(ws, 'upgrade');
    expect(res?.statusCode).toBe(101);
    ws.close();
  });

  test('升级到非 ASR 路径不会成功（连接被销毁）', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/some/other/path`);
    const [err] = await once(ws, 'error');
    expect(err).toBeDefined();
  });

  test('独立 ws 服务器对普通 HTTP 请求回 426（它不是 app 本身）', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(426);
  });
});

function once(emitter: any, event: string): Promise<any[]> {
  return new Promise((resolve) => {
    emitter.once(event, (...args: any[]) => resolve(args));
  });
}
