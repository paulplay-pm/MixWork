import { maskConnectorSecrets } from '../vault/connectorSecret';
import { mcpOAuthRedirectUri } from './connectorOauthRedirect';

export const AUTH_MODES = [
  'none',
  'shared-key',
  'user-key',
  'user-oauth',
  'client-creds',
  'sso',
] as const;
export type AuthMode6 = (typeof AUTH_MODES)[number];
export const TRANSPORTS = ['http', 'sse'] as const;
export type Transport2 = (typeof TRANSPORTS)[number];
export const CONNECTOR_TYPES = ['mcp', 'app'] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

export interface ConnectorScope {
  allCompany: boolean;
  deptIds: string[];
  userIds: string[];
}
export interface ToolEntry {
  name: string;
  desc?: string;
  enabled: boolean;
  syncedAt?: string;
  removed?: boolean;
}
export interface ConnectorDraft {
  [k: string]: unknown;
}

/** DB row shape (pg driver: timestamptz -> Date, jsonb -> parsed values). */
export interface ConnectorRow {
  id: string;
  org_id: string;
  server_key: string;
  name_en: string | null;
  name_zh: string | null;
  version: string;
  category_id: string | null;
  description: string | null;
  connector_type: ConnectorType;
  url: string;
  transport: Transport2;
  auth_mode: AuthMode6;
  auth_config: Record<string, unknown>;
  secret_meta: { lastUpdatedAt?: string; lastUpdatedBy?: string } | null;
  /** Brand logo URL. Absent means "no logo" — the desktop falls back to a
   *  generic glyph. */
  icon: string | null;
  auth_status: 'configured' | 'pending';
  enabled: boolean;
  scope: ConnectorScope;
  tools: ToolEntry[];
  draft: ConnectorDraft | null;
  last_test_at: Date | null;
  last_test_status: string | null;
  last_latency_ms: number | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Admin list/detail wire. Secrets are masked (see mapAdminConnector). */
export interface ConnectorView {
  id: string;
  serverKey: string;
  nameEn: string | null;
  nameZh: string | null;
  version: string;
  categoryId: string | null;
  description: string | null;
  connectorType: ConnectorType;
  url: string;
  transport: Transport2;
  authMode: AuthMode6;
  /** Brand logo URL, or null when the admin set none. */
  icon: string | null;
  /** Per-mode, non-secret fields + masked secret(s). Shape keyed by authMode. */
  authConfig: Record<string, unknown>;
  secretMeta: { lastUpdatedAt?: string; lastUpdatedBy?: string } | null;
  authStatus: 'configured' | 'pending';
  enabled: boolean;
  scope: ConnectorScope;
  scopeSummary: string;
  tools: ToolEntry[];
  toolCount: number;
  hasDraft: boolean;
  lastTestAt: string | null;
  lastTestStatus: string | null;
  lastLatencyMs: number | null;
  createdAt: string;
  updatedAt: string;
}

/** A connector's version-history row (admin wire, `mcp_connector_versions`
 * mapped to camelCase). `config` is intentionally NOT exposed here — rollback
 * restores it server-side; the list only needs metadata. */
export interface VersionRow {
  id: string;
  version: string;
  note: string | null;
  current: boolean;
  createdAt: string;
  createdBy: string | null;
}

/** Public (desktop) wire — scope-filtered, no secret material. */
export interface ConnectorPublicView {
  id: string;
  serverKey: string;
  name: string;
  nameZh: string | null;
  description: string;
  category: string;
  version: string;
  connectorType: ConnectorType;
  url: string;
  transport: Transport2;
  authMode: AuthMode6;
  authStatus: 'configured' | 'pending';
  /** Brand logo URL. Absent when the admin set none. */
  icon?: string | null;
  scopeSummary: string;
  hasDraft: boolean;
  enabled: boolean;
  toolCount: number;
  /** Present for the direct-link modes (`user-oauth` / `sso`). Non-secret only
   * — never carries any `*ClientSecret` or `__enc__*` ciphertext. `sso` reads
   * its endpoints from the `sso*` fields. For `user-oauth` every field is
   * optional: an absent one is filled by the desktop's OAuth discovery
   * (RFC 8414/9728) or by dynamic client registration (RFC 7591). */
  oauth?: {
    authorizeUrl?: string;
    tokenUrl?: string;
    clientId?: string;
    scopes?: string[];
    /** The loopback redirect URI the desktop sends and the admin registers
     *  at the upstream IdP. Present for `user-oauth` only — the `sso` flow
     *  runs against the org's own SSO endpoints, not a connector callback. */
    redirectUri?: string;
  };
  /** Present only for `user-key`: the header name the connector's API key is
   * injected under (non-secret). Absent when the admin left it unset (the
   * desktop then defaults to `X-Api-Key`). */
  apiKeyHeaderName?: string;
  /** The admin's per-tool toggles, already translated into OpenClaw's
   * `mcp.servers.*.toolFilter` shape. Absent when no restriction applies. */
  toolFilter?: ConnectorToolFilter;
  /** The admin's per-call timeout in seconds (OpenClaw's
   * `mcp.servers.*.timeout`). Absent means the runtime's own default. */
  timeoutSeconds?: number;
  /** How the desktop reaches this connector. `gateway` = the org key lives on
   *  the enterprise server and the desktop dials the MCP gateway with its own
   *  service token; `direct` = the desktop talks to the upstream itself. */
  consumption?: ConnectorConsumption;
  /** Only meaningful for `shared-key`: does the gateway have an org key to
   *  inject? A `false` here is the difference between "not configured yet,
   *  ask an admin" and "broken". */
  orgCredentialReady?: boolean;
}

export const ConnectorConsumption = {
  Direct: 'direct',
  Gateway: 'gateway',
} as const;
export type ConnectorConsumption =
  (typeof ConnectorConsumption)[keyof typeof ConnectorConsumption];

/** OpenClaw's per-server tool selection (`mcp.servers.*.toolFilter`). */
export interface ConnectorToolFilter {
  include?: string[];
  exclude?: string[];
}

/** Single source of the SELECT column list for admin + public queries.
 * Keep in sync with the 035 schema. */
export const COLUMNS = `id, org_id, server_key, name_en, name_zh, version, category_id, description,
  connector_type, url, transport, auth_mode, auth_config, secret_meta, auth_status,
  icon, enabled, scope, tools, draft, last_test_at, last_test_status, last_latency_ms,
  created_by, created_at, updated_at`;

/** A connector's scope grants a caller access iff allCompany, or the caller
 * is a member exception (userIds), or any granted dept id is present in the
 * caller's dept set. Pure — no DB: subtree expansion (grant 销售部 ->
 * 华东/华南 visible) happens at query time in the public route, so
 * `callerDeptIds` is the already-expanded set (scopeApi.deptIdsFor). */
export function scopeMatches(
  scope: ConnectorScope,
  callerDeptIds: string[],
  callerId: string,
): boolean {
  if (scope.allCompany) return true;
  if (scope.userIds.includes(callerId)) return true;
  return (scope.deptIds ?? []).some(d => callerDeptIds.includes(d));
}

/** Compact display string for a scope. */
export function scopeSummary(scope: ConnectorScope): string {
  if (scope.allCompany) return 'all';
  const d = scope.deptIds?.length ?? 0;
  const u = scope.userIds?.length ?? 0;
  if (d === 0 && u === 0) return 'none';
  return `depts:${d}` + (u ? `,users:${u}` : '');
}

/** Row -> admin wire. `authConfig` is masked: stored `__enc__*` secrets become
 * a `••••xxxx` form and the ciphertext keys are stripped; non-secret fields
 * pass through. Never returns plaintext. */
export function mapAdminConnector(row: ConnectorRow): ConnectorView {
  return {
    id: row.id,
    serverKey: row.server_key,
    nameEn: row.name_en,
    nameZh: row.name_zh,
    version: row.version,
    categoryId: row.category_id,
    description: row.description,
    connectorType: row.connector_type,
    url: row.url,
    transport: row.transport,
    authMode: row.auth_mode,
    icon: row.icon,
    authConfig: maskConnectorSecrets(row.auth_config),
    secretMeta: row.secret_meta,
    authStatus: row.auth_status,
    enabled: row.enabled,
    scope: row.scope,
    scopeSummary: scopeSummary(row.scope),
    tools: row.tools,
    toolCount: row.tools.filter(t => !t.removed).length,
    hasDraft: !!row.draft,
    lastTestAt: row.last_test_at ? row.last_test_at.toISOString() : null,
    lastTestStatus: row.last_test_status,
    lastLatencyMs: row.last_latency_ms,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Pick the non-secret OAuth endpoints from a stored auth_config for the given
 * mode. `user-oauth` reads `authorizeUrl`/`tokenUrl`/`clientId`/`scopes`;
 * `sso` reads the `sso*`-prefixed equivalents. Whitelist-only; ignores any
 * `*ClientSecret` and every `__enc__*` key.
 *
 * For `user-oauth` the object is returned even when the org configured
 * nothing: an empty profile means "the desktop discovers the provider"
 * (RFC 8414 / RFC 9728) and may register its own client (RFC 7591). Returning
 * undefined there would tell the desktop the connector is not OAuth at all.
 * `sso` keeps the complete-endpoints requirement — its endpoints are the
 * org's own SSO deployment, never discovered.
 *
 * `redirectUri` is the loopback callback the desktop binds. It is generated
 * by the server (see connectorOauthRedirect) rather than read from the
 * stored config, so the console, the desktop and the IdP registration can
 * never disagree about it. */
function pickPublicOauth(
  authConfig: Record<string, unknown>,
  mode: 'user-oauth' | 'sso',
  redirectUri?: string,
): ConnectorPublicView['oauth'] | undefined {
  // `sso` stores its endpoints under `sso*`-prefixed names with a capital
  // first letter (`ssoAuthorizeUrl`, …); `user-oauth` uses the bare names.
  const names =
    mode === 'sso'
      ? { authorizeUrl: 'ssoAuthorizeUrl', tokenUrl: 'ssoTokenUrl', clientId: 'ssoClientId', scopes: 'ssoScopes' }
      : { authorizeUrl: 'authorizeUrl', tokenUrl: 'tokenUrl', clientId: 'clientId', scopes: 'scopes' };
  const read = (key: string): string =>
    typeof authConfig[key] === 'string' ? (authConfig[key] as string).trim() : '';
  const authorizeUrl = read(names.authorizeUrl);
  const tokenUrl = read(names.tokenUrl);
  const clientId = read(names.clientId);
  if (mode === 'sso' && (!authorizeUrl || !tokenUrl)) return undefined;
  const scopes = Array.isArray(authConfig[names.scopes])
    ? (authConfig[names.scopes] as unknown[]).filter((s): s is string => typeof s === 'string')
    : undefined;
  const out: NonNullable<ConnectorPublicView['oauth']> = {};
  if (authorizeUrl) out.authorizeUrl = authorizeUrl;
  if (tokenUrl) out.tokenUrl = tokenUrl;
  if (clientId) out.clientId = clientId;
  if (scopes && scopes.length > 0) out.scopes = scopes;
  if (redirectUri) out.redirectUri = redirectUri;
  return out;
}

/**
 * The admin's per-call timeout, in seconds, when it is a sane number.
 *
 * The console leaves it empty for "use the runtime default", and stores
 * nothing then — so an absent value here is the normal case, not a gap.
 */
function publicTimeoutSeconds(authConfig: Record<string, unknown>): number | undefined {
  const value = authConfig.timeoutSeconds;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

/**
 * Translate the admin's per-tool toggles into OpenClaw's tool filter.
 *
 * `include` is a whitelist and the schema requires it to be non-empty, while
 * an absent filter means "every tool" — so "all tools disabled" cannot be an
 * empty include; it has to be said out loud as an exclude of everything.
 * Tools the upstream no longer lists (`removed`) are not part of the choice.
 */
export function toolFilterFor(tools: ToolEntry[]): ConnectorToolFilter | undefined {
  const live = tools.filter(t => !t.removed);
  if (live.length === 0) return undefined;
  // A tool the admin declared by hand carries no `syncedAt` — the server
  // never listed it. Such a list is a whitelist: the upstream may well
  // expose tools the admin never named (the server could not look), and
  // those must not reach the agent. So the filter names the list explicitly
  // instead of collapsing to "no restriction".
  const declared = live.filter(t => !t.syncedAt);
  if (declared.length > 0) {
    const include = live.map(t => t.name);
    // `include` requires min(1) in OpenClaw's schema, so "expose none of
    // them" is said as include-all + exclude-all rather than an empty list.
    const exclude = live.filter(t => !t.enabled).map(t => t.name);
    return exclude.length > 0 ? { include, exclude } : { include };
  }
  const enabled = live.filter(t => t.enabled);
  if (enabled.length === live.length) return undefined;
  if (enabled.length === 0) return { exclude: live.map(t => t.name) };
  return { include: enabled.map(t => t.name) };
}

/** Row -> public (desktop) wire. Only public fields: no `authConfig`, no
 * `secretMeta`, no secret material. `name` prefers zh, then en, then key.
 * Scope filtering is the public route's job (query time); this mapper only
 * shapes the row. */
export function mapPublicConnector(row: ConnectorRow): ConnectorPublicView {
  return {
    id: row.id,
    serverKey: row.server_key,
    name: row.name_zh ?? row.name_en ?? row.server_key,
    nameZh: row.name_zh,
    description: row.description ?? '',
    category: row.category_id ?? '',
    version: row.version,
    connectorType: row.connector_type,
    url: row.url,
    transport: row.transport,
    authMode: row.auth_mode,
    authStatus: row.auth_status,
    icon: row.icon ?? undefined,
    scopeSummary: scopeSummary(row.scope),
    hasDraft: !!row.draft,
    enabled: row.enabled,
    toolCount: row.tools.filter(t => !t.removed).length,
    oauth:
      row.auth_mode === 'user-oauth'
        ? pickPublicOauth(row.auth_config, 'user-oauth', mcpOAuthRedirectUri())
        : row.auth_mode === 'sso'
          ? pickPublicOauth(row.auth_config, 'sso')
          : undefined,
    apiKeyHeaderName:
      row.auth_mode === 'user-key'
        ? (typeof row.auth_config.apiKeyHeaderName === 'string' && row.auth_config.apiKeyHeaderName.trim()
            ? (row.auth_config.apiKeyHeaderName as string).trim()
            : undefined)
        : undefined,
    toolFilter: toolFilterFor(row.tools),
    timeoutSeconds: publicTimeoutSeconds(row.auth_config),
    consumption:
      row.auth_mode === 'shared-key' ? ConnectorConsumption.Gateway : ConnectorConsumption.Direct,
    // `__enc__apiKey` specifically, not `hasStoredSecret`: a row that once held
    // a `clientSecret` still carries its ciphertext, and reporting that as a
    // ready org key would hide a misconfiguration behind a green badge.
    orgCredentialReady:
      row.auth_mode === 'shared-key' ? typeof row.auth_config.__enc__apiKey === 'string' : undefined,
  };
}
