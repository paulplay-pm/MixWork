import Database from 'better-sqlite3';
import crypto from 'crypto';

import {
  type ConnectorAuthMode,
  ConnectorConsumption,
  McpAuthMethod,
  McpAuthStatus,
  type McpToolFilter,
} from '../../shared/mcp/constants';
import { t } from '../i18n';
import type { McpLaunchResolution } from './mcpLaunchResolution';

export interface McpServerRecord {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  transportType: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  isBuiltIn: boolean;
  githubUrl?: string;
  registryId?: string;
  launchResolution?: McpLaunchResolution;
  authMethod: McpAuthMethod;
  authStatus: McpAuthStatus;
  oauth?: McpOAuthCredential;
  serverKey?: string;
  /** Brand logo URL from the catalog. Rendered on the connector's rows; the
   *  UI falls back to a generic glyph when it cannot be loaded. */
  icon?: string;
  oauthConfig?: McpOAuthEndpoint;
  apiKeyHeaderName?: string;
  /** The enterprise connector's declared auth mode (absent for local servers). */
  enterpriseAuthMode?: ConnectorAuthMode;
  /** OpenClaw's per-server tool selection, captured from the org's policy. */
  toolFilter?: McpToolFilter;
  /** The org's per-call timeout in seconds. Absent means OpenClaw's default. */
  timeoutSeconds?: number;
  /** `gateway` means the org key is injected by the enterprise server and
   *  this record must never dial `url` directly. Absent means `direct`. */
  consumption?: ConnectorConsumption;
  /** The gateway service token this record dials with. Never the org key. */
  gatewayToken?: string;
  /** Which signed-in member the token was minted for. A token whose owner is
   *  not the current user is discarded, not reused. */
  gatewayTokenOwner?: string;
  gatewayTokenExpiresAt?: string;
  createdAt: number;
  updatedAt: number;
}

export interface McpServerFormData {
  name: string;
  description: string;
  transportType: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  isBuiltIn?: boolean;
  githubUrl?: string;
  registryId?: string;
  authMethod?: McpAuthMethod;
  oauth?: McpOAuthCredential;
  serverKey?: string;
  icon?: string;
  oauthConfig?: McpOAuthEndpoint;
  apiKeyHeaderName?: string;
  enterpriseAuthMode?: ConnectorAuthMode;
  toolFilter?: McpToolFilter;
  timeoutSeconds?: number;
  consumption?: ConnectorConsumption;
}

export interface McpOAuthCredential {
  providerId: string;
  token: string;
  expiresAt?: number;
}

/** Non-secret per-connector OAuth endpoint config for `user-oauth`
 * enterprise connectors. Matches the server public view's `oauth` shape
 * (connectorView.ts) — `clientSecret` is deliberately excluded: the store
 * never holds org secrets. Distinct from McpOAuthCredential (fetched token). */
export interface McpOAuthEndpoint {
  authorizeUrl?: string;
  tokenUrl?: string;
  clientId?: string;
  scopes?: string[];
  /** The loopback redirect URI the enterprise server issued for this
   *  connector. The desktop binds its port and sends it as `redirect_uri`;
   *  absent means "use the built-in default port". */
  redirectUri?: string;
}

interface McpServerRow {
  id: string;
  name: string;
  description: string;
  enabled: number;
  transport_type: string;
  config_json: string;
  auth_status: string | null;
  created_at: number;
  updated_at: number;
}

interface McpConfigJson {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  isBuiltIn?: boolean;
  githubUrl?: string;
  registryId?: string;
  authMethod?: McpAuthMethod;
  oauth?: McpOAuthCredential;
  serverKey?: string;
  icon?: string;
  oauthConfig?: McpOAuthEndpoint;
  apiKeyHeaderName?: string;
  enterpriseAuthMode?: ConnectorAuthMode;
  toolFilter?: McpToolFilter;
  timeoutSeconds?: number;
  consumption?: ConnectorConsumption;
  gatewayToken?: string;
  gatewayTokenOwner?: string;
  gatewayTokenExpiresAt?: string;
}

/** What the store writes: the form's fields plus the credential fields only
 *  the store itself sets (`saveGatewayToken`), so a form can never smuggle one
 *  in. */
