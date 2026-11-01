import crypto from 'crypto';
import { describe, expect, test, vi } from 'vitest';

import {
  buildGenericAuthorizeUrl,
  buildTokenExchangeBody,
  createPkce,
  createTokenExchangeProbe,
  MCP_OAUTH_REDIRECT_PORT_DEFAULT,
  parseTokenResponse,
  resolveOauthEndpoints,
  resolveRedirect,
} from './genericOauthFlow';

describe('createPkce', () => {
  test('produces a base64url verifier/challenge/state and the challenge is S256 of the verifier', () => {
    const { verifier, challenge, state } = createPkce();
    // The IdP receives the verifier STRING (base64url) and computes
    // BASE64URL(SHA256(code_verifier)) per RFC 7636 §4.2 — so the challenge
    // must hash the string itself, not the underlying raw bytes.
    const expectChallenge = crypto
      .createHash('sha256')
      .update(verifier)   // the base64url string itself — what the IdP receives
      .digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    expect(challenge).toBe(expectChallenge);
    expect(verifier).not.toMatch(/[+/=]/);
    expect(state).not.toMatch(/[+/=]/);
  });
});

describe('buildGenericAuthorizeUrl', () => {
  test('carries the standard PKCE params and scopes, url-encoded', () => {
    const url = buildGenericAuthorizeUrl({
      authorizeUrl: 'https://idp.example.com/oauth/authorize',
      clientId: 'cid 1',
      redirectUri: 'http://localhost:54321/callback',
      scopes: ['openid', 'email'],
      state: 'ST',
      challenge: 'CH',
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://idp.example.com/oauth/authorize');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe('cid 1');
    expect(u.searchParams.get('redirect_uri')).toBe('http://localhost:54321/callback');
    expect(u.searchParams.get('scope')).toBe('openid email');
    expect(u.searchParams.get('state')).toBe('ST');
    expect(u.searchParams.get('code_challenge')).toBe('CH');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  });
  test('omits the scope param when there are no scopes', () => {
    const url = buildGenericAuthorizeUrl({
      authorizeUrl: 'https://idp/x', clientId: 'c', redirectUri: 'http://l', state: 's', challenge: 'ch',
    });
    expect(new URL(url).searchParams.get('scope')).toBeNull();
  });
});

describe('buildTokenExchangeBody', () => {
  test('encodes grant_type=authorization_code with code, verifier, client_id and no secret', () => {
    const body = buildTokenExchangeBody({ code: 'C0DE', codeVerifier: 'V0', clientId: 'CID' });
    const params = new URLSearchParams(body);
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code')).toBe('C0DE');
    expect(params.get('code_verifier')).toBe('V0');
    expect(params.get('client_id')).toBe('CID');
    expect(body).not.toContain('client_secret');
    expect(params.get('redirect_uri')).toBeNull();
  });

  test('it carries the redirect_uri when the flow used one (RFC 6749 §4.1.3)', () => {
    const body = buildTokenExchangeBody({
      code: 'C0DE',
      codeVerifier: 'V0',
      clientId: 'CID',
      redirectUri: 'http://127.0.0.1:53232/callback',
    });
    const params = new URLSearchParams(body);
    expect(params.get('redirect_uri')).toBe('http://127.0.0.1:53232/callback');
    expect(body).not.toContain('client_secret');
  });
});

describe('parseTokenResponse', () => {
  test('returns access_token from a valid JSON response', () => {
    expect(parseTokenResponse(JSON.stringify({ access_token: 'at-1', token_type: 'Bearer' }))).toBe('at-1');
  });
  test('throws when access_token is missing', () => {
    expect(() => parseTokenResponse(JSON.stringify({ error: 'invalid_grant' }))).toThrow();
  });
});

describe('resolveRedirect', () => {
  test('it uses the loopback port the enterprise server sent', () => {
    const r = resolveRedirect('http://127.0.0.1:53232/callback');
    expect(r.port).toBe(53232);
    expect(r.uri).toBe('http://127.0.0.1:53232/callback');
  });

  test('it falls back to the default port when the server sent nothing', () => {
    const r = resolveRedirect(undefined);
    expect(r.port).toBe(MCP_OAUTH_REDIRECT_PORT_DEFAULT);
    expect(r.uri).toBe(`http://127.0.0.1:${MCP_OAUTH_REDIRECT_PORT_DEFAULT}/callback`);
  });

  test('it refuses a server-hosted callback — the desktop cannot bind that', () => {
    const r = resolveRedirect('https://oauth.mixcwork.cn/mcp/callback');
    expect(r.port).toBe(MCP_OAUTH_REDIRECT_PORT_DEFAULT);
    expect(r.uri).not.toContain('oauth.mixcwork.cn');
  });

  test('it refuses a loopback URI with no port', () => {
    expect(resolveRedirect('http://127.0.0.1/callback').port).toBe(MCP_OAUTH_REDIRECT_PORT_DEFAULT);
  });

  test('it normalizes localhost to the loopback literal it actually binds', () => {
    const r = resolveRedirect('http://localhost:53232/callback');
    expect(r.uri).toBe('http://127.0.0.1:53232/callback');
  });
});

describe('resolveOauthEndpoints', () => {
  const redirect = { uri: 'http://127.0.0.1:53232/callback', port: 53232 };
  const DISCOVERED = {
    authorizeUrl: 'https://auth.example.com/a',
    tokenUrl: 'https://auth.example.com/t',
    registrationEndpoint: 'https://auth.example.com/register',
    issuer: 'https://auth.example.com',
    sourceUrl: 'https://auth.example.com/.well-known/oauth-authorization-server',
  };

  function deps(overrides: {
    discover?: (args: { resourceUrl: string }) => Promise<typeof DISCOVERED>;
    register?: (args: { registrationEndpoint: string; redirectUri: string }) => Promise<{ clientId: string; tokenEndpointAuthMethod: 'none' }>;
  } = {}) {
    const calls = { discover: [] as string[], register: [] as string[] };
    return {
      calls,
      deps: {
        discover: async (args: { resourceUrl: string }) => {
          calls.discover.push(args.resourceUrl);
          return overrides.discover ? overrides.discover(args) : DISCOVERED;
        },
        register: async (args: { registrationEndpoint: string; redirectUri: string }) => {
          calls.register.push(`${args.registrationEndpoint} ${args.redirectUri}`);
          return overrides.register
            ? overrides.register(args)
            : { clientId: 'registered-client', tokenEndpointAuthMethod: 'none' as const };
        },
      },
    };
  }

  test('a complete org config is used as-is — nothing is discovered or registered', async () => {
    const { deps: injected, calls } = deps();
    const resolved = await resolveOauthEndpoints(
      {
        authorizeUrl: 'https://idp.example.com/authorize',
        tokenUrl: 'https://idp.example.com/token',
        clientId: 'org-client',
        resourceUrl: 'https://mcp.example.com/mcp',
      },
      redirect,
      injected,
    );

    expect(resolved).toEqual({
      authorizeUrl: 'https://idp.example.com/authorize',
      tokenUrl: 'https://idp.example.com/token',
      clientId: 'org-client',
      redirectUri: 'http://127.0.0.1:53232/callback',
      discoveredEndpoints: false,
      registeredClient: false,
    });
    expect(calls.discover).toEqual([]);
    expect(calls.register).toEqual([]);
  });

  test('missing endpoints are discovered; the org client id is kept', async () => {
    const { deps: injected, calls } = deps();
    const resolved = await resolveOauthEndpoints(
      { clientId: 'org-client', resourceUrl: 'https://mcp.example.com/mcp' },
      redirect,
      injected,
    );

    expect(resolved.authorizeUrl).toBe(DISCOVERED.authorizeUrl);
    expect(resolved.tokenUrl).toBe(DISCOVERED.tokenUrl);
    expect(resolved.clientId).toBe('org-client');
    expect(resolved.discoveredEndpoints).toBe(true);
    expect(resolved.registeredClient).toBe(false);
    expect(calls.discover).toEqual(['https://mcp.example.com/mcp']);
    expect(calls.register).toEqual([]);
  });

  test('the org wins field by field — a pinned token URL survives discovery', async () => {
    const { deps: injected } = deps();
    const resolved = await resolveOauthEndpoints(
      {
        tokenUrl: 'https://idp.example.com/pinned-token',
        clientId: 'org-client',
        resourceUrl: 'https://mcp.example.com/mcp',
      },
      redirect,
      injected,
    );

    expect(resolved.tokenUrl).toBe('https://idp.example.com/pinned-token');
    expect(resolved.authorizeUrl).toBe(DISCOVERED.authorizeUrl);
  });

  test('no client id and a registration endpoint → registers a public client on the loopback redirect', async () => {
    const { deps: injected, calls } = deps();
    const resolved = await resolveOauthEndpoints(
      { authorizeUrl: 'https://auth.example.com/a', tokenUrl: 'https://auth.example.com/t', resourceUrl: 'https://mcp.example.com/mcp' },
      redirect,
      injected,
    );

    expect(resolved.clientId).toBe('registered-client');
    expect(resolved.registeredClient).toBe(true);
    expect(calls.register).toEqual(['https://auth.example.com/register http://127.0.0.1:53232/callback']);
  });

  test('an org client id is never re-registered', async () => {
    const { deps: injected, calls } = deps();
    await resolveOauthEndpoints(
      { authorizeUrl: 'https://auth.example.com/a', tokenUrl: 'https://auth.example.com/t', clientId: 'org-client', resourceUrl: 'https://mcp.example.com/mcp' },
      redirect,
      injected,
    );
    expect(calls.register).toEqual([]);
  });

  test('incomplete config without a connector URL fails with a message that names the gap', async () => {
    const { deps: injected, calls } = deps();
    await expect(resolveOauthEndpoints({ clientId: 'org-client' }, redirect, injected)).rejects.toThrow(
      /connector URL/,
    );
    expect(calls.discover).toEqual([]);
  });

  test('no client id and no registration endpoint fails with an actionable message', async () => {
    const { deps: injected } = deps({
      discover: async () => ({ ...DISCOVERED, registrationEndpoint: undefined }),
    });
    await expect(
      resolveOauthEndpoints({ resourceUrl: 'https://mcp.example.com/mcp' }, redirect, injected),
    ).rejects.toThrow(/registration/i);
  });
});


describe('createTokenExchangeProbe', () => {
  test('exchanges the code exactly once no matter how often the probe polls', async () => {
    // openOauthFlow calls the probe on every did-finish-load and again every
    // 2s; waitForCode keeps handing back the code it captured. Re-posting the
    // exchange is what 纷享销客 rejects with "token已下发，请勿重复下发！".
    let exchangeCalls = 0;
    const onError = vi.fn();
    const closeWindow = vi.fn();
    const probe = createTokenExchangeProbe({
      waitForCode: async () => 'the-code',
      exchange: async () => {
        exchangeCalls += 1;
        return 'the-token';
      },
      closeWindow,
      onError,
    });
    const results = await Promise.all([probe(null), probe(null), probe(null)]);
    expect(exchangeCalls).toBe(1);
    expect(results).toEqual(['the-token', 'the-token', 'the-token']);
    // A later poll keeps returning the same token without a new POST.
    expect(await probe(null)).toBe('the-token');
    expect(exchangeCalls).toBe(1);
    expect(onError).not.toHaveBeenCalled();
    expect(closeWindow).not.toHaveBeenCalled();
  });

  test('does not exchange anything until a code arrives', async () => {
    let resolveCode: ((c: string | null) => void) | null = null;
    const exchange = vi.fn(async () => 'token');
    const probe = createTokenExchangeProbe({
      waitForCode: () =>
        new Promise<string | null>((r) => {
          resolveCode = r;
        }),
      exchange,
      closeWindow: vi.fn(),
      onError: vi.fn(),
    });
    const pending = probe(null);
    expect(exchange).not.toHaveBeenCalled();
    resolveCode!('late-code');
    expect(await pending).toBe('token');
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(exchange).toHaveBeenCalledWith('late-code');
  });

  test('returns null when the window closes before the code arrives', async () => {
    const exchange = vi.fn(async () => 'token');
    const probe = createTokenExchangeProbe({
      waitForCode: async () => null,
      exchange,
      closeWindow: vi.fn(),
      onError: vi.fn(),
    });
    expect(await probe(null)).toBeNull();
    expect(exchange).not.toHaveBeenCalled();
  });

  test('a failed exchange is never retried, and the window is closed once', async () => {
    const exchange = vi.fn(async () => {
      throw new Error('oauth token exchange failed: token已下发，请勿重复下发！');
    });
    const onError = vi.fn();
    const closeWindow = vi.fn();
    const win = {} as never;
    const probe = createTokenExchangeProbe({
      waitForCode: async () => 'the-code',
      exchange,
      closeWindow,
      onError,
    });
    await expect(probe(win)).rejects.toThrow(/token已下发/);
    await expect(probe(win)).rejects.toThrow(/token已下发/);
    // One POST, so the code is never burned twice.
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(closeWindow).toHaveBeenCalledTimes(1);
    expect(closeWindow).toHaveBeenCalledWith(win);
    // Every poll learns about the failure (the flow re-surfaces it).
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
  });
});
