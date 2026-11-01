import { describe, expect, test } from 'vitest';

import {
  authorizationServerMetadataUrls,
  discoverOAuthEndpoints,
  type FetchLike,
  OAuthDiscoveryError,
  parseWwwAuthenticate,
  protectedResourceMetadataUrls,
} from './oauthDiscovery';

const RESOURCE = 'https://open.example.com/mcp/acme/ai';

/** A fetch stub keyed by URL; an unlisted URL 404s like a real well-known
 *  probe would. Every request is recorded so tests can assert what was tried. */
function stubFetch(routes: Record<string, { status?: number; body?: unknown; headers?: Record<string, string> }>): {
  fetch: FetchLike;
  calls: string[];
} {
  const calls: string[] = [];
  const fetch: FetchLike = async (input) => {
    calls.push(input);
    const hit = routes[input];
    if (!hit) return new Response('not found', { status: 404 });
    return new Response(hit.body === undefined ? '' : JSON.stringify(hit.body), {
      status: hit.status ?? 200,
      headers: { 'content-type': 'application/json', ...(hit.headers ?? {}) },
    });
  };
  return { fetch, calls };
}

const PROTECTED_RESOURCE = {
  resource: RESOURCE,
  authorization_servers: ['https://auth.example.com'],
};
const AS_METADATA = {
  issuer: 'https://auth.example.com',
  authorization_endpoint: 'https://auth.example.com/oauth2.0/authorize',
  token_endpoint: 'https://auth.example.com/oauth2.0/token',
  registration_endpoint: 'https://auth.example.com/oauth2.0/register',
  code_challenge_methods_supported: ['S256'],
};

describe('protectedResourceMetadataUrls', () => {
  test('puts the RFC 9728 path-suffixed form first, then the origin form', () => {
    expect(protectedResourceMetadataUrls(RESOURCE)).toEqual([
      'https://open.example.com/.well-known/oauth-protected-resource/mcp/acme/ai',
      'https://open.example.com/.well-known/oauth-protected-resource',
    ]);
  });

  test('a resource URL with no path only needs the origin form', () => {
    expect(protectedResourceMetadataUrls('https://open.example.com')).toEqual([
      'https://open.example.com/.well-known/oauth-protected-resource',
    ]);
  });
});

describe('authorizationServerMetadataUrls', () => {
  test('RFC 8414 §3.1 inserts the well-known segment before an issuer path, and OIDC is tried too', () => {
    expect(authorizationServerMetadataUrls('https://auth.example.com/tenant/a')).toEqual([
      'https://auth.example.com/.well-known/oauth-authorization-server/tenant/a',
      'https://auth.example.com/.well-known/openid-configuration/tenant/a',
      'https://auth.example.com/tenant/a/.well-known/openid-configuration',
    ]);
  });

  test('an origin-only issuer has the two root documents', () => {
    expect(authorizationServerMetadataUrls('https://auth.example.com')).toEqual([
      'https://auth.example.com/.well-known/oauth-authorization-server',
      'https://auth.example.com/.well-known/openid-configuration',
    ]);
  });
});

describe('parseWwwAuthenticate', () => {
  test('pulls the resource_metadata URL out of a Bearer challenge', () => {
    const header =
      'Bearer resource_metadata="https://open.example.com/.well-known/oauth-protected-resource/mcp/acme/ai", scope="crm.read crm.write"';
    expect(parseWwwAuthenticate(header)).toBe(
      'https://open.example.com/.well-known/oauth-protected-resource/mcp/acme/ai',
    );
  });

  test('returns null when the challenge carries no resource_metadata', () => {
    expect(parseWwwAuthenticate('Bearer scope="x"')).toBeNull();
    expect(parseWwwAuthenticate('')).toBeNull();
  });
});