type McpServerWriteInput = McpServerFormData & Pick<
  McpConfigJson,
  'gatewayToken' | 'gatewayTokenOwner' | 'gatewayTokenExpiresAt'
>;

export interface InstallServerDeps {
  /** Exchanges a gateway connector's service token. The real helper is loaded
   *  lazily so this DB module does not pull the Electron-bound auth stack into
   *  every consumer (and into node-only tests); tests inject a stub. */
  ensureGatewayToken?: (record: {
    consumption?: ConnectorConsumption;
    serverKey?: string;
  }) => Promise<{ token: string; owner: string; expiresAt: string } | null>;
}

/** `config_json` is free-form and may hold anything a future version wrote. */
/**
 * The message for a failed gateway token exchange during install.
 *
 * The exchange IS the connector's authorization, so its refusal is the install
 * error the member reads. Folding every status into one "try again later" gives
 * them a retry button that cannot work: 403 needs an admin, 404 a marketplace
 * refresh, 400 a configuration fix, 401 a fresh sign-in, and only a network or
 * 5xx failure is worth retrying unchanged.
 *
 * `status` is read structurally (not via `instanceof EnterpriseApiError`)
 * because importing that class would pull Electron's `session` and the MCP
 * OAuth browser flow into this module — and into every test that constructs a
 * store without Electron.
 */
function gatewayInstallErrorMessage(error: unknown): string {
  switch ((error as { status?: unknown } | null)?.status) {
    case 403:
      return t('mcpInstallGatewayForbidden');
    case 404:
      return t('mcpInstallGatewayNotFound');
    case 400:
      return t('mcpInstallGatewayUnsupported');
    case 401:
      return t('mcpInstallGatewayLoginRequired');
    default:
      return t('mcpInstallGatewayTokenFailed');
  }
}

function parseConfigJson(raw: string): McpConfigJson {
  try {
    return JSON.parse(raw) as McpConfigJson;
  } catch {
    return {};
  }
}

interface McpLaunchResolutionRow {
  server_id: string;
  resolver_kind: string;
  source_fingerprint: string;
  status: string;
  package_name: string | null;
  requested_version: string | null;
  resolved_version: string | null;
  install_dir: string | null;
  command: string | null;
  args_json: string | null;
  env_json: string | null;
  error: string | null;
  installed_at: number | null;
  resolved_at: number | null;
  last_probe_at: number | null;
  last_probe_status: string | null;
  updated_at: number;
}

export function deriveAuthStatus(input: {
  authMethod: McpAuthMethod | string;
  headers?: Record<string, string>;
  oauth?: { token?: string } | null;
}): McpAuthStatus {
  const method = input.authMethod as McpAuthMethod;
  if (method === McpAuthMethod.None) return McpAuthStatus.Authenticated;
  if (method === McpAuthMethod.OAuth) {
    return input.oauth?.token ? McpAuthStatus.Authenticated : McpAuthStatus.NeedsAuth;
  }
  const h = input.headers ?? {};
  if (method === McpAuthMethod.Bearer) {
    return typeof h.Authorization === 'string' && h.Authorization.length > 0
      ? McpAuthStatus.Authenticated
      : McpAuthStatus.NeedsAuth;
  }
  // ApiKey: any non-empty custom header (Authorization is reserved for bearer)
  const hasKey = Object.entries(h).some(([k, v]) => k !== 'Authorization' && typeof v === 'string' && v.length > 0);
  return hasKey ? McpAuthStatus.Authenticated : McpAuthStatus.NeedsAuth;
}

export class McpStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  private parseJsonValue<T>(value: string | null | undefined, fallback: T): T {
    if (!value) return fallback;
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  private deserializeLaunchResolution(row: McpLaunchResolutionRow | undefined): McpLaunchResolution | undefined {
    if (!row) return undefined;
    return {
      serverId: row.server_id,
      resolverKind: row.resolver_kind as McpLaunchResolution['resolverKind'],
      sourceFingerprint: row.source_fingerprint,
      status: row.status as McpLaunchResolution['status'],
      packageName: row.package_name || undefined,
      requestedVersion: row.requested_version || undefined,
      resolvedVersion: row.resolved_version || undefined,
      installDir: row.install_dir || undefined,
      command: row.command || undefined,
      args: this.parseJsonValue<string[]>(row.args_json, []),
      env: this.parseJsonValue<Record<string, string> | undefined>(row.env_json, undefined),
      error: row.error || undefined,
      installedAt: row.installed_at || undefined,
      resolvedAt: row.resolved_at || undefined,
      lastProbeAt: row.last_probe_at || undefined,
      lastProbeStatus: row.last_probe_status || undefined,
      updatedAt: row.updated_at,
    };
  }

