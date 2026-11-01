/**
 * Builds the `mcp.servers` block of `openclaw.json`.
 *
 * Extracted from `openclawConfigSync` so the shape — in particular the tool
 * policy — can be tested without booting OpenClaw. Pure: no filesystem, no
 * electron.
 */

import { createHash } from 'crypto';

import type { McpToolFilter } from '../../shared/mcp/constants';
import { normalizeMcpServerUrlInput } from '../../shared/mcp/url';

/**
 * Where a resolved server came from.
 *
 * `Connector` — something the user installed (enterprise catalog, built-in
 * catalog, a local MCP). Its tools are the ones the "connected data sources"
 * policy talks about.
 *
 * `Builtin` — a server the runtime brings itself (computer use, the dsh code
 * agent). Listing one as a data source would tell the model to prefer it
 * over a connector, which is wrong: it is not a data source at all.
 */
export const McpServerKind = {
  Connector: 'connector',
  Builtin: 'builtin',
} as const;
export type McpServerKind = typeof McpServerKind[keyof typeof McpServerKind];

export interface ResolvedMcpServer {
  name: string;
  /**
   * The connector's stable ASCII key from the enterprise catalog
   * (`^[a-z0-9-]+$`, unique inside the organization). Preferred over `name`
   * as the OpenClaw server key: the catalog guarantees it is unique and
   * readable, while `name` is a localized display name that OpenClaw cannot
   * put into a tool name.
   */
  serverKey?: string;
  /** Defaults to `Connector`. */
  kind?: McpServerKind;
  transportType: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** The org's per-tool policy, already in OpenClaw's shape. Absent when the
   *  connector is ungoverned (local servers, or every tool enabled). */
  toolFilter?: McpToolFilter;
  /** The org's per-call timeout in seconds. Absent means OpenClaw's own
   *  default (60s) — the org left it unset. */
  timeoutSeconds?: number;
}

/**
 * One server that made it into `mcp.servers`, with the key it was written
 * under and the config entry itself.
 */
export interface ResolvedMcpServerEntry {
  server: ResolvedMcpServer;
  /**
   * The key this server is written under in `mcp.servers` — and, because the
   * key is already OpenClaw-safe, the prefix of the tool names the model
   * sees for it.
   */
  key: string;
  entry: Record<string, unknown>;
}

/** The outcome of resolving a set of servers into config entries. */
export interface McpServerEntryResolution {
  /** The servers that make it into `mcp.servers`, with their keys. */
  entries: ResolvedMcpServerEntry[];
  /** Servers left out because their URL cannot be used. */
  skipped: ResolvedMcpServer[];
}

// Normalize header keys to lowercase before writing to openclaw.json.
// The MCP SDK internally uses a `Headers` object which normalizes keys to lowercase,
// then OpenClaw's `buildSseEventSourceFetch` merges them back with the original config headers.
// If the config has e.g. "Authorization" (capitalized), the merge produces duplicate keys:
//   { authorization: "Bearer ...", Authorization: "Bearer ..." }
// Servers behind WAFs (e.g. Huawei Cloud) reject requests with duplicate auth headers (HTTP 500).
// Storing keys as lowercase prevents this duplication since HTTP headers are case-insensitive.
export function lowercaseHeaderKeys(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key.toLowerCase()] = value;
  }
  return result;
}

// ── Server keys ─────────────────────────────────────────────────────────────
//
// OpenClaw turns the `mcp.servers` key into the tool-name prefix with
// `sanitizeServerName` (openclaw/src/agents/agent-bundle-mcp-names.ts):
// every character outside `[A-Za-z0-9_-]` collapses to "-", a key that does
// not start with a letter gets an `mcp-` prefix, and the result is cut to 30
// characters.
//
// MixWork pre-applies the same rule so the key it writes IS the final
// tool-name prefix. Without that, the desktop could not tell which tool names
// belong to which connector, and neither the AGENTS.md "connected data
// sources" policy nor the chat transcript could name a connector's tools.
const OPENCLAW_KEY_UNSAFE_RE = /[^A-Za-z0-9_-]/g;
const OPENCLAW_KEY_MAX_LENGTH = 30;

/**
 * The shape OpenClaw's `sanitizeServerName` leaves a key in. A key that
 * already matches it is a fixed point — OpenClaw's own sanitizer is a no-op
 * on it, so the config key and the tool-name prefix stay identical.
 */
const OPENCLAW_SAFE_KEY_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Whether a key would survive OpenClaw's sanitizer unchanged. */
export function isOpenClawSafeKey(key: string): boolean {
  return key.length <= OPENCLAW_KEY_MAX_LENGTH && OPENCLAW_SAFE_KEY_RE.test(key);
}

/**
 * The OpenClaw server key for a name that is already ASCII.
 *
 * Mirrors `sanitizeToolFragment` in openclaw/src/agents/agent-bundle-mcp-names.ts.
 * Only valid for ASCII input: a non-ASCII name collapses every CJK character
 * into "-", so two different names of the same length land on the same key.
 * `resolveMcpServerKey` handles that case separately.
 */
function toOpenClawServerKey(raw: string): string {
  const cleaned = raw.trim().replace(OPENCLAW_KEY_UNSAFE_RE, '-');
  const normalized = cleaned || 'mcp';
  const providerSafe = /^[A-Za-z]/.test(normalized) ? normalized : `mcp-${normalized}`;
  return providerSafe.slice(0, OPENCLAW_KEY_MAX_LENGTH);
}

