import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { McpAuthMethod, McpAuthStatus } from '../../shared/mcp/constants';
import { t } from '../i18n';
import { ensureGatewayToken } from './mcpGatewayToken';
import { deriveAuthStatus,McpStore } from './mcpStore';

// The install path exchanges the org connector's service token; the store
// loads that helper lazily, and here it is replaced outright.
vi.mock('./mcpGatewayToken', () => ({ ensureGatewayToken: vi.fn() }));

const issue = vi.mocked(ensureGatewayToken);

describe('McpStore', () => {
  let db: Database.Database | undefined;
  let store: McpStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        transport_type TEXT NOT NULL DEFAULT 'stdio',
        config_json TEXT NOT NULL DEFAULT '{}',
        auth_status TEXT NOT NULL DEFAULT 'authenticated',
        last_probe_status TEXT,
        last_probe_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE mcp_launch_resolutions (
        server_id TEXT PRIMARY KEY,
        resolver_kind TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        package_name TEXT,
        requested_version TEXT,
        resolved_version TEXT,
        install_dir TEXT,
        command TEXT,
        args_json TEXT,
        env_json TEXT,
        error TEXT,
        installed_at INTEGER,
        resolved_at INTEGER,
        last_probe_at INTEGER,
        last_probe_status TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
    store = new McpStore(db);
  });

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  test('clears remote headers when update passes an empty headers object', () => {
    const server = store.createServer({
      name: 'remote',
      description: '',
      transportType: 'http',
      url: 'https://mcp.example.com',
      headers: {
        Authorization: 'Bearer token',
        'X-Tenant-Id': 'tenant-123',
      },
    });

    const updated = store.updateServer(server.id, { headers: {} });

    expect(updated?.headers).toBeUndefined();
    expect(updated?.url).toBe('https://mcp.example.com');
  });

  test('drops stale remote fields when switching to stdio', () => {
    const server = store.createServer({
      name: 'switchable',
      description: '',
      transportType: 'http',
      url: 'https://mcp.example.com',
      headers: { Authorization: 'Bearer token' },
    });

    const updated = store.updateServer(server.id, {
      transportType: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { API_KEY: 'key' },
    });

    expect(updated).toMatchObject({
      transportType: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { API_KEY: 'key' },
    });
    expect(updated?.url).toBeUndefined();
    expect(updated?.headers).toBeUndefined();
  });

  test('drops stale stdio fields when switching to remote', () => {
    const server = store.createServer({
      name: 'stdio-server',
      description: '',
      transportType: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { API_KEY: 'key' },
    });

    const updated = store.updateServer(server.id, {
      transportType: 'sse',
      url: 'https://mcp.example.com/sse',
      headers: { Authorization: 'Bearer token' },
    });

    expect(updated).toMatchObject({
      transportType: 'sse',
      url: 'https://mcp.example.com/sse',
      headers: { Authorization: 'Bearer token' },
    });
    expect(updated?.command).toBeUndefined();
    expect(updated?.args).toBeUndefined();
    expect(updated?.env).toBeUndefined();
  });

  test('updateAuthStatus writes the column', () => {
    const s = store.createServer({ name: 'a', description: '', transportType: 'http', url: 'https://x', headers: { Authorization: 'Bearer y' } });
    store.updateAuthStatus(s.id, McpAuthStatus.NeedsAuth, 'unauthorized', Date.now());
    const after = store.getServer(s.id)!;
    expect(after.authStatus).toBe(McpAuthStatus.NeedsAuth);
  });

  test('oauth credential round-trips through updateServer + getServer', () => {
    const s = store.createServer({
      name: 'qcc',
      description: '',
      transportType: 'http',
      url: 'https://agent.qcc.com',
      headers: {},
      authMethod: McpAuthMethod.OAuth,
    });
    const updated = store.updateServer(s.id, {
      oauth: { providerId: 'qichacha', token: 'tk-1' },
    });
    expect(updated).not.toBeNull();
    // The store only persists the `oauth` sub-key — the dispatcher (in
    // mcpAuthFlows) is responsible for mirroring the token into
    // headers.Authorization before the probe runs.
    expect(updated?.headers?.Authorization).toBeUndefined();

    // Reload from disk and verify the persisted record still carries
    // authMethod (via config_json) so deriveAuthStatus recognizes it.
    const after = store.getServer(s.id)!;
    expect(after.authMethod).toBe(McpAuthMethod.OAuth);
  });

  test('round-trips oauthConfig and serverKey through the config blob', () => {
    const s = store.createServer({
      name: 'fxsk',
      description: 'fenxiang',
      transportType: 'http',
      url: 'https://fxsk.example.com/mcp',
      authMethod: McpAuthMethod.OAuth,
      serverKey: 'fxsk-mcp',
      oauthConfig: {
        authorizeUrl: 'https://idp.example.com/oauth/authorize',
        tokenUrl: 'https://idp.example.com/oauth/token',
        clientId: 'public-cid',
        scopes: ['openid'],
      },
    });
    expect(s.serverKey).toBe('fxsk-mcp');
    expect(s.oauthConfig?.clientId).toBe('public-cid');

    const updated = store.updateServer(s.id, {
      oauthConfig: { authorizeUrl: 'https://x', tokenUrl: 'https://y', clientId: 'c2' },
    });
    expect(updated?.oauthConfig?.clientId).toBe('c2');
  });

  test('oauth preserves previous token when update omits the field', () => {
    const s = store.createServer({
      name: 'qcc-keep',
      description: '',
      transportType: 'http',
      url: 'https://agent.qcc.com',
      headers: {},
    });
    store.updateServer(s.id, { oauth: { providerId: 'qichacha', token: 'tk-1' } });

    // Sanity: the token really made it into config_json on the first write.
    const row1 = db!.prepare('SELECT config_json FROM mcp_servers WHERE id = ?').get(s.id) as { config_json: string };
    expect(JSON.parse(row1.config_json).oauth).toEqual({ providerId: 'qichacha', token: 'tk-1' });

    // A subsequent update that omits `oauth` must keep the prior value
    // (existing.oauth fallback in the merge).
    const unchanged = store.updateServer(s.id, { description: 'tweaked' });
    expect(unchanged?.description).toBe('tweaked');
    const row2 = db!.prepare('SELECT config_json FROM mcp_servers WHERE id = ?').get(s.id) as { config_json: string };
    expect(JSON.parse(row2.config_json).oauth).toEqual({ providerId: 'qichacha', token: 'tk-1' });
  });
});

