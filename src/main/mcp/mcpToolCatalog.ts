import { spawn } from 'node:child_process';

import { EnterpriseApiErrorCode } from '../../shared/enterpriseAccount/constants';
import { ConnectorConsumption, McpGatewayError } from '../../shared/mcp/constants';
import {
  EnterpriseMembershipRevocationSource,
  readEnterpriseApiErrorCode,
} from '../enterpriseAccount/membershipRevocation';
import { handleEnterpriseMembershipRevocation } from '../enterpriseAccount/membershipRevocationBridge';
import { checkMissingCredential } from './mcpAuthProbe';
import { ensureGatewayToken } from './mcpGatewayToken';
import type { McpServerRecord } from './mcpStore';
import { enterpriseBaseUrlOrNull, resolveMcpTarget } from './mcpTarget';

/**
 * Read one MCP server's tool list by speaking the protocol directly.
 *
 * Why the desktop does this instead of asking OpenClaw: the detail dialog has
 * to be able to say something about a connector whether or not the runtime has
 * it loaded, and the answer must be "what this endpoint advertises right now".
 * OpenClaw is still the client that actually runs tools; this is a read-only
 * inspection with the credential the user already saved.
 */

export interface McpToolSummary {
  name: string;
  description?: string;
}

export const McpToolListStatus = {
  Ok: 'ok',
  Unauthorized: 'unauthorized',
  ConnectError: 'connect-error',
  MissingCredential: 'missing-credential',
} as const;
export type McpToolListStatus = typeof McpToolListStatus[keyof typeof McpToolListStatus];

export interface McpToolListResult {
  ok: boolean;
  status: McpToolListStatus;
  tools: McpToolSummary[];
  latencyMs: number;
  /** User-safe reason: never contains a credential value. */
  error?: string;
  /** The gateway's own error string (`UpstreamUnauthorized`, …) when this
   *  build understands it, so the dialog can say what to do instead of
   *  printing "HTTP 502". Absent for a direct connector, an upstream's own
   *  refusal, and any code a newer server invented. */
  errorCode?: string;
}

export interface ListToolsDeps {
  /** Injected in tests; production uses the global fetch. */
  fetchImpl?: typeof fetch;
  /** Overrides the per-request deadline (tests). */
  timeoutMs?: number;
  /** Persists a gateway token this probe had to mint, so the next probe and
   *  the next config build reuse it. Wired to the store by the IPC handler;
   *  absent means "mint and discard". */
  saveGatewayToken?: (serverId: string, token: string, owner: string, expiresAt: string) => void;
}

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'mixcwork-tool-catalog', version: '1.0.0' } as const;
const DEFAULT_TIMEOUT_MS = 10_000;
const STDIO_TIMEOUT_MS = 8_000;
/** A server that never stops paginating must not hang the dialog. */
const MAX_TOOL_PAGES = 5;
/** The dialog only renders names (and a one-line hint), so cap the payload. */
const MAX_DESCRIPTION_CHARS = 200;
/** Shown when a gateway record cannot produce a dialable target. Names no
 *  secret: the org key is the server's, and the member's next step is to ask
 *  an admin or sign in again, not to paste anything here. */
const GATEWAY_CREDENTIAL_UNAVAILABLE = 'Enterprise gateway credential is unavailable';

/** How long one HTTP leg may take: the connector's configured timeout when the
 *  org set one (the same value OpenClaw uses), else the default. */
function requestTimeoutMs(record: McpServerRecord, deps: ListToolsDeps): number {
  if (deps.timeoutMs && deps.timeoutMs > 0) return deps.timeoutMs;
  const configured = record.timeoutSeconds;
  if (typeof configured === 'number' && configured > 0) {
    return Math.min(configured, 60) * 1000;
  }
  return DEFAULT_TIMEOUT_MS;
}

/**
 * Split whatever the transport returned into JSON-RPC messages.
 *
 * A streamable-HTTP server answers either with a plain JSON body or with an
 * SSE stream (`text/event-stream`), and the SSE variant may wrap one or more
 * messages in `data:` lines. Both shapes are normal, so both are accepted.
 */
export function parseJsonRpcMessages(text: string): unknown[] {
  const out: unknown[] = [];
  const trimmed = text.trim();
  if (!trimmed) return out;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) out.push(...parsed);
    else out.push(parsed);
    return out;
  } catch {
    // Not plain JSON — fall through to SSE framing.
  }
  for (const event of trimmed.split(/\r?\n\r?\n+/)) {
    const dataLines: string[] = [];
    for (const rawLine of event.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload) dataLines.push(payload);
    }
    if (dataLines.length === 0) continue;
    const payload = dataLines.join('\n');
    if (payload === '[DONE]') continue;
    try {
      out.push(JSON.parse(payload));
    } catch {
      /* a non-JSON SSE event (e.g. a comment) is not an error */
    }
  }
  return out;
}

