import '../helpers/setupEnv';

import { describe, expect, test } from 'vitest';

import { mcpOAuthRedirectUri } from '../../src/models/connectorOauthRedirect';
import {
  type ConnectorRow,
  mapAdminConnector,
  mapPublicConnector,
  scopeMatches,
  scopeSummary,
} from '../../src/models/connectorView';
import { encrypt } from '../../src/vault/crypto';

describe('scopeMatches', () => {
  test('allCompany grants everyone', () => {
    expect(scopeMatches({ allCompany: true, deptIds: [], userIds: [] }, [], 'u1')).toBe(true);
  });
  test('member exception grants the user', () => {
    expect(scopeMatches({ allCompany: false, deptIds: [], userIds: ['u1'] }, [], 'u1')).toBe(true);
  });
  test('a granted dept grants its member', () => {
    expect(
      scopeMatches({ allCompany: false, deptIds: ['rd'], userIds: [] }, ['rd', 'fe'], 'u1'),
    ).toBe(true);
  });
  test('unmatched member is denied', () => {
    expect(scopeMatches({ allCompany: false, deptIds: ['sales'], userIds: [] }, ['rd'], 'u1')).toBe(
      false,
    );
  });
});

describe('scopeSummary', () => {
  test('allCompany -> all', () => {
    expect(scopeSummary({ allCompany: true, deptIds: [], userIds: [] })).toBe('all');
  });
  test('empty scope -> none', () => {
    expect(scopeSummary({ allCompany: false, deptIds: [], userIds: [] })).toBe('none');
  });
  test('depts only and depts+users', () => {
    expect(scopeSummary({ allCompany: false, deptIds: ['a', 'b'], userIds: [] })).toBe('depts:2');
    expect(scopeSummary({ allCompany: false, deptIds: ['a'], userIds: ['u1', 'u2'] })).toBe(
      'depts:1,users:2',
    );
  });
});

const makeRow = (over: Partial<ConnectorRow> = {}): ConnectorRow => ({
  id: 'c1',
  org_id: 'o1',
  server_key: 'crm-api',
  name_en: 'CRM API',
  name_zh: '客户关系',
  version: '1.0.0',
  category_id: null,
  description: null,
  connector_type: 'mcp',
  url: 'https://crm.example.com/mcp',
  transport: 'http',
  auth_mode: 'shared-key',
  auth_config: {},
  secret_meta: null,
  auth_status: 'configured',
  icon: null,
  enabled: true,
  scope: { allCompany: false, deptIds: ['sales'], userIds: ['u9'] },
  tools: [
    { name: 'query', enabled: true },
    { name: 'legacy-tool', enabled: false, removed: true },
  ],
  draft: null,
  last_test_at: null,
  last_test_status: null,
  last_latency_ms: null,
  created_by: null,
  created_at: new Date('2026-09-01T10:00:00Z'),
  updated_at: new Date('2026-09-15T12:30:00Z'),
  ...over,
});

describe('mapPublicConnector', () => {
  test('exposes no authConfig, no secretMeta, no ciphertext', () => {
    const cipher = encrypt('sk-supersecret1234');
    const row = makeRow({ auth_config: { __enc__apiKey: cipher, region: 'cn' } });
    const v = mapPublicConnector(row);
    expect(v).not.toHaveProperty('authConfig');
    expect(v).not.toHaveProperty('secretMeta');
    expect(JSON.stringify(v)).not.toContain(cipher);
    expect(JSON.stringify(v)).not.toContain('sk-supersecret1234');
  });
  test('carries the brand icon so the member sees a logo, not a glyph', () => {
    expect(mapPublicConnector(makeRow({ icon: 'https://cdn.example.com/crm.png' })).icon)
      .toBe('https://cdn.example.com/crm.png');
    // A connector without one stays absent rather than becoming an empty
    // string the desktop would try to load.
    expect(mapPublicConnector(makeRow({ icon: null })).icon).toBeUndefined();
  });
  test('never leaks ssoClientSecret into the public view', () => {
    const v = mapPublicConnector(makeRow({
      auth_mode: 'sso',
      auth_config: {
        ssoAuthorizeUrl: 'https://a',
        ssoTokenUrl: 'https://t',
        ssoClientId: 'c',
        ssoClientSecret: 'top-secret-sso',
      },
    }));
    expect(JSON.stringify(v)).not.toContain('top-secret-sso');
  });
  test('name prefers zh, then en, then server_key', () => {
    expect(mapPublicConnector(makeRow()).name).toBe('客户关系');
    expect(mapPublicConnector(makeRow({ name_zh: null })).name).toBe('CRM API');
    expect(mapPublicConnector(makeRow({ name_zh: null, name_en: null })).name).toBe('crm-api');
  });
  test('nullable row fields fall back to empty string; toolCount skips removed', () => {
    const v = mapPublicConnector(makeRow());
    expect(v.description).toBe('');
    expect(v.category).toBe('');
    expect(v.toolCount).toBe(1);
    expect(v.hasDraft).toBe(false);
    expect(v.scopeSummary).toBe('depts:1,users:1');
  });
});