describe('authStatus derivation', () => {
  test('none is always authenticated', () => {
    expect(deriveAuthStatus({ authMethod: McpAuthMethod.None })).toBe(McpAuthStatus.Authenticated);
  });
  test('bearer without Authorization → needs-auth', () => {
    expect(deriveAuthStatus({ authMethod: McpAuthMethod.Bearer, headers: {} })).toBe(McpAuthStatus.NeedsAuth);
  });
  test('bearer with Authorization → authenticated', () => {
    expect(deriveAuthStatus({ authMethod: McpAuthMethod.Bearer, headers: { Authorization: 'Bearer x' } }))
      .toBe(McpAuthStatus.Authenticated);
  });
  test('api-key with empty headers → needs-auth', () => {
    expect(deriveAuthStatus({ authMethod: McpAuthMethod.ApiKey, headers: {} })).toBe(McpAuthStatus.NeedsAuth);
  });
  test('api-key with a custom header → authenticated', () => {
    expect(deriveAuthStatus({ authMethod: McpAuthMethod.ApiKey, headers: { 'X-API-Key': 'k' } }))
      .toBe(McpAuthStatus.Authenticated);
  });
  test('api-key does not treat Authorization as the key', () => {
    expect(deriveAuthStatus({ authMethod: McpAuthMethod.ApiKey, headers: { Authorization: 'Bearer x' } }))
      .toBe(McpAuthStatus.NeedsAuth);
  });
  test('oauth without token → needs-auth', () => {
    expect(deriveAuthStatus({ authMethod: McpAuthMethod.OAuth, oauth: {} })).toBe(McpAuthStatus.NeedsAuth);
  });
  test('oauth with token → authenticated', () => {
    expect(deriveAuthStatus({ authMethod: McpAuthMethod.OAuth, oauth: { token: 't' } }))
      .toBe(McpAuthStatus.Authenticated);
  });
});