/**
 * The key a connector is written under in `mcp.servers`.
 *
 * An enterprise connector's `serverKey` wins: the catalog guarantees it is
 * ASCII, unique inside the organization, and stable across renames of the
 * display name. Everything else falls back to the display name.
 *
 * A display name that is not ASCII cannot be represented in OpenClaw's
 * tool-name charset: every CJK character collapses to "-", so 纷享销客 and
 * 腾讯文档 would both land on `mcp-----` and be told apart only by an
 * order-dependent `-2` suffix. Such a name gets a stable hash instead.
 */
export function resolveMcpServerKey(input: { serverKey?: string | null; name: string }): string {
  const candidate = (input.serverKey ?? '').trim() || input.name.trim();
  if (!candidate) return 'mcp';
  if (/[^\x00-\x7F]/.test(candidate)) {
    return `mcp-${createHash('md5').update(candidate).digest('hex').slice(0, 8)}`;
  }
  return toOpenClawServerKey(candidate);
}

/**
 * A key that is unique among the servers of one config.
 *
 * OpenClaw disambiguates colliding keys itself (`sanitizeServerName` appends
 * `-2`, `-3`, …), but the desktop has to know the FINAL key to name a
 * connector's tools. MixWork therefore disambiguates first, with the same
 * algorithm and the same order OpenClaw would use, so the two agree.
 *
 * The one case where they can still disagree is a plugin-provided MCP server
 * that claims the same name: OpenClaw merges those into the same namespace
 * and resolves the collision in ITS iteration order. Nothing on the desktop
 * knows those names, so the mapping is best-effort for that one server.
 */
function uniqueServerKey(base: string, used: Set<string>): string {
  let candidate = base;
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = `-${n}`;
    candidate = `${base.slice(0, Math.max(1, OPENCLAW_KEY_MAX_LENGTH - suffix.length))}${suffix}`;
    n += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/**
 * The servers that make it into `mcp.servers`, each with the key it is
 * written under and its config entry.
 *
 * One function for both consumers — the config builder and the AGENTS.md
 * policy — so the key a connector is named by in the prompt is the very key
 * the runtime writes into `openclaw.json`.
 */
export function resolveMcpServerEntries(servers: ResolvedMcpServer[]): McpServerEntryResolution {
  const entries: ResolvedMcpServerEntry[] = [];
  const skipped: ResolvedMcpServer[] = [];
  const usedKeys = new Set<string>();
  for (const server of servers) {
    const entry: Record<string, unknown> = {};
    let normalizedRemoteUrl = '';
    if (server.transportType !== 'stdio') {
      const normalizedUrl = normalizeMcpServerUrlInput(server.url);
      if (!normalizedUrl.ok) {
        skipped.push(server);
        continue;
      }
      normalizedRemoteUrl = normalizedUrl.url;
    }

    switch (server.transportType) {
      case 'stdio':
        if (server.command) entry.command = server.command;
        if (server.args?.length) entry.args = server.args;
        if (server.env && Object.keys(server.env).length > 0) entry.env = server.env;
        break;
      case 'sse':
        entry.url = normalizedRemoteUrl;
        if (server.headers && Object.keys(server.headers).length > 0)
          entry.headers = lowercaseHeaderKeys(server.headers);
        break;
      case 'http':
        entry.url = normalizedRemoteUrl;
        if (server.headers && Object.keys(server.headers).length > 0)
          entry.headers = lowercaseHeaderKeys(server.headers);
        entry.transport = 'streamable-http';
        break;
    }

    // The org's tool policy, verbatim. Absent means "no restriction".
    const filter = normalizedFilter(server.toolFilter);
    if (filter) entry.toolFilter = filter;

    // The org's per-call timeout, in seconds. Absent means "use the runtime
    // default" — writing a zero or a negative would be invalid config.
    if (typeof server.timeoutSeconds === 'number' && Number.isFinite(server.timeoutSeconds)
      && server.timeoutSeconds > 0) {
      entry.timeout = server.timeoutSeconds;
    }

    const key = uniqueServerKey(resolveMcpServerKey({ serverKey: server.serverKey, name: server.name }), usedKeys);
    entries.push({ server, key, entry });
  }
  return { entries, skipped };
}

/** OpenClaw's schema requires a non-empty list, so an empty one is the same
 *  as no filter at all — writing it would only be invalid. */
function normalizedFilter(filter: McpToolFilter | undefined): McpToolFilter | null {
  if (!filter) return null;
  const include = filter.include?.filter((t) => t.trim().length > 0) ?? [];
  const exclude = filter.exclude?.filter((t) => t.trim().length > 0) ?? [];
  if (include.length === 0 && exclude.length === 0) return null;
  return {
    ...(include.length > 0 ? { include } : {}),
    ...(exclude.length > 0 ? { exclude } : {}),
  };
}

export function buildOpenClawMcpServers(
  servers: ResolvedMcpServer[],
): Record<string, Record<string, unknown>> {
  const { entries, skipped } = resolveMcpServerEntries(servers);
  for (const server of skipped) {
    console.warn(`[OpenClawConfigSync] skipped MCP server "${server.name}" because its URL is invalid`);
  }
  const result: Record<string, Record<string, unknown>> = {};
  for (const { key, entry } of entries) {
    result[key] = entry;
  }
  return result;
}