/** Find the response envelope for one request id. */
function findResponse(
  messages: unknown[],
  id: number,
): { result?: unknown; error?: { message?: string } } | null {
  for (const message of messages) {
    const obj = message as { id?: unknown; result?: unknown; error?: unknown } | null;
    if (obj && obj.id === id) {
      const error = obj.error as { message?: string } | undefined;
      return { result: obj.result, ...(error ? { error } : {}) };
    }
  }
  return null;
}

/** Normalize a `tools/list` result into the shape the dialog renders. */
export function extractToolSummaries(result: unknown): {
  tools: McpToolSummary[];
  nextCursor?: string;
} {
  const body = result as { tools?: unknown; nextCursor?: unknown } | null;
  const rawTools = Array.isArray(body?.tools) ? body.tools : [];
  const tools: McpToolSummary[] = [];
  for (const raw of rawTools) {
    const tool = raw as { name?: unknown; description?: unknown } | null;
    if (!tool || typeof tool.name !== 'string' || tool.name.length === 0) continue;
    if (typeof tool.description === 'string' && tool.description.trim().length > 0) {
      const description = tool.description.trim();
      tools.push({
        name: tool.name,
        description:
          description.length > MAX_DESCRIPTION_CHARS
            ? `${description.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`
            : description,
      });
    } else {
      tools.push({ name: tool.name });
    }
  }
  const nextCursor =
    typeof body?.nextCursor === 'string' && body.nextCursor.length > 0 ? body.nextCursor : undefined;
  return { tools, ...(nextCursor ? { nextCursor } : {}) };
}

function rpcRequest(id: number, method: string, params?: unknown): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    ...(params === undefined ? {} : { params }),
  });
}

function rpcNotification(method: string): string {
  return JSON.stringify({ jsonrpc: '2.0', method });
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function missingResult(start: number, error: string): McpToolListResult {
  return {
    ok: false,
    status: McpToolListStatus.MissingCredential,
    tools: [],
    latencyMs: Date.now() - start,
    error,
  };
}

function failedResult(
  start: number,
  error: string,
  status: McpToolListStatus = McpToolListStatus.ConnectError,
  errorCode?: string,
): McpToolListResult {
  return { ok: false, status, tools: [], latencyMs: Date.now() - start, error, errorCode };
}

/** One POST that returns the text body plus the response headers we care
 *  about (the session id lives only on the initialize response). */
async function postJsonRpc(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; text: string; sessionId?: string; timedOut: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: 'POST', headers, body, signal: controller.signal });
    const text = await res.text();
    const sessionId = res.headers.get('mcp-session-id') ?? undefined;
    return { ok: res.ok, status: res.status, text, ...(sessionId ? { sessionId } : {}), timedOut: false };
  } catch (err) {
    const timedOut = (err as { name?: string })?.name === 'AbortError';
    return { ok: false, status: 0, text: '', timedOut };
  } finally {
    clearTimeout(timer);
  }
}

interface HttpAttempt {
  result: McpToolListResult;
  /** The enterprise server's error code when the refusal body carried one.
   *  Null for an upstream's own 401 (a vendor body has no code). */
  unauthorizedCode: number | null;
}

/** Read the desktop-facing `code` off a refusal body. Only plain JSON is
 *  expected here: the enterprise gateway answers these with `c.json`. */
function readErrorCodeFromText(text: string): number | null {
  if (!text) return null;
  try {
    return readEnterpriseApiErrorCode(JSON.parse(text));
  } catch {
    return null;
  }
}

const KNOWN_GATEWAY_ERRORS = new Set<string>(Object.values(McpGatewayError));

/** The gateway's error string, but only when this is a gateway leg and the
 *  string is one this build knows. A vendor endpoint can return
 *  `{"error":"not_found"}` for its own reasons; translating that as "the
 *  connector was removed from your org" would be a lie about someone else's
 *  API. */
function gatewayErrorCodeFrom(text: string, isGateway: boolean): string | undefined {
  if (!isGateway || !text) return undefined;
  try {
    const body = JSON.parse(text) as { error?: unknown };
    return typeof body?.error === 'string' && KNOWN_GATEWAY_ERRORS.has(body.error)
      ? body.error
      : undefined;
  } catch {
    return undefined;
  }
}