describe('mapPublicConnector.timeoutSeconds', () => {
  test('a stored timeout reaches the desktop, so the field is not decorative', () => {
    const v = mapPublicConnector(makeRow({ auth_config: { timeoutSeconds: 90 } }));
    expect(v.timeoutSeconds).toBe(90);
  });
  test('no timeout means the runtime default — the field is simply absent', () => {
    expect(mapPublicConnector(makeRow()).timeoutSeconds).toBeUndefined();
    expect(mapPublicConnector(makeRow({ auth_config: {} })).timeoutSeconds).toBeUndefined();
  });
  test('a nonsense stored value is not forwarded', () => {
    expect(mapPublicConnector(makeRow({ auth_config: { timeoutSeconds: 0 } })).timeoutSeconds).toBeUndefined();
    expect(
      mapPublicConnector(makeRow({ auth_config: { timeoutSeconds: 'sixty' } })).timeoutSeconds,
    ).toBeUndefined();
    expect(
      mapPublicConnector(makeRow({ auth_config: { timeoutSeconds: -5 } })).timeoutSeconds,
    ).toBeUndefined();
  });
});

describe('mapPublicConnector.oauth (user-oauth whitelist)', () => {
  const base = {
    auth_mode: 'user-oauth' as const,
    auth_config: {
      authorizeUrl: 'https://idp.example.com/oauth/authorize',
      tokenUrl: 'https://idp.example.com/oauth/token',
      clientId: 'public-client-123',
      scopes: ['openid', 'profile'],
      clientSecret: 'shoud-not-leak-plaintext',
      __enc__clientSecret: 'ENC_CIPHERTEXT_DO_NOT_LEAK',
    },
  };
  test('fills oauth from the whitelist when endpoints are complete', () => {
    const v = mapPublicConnector(makeRow(base));
    expect(v.oauth).toEqual({
      authorizeUrl: 'https://idp.example.com/oauth/authorize',
      tokenUrl: 'https://idp.example.com/oauth/token',
      clientId: 'public-client-123',
      scopes: ['openid', 'profile'],
      // The desktop binds this loopback callback and sends it as the
      // `redirect_uri`; the admin registers the same URI at the IdP.
      redirectUri: mcpOAuthRedirectUri(),
    });
  });
  test('the redirect URI is the server-generated loopback callback, not a stored value', () => {
    // A stored `callbackUrl` from an older record is NOT what the desktop
    // sends — only the server's own value is, so the console, the desktop
    // and the IdP registration cannot drift apart.
    const v = mapPublicConnector(
      makeRow({ ...base, auth_config: { ...base.auth_config, callbackUrl: 'https://oauth.mixcwork.cn/mcp/callback' } }),
    );
    expect(v.oauth?.redirectUri).toBe(mcpOAuthRedirectUri());
    expect(v.oauth?.redirectUri).toBe('http://127.0.0.1:53232/callback');
  });
  test('never leaks clientSecret or __enc__* into the public view', () => {
    const v = mapPublicConnector(makeRow(base));
    expect(v).not.toHaveProperty('clientSecret');
    expect(JSON.stringify(v)).not.toContain('shoud-not-leak-plaintext');
    expect(JSON.stringify(v)).not.toContain('ENC_CIPHERTEXT_DO_NOT_LEAK');
    expect(JSON.stringify(v)).not.toContain('__enc__');
  });
  test('a user-oauth connector with nothing configured is still OAuth — it carries the redirect URI alone', () => {
    // The desktop discovers the endpoints and registers a client from the MCP
    // URL; what it needs from the server is the loopback URI to bind (and the
    // fact that this connector is OAuth at all).
    expect(mapPublicConnector(makeRow({ ...base, auth_config: {} })).oauth).toEqual({
      redirectUri: mcpOAuthRedirectUri(),
    });
    expect(
      mapPublicConnector(makeRow({ ...base, auth_config: { clientId: 'c', authorizeUrl: 'https://a', tokenUrl: '' } })).oauth,
    ).toEqual({ clientId: 'c', authorizeUrl: 'https://a', redirectUri: mcpOAuthRedirectUri() });
  });
  test('oauth is undefined for non-user-oauth modes even with endpoints set', () => {
    const v = mapPublicConnector(makeRow({ ...base, auth_mode: 'client-creds' }));
    expect(v.oauth).toBeUndefined();
  });
  test('fills oauth for sso from the sso-* field whitelist when endpoints are complete', () => {
    const v = mapPublicConnector(makeRow({
      auth_mode: 'sso',
      auth_config: {
        ssoApp: 'feishu',
        ssoAuthorizeUrl: 'https://idp.example.com/sso/authorize',
        ssoTokenUrl: 'https://idp.example.com/sso/token',
        ssoClientId: 'sso-public-client',
        ssoScopes: ['openid', 'profile'],
        ssoClientSecret: 'shoud-not-leak-plaintext',
      },
    }));
    expect(v.oauth).toEqual({
      authorizeUrl: 'https://idp.example.com/sso/authorize',
      tokenUrl: 'https://idp.example.com/sso/token',
      clientId: 'sso-public-client',
      scopes: ['openid', 'profile'],
      // The org SSO flow has its own redirect (the server's /auth/sso/callback),
      // so the connector's loopback callback does not belong to it.
    });
    // ssoApp / ssoClientSecret never cross to the desktop.
    expect(JSON.stringify(v)).not.toContain('sso-public-client-secret');
    expect(v).not.toHaveProperty('ssoApp');
  });
  test('sso oauth is undefined when an sso endpoint is missing', () => {
    expect(
      mapPublicConnector(makeRow({
        auth_mode: 'sso',
        auth_config: { ssoApp: 'feishu', ssoAuthorizeUrl: 'https://a', ssoTokenUrl: '', ssoClientId: 'c' },
      })).oauth,
    ).toBeUndefined();
  });
  test('user-key exposes apiKeyHeaderName when set, omits it when unset', () => {
    const withName = mapPublicConnector(makeRow({ auth_mode: 'user-key', auth_config: { apiKeyHeaderName: 'X-My-Key' } }));
    expect(withName.apiKeyHeaderName).toBe('X-My-Key');
    const without = mapPublicConnector(makeRow({ auth_mode: 'user-key', auth_config: {} }));
    expect(without.apiKeyHeaderName).toBeUndefined();
  });
});

