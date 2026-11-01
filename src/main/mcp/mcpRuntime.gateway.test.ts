// Config-sync tests for gateway connectors. Kept in their own file because
// McpRuntime pulls in Electron and the computer-use/dsh runtimes, and mocking
// all of that next to the launch-resolution tests would obscure both.
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: class {},
}));
vi.mock('../computerUse/computerUseKit', () => ({ isComputerUseKitInstalled: () => false }));
vi.mock('../computerUse/computerUseMcpServer', () => ({ resolveComputerUseMcpServer: () => null }));
vi.mock('../computerUse/computerUseRuntime', () => ({ installComputerUseRuntime: vi.fn() }));
vi.mock('../ipcHandlers/dsh/handlers', () => ({ resolveDshCodeMcpServerForConfig: async () => null }));
vi.mock('../libs/mixcworkUtil', () => ({ getElectronNodeRuntimePath: () => '/electron' }));
vi.mock('../libs/mcpBridgeServer', () => ({ McpBridgeServer: class {} }));
vi.mock('../libs/resolveStdioCommand', () => ({ resolveStdioCommand: vi.fn() }));
vi.mock('./mcpLaunchResolverManager', () => ({ McpLaunchResolverManager: class {} }));
vi.mock('../libs/endpoints', () => ({ getServerApiBaseUrl: () => 'https://ent' }));
// The real token module runs against a mocked session and HTTP client: the
// owner rule (`gatewayTokenOwner` vs the signed-in member) is the behavior
// under test, so mocking `ensureGatewayToken` itself would hide it.
vi.mock('../auth/enterpriseClient', () => ({ enterpriseClient: { issueGatewayToken: vi.fn() } }));
vi.mock('../auth/sessionStorage', () => ({ sessionStorage: { load: vi.fn() } }));

import { enterpriseClient } from '../auth/enterpriseClient';
import { sessionStorage } from '../auth/sessionStorage';
import { McpRuntime } from './mcpRuntime';

const issue = vi.mocked(enterpriseClient.issueGatewayToken);
const load = vi.mocked(sessionStorage.load);
const DAY = 86_400_000;
const later = (days: number): string => new Date(Date.now() + days * DAY).toISOString();

let db: Database.Database;
let runtime: McpRuntime;

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
      updated_at INTEGER NOT NULL
    );
  `);
  runtime = new McpRuntime({
    getStore: () => ({ getDatabase: () => db }) as never,
    syncOpenClawConfig: async () => ({ success: true, changed: false }),
  });
  load.mockReturnValue({ userId: 'u1' } as ReturnType<typeof sessionStorage.load>);
});

afterEach(() => {
  vi.clearAllMocks();
  db.close();
});

function gatewayRecord(name = 'gw'): string {
  const store = runtime.getStore();
  const s = store.createServer({
    name,
    description: '',
    transportType: 'http',
    url: 'https://up.example/mcp',
    consumption: 'gateway',
    serverKey: 'sk-1',
  });
  return s.id;
}

describe('getResolvedServers for gateway connectors', () => {
  test('a fresh token owned by the current member is used as-is', async () => {
    const id = gatewayRecord();
    runtime.getStore().saveGatewayToken(id, 'gsj-1', 'u1', later(60));

    const servers = await runtime.refreshResolvedServersCache();
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      name: 'gw',
      url: 'https://ent/mcp/gateway/sk-1',
      headers: { authorization: 'McpGateway gsj-1' },
    });
    // The vendor URL must not survive into the config in any form.
    expect(JSON.stringify(servers[0])).not.toContain('up.example');
    expect(issue).not.toHaveBeenCalled();
  });

  test('a token inside the refresh window is re-minted and written back', async () => {
    const id = gatewayRecord();
    runtime.getStore().saveGatewayToken(id, 'gsj-old', 'u1', later(5));
    // One value, asserted twice: `later()` recomputes from `Date.now()`, so a
    // second call a millisecond later would compare two different instants.
    const fresh = { token: 'gsj-new', expiresAt: later(90) };
    issue.mockResolvedValue(fresh);

    const servers = await runtime.refreshResolvedServersCache();
    expect(servers[0]).toMatchObject({ headers: { authorization: 'McpGateway gsj-new' } });
    // Persisted, so the next config build does not mint again.
    expect(runtime.getStore().getServer(id)).toMatchObject({
      gatewayToken: 'gsj-new',
      gatewayTokenOwner: 'u1',
      gatewayTokenExpiresAt: fresh.expiresAt,
    });
  });

  test('a failed refresh for the same member keeps the stored token', async () => {
    const id = gatewayRecord();
    runtime.getStore().saveGatewayToken(id, 'gsj-old', 'u1', later(60));
    issue.mockRejectedValue(new Error('network'));

    const servers = await runtime.refreshResolvedServersCache();
    // Dropping the server here would restart OpenClaw and remove tools the
    // member is using, over a transient network error.
    expect(servers).toHaveLength(1);
    expect(servers[0].headers).toMatchObject({ authorization: 'McpGateway gsj-old' });
  });

  test('a gateway record with no token at all is skipped, never dialed directly', async () => {
    gatewayRecord();
    issue.mockRejectedValue(new Error('401 not_member'));

    const servers = await runtime.refreshResolvedServersCache();
    expect(servers).toHaveLength(0);
  });

  test('a signed-out app drops the server instead of reusing a stored token', async () => {
    const id = gatewayRecord();
    runtime.getStore().saveGatewayToken(id, 'gsj-1', 'u1', later(60));
    load.mockReturnValue(null);

    const servers = await runtime.refreshResolvedServersCache();
    // §8.26: signed out means no gateway connector reaches openclaw.json —
    // the previous member's credential must not live on in the config.
    expect(servers).toHaveLength(0);
    expect(JSON.stringify(servers)).not.toContain('McpGateway');
    expect(issue).not.toHaveBeenCalled();
  });

  test("another member's token is never used when this member's mint fails", async () => {
    const id = gatewayRecord();
    // A installed it; B is signed in now and is outside the connector's scope,
    // so B's exchange is refused.
    runtime.getStore().saveGatewayToken(id, 'gsj-of-A', 'user-a', later(60));
    load.mockReturnValue({ userId: 'user-b' } as ReturnType<typeof sessionStorage.load>);
    issue.mockRejectedValue(new Error('403 forbidden'));

    const servers = await runtime.refreshResolvedServersCache();
    // Riding A's 90-day token would authorize B with A's org identity and
    // attribute the audit rows to A (§9.11).
    expect(servers).toHaveLength(0);
    expect(JSON.stringify(servers)).not.toContain('gsj-of-A');
  });

  test('a direct record is untouched', async () => {
    runtime.getStore().createServer({
      name: 'direct',
      description: '',
      transportType: 'http',
      url: 'https://up.example/mcp',
      headers: { 'x-a': 'b' },
    });
    const servers = await runtime.refreshResolvedServersCache();
    expect(servers[0]).toMatchObject({ url: 'https://up.example/mcp', headers: { 'x-a': 'b' } });
    expect(issue).not.toHaveBeenCalled();
  });
});
