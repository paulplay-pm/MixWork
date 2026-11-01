import type { Context } from 'hono';
import { Hono } from 'hono';

import { auditStore } from '../audit/auditStore';
import { type Claims, type GatewayClaims, signGatewayToken, verifyGatewayToken } from '../auth/jwt';
import { resolveMemberStatus } from '../auth/memberStatus';
import { requireAuth } from '../auth/middleware';
import { scopeApi } from '../auth/scopeResolver';
import { pool } from '../db/pool';
import {
  type ConnectorCaller,
  connectorVisibleToCaller,
  loadConnectorDeptPath,
} from '../mcp/connectorVisibility';
import { toolAllowedByPolicy } from '../mcp/gatewayPolicy';
import { buildOrgCredentialHeaders } from '../mcp/orgCredential';
import { COLUMNS, type ConnectorRow } from '../models/connectorView';
import {
  AuditAction,
  EnterpriseApiErrorCode,
  ProviderProxyWireError,
  Role,
} from '../shared/enterpriseServerConstants';
import { decryptConnectorSecrets } from '../vault/connectorSecret';

export const mcpGatewayRoutes = new Hono();

/** A non-loopback upstream must be https before an org key is sent to it. */
export function isUpstreamAddressAllowed(url: string | null): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  // `URL.hostname` keeps a bracketed IPv6 literal (`[::1]`), so unwrap it.
  return ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname.replace(/^\[|\]$/g, ''));
}

async function loadConnector(orgId: string, serverKey: string): Promise<ConnectorRow | null> {
  const r = await pool.query<ConnectorRow>(
    `SELECT ${COLUMNS} FROM mcp_connectors WHERE org_id = $1 AND server_key = $2`,
    [orgId, serverKey],
  );
  return r.rows[0] ?? null;
}

async function callerFor(claims: Claims): Promise<ConnectorCaller> {
  const isSuperAdmin = (claims.roles ?? []).includes(Role.SuperAdmin);
  return {
    userId: claims.sub,
    isSuperAdmin,
    deptIds: isSuperAdmin ? [] : await scopeApi.deptIdsFor(claims.orgId, claims.sub),
  };
}

/**
 * Mint (or refresh) the gateway service token for one connector.
 *
 * The desktop calls this with the member's ordinary enterprise JWT — the same
 * session it already holds — so installing a shared-key connector needs no
 * user-visible authorization step. Every refusal is a distinct status because
 * the desktop turns them into different messages: 404 gone, 403 not yours,
 * 400 not a gateway connector / not a safe destination.
 */
mcpGatewayRoutes.post('/mcp/gateway/:serverKey/token', requireAuth, async (c) => {
  const claims = c.get('claims');
  const serverKey = c.req.param('serverKey');
  const row = await loadConnector(claims.orgId, serverKey);
  if (!row || !row.enabled) return c.json({ error: 'not_found' }, 404);

  const caller = await callerFor(claims);
  const deptPath = await loadConnectorDeptPath(claims.orgId);
  if (!connectorVisibleToCaller(row, caller, deptPath)) return c.json({ error: 'forbidden' }, 403);

  if (row.auth_mode !== 'shared-key') return c.json({ error: 'not_gateway_mode' }, 400);
  if (!isUpstreamAddressAllowed(row.url)) return c.json({ error: 'upstream_insecure' }, 400);

  const { token, expiresAt } = await signGatewayToken({
    orgId: claims.orgId,
    sub: claims.sub,
    serverKey: row.server_key,
  });
  return c.json({ token, expiresAt });
});

/** The auth scheme desktop uses for a gateway service token. Distinct from
 *  `Bearer` on purpose: a member JWT that lands on the relay must be refused,
 *  not mistaken for a service token (and vice versa). */
const GATEWAY_SCHEME = 'McpGateway';

/** Hop-by-hop and credential headers that must never be forwarded as-is:
 *  `authorization` carries the client's gateway token, which the org
 *  credential replaces; the rest are recomputed by the upstream connection. */