describe('mapAdminConnector', () => {
  test('masks the stored secret and strips the ciphertext key', () => {
    const row = makeRow({
      auth_config: { __enc__apiKey: encrypt('sk-supersecret1234'), region: 'cn' },
      secret_meta: { lastUpdatedAt: '2026-09-10T00:00:00.000Z', lastUpdatedBy: 'admin@o1' },
    });
    const v = mapAdminConnector(row);
    expect(v.authConfig.apiKey).toBe('••••1234');
    expect(v.authConfig).not.toHaveProperty('__enc__apiKey');
    expect(v.authConfig.region).toBe('cn');
    expect(JSON.stringify(v)).not.toContain('sk-supersecret1234');
    expect(v.secretMeta).toEqual({
      lastUpdatedAt: '2026-09-10T00:00:00.000Z',
      lastUpdatedBy: 'admin@o1',
    });
  });
  test('no stored secret passes authConfig through unchanged', () => {
    const v = mapAdminConnector(makeRow({ auth_config: { region: 'cn' } }));
    expect(v.authConfig).toEqual({ region: 'cn' });
  });
  test('ISO-strings dates, nulls stay null, toolCount skips removed, hasDraft', () => {
    const v = mapAdminConnector(makeRow());
    expect(v.createdAt).toBe('2026-09-01T10:00:00.000Z');
    expect(v.updatedAt).toBe('2026-09-15T12:30:00.000Z');
    expect(v.lastTestAt).toBeNull();
    expect(v.lastTestStatus).toBeNull();
    expect(v.lastLatencyMs).toBeNull();
    expect(v.toolCount).toBe(1);
    expect(v.hasDraft).toBe(false);
    expect(mapAdminConnector(makeRow({ draft: { url: 'x' } })).hasDraft).toBe(true);
    expect(v.scopeSummary).toBe('depts:1,users:1');
    expect(v.serverKey).toBe('crm-api');
  });
});

