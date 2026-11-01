import { beforeEach, describe, expect, test, vi } from 'vitest';

import { EnterpriseApiErrorCode } from '../../shared/enterpriseAccount/constants';
import { McpAuthMethod, McpAuthStatus, McpGatewayError } from '../../shared/mcp/constants';
import { EnterpriseMembershipRevocationSource } from '../enterpriseAccount/membershipRevocation';
import { handleEnterpriseMembershipRevocation } from '../enterpriseAccount/membershipRevocationBridge';
import { ensureGatewayToken } from './mcpGatewayToken';
import type { McpServerRecord } from './mcpStore';
import {
  extractToolSummaries,
  listServerTools,
  McpToolListStatus,
  parseJsonRpcMessages,
} from './mcpToolCatalog';

// The probe reaches the enterprise gateway through the same two helpers config
// sync uses; both are stubbed so these tests assert on what the probe dialed
// rather than on the enterprise client.
vi.mock('./mcpGatewayToken', () => ({ ensureGatewayToken: vi.fn() }));
vi.mock('../enterpriseAccount/membershipRevocationBridge', () => ({
  handleEnterpriseMembershipRevocation: vi.fn(),
}));
vi.mock('../libs/endpoints', () => ({
  getServerApiBaseUrl: () => 'https://ent.example.com',
}));

const issue = vi.mocked(ensureGatewayToken);
const revoked = vi.mocked(handleEnterpriseMembershipRevocation);

