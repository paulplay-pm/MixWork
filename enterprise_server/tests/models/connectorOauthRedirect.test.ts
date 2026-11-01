import '../helpers/setupEnv';

import { describe, expect, test } from 'vitest';

import {
  MCP_OAUTH_REDIRECT_PORT_DEFAULT,
  mcpOAuthRedirectUri,
  resolveMcpOAuthRedirectPort,
} from '../../src/models/connectorOauthRedirect';

describe('the connector OAuth redirect URI', () => {
  test('it is the loopback callback the desktop binds', () => {
    expect(mcpOAuthRedirectUri({})).toBe(
      `http://127.0.0.1:${MCP_OAUTH_REDIRECT_PORT_DEFAULT}/callback`,
    );
  });

  test('an enterprise can move it to another port', () => {
    expect(resolveMcpOAuthRedirectPort({ MCP_OAUTH_REDIRECT_PORT: '40000' })).toEqual({
      port: 40000,
      fromEnv: true,
    });
    expect(mcpOAuthRedirectUri({ MCP_OAUTH_REDIRECT_PORT: '40000' })).toBe(
      'http://127.0.0.1:40000/callback',
    );
  });

  test('a nonsense port falls back to the default instead of serving a broken URI', () => {
    expect(resolveMcpOAuthRedirectPort({ MCP_OAUTH_REDIRECT_PORT: 'abc' }).port).toBe(
      MCP_OAUTH_REDIRECT_PORT_DEFAULT,
    );
    expect(resolveMcpOAuthRedirectPort({ MCP_OAUTH_REDIRECT_PORT: '70000' }).port).toBe(
      MCP_OAUTH_REDIRECT_PORT_DEFAULT,
    );
    expect(resolveMcpOAuthRedirectPort({ MCP_OAUTH_REDIRECT_PORT: '0' }).port).toBe(
      MCP_OAUTH_REDIRECT_PORT_DEFAULT,
    );
  });

  test('the host is the loopback literal, never localhost', () => {
    // The desktop binds the IPv4 loopback; a browser that resolves
    // `localhost` to `::1` would send the code to a socket nobody listens on.
    expect(mcpOAuthRedirectUri({})).toContain('http://127.0.0.1:');
  });
});