const DROP_REQUEST_HEADERS = new Set([
  'authorization',
  'host',
  'content-length',
  'connection',
  'accept-encoding',
]);

/** Response headers that describe the upstream framing or its cookies, none of
 *  which survive a relay hop unchanged. `content-type` and `mcp-session-id`
 *  are the two the client actually needs. */
const DROP_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'set-cookie',
]);

const BODYLESS_METHODS = new Set(['GET', 'HEAD', 'DELETE']);

interface Authorized {
  claims: GatewayClaims;
  row: ConnectorRow;
}

/**
 * The one place a relay request is authorized. Returns either a `Response` to
 * send (every refusal) or the verified claims plus the connector row.
 *
 * Order matters and is the spec's: the token decides *who*, the row decides
 * *what*, and each refusal keeps its own status because the desktop renders
 * them differently. A revoked member short-circuits everything — their token
 * is still valid cryptography, but they must not reach an org credential.
 */
async function authorizeRelay(c: Context): Promise<Response | Authorized> {
  const serverKey = c.req.param('serverKey');
  const header = c.req.header('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (!token || scheme.toLowerCase() !== GATEWAY_SCHEME.toLowerCase()) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const claims = await verifyGatewayToken(token);
  if (!claims) return c.json({ error: 'unauthorized' }, 401);

  // A token minted for connector A must not open connector B — otherwise one
  // visible connector becomes a key to every connector in the org.
  if (claims.serverKey !== serverKey) return c.json({ error: 'not_found' }, 404);

  const member = await resolveMemberStatus(claims.sub);
  if (member.kind === 'missing' || (member.kind === 'status' && member.status !== 'active')) {
    return c.json(
      { error: ProviderProxyWireError.NotMember, code: EnterpriseApiErrorCode.NotMember },
      401,
    );
  }
  // `kind === 'error'` deliberately falls through: a transient DB failure must
  // not sign an innocent member out mid-conversation.

  const row = await loadConnector(claims.orgId, serverKey);
  if (!row || !row.enabled) return c.json({ error: 'not_found' }, 404);

  // A GSJ carries no roles — it lives 90 days, and baking a role into it
  // would let a demoted admin keep the org-wide view until it expired. The
  // membership read above already fetched the row, so its `extra_roles` is
  // the freshest answer available at zero extra cost.
  const isSuperAdmin = member.kind === 'status' && member.isSuperAdmin;
  const caller: ConnectorCaller = {
    userId: claims.sub,
    isSuperAdmin,
    deptIds: isSuperAdmin ? [] : await scopeApi.deptIdsFor(claims.orgId, claims.sub),
  };
  const deptPath = await loadConnectorDeptPath(claims.orgId);
  if (!connectorVisibleToCaller(row, caller, deptPath)) return c.json({ error: 'forbidden' }, 403);

  return { claims, row };
}

const TOOL_NOT_FOUND = -32601;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: { name?: string } & Record<string, unknown>;
}

/**
 * Refuse a `tools/call` for a tool the connector does not expose.
 *
 * The catalog is the admin's list, not the upstream's: a tool the admin
 * disabled (or one never probed at all) must be refused HERE, before the org
 * key is spent on it. A batch with a single violation is refused whole — the
 * client pairs responses to requests by id, and relaying half a batch leaves
 * it waiting on the other half forever.
 *
 * Returns the response to send, or null to relay the request unchanged.
 */
function refuseDeniedToolCalls(row: ConnectorRow, body: string): unknown | null {
  let parsed: JsonRpcMessage | JsonRpcMessage[];
  try {
    parsed = JSON.parse(body) as JsonRpcMessage | JsonRpcMessage[];
  } catch {
    return null; // not JSON — not ours to judge
  }

  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const calls = messages.filter((m) => m?.method === 'tools/call');
  if (calls.length === 0) return null;

  const denied = calls.find((m) => !toolAllowedByPolicy(row.tools ?? [], m.params?.name ?? ''));
  if (!denied) return null;

  const tool = denied.params?.name ?? '';
  const error = (id: unknown, message: string) => ({
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code: TOOL_NOT_FOUND, message },
  });

  if (!Array.isArray(parsed)) {
    return error(parsed.id, `tool not exposed on this connector: ${tool}`);
  }
  // Every element gets an answer, so the client can retire each pending id.
  return messages.map((m) =>
    error(m?.id, `batch refused: ${tool} is not exposed on this connector`),
  );
}

