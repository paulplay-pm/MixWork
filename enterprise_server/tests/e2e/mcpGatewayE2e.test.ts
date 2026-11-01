// End-to-end proof of the MCP shared-key gateway (Task 30).
//
// Every other gateway test goes through `app.request()`, which never touches
// `node:http` — and the adapter is the one place where a buffering bug kills
// the whole feature (an MCP session is an open SSE stream). This file runs the
// real stack: a real `http.Server` on a real port, a real global `fetch` for
// the relay hop, and a fake MCP upstream on loopback that records exactly what
// crossed it.
//
// The org key never leaves this process: the upstream sees it, the gateway
// token the desktop holds never does, and the audit trail names the tool but
// never the key.
import '../helpers/setupEnv';

import http from 'node:http';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { signToken } from '../../src/auth/jwt';
import { _resetMemberStatusCacheForTest } from '../../src/auth/memberStatus';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { createNodeRequestHandler } from '../../src/http/nodeAdapter';
import { buildApp } from '../../src/server';
import { Role } from '../../src/shared/enterpriseServerConstants';

/** The org's shared key. Nothing on the desktop side ever holds this value. */
const ORG_KEY = 'org-key-xyz';

interface SeenRequest {
  method: string;
  /** The JSON-RPC method for a POST (initialize / tools/list / tools/call). */
  rpc?: string;
  authorization?: string;
}

interface FakeUpstream {
  url: string;
  seen: SeenRequest[];
  stop: () => Promise<void>;
}

/**
 * A minimal MCP server: initialize, tools/list, tools/call, and an SSE channel.
 *
 * Loopback on purpose — it is the D17 exception in the gateway's address
 * check, so this harness needs no TLS. The GET handler writes one event and
 * then holds the stream open: that is what a real MCP server's server→client
 * channel looks like, and what the adapter must not buffer.
 */
