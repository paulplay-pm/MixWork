// Route tests for the MCP gateway: the token half (Task 12) and the relay
// half (Tasks 13–15). One file because both halves live on one module and a
// caller always does them in sequence: mint a service token, then dial.
//
// Auth on the token route is the member's ordinary enterprise JWT
// (`requireAuth`), so every refusal is a distinct status — the desktop turns
// 404 / 403 / 400 into different messages and must not blur them.
import '../helpers/setupEnv';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';

import { signGatewayToken, signToken, verifyGatewayToken } from '../../src/auth/jwt';
import { _resetMemberStatusCacheForTest } from '../../src/auth/memberStatus';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { mcpGatewayRoutes } from '../../src/routes/mcpGateway';
import { encryptConnectorSecrets } from '../../src/vault/connectorSecret';

const app = new Hono();
app.route('/', mcpGatewayRoutes);

interface ConnectorSeed {
  id: string;
  serverKey: string;
  orgId?: string;
  url?: string;
  authMode?: string;
  enabled?: boolean;
  tools?: Array<{ name: string; enabled?: boolean; removed?: boolean }>;
  scope?: { allCompany: boolean; deptIds: string[]; userIds: string[] };
}

/** Insert a connector directly. `auth_config` is written through the real
 *  encryptor so the relay half of this file can decrypt what it is handed —
 *  a hand-written `__enc__` stub would prove nothing about that path. */
async function mkConnector(s: ConnectorSeed): Promise<void> {
  await testPool.query(
    `INSERT INTO mcp_connectors
       (id, org_id, server_key, name_en, url, enabled, auth_mode, auth_config, scope, tools)
     VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9)`,
    [
      s.id,
      s.orgId ?? 'o1',
      s.serverKey,
      s.url ?? `https://mcp.example.com/${s.serverKey}`,
      s.enabled ?? true,
      s.authMode ?? 'shared-key',
      JSON.stringify(encryptConnectorSecrets({ apiKey: 'org-key-abc' })),
      JSON.stringify(s.scope ?? { allCompany: true, deptIds: [], userIds: [] }),
      JSON.stringify(s.tools ?? []),
    ],
  );
}

/** Two orgs; `fe` sits under `rd` so the subtree grant is exercised. */
async function seed(): Promise<void> {
  await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T1'), ('o2', 'T2')`);
  await testPool.query(
    `INSERT INTO departments(id, org_id, name, parent_id, path) VALUES
       ('rd',    'o1', '研发', NULL, '/rd'),
       ('fe',    'o1', '前端', 'rd',   '/rd/fe'),
       ('sales', 'o1', '销售', NULL,   '/sales')`,
  );
  await testPool.query(
    `INSERT INTO users(id, org_id, username, password_hash, display_name) VALUES
       ('u2',    'o1', 'u2',    'x', 'U2'),
       ('u3',    'o1', 'u3',    'x', 'U3'),
       ('admin', 'o1', 'admin', 'x', 'Admin')`,
  );
  await testPool.query(
    `INSERT INTO user_departments(user_id, dept_id, is_primary) VALUES
       ('u2', 'fe', true),
       ('u3', 'sales', true)`,
  );

  await mkConnector({
    id: 'c-1',
    serverKey: 'sk-1',
    tools: [
      { name: 'good_tool', enabled: true },
      { name: 'disabled_tool', enabled: false },
    ],
  });
  // Never probed: `tools` is still [] — every call must be denied.
  await mkConnector({ id: 'c-notools', serverKey: 'sk-notools' });
  // Granted to the parent dept — u2 in the child `fe` must still reach it.
  await mkConnector({ id: 'c-rd', serverKey: 'sk-rd', scope: { allCompany: false, deptIds: ['rd'], userIds: [] } });
  // Same shape as c-1 but disabled.
  await mkConnector({ id: 'c-off', serverKey: 'sk-off', enabled: false });
  // Same server key, different org.
  await mkConnector({ id: 'c-o2', serverKey: 'sk-o2', orgId: 'o2' });
  await mkConnector({ id: 'c-none', serverKey: 'sk-none', authMode: 'none' });
  await mkConnector({ id: 'c-http', serverKey: 'sk-http', url: 'http://example.com/mcp' });
  await mkConnector({ id: 'c-loop', serverKey: 'sk-loop', url: 'http://127.0.0.1:8931/mcp' });
  await mkConnector({ id: 'c-v6', serverKey: 'sk-v6', url: 'http://[::1]:8931/mcp' });
}