/** Names of the `tools/call` targets in a request body, in order. */
function toolCallNames(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as JsonRpcMessage | JsonRpcMessage[];
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    return messages.filter((m) => m?.method === 'tools/call').map((m) => m.params?.name ?? '');
  } catch {
    return [];
  }
}

/**
 * One audit row per tool call, written the instant the upstream's response
 * headers arrive.
 *
 * Deliberately not after the body: an MCP tool call may answer over an SSE
 * stream that stays open for minutes, and waiting would both delay the trail
 * and lose it entirely if the member closed the app. The upstream status is
 * the honest record — whether the tool *succeeded* is in the body, which the
 * gateway never reads.
 *
 * Never throws: an audit failure is logged and does not fail the call.
 */
async function auditToolCalls(
  row: ConnectorRow,
  userId: string,
  toolNames: string[],
  status: number,
  latencyMs: number,
): Promise<void> {
  for (const tool of toolNames) {
    try {
      await auditStore.write({
        orgId: row.org_id,
        userId,
        action: AuditAction.McpGatewayCall,
        targetType: 'connector',
        targetId: row.server_key,
        payload: { method: 'tools/call', tool, status, latencyMs },
      });
    } catch (err) {
      console.error('[McpGateway] audit write failed', err);
    }
  }
}

/**
 * Relay one MCP request to the connector's upstream, injecting the org
 * credential on the way out.
 *
 * The response body is handed straight through as a stream: MCP answers
 * `initialize` and long tool calls over SSE, and buffering it would hold the
 * desktop's session open until the server finished talking.
 */
mcpGatewayRoutes.all('/mcp/gateway/:serverKey', async (c) => {
  const auth = await authorizeRelay(c);
  if (auth instanceof Response) return auth;
  const { row } = auth;

  if (row.transport === 'sse') return c.json({ error: 'unsupported_transport' }, 400);
  if (!isUpstreamAddressAllowed(row.url)) return c.json({ error: 'upstream_insecure' }, 502);

  const headers = new Headers();
  for (const [name, value] of c.req.raw.headers) {
    if (!DROP_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  // The org key is set last: whatever the client sent is replaced, never merged.
  for (const [name, value] of Object.entries(
    buildOrgCredentialHeaders(row.auth_mode, decryptConnectorSecrets(row.auth_config)),
  )) {
    headers.set(name, value);
  }

  const method = c.req.method.toUpperCase();
  const body = BODYLESS_METHODS.has(method) ? null : await c.req.text();

  if (body) {
    const refusal = refuseDeniedToolCalls(row, body);
    if (refusal) return c.json(refusal as Record<string, unknown>, 200);
  }

  const startedAt = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch(row.url, { method, headers, body });
  } catch {
    return c.json({ error: 'upstream_unreachable' }, 502);
  }

  const toolNames = body ? toolCallNames(body) : [];
  if (toolNames.length > 0) {
    await auditToolCalls(row, auth.claims.sub, toolNames, upstream.status, Date.now() - startedAt);
  }

  // An upstream 401 means the ORG key was refused. Reporting it as our own 401
  // would tell the desktop its gateway token is bad and send it off to re-mint
  // one, which would change nothing.
  if (upstream.status === 401 || upstream.status === 403) {
    return c.json({ error: 'upstream_unauthorized' }, 502);
  }

  const outHeaders = new Headers();
  for (const [name, value] of upstream.headers) {
    if (!DROP_RESPONSE_HEADERS.has(name.toLowerCase())) outHeaders.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
});