function startUpstream(): Promise<FakeUpstream> {
  const seen: SeenRequest[] = [];
  const server = http.createServer((req, res) => {
    const authorization = req.headers.authorization;
    if (req.method === 'GET') {
      seen.push({ method: 'GET', authorization });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"jsonrpc":"2.0","method":"notifications/message"}\n\n');
      return; // stays open on purpose
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const msg = (body ? JSON.parse(body) : null) as
        | { id?: number | string | null; method?: string }
        | null;
      // A notification has no id and must be accepted with 202 and no body.
      if (msg?.method === 'notifications/initialized') {
        res.writeHead(202).end();
        return;
      }
      seen.push({ method: 'POST', rpc: msg?.method, authorization });
      const result =
        msg?.method === 'tools/list'
          ? {
              tools: [
                // `inputSchema` is required by the MCP SDK's ToolSchema — the
                // admin probe runs that client, so a tool without it is
                // rejected before the policy ever sees the list.
                { name: 'create_lead', inputSchema: { type: 'object', properties: {} } },
                { name: 'disabled_tool', inputSchema: { type: 'object', properties: {} } },
              ],
            }
          : msg?.method === 'tools/call'
            ? { content: [{ type: 'text', text: 'ok' }] }
            : {
                protocolVersion: '2024-11-05',
                capabilities: {},
                serverInfo: { name: 'fake', version: '1' },
              };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg?.id ?? null, result }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        seen,
        stop: () =>
          new Promise<void>((done) => {
            // The SSE channels never end on their own; drop them so close()
            // can finish.
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

interface Enterprise {
  base: string;
  port: number;
  stop: () => Promise<void>;
}

/** The real app behind the real `node:http` adapter — the same wiring
 *  `server.ts` uses in production. */
function startEnterprise(): Promise<Enterprise> {
  const server = http.createServer(createNodeRequestHandler(buildApp()));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        base: `http://127.0.0.1:${port}`,
        port,
        stop: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

/** Two orgs; `fe` sits under `rd`, so a grant to `rd` reaches `u2` in `fe`. */
async function seed(): Promise<void> {
  await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T1'), ('o2', 'T2')`);
  await testPool.query(
    `INSERT INTO departments(id, org_id, name, parent_id, path) VALUES
       ('rd', 'o1', '研发', NULL, '/rd'),
       ('fe', 'o1', '前端', 'rd',   '/rd/fe')`,
  );
  await testPool.query(
    `INSERT INTO users(id, org_id, username, password_hash, display_name) VALUES
       ('u2',    'o1', 'u2',    'x', 'U2'),
       ('admin', 'o1', 'admin', 'x', 'Admin')`,
  );
  await testPool.query(
    `INSERT INTO user_departments(user_id, dept_id, is_primary) VALUES ('u2', 'fe', true)`,
  );
}

let upstream: FakeUpstream;
let enterprise: Enterprise;
let serverKey: string;
let gsj: string;
let adminTok: string;
let memberTok: string;

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function post(path: string, token: string, body?: unknown): Promise<Response> {
  return fetch(`${enterprise.base}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** One MCP request through the gateway, the way a desktop sends it. */
async function relay(body: unknown): Promise<Response> {
  return fetch(`${enterprise.base}/mcp/gateway/${serverKey}`, {
    method: 'POST',
    headers: {
      authorization: `McpGateway ${gsj}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await resetSchema();
  await runMigrations();
  await seed();
  _resetMemberStatusCacheForTest();
  upstream = await startUpstream();
  enterprise = await startEnterprise();

  adminTok = await signToken({ sub: 'admin', orgId: 'o1', roles: [Role.SuperAdmin] });
  memberTok = await signToken({ sub: 'u2', orgId: 'o1', roles: [Role.User] });

  // 1. The admin publishes a shared-key connector at the loopback upstream,
  //    probes it for real (the org key goes out, the tool list comes back),
  //    and publishes the working copy with one tool disabled.
  const created = await post('/admin/mcp-connectors', adminTok, {
    orgId: 'o1',
    serverKey: 'sk-1',
    nameEn: 'Fake MCP',
    url: upstream.url,
    authMode: 'shared-key',
    authConfig: { apiKey: ORG_KEY },
    scope: { allCompany: false, deptIds: ['rd'], userIds: [] },
  });
  expect(created.status).toBe(201);
  const { id } = await json(created);
  serverKey = 'sk-1';

  const probed = await post(`/admin/mcp-connectors/${String(id)}/test`, adminTok);
  expect(probed.status).toBe(200);
  expect((await json(probed)).status).toBe('connected');

  const published = await post(`/admin/mcp-connectors/${String(id)}/publish`, adminTok, {
    url: upstream.url,
    version: '1.0.0',
    transport: 'http',
    authMode: 'shared-key',
    scope: { allCompany: false, deptIds: ['rd'], userIds: [] },
    tools: [
      { name: 'create_lead', enabled: true },
      { name: 'disabled_tool', enabled: false },
    ],
  });
  expect(published.status).toBe(200);

  // 2. The member's ordinary enterprise JWT buys a gateway service token.
  const minted = await post(`/mcp/gateway/${serverKey}/token`, memberTok);
  expect(minted.status).toBe(200);
  const mintedBody = await json(minted);
  gsj = String(mintedBody.token);
  expect(typeof mintedBody.expiresAt).toBe('string');
});

afterEach(async () => {
  await enterprise.stop();
  await upstream.stop();
});

describe('MCP gateway over a real socket', () => {
  // 3–5. The relay: the org key is injected upstream, the tool policy is
  // enforced locally, and a disabled tool never spends the key.
  test('relays tools/list and tools/call with the org key, refusing a disabled tool', async () => {
    const list = await relay({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(list.status).toBe(200);
    const listed = (await json(list)) as { result?: { tools?: Array<{ name: string }> } };
    expect(listed.result?.tools?.map((t) => t.name)).toEqual(['create_lead', 'disabled_tool']);

    const callsBefore = upstream.seen.filter((s) => s.rpc === 'tools/call').length;
    const call = await relay({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'create_lead', arguments: {} },
    });
    expect(call.status).toBe(200);
    const called = (await json(call)) as { result?: { content?: Array<{ text: string }> } };
    expect(called.result?.content?.[0]?.text).toBe('ok');
    expect(upstream.seen.filter((s) => s.rpc === 'tools/call').length).toBe(callsBefore + 1);

    const denied = await relay({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'disabled_tool', arguments: {} },
    });
    // A refused tool is answered in-band (JSON-RPC error) and never dialed.
    expect(denied.status).toBe(200);
    const denial = (await denied.json()) as { error?: { code: number } };
    expect(denial.error?.code).toBe(-32601);
    expect(upstream.seen.filter((s) => s.rpc === 'tools/call').length).toBe(callsBefore + 1);

    // Every hop upstream carried the org key — never the desktop's token.
    expect(upstream.seen.length).toBeGreaterThan(0);
    for (const seen of upstream.seen) {
      expect(seen.authorization).toBe(`Bearer ${ORG_KEY}`);
    }
    expect(JSON.stringify(upstream.seen)).not.toContain('McpGateway');
    expect(JSON.stringify(upstream.seen)).not.toContain(gsj);
  });

  // 6. The one assertion that fails if the adapter buffers: an SSE chunk must
  //    reach the client while the response is still open.
  test('streams an SSE chunk while the response is still open', async () => {
    const received = await new Promise<string>((resolve, reject) => {
      const sentinel = setTimeout(
        () => reject(new Error('adapter buffered: no chunk arrived while the stream was open')),
        2000,
      );
      const req = http.get(
        {
          host: '127.0.0.1',
          port: enterprise.port,
          path: `/mcp/gateway/${serverKey}`,
          headers: { authorization: `McpGateway ${gsj}`, accept: 'text/event-stream' },
        },
        (res) => {
          res.once('data', (buf: Buffer) => {
            clearTimeout(sentinel);
            resolve(buf.toString());
            req.destroy();
          });
        },
      );
      req.on('error', (err) => {
        clearTimeout(sentinel);
        reject(err);
      });
    });
    expect(received).toContain('notifications/message');
  });

  // 7. One audit row per tool call, naming the member and the tool — and never
  //    the org key.
  test('audits each tool call without recording the org key', async () => {
    await relay({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'create_lead', arguments: {} },
    });
    // A denied call is not a call: it must leave no audit row.
    await relay({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'disabled_tool', arguments: {} },
    });

    const rows = await testPool.query<{ user_id: string; payload: Record<string, unknown> }>(
      `SELECT user_id, payload FROM audit_events WHERE action = 'mcp_gateway_call' ORDER BY id`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].user_id).toBe('u2');
    expect(rows.rows[0].payload.tool).toBe('create_lead');
    expect(JSON.stringify(rows.rows)).not.toContain(ORG_KEY);
  });
});