/** One full initialize + initialized + tools/list pass against one target. */
async function runHttpList(
  fetchImpl: typeof fetch,
  target: { url: string; headers: Record<string, string> },
  body: string,
  timeoutMs: number,
  start: number,
  isGateway: boolean,
): Promise<HttpAttempt> {
  const url = target.url;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...target.headers,
  };

  const init = await postJsonRpc(fetchImpl, url, headers, body, timeoutMs);
  if (init.timedOut) {
    return { result: failedResult(start, `initialize timed out after ${timeoutMs}ms`), unauthorizedCode: null };
  }
  if (init.status === 401 || init.status === 403) {
    return {
      result: failedResult(start, `HTTP ${init.status}`, McpToolListStatus.Unauthorized),
      unauthorizedCode: readErrorCodeFromText(init.text),
    };
  }
  if (!init.ok) {
    return {
      result: failedResult(
        start,
        `initialize failed: HTTP ${init.status}`,
        McpToolListStatus.ConnectError,
        gatewayErrorCodeFrom(init.text, isGateway),
      ),
      unauthorizedCode: null,
    };
  }
  const initResponse = findResponse(parseJsonRpcMessages(init.text), 1);
  if (!initResponse?.result) {
    return { result: failedResult(start, 'initialize returned no result'), unauthorizedCode: null };
  }

  // RFC-compliant streamable servers mint a session on initialize and require
  // it on every later request. Servers that answer statelessly omit the
  // header, and then the remaining calls simply carry no session.
  const sessionHeaders: Record<string, string> = init.sessionId
    ? { ...headers, 'mcp-session-id': init.sessionId }
    : headers;
  // `notifications/initialized` is mandatory before other requests on a
  // session server; a server that does not implement the session will answer
  // an error, which must not abort the listing.
  await postJsonRpc(fetchImpl, url, sessionHeaders, rpcNotification('notifications/initialized'), timeoutMs);

  const tools: McpToolSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    const id = 2 + page;
    const res = await postJsonRpc(
      fetchImpl,
      url,
      sessionHeaders,
      rpcRequest(id, 'tools/list', cursor ? { cursor } : {}),
      timeoutMs,
    );
    if (res.timedOut) {
      return { result: failedResult(start, `tools/list timed out after ${timeoutMs}ms`), unauthorizedCode: null };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        result: failedResult(start, `HTTP ${res.status}`, McpToolListStatus.Unauthorized),
        unauthorizedCode: readErrorCodeFromText(res.text),
      };
    }
    if (!res.ok) {
      return {
        result: failedResult(
          start,
          `tools/list failed: HTTP ${res.status}`,
          McpToolListStatus.ConnectError,
          gatewayErrorCodeFrom(res.text, isGateway),
        ),
        unauthorizedCode: null,
      };
    }
    const response = findResponse(parseJsonRpcMessages(res.text), id);
    if (!response) {
      return { result: failedResult(start, 'tools/list returned no response'), unauthorizedCode: null };
    }
    if (response.error) {
      return {
        result: failedResult(start, `tools/list error: ${response.error.message ?? 'unknown error'}`),
        unauthorizedCode: null,
      };
    }
    const pageResult = extractToolSummaries(response.result);
    tools.push(...pageResult.tools);
    if (!pageResult.nextCursor) break;
    cursor = pageResult.nextCursor;
  }
  return {
    result: { ok: true, status: McpToolListStatus.Ok, tools, latencyMs: Date.now() - start },
    unauthorizedCode: null,
  };
}