describe('mapPublicConnector.toolFilter (admin tool toggles -> OpenClaw)', () => {
  // A discovered tool carries the `syncedAt` stamp the server puts on the
  // tools it listed itself. A hand-declared tool does not — that difference
  // is what tells the two lists apart below.
  const SYNCED = '2026-01-01T00:00:00.000Z';

  test('no restriction when every live tool is enabled', () => {
    const v = mapPublicConnector(
      makeRow({
        tools: [
          { name: 'query', enabled: true, syncedAt: SYNCED },
          { name: 'create', enabled: true, syncedAt: SYNCED },
          { name: 'gone', enabled: false, removed: true, syncedAt: SYNCED },
        ],
      }),
    );
    // The desktop writes no filter at all, so the whole tool list stays available.
    expect(v.toolFilter).toBeUndefined();
  });

  test('a partial selection becomes an include whitelist', () => {
    const v = mapPublicConnector(
      makeRow({
        tools: [
          { name: 'query', enabled: true, syncedAt: SYNCED },
          { name: 'create', enabled: false, syncedAt: SYNCED },
          { name: 'delete', enabled: true, syncedAt: SYNCED },
          { name: 'gone', enabled: false, removed: true, syncedAt: SYNCED },
        ],
      }),
    );
    expect(v.toolFilter).toEqual({ include: ['query', 'delete'] });
  });

  test('disabling every tool becomes an exclude list, not an empty include', () => {
    // `include` requires min(1) in OpenClaw's schema, and an omitted filter
    // means "every tool" — so "all disabled" must be said out loud.
    const v = mapPublicConnector(
      makeRow({
        tools: [
          { name: 'query', enabled: false, syncedAt: SYNCED },
          { name: 'create', enabled: false, syncedAt: SYNCED },
        ],
      }),
    );
    expect(v.toolFilter).toEqual({ exclude: ['query', 'create'] });
  });

  test('a connector with no live tools carries no filter', () => {
    const v = mapPublicConnector(
      makeRow({ tools: [{ name: 'gone', enabled: true, removed: true, syncedAt: SYNCED }] }),
    );
    expect(v.toolFilter).toBeUndefined();
  });
});

describe('mapPublicConnector.toolFilter (a hand-declared tool list)', () => {
  // The server cannot list the tools of a connector whose credential belongs
  // to the member, so the admin writes the list. That list is a whitelist:
  // the upstream may well expose tools the admin never named, and those must
  // not reach the agent.

  test('a declared list stays a whitelist even when every tool is enabled', () => {
    const v = mapPublicConnector(
      makeRow({
        tools: [
          { name: 'query', enabled: true },
          { name: 'delete', enabled: true },
        ],
      }),
    );
    expect(v.toolFilter).toEqual({ include: ['query', 'delete'] });
  });

  test('a disabled declared tool is excluded from the whitelist', () => {
    const v = mapPublicConnector(
      makeRow({
        tools: [
          { name: 'query', enabled: true },
          { name: 'delete', enabled: false },
        ],
      }),
    );
    expect(v.toolFilter).toEqual({ include: ['query', 'delete'], exclude: ['delete'] });
  });

  test('disabling every declared tool says both, so the upstream keeps nothing', () => {
    // An exclude-only filter would let the upstream's unnamed tools through —
    // the opposite of what the admin asked for.
    const v = mapPublicConnector(
      makeRow({
        tools: [
          { name: 'query', enabled: false },
          { name: 'delete', enabled: false },
        ],
      }),
    );
    expect(v.toolFilter).toEqual({ include: ['query', 'delete'], exclude: ['query', 'delete'] });
  });

  test('a removed declared tool does not enter the whitelist', () => {
    const v = mapPublicConnector(
      makeRow({
        tools: [
          { name: 'query', enabled: true },
          { name: 'delete', enabled: true, removed: true },
        ],
      }),
    );
    expect(v.toolFilter).toEqual({ include: ['query'] });
  });
});

describe('mapPublicConnector.consumption', () => {
  test('shared-key is a gateway mode and reports whether the org key is stored', () => {
    const v = mapPublicConnector(
      makeRow({ auth_mode: 'shared-key', auth_config: { __enc__apiKey: encrypt('org-key') } }),
    );
    expect(v.consumption).toBe('gateway');
    expect(v.orgCredentialReady).toBe(true);
  });

  test('a shared-key row with no stored key is not ready', () => {
    const v = mapPublicConnector(makeRow({ auth_mode: 'shared-key', auth_config: {} }));
    expect(v.orgCredentialReady).toBe(false);
  });

  test('a leftover client secret does not make the org key "ready"', () => {
    // `hasStoredSecret` would say true here; only `__enc__apiKey` means the
    // gateway has something to inject.
    const v = mapPublicConnector(
      makeRow({ auth_mode: 'shared-key', auth_config: { __enc__clientSecret: encrypt('cs') } }),
    );
    expect(v.orgCredentialReady).toBe(false);
  });

  test('other modes are direct and carry no readiness claim', () => {
    const v = mapPublicConnector(
      makeRow({ auth_mode: 'user-key', auth_config: { __enc__apiKey: encrypt('k') } }),
    );
    expect(v.consumption).toBe('direct');
    expect(v.orgCredentialReady).toBeUndefined();
  });
});