  getLaunchResolution(serverId: string): McpLaunchResolution | undefined {
    const row = this.db
      .prepare('SELECT * FROM mcp_launch_resolutions WHERE server_id = ?')
      .get(serverId) as McpLaunchResolutionRow | undefined;
    return this.deserializeLaunchResolution(row);
  }

  upsertLaunchResolution(resolution: McpLaunchResolution): void {
    const now = resolution.updatedAt || Date.now();
    this.db
      .prepare(`
        INSERT INTO mcp_launch_resolutions (
          server_id, resolver_kind, source_fingerprint, status,
          package_name, requested_version, resolved_version, install_dir,
          command, args_json, env_json, error,
          installed_at, resolved_at, last_probe_at, last_probe_status, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(server_id) DO UPDATE SET
          resolver_kind = excluded.resolver_kind,
          source_fingerprint = excluded.source_fingerprint,
          status = excluded.status,
          package_name = excluded.package_name,
          requested_version = excluded.requested_version,
          resolved_version = excluded.resolved_version,
          install_dir = excluded.install_dir,
          command = excluded.command,
          args_json = excluded.args_json,
          env_json = excluded.env_json,
          error = excluded.error,
          installed_at = excluded.installed_at,
          resolved_at = excluded.resolved_at,
          last_probe_at = excluded.last_probe_at,
          last_probe_status = excluded.last_probe_status,
          updated_at = excluded.updated_at
      `)
      .run(
        resolution.serverId,
        resolution.resolverKind,
        resolution.sourceFingerprint,
        resolution.status,
        resolution.packageName ?? null,
        resolution.requestedVersion ?? null,
        resolution.resolvedVersion ?? null,
        resolution.installDir ?? null,
        resolution.command ?? null,
        resolution.args ? JSON.stringify(resolution.args) : null,
        resolution.env ? JSON.stringify(resolution.env) : null,
        resolution.error ?? null,
        resolution.installedAt ?? null,
        resolution.resolvedAt ?? null,
        resolution.lastProbeAt ?? null,
        resolution.lastProbeStatus ?? null,
        now,
      );
  }

  deleteLaunchResolution(serverId: string): void {
    this.db.prepare('DELETE FROM mcp_launch_resolutions WHERE server_id = ?').run(serverId);
  }