async function listViaHttp(
  record: McpServerRecord,
  deps: ListToolsDeps,
  start: number,
): Promise<McpToolListResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = requestTimeoutMs(record, deps);
  const isGateway = record.consumption === ConnectorConsumption.Gateway;
  const enterpriseBaseUrl = enterpriseBaseUrlOrNull();

  // Same credential the config build dials with, so the dialog can never
  // report "connected" for a connector the agent cannot reach.
  const gateway = isGateway ? await ensureGatewayToken(record) : null;
  // A gateway record dials with a token minted for THIS member or not at all.
  // Falling back to `record.gatewayToken` here would let a signed-out app — or
  // the previous member on a shared machine — probe with a credential the
  // current session cannot use (§8.26, §9.11).
  if (isGateway && !gateway) return missingResult(start, GATEWAY_CREDENTIAL_UNAVAILABLE);
  const target = resolveMcpTarget(
    { ...record, ...(gateway ? { gatewayToken: gateway.token } : {}) },
    { enterpriseBaseUrl },
  );
  if (!target) {
    return missingResult(start, isGateway ? GATEWAY_CREDENTIAL_UNAVAILABLE : 'Missing URL');
  }
  if (gateway && gateway.token !== record.gatewayToken) {
    deps.saveGatewayToken?.(record.id, gateway.token, gateway.owner, gateway.expiresAt);
  }

  const first = await runHttpList(
    fetchImpl,
    target,
    rpcRequest(1, 'initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    }),
    timeoutMs,
    start,
    isGateway,
  );
  if (!isGateway || first.result.status !== McpToolListStatus.Unauthorized) return first.result;

  // A revoked membership is not an expired credential: minting again would
  // hand a dead session a fresh key, so sign the member out instead.
  if (first.unauthorizedCode === EnterpriseApiErrorCode.NotMember) {
    handleEnterpriseMembershipRevocation(
      first.unauthorizedCode,
      EnterpriseMembershipRevocationSource.JsonApi,
    );
    return first.result;
  }

  // The stored token was refused. Mint one unconditionally — asking
  // `ensureGatewayToken` with the failed record would hand back the same dead
  // token under its own reuse rule — then retry once.
  const refreshed = await ensureGatewayToken({
    consumption: record.consumption,
    serverKey: record.serverKey,
  });
  if (!refreshed) return first.result;
  deps.saveGatewayToken?.(record.id, refreshed.token, refreshed.owner, refreshed.expiresAt);
  const retryTarget = resolveMcpTarget(
    { ...record, gatewayToken: refreshed.token },
    { enterpriseBaseUrl },
  );
  if (!retryTarget) return first.result;
  return (await runHttpList(
    fetchImpl,
    retryTarget,
    rpcRequest(1, 'initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    }),
    timeoutMs,
    start,
    isGateway,
  )).result;
}

async function listViaStdio(
  record: McpServerRecord,
  deps: ListToolsDeps,
  start: number,
): Promise<McpToolListResult> {
  const command = record.command;
  if (!command) return missingResult(start, 'Missing command');
  const timeoutMs = deps.timeoutMs && deps.timeoutMs > 0 ? deps.timeoutMs : STDIO_TIMEOUT_MS;
  const env = { ...process.env, ...(record.env ?? {}) };

  return await new Promise<McpToolListResult>((resolve) => {
    let settled = false;
    let buffer = '';
    let sawInitialize = false;
    const finish = (result: McpToolListResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve(result);
    };
    const child = spawn(command, record.args ?? [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      finish(failedResult(start, `stdio server did not answer within ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      // MCP stdio is newline-delimited JSON.
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) {
          let message: unknown;
          try {
            message = JSON.parse(line);
          } catch {
            message = null;
          }
          const obj = message as { id?: unknown; result?: unknown; error?: { message?: string } } | null;
          if (obj?.id === 1 && obj.result && !sawInitialize) {
            sawInitialize = true;
            child.stdin.write(rpcNotification('notifications/initialized') + '\n');
            child.stdin.write(rpcRequest(2, 'tools/list') + '\n');
          } else if (obj?.id === 2) {
            if (obj.error) {
              finish(failedResult(start, `tools/list error: ${obj.error.message ?? 'unknown error'}`));
              return;
            }
            const { tools } = extractToolSummaries(obj.result);
            finish({ ok: true, status: McpToolListStatus.Ok, tools, latencyMs: Date.now() - start });
            return;
          }
        }
        newline = buffer.indexOf('\n');
      }
    });
    child.on('error', (err) => finish(failedResult(start, errMsg(err))));
    child.on('exit', (code) => {
      finish(failedResult(start, `stdio server exited (code=${code ?? 'null'}) before answering`));
    });
    try {
      child.stdin.write(
        rpcRequest(1, 'initialize', {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        }) + '\n',
      );
    } catch (err) {
      finish(failedResult(start, errMsg(err)));
    }
  });
}

/** Read the server's advertised tools. Never throws: every failure comes back
 *  as a status the dialog can render. */
export async function listServerTools(
  record: McpServerRecord,
  deps: ListToolsDeps = {},
): Promise<McpToolListResult> {
  const start = Date.now();
  const missing = checkMissingCredential(record);
  if (missing) return missingResult(start, missing);
  try {
    if (record.transportType === 'stdio') {
      return await listViaStdio(record, deps, start);
    }
    return await listViaHttp(record, deps, start);
  } catch (err) {
    return failedResult(start, errMsg(err));
  }
}