function makeRecord(overrides: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    id: 'srv-1',
    name: '纷享销客',
    description: '',
    enabled: true,
    transportType: 'http',
    url: 'https://open.fxiaoke.com/mcp/nuobo2026/ai',
    headers: { Authorization: 'Bearer the-token' },
    isBuiltIn: false,
    authMethod: McpAuthMethod.OAuth,
    authStatus: McpAuthStatus.Authenticated,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

interface Recorded {
  url: string;
  body: string;
  headers: Record<string, string>;
}

/** A fetch that answers each POST with the next scripted reply. */
function scriptedFetch(
  replies: Array<{ status?: number; text: string; headers?: Record<string, string> }>,
): { fetchImpl: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let index = 0;
  const fetchImpl = (async (input: string, init: RequestInit) => {
    const reply = replies[index];
    index += 1;
    calls.push({
      url: String(input),
      body: String(init.body ?? ''),
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    if (!reply) throw new Error(`unexpected request #${index}`);
    return new Response(reply.text, {
      status: reply.status ?? 200,
      headers: reply.headers,
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const INITIALIZE_OK = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  result: {
    protocolVersion: '2024-11-05',
    serverInfo: { name: 'fxiaoke-crm', version: '1.0.0' },
    capabilities: { tools: {} },
  },
});

const TOOLS_OK = JSON.stringify({
  jsonrpc: '2.0',
  id: 2,
  result: {
    tools: [
      { name: 'create_lead', description: 'Create a lead in the CRM' },
      { name: 'search_customer' },
    ],
  },
});

describe('parseJsonRpcMessages', () => {
  test('parses a plain JSON body and a batched array', () => {
    expect(parseJsonRpcMessages('{"id":1,"result":{}}')).toEqual([{ id: 1, result: {} }]);
    expect(parseJsonRpcMessages('[{"id":1},{"id":2}]')).toHaveLength(2);
  });

  test('parses SSE frames, including multi-line data payloads', () => {
    const sse = [
      'event: message',
      'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
      '',
      'event: message',
      'data: {"jsonrpc":"2.0",',
      'data: "id":2}',
      '',
    ].join('\n');
    expect(parseJsonRpcMessages(sse)).toEqual([
      { jsonrpc: '2.0', id: 1, result: { ok: true } },
      { jsonrpc: '2.0', id: 2 },
    ]);
  });

  test('returns nothing for an empty or non-JSON body', () => {
    expect(parseJsonRpcMessages('')).toEqual([]);
    expect(parseJsonRpcMessages('not json')).toEqual([]);
  });
});

describe('extractToolSummaries', () => {
  test('keeps name + description and drops entries with no name', () => {
    const result = extractToolSummaries({
      tools: [{ name: 'a', description: 'does a' }, { description: 'missing name' }, { name: '' }],
    });
    expect(result.tools).toEqual([{ name: 'a', description: 'does a' }]);
  });

  test('carries nextCursor and truncates very long descriptions', () => {
    const long = 'x'.repeat(400);
    const result = extractToolSummaries({ tools: [{ name: 'a', description: long }], nextCursor: 'p2' });
    expect(result.nextCursor).toBe('p2');
    expect(result.tools[0]!.description!.length).toBeLessThanOrEqual(200);
    expect(result.tools[0]!.description!.endsWith('…')).toBe(true);
  });
});

describe('listServerTools (http)', () => {
  test('initializes, sends the initialized notification, then lists tools', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      { text: INITIALIZE_OK, headers: { 'mcp-session-id': 'sess-1' } },
      { status: 202, text: '' },
      { text: TOOLS_OK },
    ]);
    const result = await listServerTools(makeRecord(), { fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(McpToolListStatus.Ok);
    expect(result.tools.map((t) => t.name)).toEqual(['create_lead', 'search_customer']);
    expect(calls).toHaveLength(3);
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ method: 'initialize', id: 1 });
    expect(JSON.parse(calls[1]!.body)).toMatchObject({ method: 'notifications/initialized' });
    expect(JSON.parse(calls[2]!.body)).toMatchObject({ method: 'tools/list', id: 2 });
    // The session id from initialize is presented on every later request.
    expect(calls[1]!.headers['mcp-session-id']).toBe('sess-1');
    expect(calls[2]!.headers['mcp-session-id']).toBe('sess-1');
    // The saved credential rides along, and never appears in the result.
    expect(calls[2]!.headers.Authorization).toBe('Bearer the-token');
    expect(JSON.stringify(result)).not.toContain('the-token');
  });

  test('works against a stateless server that mints no session', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      { text: INITIALIZE_OK },
      { status: 202, text: '' },
      { text: TOOLS_OK },
    ]);
    const result = await listServerTools(makeRecord(), { fetchImpl });
    expect(result.ok).toBe(true);
    expect(calls[2]!.headers['mcp-session-id']).toBeUndefined();
  });

  test('an SSE-encoded tools/list response is understood', async () => {
    const sse = `event: message\ndata: ${TOOLS_OK}\n\n`;
    const { fetchImpl } = scriptedFetch([
      { text: INITIALIZE_OK },
      { status: 202, text: '' },
      { text: sse },
    ]);
    const result = await listServerTools(makeRecord(), { fetchImpl });
    expect(result.tools.map((t) => t.name)).toEqual(['create_lead', 'search_customer']);
  });

  test('maps 401 to unauthorized, not a generic connection error', async () => {
    const { fetchImpl } = scriptedFetch([{ status: 401, text: '' }]);
    const result = await listServerTools(makeRecord(), { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(McpToolListStatus.Unauthorized);
    expect(result.error).toBe('HTTP 401');
  });

  test('a tools/list error message is surfaced verbatim', async () => {
    const { fetchImpl } = scriptedFetch([
      { text: INITIALIZE_OK },
      { status: 202, text: '' },
      {
        text: JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'Method not found' } }),
      },
    ]);
    const result = await listServerTools(makeRecord(), { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Method not found');
  });

  test('follows nextCursor for paginated tool lists', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      { text: INITIALIZE_OK },
      { status: 202, text: '' },
      {
        text: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          result: { tools: [{ name: 'first' }], nextCursor: 'page-2' },
        }),
      },
      {
        text: JSON.stringify({ jsonrpc: '2.0', id: 3, result: { tools: [{ name: 'second' }] } }),
      },
    ]);
    const result = await listServerTools(makeRecord(), { fetchImpl });
    expect(result.tools.map((t) => t.name)).toEqual(['first', 'second']);
    expect(JSON.parse(calls[3]!.body).params).toEqual({ cursor: 'page-2' });
  });

  test('refuses to probe without the credential the auth method requires', async () => {
    const fetchImpl = vi.fn();
    const result = await listServerTools(makeRecord({ headers: {} }), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.status).toBe(McpToolListStatus.MissingCredential);
    expect(result.error).toContain('OAuth token missing');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('listServerTools (enterprise gateway)', () => {
  const FAR_FUTURE = '2030-01-01T00:00:00.000Z';
  const GATEWAY_URL = 'https://ent.example.com/mcp/gateway/sk-1';

  /** A record installed from a `shared-key` catalog entry: no credential of
   *  its own, dialed through the gateway with the service token it carries. */
  const gatewayRecord = (overrides: Partial<McpServerRecord> = {}): McpServerRecord =>
    makeRecord({
      url: 'https://vendor.example.com/mcp/sk-1',
      headers: {},
      authMethod: McpAuthMethod.None,
      consumption: 'gateway',
      serverKey: 'sk-1',
      gatewayToken: 'gsj-1',
      gatewayTokenOwner: 'u1',
      gatewayTokenExpiresAt: FAR_FUTURE,
      ...overrides,
    });

  beforeEach(() => {
    issue.mockReset();
    revoked.mockReset();
    issue.mockResolvedValue({ token: 'gsj-1', owner: 'u1', expiresAt: FAR_FUTURE });
  });

  test('the probe hits the gateway, not the upstream', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      { text: INITIALIZE_OK },
      { status: 202, text: '' },
      { text: TOOLS_OK },
    ]);
    const result = await listServerTools(gatewayRecord(), { fetchImpl });

    expect(result.status).toBe(McpToolListStatus.Ok);
    expect(calls[0]!.url).toBe(GATEWAY_URL);
    expect(calls[0]!.headers.authorization).toBe('McpGateway gsj-1');
    // Every leg, not just the first: the upstream must never be dialed, and
    // the service token must never end up in the dialog's data.
    expect(calls.every((call) => call.url === GATEWAY_URL)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('gsj-1');
    expect(JSON.stringify(result)).not.toContain('vendor.example.com');
  });

  test('a 401 re-mints the token once and retries against the gateway', async () => {
    issue
      .mockResolvedValueOnce({ token: 'gsj-1', owner: 'u1', expiresAt: FAR_FUTURE })
      .mockResolvedValueOnce({ token: 'gsj-2', owner: 'u1', expiresAt: FAR_FUTURE });
    const saveGatewayToken = vi.fn();
    const { fetchImpl, calls } = scriptedFetch([
      { status: 401, text: JSON.stringify({ error: 'unauthorized' }) },
      { text: INITIALIZE_OK },
      { status: 202, text: '' },
      { text: TOOLS_OK },
    ]);

    const result = await listServerTools(gatewayRecord(), { fetchImpl, saveGatewayToken });

    expect(result.status).toBe(McpToolListStatus.Ok);
    expect(calls).toHaveLength(4);
    expect(calls[1]!.headers.authorization).toBe('McpGateway gsj-2');
    // One fresh mint per refused attempt — no retry loop around a dead token.
    expect(issue).toHaveBeenCalledTimes(2);
    // The refreshed token is written back so the next probe and the next
    // config build reuse it instead of minting again.
    expect(saveGatewayToken).toHaveBeenCalledTimes(1);
    expect(saveGatewayToken).toHaveBeenCalledWith('srv-1', 'gsj-2', 'u1', FAR_FUTURE);
    expect(revoked).not.toHaveBeenCalled();
  });

  test('a 401 not_member revokes the session instead of refreshing', async () => {
    const saveGatewayToken = vi.fn();
    const { fetchImpl, calls } = scriptedFetch([
      { status: 401, text: JSON.stringify({ error: 'not_member', code: EnterpriseApiErrorCode.NotMember }) },
    ]);

    const result = await listServerTools(gatewayRecord(), { fetchImpl, saveGatewayToken });

    expect(result.status).toBe(McpToolListStatus.Unauthorized);
    expect(calls).toHaveLength(1);
    expect(revoked).toHaveBeenCalledWith(
      EnterpriseApiErrorCode.NotMember,
      EnterpriseMembershipRevocationSource.JsonApi,
    );
    // A refresh would be issued against a revoked member's JWT — pointless at
    // best, and it would keep the dead session alive.
    expect(issue).toHaveBeenCalledTimes(1);
    expect(saveGatewayToken).not.toHaveBeenCalled();
  });

  test('a gateway 502 carries the relay error so the dialog can name the cause', async () => {
    const { fetchImpl } = scriptedFetch([
      { status: 502, text: JSON.stringify({ error: 'upstream_unauthorized' }) },
    ]);

    const result = await listServerTools(gatewayRecord(), { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(McpToolListStatus.ConnectError);
    expect(result.errorCode).toBe(McpGatewayError.UpstreamUnauthorized);
    // The protocol-level detail stays as the fallback for a code this build
    // does not know.
    expect(result.error).toContain('502');
  });

  test('a direct connector that answers 502 carries no gateway code', async () => {
    // The same `{"error": ...}` body from a vendor endpoint is not the
    // gateway speaking, and must not be translated as "the org key died".
    const { fetchImpl } = scriptedFetch([
      { status: 502, text: JSON.stringify({ error: 'upstream_unauthorized' }) },
    ]);

    const result = await listServerTools(
      makeRecord({ url: 'https://vendor.example.com/mcp', headers: {} }),
      { fetchImpl },
    );

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBeUndefined();
  });

  test('an unrecognised gateway code is dropped rather than shown raw', async () => {
    const { fetchImpl } = scriptedFetch([
      { status: 502, text: JSON.stringify({ error: 'some_future_code' }) },
    ]);

    const result = await listServerTools(gatewayRecord(), { fetchImpl });

    expect(result.errorCode).toBeUndefined();
  });

  test('a signed-out app reports a missing credential instead of dialing with a stored token', async () => {
    const fetchImpl = vi.fn();
    // No member to mint for. The record still carries the token a previous
    // session minted; the probe must not dial the gateway with it (§8.26).
    issue.mockResolvedValue(null);
    const result = await listServerTools(gatewayRecord(), { fetchImpl });
    expect(result.status).toBe(McpToolListStatus.MissingCredential);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('a record the gateway cannot address is reported, never dialed directly', async () => {
    const fetchImpl = vi.fn();
    const result = await listServerTools(gatewayRecord({ serverKey: undefined }), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.status).toBe(McpToolListStatus.MissingCredential);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('a direct connector still dials its own url and never touches the gateway', async () => {
    const { fetchImpl, calls } = scriptedFetch([{ status: 401, text: '{"error":"nope"}' }]);
    const result = await listServerTools(makeRecord(), { fetchImpl });

    expect(result.status).toBe(McpToolListStatus.Unauthorized);
    expect(calls[0]!.url).toBe('https://open.fxiaoke.com/mcp/nuobo2026/ai');
    expect(issue).not.toHaveBeenCalled();
    expect(revoked).not.toHaveBeenCalled();
  });
});