describe('McpStore enterprise connector metadata', () => {
  let db2: Database.Database;
  let enterpriseStore: McpStore;

  beforeEach(() => {
    db2 = new Database(':memory:');
    db2.exec(`
      CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        transport_type TEXT NOT NULL DEFAULT 'stdio',
        config_json TEXT NOT NULL DEFAULT '{}',
        auth_status TEXT NOT NULL DEFAULT 'authenticated',
        last_probe_status TEXT,
        last_probe_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE mcp_launch_resolutions (
        server_id TEXT PRIMARY KEY,
        resolver_kind TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    enterpriseStore = new McpStore(db2);
  });

  afterEach(() => {
    db2.close();
  });

  test('a fresh install with an auth method but no credential starts needs-auth', () => {
    // The column default is 'authenticated', and createServer never wrote it,
    // so every freshly installed OAuth connector claimed to be connected until
    // the first probe failed. Installing is not authenticating.
    const rec = enterpriseStore.createServer({
      name: 'crm',
      description: '',
      transportType: 'http',
      url: 'https://crm.example.com/mcp',
      authMethod: McpAuthMethod.OAuth,
      oauthConfig: { authorizeUrl: 'https://a', tokenUrl: 'https://t', clientId: 'c' },
      serverKey: 'crm',
    });
    expect(rec.authStatus).toBe(McpAuthStatus.NeedsAuth);
  });

  test('a fresh install with no auth method is authenticated', () => {
    const rec = enterpriseStore.createServer({
      name: 'public',
      description: '',
      transportType: 'http',
      url: 'https://public.example.com/mcp',
      authMethod: McpAuthMethod.None,
      serverKey: 'public',
    });
    expect(rec.authStatus).toBe(McpAuthStatus.Authenticated);
  });

  test('toolFilter and the enterprise auth mode survive a round-trip', () => {
    const created = enterpriseStore.createServer({
      name: 'crm',
      description: '',
      transportType: 'http',
      url: 'https://crm.example.com/mcp',
      authMethod: McpAuthMethod.OAuth,
      serverKey: 'crm',
      enterpriseAuthMode: 'user-oauth',
      toolFilter: { include: ['query', 'create'] },
    });
    const reread = enterpriseStore.getServer(created.id)!;
    expect(reread.enterpriseAuthMode).toBe('user-oauth');
    expect(reread.toolFilter).toEqual({ include: ['query', 'create'] });
  });

  test('an update without toolFilter keeps the stored filter', () => {
    const created = enterpriseStore.createServer({
      name: 'crm',
      description: '',
      transportType: 'http',
      url: 'https://crm.example.com/mcp',
      authMethod: McpAuthMethod.OAuth,
      serverKey: 'crm',
      toolFilter: { exclude: ['delete'] },
    });
    const updated = enterpriseStore.updateServer(created.id, { description: 'renamed' })!;
    expect(updated.toolFilter).toEqual({ exclude: ['delete'] });
  });

  test('an enterprise update that now allows every tool clears the stored filter', () => {
    // 更新配置 re-sends the catalog's truth. The catalogue expresses "every
    // tool" as no filter at all, so an update that carries no filter has to
    // clear the old one — otherwise a tool the admin re-enabled would stay
    // blocked on every desktop that had already installed the connector.
    const created = enterpriseStore.createServer({
      name: 'crm',
      description: '',
      transportType: 'http',
      url: 'https://crm.example.com/mcp',
      authMethod: McpAuthMethod.OAuth,
      serverKey: 'crm',
      enterpriseAuthMode: 'user-oauth',
      toolFilter: { include: ['query'] },
    });
    const updated = enterpriseStore.updateServer(created.id, { enterpriseAuthMode: 'user-oauth' })!;
    expect(updated.toolFilter).toBeUndefined();
  });

  test('the org timeout survives a round-trip', () => {
    const created = enterpriseStore.createServer({
      name: 'crm',
      description: '',
      transportType: 'http',
      url: 'https://crm.example.com/mcp',
      authMethod: McpAuthMethod.OAuth,
      serverKey: 'crm',
      enterpriseAuthMode: 'user-oauth',
      timeoutSeconds: 90,
    });
    const reread = enterpriseStore.getServer(created.id)!;
    expect(reread.timeoutSeconds).toBe(90);
  });

  test('an update without a timeout keeps the stored one', () => {
    const created = enterpriseStore.createServer({
      name: 'crm',
      description: '',
      transportType: 'http',
      url: 'https://crm.example.com/mcp',
      authMethod: McpAuthMethod.OAuth,
      serverKey: 'crm',
      timeoutSeconds: 90,
    });
    const updated = enterpriseStore.updateServer(created.id, { description: 'renamed' })!;
    expect(updated.timeoutSeconds).toBe(90);
  });

  test('an enterprise update that left the timeout at the default clears the stored one', () => {
    // Same rule as the tool filter: 更新配置 re-sends the catalog's truth, and
    // "no timeout" in the catalog means "use the runtime default".
    const created = enterpriseStore.createServer({
      name: 'crm',
      description: '',
      transportType: 'http',
      url: 'https://crm.example.com/mcp',
      authMethod: McpAuthMethod.OAuth,
      serverKey: 'crm',
      enterpriseAuthMode: 'user-oauth',
      timeoutSeconds: 90,
    });
    const updated = enterpriseStore.updateServer(created.id, { enterpriseAuthMode: 'user-oauth' })!;
    expect(updated.timeoutSeconds).toBeUndefined();
  });
});

describe('McpStore gateway credentials', () => {
  let db3: Database.Database;
  let gwStore: McpStore;

  beforeEach(() => {
    db3 = new Database(':memory:');
    db3.exec(`
      CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        transport_type TEXT NOT NULL DEFAULT 'stdio',
        config_json TEXT NOT NULL DEFAULT '{}',
        auth_status TEXT NOT NULL DEFAULT 'authenticated',
        last_probe_status TEXT,
        last_probe_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE mcp_launch_resolutions (
        server_id TEXT PRIMARY KEY,
        resolver_kind TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    gwStore = new McpStore(db3);
  });

  afterEach(() => {
    db3.close();
  });

  const gateway = (name: string) =>
    gwStore.createServer({
      name,
      description: '',
      transportType: 'http',
      url: 'https://ent.example.com/mcp/gateway/sk-1',
      consumption: 'gateway',
      serverKey: 'sk-1',
    });

  test('a gateway record round-trips its consumption, token, owner and expiry', () => {
    const s = gateway('gw');
    expect(s.consumption).toBe('gateway');
    gwStore.saveGatewayToken(s.id, 'gsj-1', 'u1', '2030-01-01T00:00:00.000Z');
    expect(gwStore.getServer(s.id)).toMatchObject({
      consumption: 'gateway',
      gatewayToken: 'gsj-1',
      gatewayTokenOwner: 'u1',
      gatewayTokenExpiresAt: '2030-01-01T00:00:00.000Z',
    });
  });

  test('clearing tokens touches only gateway records and keeps their url', () => {
    const g = gateway('gw');
    const direct = gwStore.createServer({
      name: 'direct',
      description: '',
      transportType: 'http',
      url: 'https://up.example/mcp',
    });
    gwStore.saveGatewayToken(g.id, 'gsj-1', 'u1', '2030-01-01T00:00:00.000Z');

    expect(gwStore.clearGatewayTokens()).toBe(1);
    const back = gwStore.getServer(g.id)!;
    expect(back.gatewayToken).toBeUndefined();
    expect(back.gatewayTokenOwner).toBeUndefined();
    expect(back.gatewayTokenExpiresAt).toBeUndefined();
    // The record is still a gateway record: the next call re-mints a token.
    expect(back.consumption).toBe('gateway');
    expect(back.url).toBe('https://ent.example.com/mcp/gateway/sk-1');
    expect(gwStore.getServer(direct.id)!.url).toBe('https://up.example/mcp');
  });

  test('a record with no consumption reads as direct', () => {
    const local = gwStore.createServer({
      name: 'plain',
      description: '',
      transportType: 'http',
      url: 'https://up.example/mcp',
    });
    expect(gwStore.getServer(local.id)!.consumption).toBeUndefined();
  });

  test('an update that changes the url keeps the stored token', () => {
    // Editing anything else must not silently drop the credential and force
    // every member through a fresh mint.
    const s = gateway('gw');
    gwStore.saveGatewayToken(s.id, 'gsj-1', 'u1', '2030-01-01T00:00:00.000Z');
    gwStore.updateServer(s.id, { description: 'renamed' });
    expect(gwStore.getServer(s.id)!.gatewayToken).toBe('gsj-1');
  });
});

describe('McpStore gateway installs', () => {
  let db4: Database.Database;
  let installStore: McpStore;

  beforeEach(() => {
    db4 = new Database(':memory:');
    db4.exec(`
      CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        transport_type TEXT NOT NULL DEFAULT 'stdio',
        config_json TEXT NOT NULL DEFAULT '{}',
        auth_status TEXT NOT NULL DEFAULT 'authenticated',
        last_probe_status TEXT,
        last_probe_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE mcp_launch_resolutions (
        server_id TEXT PRIMARY KEY,
        resolver_kind TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    installStore = new McpStore(db4);
    issue.mockReset();
  });

  afterEach(() => {
    db4.close();
  });

  const gatewayData = {
    name: 'gw-install',
    description: '',
    transportType: 'http' as const,
    url: 'https://ent.example.com/mcp/gateway/sk-1',
    consumption: 'gateway' as const,
    serverKey: 'sk-1',
  };

  test('installing a gateway connector stores a gsj, with no user-visible step', async () => {
    issue.mockResolvedValue({ token: 'gsj-new', owner: 'u1', expiresAt: '2030-01-01T00:00:00.000Z' });

    const created = await installStore.installServer(gatewayData);

    expect(created).toMatchObject({
      consumption: 'gateway',
      gatewayToken: 'gsj-new',
      gatewayTokenOwner: 'u1',
      gatewayTokenExpiresAt: '2030-01-01T00:00:00.000Z',
    });
    // The record on disk carries it too — the install is the token's first and
    // last user-visible moment, and there is nothing to ask the member for.
    expect(installStore.getServer(created.id)!.gatewayToken).toBe('gsj-new');
    expect(issue).toHaveBeenCalledWith({ consumption: 'gateway', serverKey: 'sk-1' });
  });

  test('a failed exchange fails the install and leaves no row', async () => {
    issue.mockRejectedValue(new Error('boom'));

    await expect(installStore.installServer(gatewayData)).rejects.toThrow();
    expect(installStore.listServers()).toHaveLength(0);
  });

  // Each refusal already carries its cause. Folding them all into "could not
  // obtain a credential" hands the member a retry button that cannot work: a
  // 403 needs an admin, a 404 needs a marketplace refresh, and only a network
  // or 5xx failure is worth retrying.
  const refusals: Array<[string, { status: number | null; code: string | null }, string]> = [
    ['invisible to this member (403)', { status: 403, code: 'forbidden' }, 'mcpInstallGatewayForbidden'],
    ['connector gone (404)', { status: 404, code: 'not_found' }, 'mcpInstallGatewayNotFound'],
    ['not a gateway connector (400)', { status: 400, code: 'not_gateway_mode' }, 'mcpInstallGatewayUnsupported'],
    ['plaintext upstream (400)', { status: 400, code: 'upstream_insecure' }, 'mcpInstallGatewayUnsupported'],
    ['revoked membership (401 not_member)', { status: 401, code: 'not_member' }, 'mcpInstallGatewayLoginRequired'],
    ['expired session (401)', { status: 401, code: 'unauthorized' }, 'mcpInstallGatewayLoginRequired'],
    ['network failure', { status: null, code: 'network' }, 'mcpInstallGatewayTokenFailed'],
    ['server error (500)', { status: 500, code: 'server_error' }, 'mcpInstallGatewayTokenFailed'],
  ];

  for (const [name, shape, key] of refusals) {
    test(`a ${name} refusal becomes its own message`, async () => {
      issue.mockRejectedValue(
        Object.assign(new Error('exchange failed'), { name: 'EnterpriseApiError', ...shape }),
      );

      const error = await installStore.installServer(gatewayData).then(
        () => null,
        (err: unknown) => err as Error,
      );

      expect(error?.message).toBe(t(key));
      expect(installStore.listServers()).toHaveLength(0);
    });
  }

  test('a signed-out install fails with the translated reason, not a half-written record', async () => {
    issue.mockResolvedValue(null);

    const error = await installStore.installServer(gatewayData).then(
      () => null,
      (err: unknown) => err as Error,
    );
    expect(error?.message).toBe(t('mcpInstallGatewayLoginRequired'));
    expect(installStore.listServers()).toHaveLength(0);
  });

  test('a direct install never asks the gateway for anything', async () => {
    const created = await installStore.installServer({
      name: 'plain',
      description: '',
      transportType: 'http',
      url: 'https://up.example/mcp',
    });
    expect(issue).not.toHaveBeenCalled();
    expect(created.gatewayToken).toBeUndefined();
  });
});