  private deserializeRow(row: McpServerRow): McpServerRecord {
    const config = parseConfigJson(row.config_json);

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      enabled: row.enabled === 1,
      transportType: row.transport_type as 'stdio' | 'sse' | 'http',
      command: config.command,
      args: config.args,
      env: config.env,
      url: config.url,
      headers: config.headers,
      isBuiltIn: config.isBuiltIn === true,
      githubUrl: config.githubUrl,
      registryId: config.registryId,
      launchResolution: this.getLaunchResolution(row.id),
      authMethod: config.authMethod ?? McpAuthMethod.None,
      authStatus: (row.auth_status as McpAuthStatus) ?? deriveAuthStatus({
        authMethod: config.authMethod ?? McpAuthMethod.None,
        headers: config.headers,
        oauth: config.oauth,
      }),
      oauth: config.oauth,
      serverKey: config.serverKey,
      icon: config.icon,
      oauthConfig: config.oauthConfig,
      apiKeyHeaderName: config.apiKeyHeaderName,
      enterpriseAuthMode: config.enterpriseAuthMode,
      toolFilter: config.toolFilter,
      timeoutSeconds: config.timeoutSeconds,
      consumption: config.consumption,
      gatewayToken: config.gatewayToken,
      gatewayTokenOwner: config.gatewayTokenOwner,
      gatewayTokenExpiresAt: config.gatewayTokenExpiresAt,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private serializeConfig(data: McpConfigJson): string {
    const config: McpConfigJson = {};
    if (data.command !== undefined) config.command = data.command;
    if (data.args !== undefined) config.args = data.args;
    if (data.env !== undefined && Object.keys(data.env).length > 0) config.env = data.env;
    if (data.url !== undefined) config.url = data.url;
    if (data.headers !== undefined && Object.keys(data.headers).length > 0) config.headers = data.headers;
    if (data.isBuiltIn) config.isBuiltIn = true;
    if (data.githubUrl) config.githubUrl = data.githubUrl;
    if (data.registryId) config.registryId = data.registryId;
    if (data.authMethod !== undefined) config.authMethod = data.authMethod;
    if (data.oauth !== undefined && data.oauth.token) config.oauth = data.oauth;
    if (data.serverKey !== undefined) config.serverKey = data.serverKey;
    if (data.icon !== undefined) config.icon = data.icon;
    if (data.oauthConfig !== undefined) config.oauthConfig = data.oauthConfig;
    if (data.apiKeyHeaderName !== undefined) config.apiKeyHeaderName = data.apiKeyHeaderName;
    if (data.enterpriseAuthMode !== undefined) config.enterpriseAuthMode = data.enterpriseAuthMode;
    // An empty filter means "no restriction", which is the same as absent —
    // writing `{}` would only make the config blob lie about having a policy.
    if (data.toolFilter && ((data.toolFilter.include?.length ?? 0) > 0 || (data.toolFilter.exclude?.length ?? 0) > 0)) {
      config.toolFilter = data.toolFilter;
    }
    // Zero/negative is not a valid timeout; treat it as "use the default".
    if (typeof data.timeoutSeconds === 'number' && Number.isFinite(data.timeoutSeconds)
      && data.timeoutSeconds > 0) {
      config.timeoutSeconds = data.timeoutSeconds;
    }
    if (data.consumption !== undefined) config.consumption = data.consumption;
    if (data.gatewayToken !== undefined) config.gatewayToken = data.gatewayToken;
    if (data.gatewayTokenOwner !== undefined) config.gatewayTokenOwner = data.gatewayTokenOwner;
    if (data.gatewayTokenExpiresAt !== undefined) config.gatewayTokenExpiresAt = data.gatewayTokenExpiresAt;
    return JSON.stringify(config);
  }

  private normalizeTransportConfig(data: McpServerWriteInput): McpServerWriteInput {
    if (data.transportType === 'stdio') {
      return {
        ...data,
        url: undefined,
        headers: undefined,
      };
    }

    return {
      ...data,
      command: undefined,
      args: undefined,
      env: undefined,
    };
  }

  listServers(): McpServerRecord[] {
    const rows = this.db
      .prepare(
        'SELECT id, name, description, enabled, transport_type, config_json, auth_status, created_at, updated_at FROM mcp_servers ORDER BY created_at ASC',
      )
      .all() as McpServerRow[];
    return rows.map((row) => this.deserializeRow(row));
  }

  getServer(id: string): McpServerRecord | null {
    const row = this.db
      .prepare(
        'SELECT id, name, description, enabled, transport_type, config_json, auth_status, created_at, updated_at FROM mcp_servers WHERE id = ?',
      )
      .get(id) as McpServerRow | undefined;
    if (!row) return null;
    return this.deserializeRow(row);
  }

  /**
   * Install a connector: exchange its service token when it is gateway-scoped,
   * then write the record.
   *
   * The exchange runs before the insert because a gateway record without a
   * token is a half-installed connector — it would list as installed and then
   * silently fail every call. The member sees no auth step: the enterprise JWT
   * they already hold is the whole exchange, and a failure fails the install
   * with a reason instead of leaving a row behind.
   */
  async installServer(
    data: McpServerFormData,
    deps: InstallServerDeps = {},
  ): Promise<McpServerRecord> {
    if (data.consumption !== ConnectorConsumption.Gateway) return this.createServer(data);

    const ensure = deps.ensureGatewayToken
      ?? (async (record) => (await import('./mcpGatewayToken')).ensureGatewayToken(record));
    let credential: { token: string; owner: string; expiresAt: string } | null;
    try {
      credential = await ensure({ consumption: data.consumption, serverKey: data.serverKey });
    } catch (error) {
      console.error('[Mcp] gateway token exchange failed during install', error);
      throw new Error(gatewayInstallErrorMessage(error));
    }
    if (!credential) throw new Error(t('mcpInstallGatewayLoginRequired'));

    return this.createServer({
      ...data,
      gatewayToken: credential.token,
      gatewayTokenOwner: credential.owner,
      gatewayTokenExpiresAt: credential.expiresAt,
    });
  }

  createServer(data: McpServerWriteInput): McpServerRecord {
    const id = crypto.randomUUID();
    const now = Date.now();
    const normalized = this.normalizeTransportConfig(data);
    const configJson = this.serializeConfig(normalized);
    // Installing a connector is not authenticating it. The column defaults to
    // 'authenticated', which made a fresh OAuth install look connected until
    // the first probe failed; derive it from whether a credential exists.
    const authStatus = deriveAuthStatus({
      authMethod: normalized.authMethod ?? McpAuthMethod.None,
      headers: normalized.headers,
      oauth: normalized.oauth,
    });

    this.db
      .prepare(
        `INSERT INTO mcp_servers (id, name, description, enabled, transport_type, config_json, auth_status, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      )
      .run(id, normalized.name, normalized.description, normalized.transportType, configJson, authStatus, now, now);

    return this.getServer(id)!;
  }

  updateServer(id: string, data: Partial<McpServerFormData>): McpServerRecord | null {
    const existing = this.getServer(id);
    if (!existing) return null;

    const nextConsumption =
      data.enterpriseAuthMode !== undefined
        ? data.consumption
        : data.consumption !== undefined
          ? data.consumption
          : existing.consumption;
    const keepGatewayToken = nextConsumption === ConnectorConsumption.Gateway;

    const now = Date.now();
    const merged = this.normalizeTransportConfig({
      name: data.name ?? existing.name,
      description: data.description ?? existing.description,
      transportType: data.transportType ?? existing.transportType,
      command: data.command !== undefined ? data.command : existing.command,
      args: data.args !== undefined ? data.args : existing.args,
      env: data.env !== undefined ? data.env : existing.env,
      url: data.url !== undefined ? data.url : existing.url,
      headers: data.headers !== undefined ? data.headers : existing.headers,
      isBuiltIn: data.isBuiltIn !== undefined ? data.isBuiltIn : existing.isBuiltIn,
      githubUrl: data.githubUrl !== undefined ? data.githubUrl : existing.githubUrl,
      registryId: data.registryId !== undefined ? data.registryId : existing.registryId,
      authMethod: data.authMethod !== undefined ? data.authMethod : existing.authMethod,
      oauth: data.oauth !== undefined ? data.oauth : existing.oauth,
      serverKey: data.serverKey !== undefined ? data.serverKey : existing.serverKey,
      oauthConfig: data.oauthConfig !== undefined ? data.oauthConfig : existing.oauthConfig,
      apiKeyHeaderName: data.apiKeyHeaderName !== undefined ? data.apiKeyHeaderName : existing.apiKeyHeaderName,
      enterpriseAuthMode:
        data.enterpriseAuthMode !== undefined ? data.enterpriseAuthMode : existing.enterpriseAuthMode,
      // The enterprise catalog owns the tool selection: an enterprise update
      // always carries the catalog's current answer, and no filter there means
      // "every tool" — so it clears rather than keeps the old restriction.
      toolFilter:
        data.enterpriseAuthMode !== undefined
          ? data.toolFilter
          : data.toolFilter !== undefined
            ? data.toolFilter
            : existing.toolFilter,
      // The enterprise catalog owns the timeout too: an enterprise update
      // always carries the catalog's current answer, and no timeout there
      // means "use the runtime default" — so it clears rather than keeps the
      // old value.
      timeoutSeconds:
        data.enterpriseAuthMode !== undefined
          ? data.timeoutSeconds
          : data.timeoutSeconds !== undefined
            ? data.timeoutSeconds
            : existing.timeoutSeconds,
      // The catalog owns this too: an enterprise update always carries its
      // current answer, so a connector the admin moved off `shared-key` stops
      // routing through the gateway.
      consumption:
        data.enterpriseAuthMode !== undefined
          ? data.consumption
          : data.consumption !== undefined
            ? data.consumption
            : existing.consumption,
      // Tokens are written only by `saveGatewayToken`/`clearGatewayTokens`;
      // a form update must never drop a live credential. They go away with
      // the mode that uses them.
      gatewayToken: keepGatewayToken ? existing.gatewayToken : undefined,
      gatewayTokenOwner: keepGatewayToken ? existing.gatewayTokenOwner : undefined,
      gatewayTokenExpiresAt: keepGatewayToken ? existing.gatewayTokenExpiresAt : undefined,
    });

    const configJson = this.serializeConfig(merged);

    this.db
      .prepare(
        `UPDATE mcp_servers SET name = ?, description = ?, transport_type = ?, config_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(merged.name, merged.description, merged.transportType, configJson, now, id);

    return this.getServer(id);
  }

  deleteServer(id: string): boolean {
    const existing = this.getServer(id);
    if (!existing) return false;

    this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
    this.deleteLaunchResolution(id);
    return true;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const existing = this.getServer(id);
    if (!existing) return false;

    const now = Date.now();
    this.db
      .prepare('UPDATE mcp_servers SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, now, id);
    return true;
  }

  getEnabledServers(): McpServerRecord[] {
    const rows = this.db
      .prepare(
        'SELECT id, name, description, enabled, transport_type, config_json, auth_status, created_at, updated_at FROM mcp_servers WHERE enabled = 1 ORDER BY created_at ASC',
      )
      .all() as McpServerRow[];
    return rows.map((row) => this.deserializeRow(row));
  }

  /** Store the gateway service token a record dials with, and who it was
   *  minted for. Written in place: this is not a user edit, so the row's
   *  updated_at changes but nothing else does. */
  saveGatewayToken(serverId: string, token: string, owner: string, expiresAt: string): void {
    const row = this.db
      .prepare('SELECT config_json FROM mcp_servers WHERE id = ?')
      .get(serverId) as { config_json: string } | undefined;
    if (!row) return;
    const config = parseConfigJson(row.config_json);
    config.gatewayToken = token;
    config.gatewayTokenOwner = owner;
    config.gatewayTokenExpiresAt = expiresAt;
    this.db
      .prepare('UPDATE mcp_servers SET config_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(config), Date.now(), serverId);
  }

  /** Forget every gateway credential (sign-out hygiene). Correctness does not
   *  depend on this — the owner check discards a foreign token anyway — but a
   *  credential that can no longer be used should not sit in the DB. */
  clearGatewayTokens(): number {
    const rows = this.db
      .prepare('SELECT id, config_json FROM mcp_servers')
      .all() as Array<{ id: string; config_json: string }>;
    const update = this.db.prepare(
      'UPDATE mcp_servers SET config_json = ?, updated_at = ? WHERE id = ?',
    );
    let touched = 0;
    for (const row of rows) {
      const config = parseConfigJson(row.config_json);
      if (config.consumption !== ConnectorConsumption.Gateway) continue;
      delete config.gatewayToken;
      delete config.gatewayTokenOwner;
      delete config.gatewayTokenExpiresAt;
      update.run(JSON.stringify(config), Date.now(), row.id);
      touched += 1;
    }
    return touched;
  }

  updateAuthStatus(id: string, status: McpAuthStatus, lastProbeStatus?: string, lastProbeAt?: number): void {
    const now = Date.now();
    if (lastProbeStatus !== undefined && lastProbeAt !== undefined) {
      this.db
        .prepare('UPDATE mcp_servers SET auth_status = ?, last_probe_status = ?, last_probe_at = ?, updated_at = ? WHERE id = ?')
        .run(status, lastProbeStatus, lastProbeAt, now, id);
    } else if (lastProbeStatus !== undefined) {
      this.db
        .prepare('UPDATE mcp_servers SET auth_status = ?, last_probe_status = ?, updated_at = ? WHERE id = ?')
        .run(status, lastProbeStatus, now, id);
    } else {
      this.db
        .prepare('UPDATE mcp_servers SET auth_status = ?, updated_at = ? WHERE id = ?')
        .run(status, now, id);
    }
  }
}
