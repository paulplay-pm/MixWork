import { describe, expect, test } from 'vitest';

import { type FetchLike,OAuthRegistrationError, registerPublicClient } from './oauthRegistration';

const REGISTRATION = 'https://auth.example.com/oauth2.0/register';
const REDIRECT = 'http://127.0.0.1:53232/callback';

function stubFetch(response: { status?: number; body: unknown }): { fetch: FetchLike; init: RequestInit[]; urls: string[] } {
  const init: RequestInit[] = [];
  const urls: string[] = [];
  const fetch: FetchLike = async (input, requestInit) => {
    urls.push(input);
    init.push(requestInit ?? {});
    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 201,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, init, urls };
}

describe('registerPublicClient (RFC 7591)', () => {
  test('posts the public-client registration for the exact loopback redirect', async () => {
    const { fetch, init, urls } = stubFetch({ body: { client_id: 'mixcwork-abc', token_endpoint_auth_method: 'none' } });

    const client = await registerPublicClient({
      registrationEndpoint: REGISTRATION,
      redirectUri: REDIRECT,
      fetchImpl: fetch,
    });

    expect(client).toEqual({ clientId: 'mixcwork-abc', tokenEndpointAuthMethod: 'none' });
    expect(urls).toEqual([REGISTRATION]);
    expect(init[0].method).toBe('POST');
    expect((init[0].headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(String(init[0].body))).toEqual({
      client_name: 'MixCWork Desktop',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });

  test('accepts a 200 as well as the spec’s 201', async () => {
    const { fetch } = stubFetch({ status: 200, body: { client_id: 'x' } });
    await expect(
      registerPublicClient({ registrationEndpoint: REGISTRATION, redirectUri: REDIRECT, fetchImpl: fetch }),
    ).resolves.toEqual({ clientId: 'x', tokenEndpointAuthMethod: 'none' });
  });

  test('surfaces the provider’s error code and description', async () => {
    const { fetch } = stubFetch({
      status: 400,
      body: { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https' },
    });
    const error = await registerPublicClient({
      registrationEndpoint: REGISTRATION,
      redirectUri: REDIRECT,
      fetchImpl: fetch,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(OAuthRegistrationError);
    expect(error.message).toContain('invalid_redirect_uri');
    expect(error.message).toContain('redirect_uris must be https');
  });

  test('refuses a response with no client_id — the rest of the flow cannot run', async () => {
    const { fetch } = stubFetch({ body: { /* nothing */ } });
    await expect(
      registerPublicClient({ registrationEndpoint: REGISTRATION, redirectUri: REDIRECT, fetchImpl: fetch }),
    ).rejects.toThrow(/client_id/);
  });

  test('refuses a confidential registration: this flow is a public PKCE client', async () => {
    const { fetch } = stubFetch({
      body: { client_id: 'x', client_secret: 'shh', token_endpoint_auth_method: 'client_secret_basic' },
    });
    await expect(
      registerPublicClient({ registrationEndpoint: REGISTRATION, redirectUri: REDIRECT, fetchImpl: fetch }),
    ).rejects.toThrow(/public client|confidential/i);
  });

  test('will not register against a plain-http, non-loopback endpoint', async () => {
    await expect(
      registerPublicClient({
        registrationEndpoint: 'http://auth.example.com/register',
        redirectUri: REDIRECT,
        fetchImpl: async () => new Response('{}'),
      }),
    ).rejects.toThrow(/https/);
  });
});