describe('discoverOAuthEndpoints', () => {
  test('follows the protected-resource document to the authorization server metadata', async () => {
    const { fetch, calls } = stubFetch({
      [protectedResourceMetadataUrls(RESOURCE)[0]]: { body: PROTECTED_RESOURCE },
      'https://auth.example.com/.well-known/oauth-authorization-server': { body: AS_METADATA },
    });

    const result = await discoverOAuthEndpoints({ resourceUrl: RESOURCE, fetchImpl: fetch });

    expect(result).toEqual({
      authorizeUrl: 'https://auth.example.com/oauth2.0/authorize',
      tokenUrl: 'https://auth.example.com/oauth2.0/token',
      registrationEndpoint: 'https://auth.example.com/oauth2.0/register',
      issuer: 'https://auth.example.com',
      sourceUrl: 'https://auth.example.com/.well-known/oauth-authorization-server',
      resourceMetadataUrl: protectedResourceMetadataUrls(RESOURCE)[0],
    });
    expect(calls).toEqual([
      protectedResourceMetadataUrls(RESOURCE)[0],
      'https://auth.example.com/.well-known/oauth-authorization-server',
    ]);
  });

  test('falls back to the resource origin as the issuer when the document names none', async () => {
    const { fetch } = stubFetch({
      [protectedResourceMetadataUrls(RESOURCE)[0]]: { body: { resource: RESOURCE } },
      'https://open.example.com/.well-known/oauth-authorization-server': { body: AS_METADATA },
    });

    const result = await discoverOAuthEndpoints({ resourceUrl: RESOURCE, fetchImpl: fetch });
    expect(result.tokenUrl).toBe('https://auth.example.com/oauth2.0/token');
  });

  test('tries the origin-form protected-resource document when the path-suffixed one 404s', async () => {
    const origin = protectedResourceMetadataUrls(RESOURCE)[1];
    const { fetch, calls } = stubFetch({
      [origin]: { body: PROTECTED_RESOURCE },
      'https://auth.example.com/.well-known/oauth-authorization-server': { body: AS_METADATA },
    });

    await discoverOAuthEndpoints({ resourceUrl: RESOURCE, fetchImpl: fetch });
    expect(calls).toContain(origin);
    expect(calls).toContain(protectedResourceMetadataUrls(RESOURCE)[0]);
  });

  test('skips an authorization server that only supports the plain PKCE method', async () => {
    const { fetch } = stubFetch({
      [protectedResourceMetadataUrls(RESOURCE)[0]]: { body: PROTECTED_RESOURCE },
      'https://auth.example.com/.well-known/oauth-authorization-server': {
        body: { ...AS_METADATA, code_challenge_methods_supported: ['plain'] },
      },
    });

    await expect(discoverOAuthEndpoints({ resourceUrl: RESOURCE, fetchImpl: fetch })).rejects.toThrow(
      /S256/,
    );
  });

  test('uses the WWW-Authenticate challenge when the well-known guesses all 404', async () => {
    const metadataUrl = 'https://open.example.com/custom/prm';
    const { fetch, calls } = stubFetch({
      [RESOURCE]: { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${metadataUrl}"` } },
      [metadataUrl]: { body: PROTECTED_RESOURCE },
      'https://auth.example.com/.well-known/oauth-authorization-server': { body: AS_METADATA },
    });

    const result = await discoverOAuthEndpoints({ resourceUrl: RESOURCE, fetchImpl: fetch });

    expect(result.authorizeUrl).toBe('https://auth.example.com/oauth2.0/authorize');
    expect(result.resourceMetadataUrl).toBe(metadataUrl);
    expect(calls).toContain(RESOURCE);
  });

  test('reports every URL it tried when nothing answers', async () => {
    const { fetch } = stubFetch({});
    const error = await discoverOAuthEndpoints({ resourceUrl: RESOURCE, fetchImpl: fetch }).catch((e) => e);

    expect(error).toBeInstanceOf(OAuthDiscoveryError);
    // No document named an issuer, so the walk only ever tried the resource's
    // own origin as the authorization server — that is what must be reported.
    expect(error.message).toContain('oauth discovery failed');
    expect(error.tried).toContain('https://open.example.com/.well-known/oauth-authorization-server');
    expect(error.tried).toContain('https://open.example.com/.well-known/oauth-protected-resource/mcp/acme/ai');
  });

  test('refuses a resource URL it cannot trust — plain http off loopback is not discovered', async () => {
    await expect(
      discoverOAuthEndpoints({ resourceUrl: 'http://open.example.com/mcp/x', fetchImpl: async () => new Response('') }),
    ).rejects.toThrow(/https/);
  });

  test('allows plain http on loopback so local servers are testable', async () => {
    const local = 'http://127.0.0.1:8787/mcp';
    const { fetch } = stubFetch({
      [protectedResourceMetadataUrls(local)[0]]: { body: { authorization_servers: ['http://127.0.0.1:8787'] } },
      'http://127.0.0.1:8787/.well-known/oauth-authorization-server': {
        body: { ...AS_METADATA, authorization_endpoint: 'http://127.0.0.1:8787/a', token_endpoint: 'http://127.0.0.1:8787/t' },
      },
    });
    const result = await discoverOAuthEndpoints({ resourceUrl: local, fetchImpl: fetch });
    expect(result.tokenUrl).toBe('http://127.0.0.1:8787/t');
  });
});