const tok = (sub: string, roles: string[] = ['member'], orgId = 'o1') =>
  signToken({ sub, orgId, roles });

async function mint(serverKey: string, jwt: string | null): Promise<Response> {
  return app.request(`/mcp/gateway/${serverKey}/token`, {
    method: 'POST',
    headers: jwt ? { authorization: `Bearer ${jwt}` } : {},
  });
}

describe('POST /mcp/gateway/:serverKey/token', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await seed();
  });

  test('a member gets a gsj for a shared-key connector they can see', async () => {
    const res = await mint('sk-1', await tok('u2'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresAt: string };
    expect(typeof body.token).toBe('string');

    // The token is not a bearer JWT: it must not pass the ordinary gate.
    const reuse = await app.request('/mcp/gateway/sk-1/token', {
      method: 'POST',
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(reuse.status).toBe(401);

    const claims = await verifyGatewayToken(body.token);
    expect(claims?.serverKey).toBe('sk-1');
    expect(claims?.orgId).toBe('o1');
    expect(claims?.sub).toBe('u2');

    // A 90-day lifetime is the point of this token: the desktop writes it into
    // OpenClaw config, and any config change restarts the gateway, so a short
    // lifetime would restart an agent's runtime every few minutes.
    const days = (Date.parse(body.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThanOrEqual(90);
  });

  test('a connector granted to the caller org dept is reachable from a child dept', async () => {
    const res = await mint('sk-rd', await tok('u2'));
    expect(res.status).toBe(200);
  });

  test('a connector the caller cannot see is 403', async () => {
    // c-rd is granted to `rd`; u3 sits in the unrelated `sales` dept.
    const res = await mint('sk-rd', await tok('u3'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });

  test('a non shared-key connector is 400', async () => {
    const res = await mint('sk-none', await tok('u2'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'not_gateway_mode' });
  });

  test('an unknown server key is 404', async () => {
    const res = await mint('sk-nope', await tok('u2'));
    expect(res.status).toBe(404);
  });

  test('a disabled connector is 404', async () => {
    const res = await mint('sk-off', await tok('u2'));
    expect(res.status).toBe(404);
  });

  test('a connector in another org is 404, not 403', async () => {
    const res = await mint('sk-o2', await tok('u2'));
    expect(res.status).toBe(404);
  });

  test('an unauthenticated request is 401', async () => {
    const res = await mint('sk-1', null);
    expect(res.status).toBe(401);
  });

  test('a plaintext http upstream is 400', async () => {
    const res = await mint('sk-http', await tok('u2'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'upstream_insecure' });
  });

  test('a loopback http upstream is allowed', async () => {
    expect((await mint('sk-loop', await tok('u2'))).status).toBe(200);
    // Bracketed IPv6 literal — `URL.hostname` is `[::1]`, not `::1`.
    expect((await mint('sk-v6', await tok('u2'))).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Relay half: `ALL /mcp/gateway/:serverKey`.
//
// The relay dials with the global `fetch`, so each relay test replaces it and
// asserts on what actually went out. Hono's `app.request()` never uses global
// fetch, so only the upstream hop is intercepted.
// ---------------------------------------------------------------------------

const upstream = vi.fn();

function stubUpstream(res: Response | (() => Response | Promise<Response>)): void {
  upstream.mockImplementation(async () => (typeof res === 'function' ? res() : res));
}

const relay = (serverKey: string, token: string | null, init: RequestInit = {}) =>
  app.request(`/mcp/gateway/${serverKey}`, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    ...init,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `McpGateway ${token}` } : {}),
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });

const mintG = async (serverKey: string, sub = 'u2'): Promise<string> =>
  (await signGatewayToken({ orgId: 'o1', sub, serverKey })).token;

describe('ALL /mcp/gateway/:serverKey', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await seed();
    _resetMemberStatusCacheForTest();
    upstream.mockReset();
    vi.stubGlobal('fetch', upstream);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('injects the org key and relays the upstream answer', async () => {
    stubUpstream(
      new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'mcp-session-id': 's1' },
      }),
    );

    const res = await relay('sk-1', await mintG('sk-1'));
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBe('s1');
    expect(await res.text()).toBe('{"jsonrpc":"2.0","id":1,"result":{}}');

    expect(upstream).toHaveBeenCalledTimes(1);
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://mcp.example.com/sk-1');
    const sent = new Headers(init.headers);
    // The org key, never the gateway token.
    expect(sent.get('authorization')).toBe('Bearer org-key-abc');
    // The client's own negotiation survives the hop.
    expect(sent.get('accept')).toContain('text/event-stream');
    expect(sent.get('content-type')).toBe('application/json');
    // The gateway token must not leak upstream in any form.
    expect(JSON.stringify([...(init.headers as Headers).entries()])).not.toContain('McpGateway');
  });

  test('streams the upstream body instead of buffering it', async () => {
    // A stream that yields one event and never closes. If the relay buffered,
    // this read would hang until the never-arriving end.
    stubUpstream(
      new Response(
        new ReadableStream({
          start(ctrl) {
            ctrl.enqueue(new TextEncoder().encode('data: hello\n\n'));
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    );

    const res = await relay('sk-1', await mintG('sk-1'));
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('relay buffered')), 2000)),
    ]);
    expect(new TextDecoder().decode(first.value)).toContain('data: hello');
    await reader.cancel();
  });

  test('an upstream 401 is reported as 502 upstream_unauthorized, not as a bad token', async () => {
    stubUpstream(new Response('nope', { status: 401 }));
    const res = await relay('sk-1', await mintG('sk-1'));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upstream_unauthorized' });
  });

  test('a bearer token is not a gateway credential', async () => {
    const res = await relay('sk-1', null, {
      headers: { authorization: `Bearer ${await mintG('sk-1')}` },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  test('a gsj for another connector is 404', async () => {
    const res = await relay('sk-1', await mintG('sk-2'));
    expect(res.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  test('a revoked member is 401 not_member with the desktop-facing code', async () => {
    await testPool.query(`UPDATE users SET status = 'disabled' WHERE id = 'u2'`);
    _resetMemberStatusCacheForTest();
    const res = await relay('sk-1', await mintG('sk-1'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'not_member', code: 41602 });
    expect(upstream).not.toHaveBeenCalled();
  });

  test('a super admin with no dept row reaches a dept-scoped connector', async () => {
    // The mint route authorizes a super admin from their JWT roles; the relay
    // verifies a GSJ that carries no roles at all. If the relay assumed
    // `isSuperAdmin: false`, an admin could mint a token and then be refused
    // by the relay one second later — a connector the console offered them,
    // made unusable by a 403 the desktop cannot explain.
    await testPool.query(
      `UPDATE users SET extra_roles = '["super_admin"]'::jsonb WHERE id = 'admin'`,
    );
    _resetMemberStatusCacheForTest();
    stubUpstream(
      new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const res = await relay('sk-rd', await mintG('sk-rd', 'admin'));
    expect(res.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  test('a demoted super admin loses the wide view on the next relay, not in 90 days', async () => {
    // The role is re-read from the row (30s cache), so a GSJ minted while the
    // user was an admin stops opening dept-scoped connectors once the role is
    // taken away — a role baked into the 90-day token could not do that.
    await testPool.query(
      `UPDATE users SET extra_roles = '["super_admin"]'::jsonb WHERE id = 'admin'`,
    );
    _resetMemberStatusCacheForTest();
    const gsj = await mintG('sk-rd', 'admin');
    await testPool.query(`UPDATE users SET extra_roles = '["member"]'::jsonb WHERE id = 'admin'`);
    _resetMemberStatusCacheForTest();

    const res = await relay('sk-rd', gsj);
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  test('a disabled connector is 404 and an invisible one is 403', async () => {
    const off = await relay('sk-off', await mintG('sk-off'));
    expect(off.status).toBe(404);

    // sk-rd is granted to `rd`; u3 sits in the unrelated `sales` dept.
    const hidden = await relay('sk-rd', await mintG('sk-rd', 'u3'));
    expect(hidden.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  test('a plaintext http upstream is refused with 502', async () => {
    // The token route refuses to mint for this connector, so forge one.
    const res = await relay('sk-http', await mintG('sk-http'));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upstream_insecure' });
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('the tool policy', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await seed();
    _resetMemberStatusCacheForTest();
    upstream.mockReset();
    vi.stubGlobal('fetch', upstream);
    stubUpstream(new Response('{"jsonrpc":"2.0","id":1,"result":{}}', { status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const call = (name: string, id = 7) =>
    JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } });

  test('an allowed tool is relayed', async () => {
    const res = await relay('sk-1', await mintG('sk-1'), { body: call('good_tool') });
    expect(res.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect((upstream.mock.calls[0] as [string, RequestInit])[1].body).toBe(call('good_tool'));
  });

  test('a disabled tool is refused without touching upstream', async () => {
    const res = await relay('sk-1', await mintG('sk-1'), { body: call('disabled_tool') });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32601 },
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  test('one denied element refuses the whole batch', async () => {
    const batch = [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'good_tool', arguments: {} } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'disabled_tool', arguments: {} } },
    ];
    const res = await relay('sk-1', await mintG('sk-1'), { body: JSON.stringify(batch) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: number; error?: { code: number } }>;
    expect(body).toHaveLength(2);
    expect(body.every((r) => r.error?.code === -32601)).toBe(true);
    expect(upstream).not.toHaveBeenCalled();
  });

  test('a batch of only allowed calls is relayed as a batch', async () => {
    const batch = [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'good_tool', arguments: {} } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ];
    const res = await relay('sk-1', await mintG('sk-1'), { body: JSON.stringify(batch) });
    expect(res.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect((upstream.mock.calls[0] as [string, RequestInit])[1].body).toBe(JSON.stringify(batch));
  });

  test('a connector that was never probed denies every call', async () => {
    const res = await relay('sk-notools', await mintG('sk-notools'), { body: call('anything') });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ jsonrpc: '2.0', id: 7, error: { code: -32601 } });
    expect(upstream).not.toHaveBeenCalled();
  });

  test('a request with no tools/call passes through untouched', async () => {
    const res = await relay('sk-1', await mintG('sk-1'), { body: '{ not json' });
    expect(res.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});

describe('the gateway audit trail', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await seed();
    _resetMemberStatusCacheForTest();
    upstream.mockReset();
    vi.stubGlobal('fetch', upstream);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const auditRows = async (): Promise<Array<Record<string, unknown>>> => {
    const r = await testPool.query(
      `SELECT user_id, target_type, target_id, payload FROM audit_events
        WHERE org_id = 'o1' AND action = 'mcp_gateway_call' ORDER BY ts`,
    );
    return r.rows as Array<Record<string, unknown>>;
  };

  test('a tools/call is audited from the response headers, without reading the body', async () => {
    // A stream that yields headers and never ends: any implementation that
    // reads the body before auditing would hang here forever.
    stubUpstream(
      new Response(
        new ReadableStream({
          start(ctrl) {
            ctrl.enqueue(new TextEncoder().encode('data: {"jsonrpc":"2.0","id":7,"result":{}}\n\n'));
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    );

    const res = await relay('sk-1', await mintG('sk-1'), {
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'good_tool', arguments: {} } }),
    });
    expect(res.status).toBe(200);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: 'u2',
      target_type: 'connector',
      target_id: 'sk-1',
    });
    const payload = JSON.stringify(rows[0].payload);
    expect(payload).toContain('good_tool');
    expect(payload).toContain('200');
    // No key material and no gateway token in the audit trail.
    expect(payload).not.toContain('org-key-abc');
    await res.body?.cancel();
  });

  test('initialize is not audited', async () => {
    stubUpstream(new Response('{}', { status: 200 }));
    await relay('sk-1', await mintG('sk-1'), {
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(await auditRows()).toHaveLength(0);
  });

  test('a refused tool call is not audited as an upstream call', async () => {
    stubUpstream(new Response('{}', { status: 200 }));
    await relay('sk-1', await mintG('sk-1'), {
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'disabled_tool', arguments: {} } }),
    });
    expect(await auditRows()).toHaveLength(0);
  });
});
