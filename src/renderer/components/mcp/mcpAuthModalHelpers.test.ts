import { describe, expect, test } from 'vitest';

import { McpAuthMethod, QICHACHA_REGISTRY_ID } from '../../../shared/mcp/constants';
import {
  buildSaveCredentialPayload,
  getAuthDotClass,
  mapProbeResultToUiState,
  type McpAuthProbeResult,
  oauthUsesDiscovery,
  probeLabelKey,
  showsProbeDetail,
  usesGenericOAuth,
} from './mcpAuthModalHelpers';

describe('buildSaveCredentialPayload', () => {
  test('bearer maps a trimmed bearer value to { kind: "bearer", bearer }', () => {
    expect(buildSaveCredentialPayload(McpAuthMethod.Bearer, { bearer: 'tok-123' })).toEqual({
      kind: 'bearer',
      bearer: 'tok-123',
    });
  });

  test('bearer trims whitespace before validating non-empty', () => {
    expect(buildSaveCredentialPayload(McpAuthMethod.Bearer, { bearer: '  tok  ' })).toEqual({
      kind: 'bearer',
      bearer: 'tok',
    });
  });

  test('bearer returns null for an empty value', () => {
    expect(buildSaveCredentialPayload(McpAuthMethod.Bearer, { bearer: '   ' })).toBeNull();
  });

  test('api-key maps { headerName, value } to { kind: "apiKey", headerName, value }', () => {
    expect(
      buildSaveCredentialPayload(McpAuthMethod.ApiKey, {
        headerName: 'X-API-Key',
        value: 'k',
      }),
    ).toEqual({ kind: 'apiKey', headerName: 'X-API-Key', value: 'k' });
  });

  test('api-key returns null when headerName is empty', () => {
    expect(buildSaveCredentialPayload(McpAuthMethod.ApiKey, { headerName: '', value: 'k' })).toBeNull();
  });

  test('api-key returns null when value is empty', () => {
    expect(
      buildSaveCredentialPayload(McpAuthMethod.ApiKey, { headerName: 'X-API-Key', value: '  ' }),
    ).toBeNull();
  });

  test('only the built-in qichacha bundle drives the qichacha login page', () => {
    expect(
      buildSaveCredentialPayload(McpAuthMethod.OAuth, { registryId: QICHACHA_REGISTRY_ID }),
    ).toEqual({
      kind: 'oauth',
      providerId: 'qichacha',
    });
  });

  test('a local OAuth connector with no serverKey drives its own flow, not qichacha', () => {
    // The bug this guards: a hand-added OAuth server has no serverKey, and
    // falling back to qichacha sent the user to the wrong provider's login.
    expect(
      buildSaveCredentialPayload(McpAuthMethod.OAuth, { serverId: 'srv-12' }),
    ).toEqual({ kind: 'oauth', providerId: 'generic:srv-12' });
  });

  test('oauth with a serverKey and complete oauthConfig maps to a generic provider', () => {
    const cfg = { authorizeUrl: 'https://idp/a', tokenUrl: 'https://idp/t', clientId: 'c' };
    expect(
      buildSaveCredentialPayload(McpAuthMethod.OAuth, { serverKey: 'fxsk-mcp', oauthConfig: cfg }),
    ).toEqual({ kind: 'oauth', providerId: 'generic:fxsk-mcp', oauthConfig: cfg });
  });

  test('an enterprise connector with no client profile still drives its own flow — discovery, not qichacha', () => {
    // The org may leave every field to RFC 8414/9728 discovery, and the client
    // to RFC 7591 registration. The guardrail that matters is the provider id:
    // an enterprise connector must NEVER fall through to the built-in qichacha
    // entry, whatever its config looks like.
    expect(buildSaveCredentialPayload(McpAuthMethod.OAuth, { serverKey: 'fxsk-mcp' })).toEqual({
      kind: 'oauth',
      providerId: 'generic:fxsk-mcp',
    });
  });

  test('a partial client profile is passed through for discovery to complete', () => {
    const cfg = { authorizeUrl: 'https://idp/a', tokenUrl: '', clientId: 'c' };
    expect(
      buildSaveCredentialPayload(McpAuthMethod.OAuth, { serverKey: 'fxsk-mcp', oauthConfig: cfg }),
    ).toEqual({ kind: 'oauth', providerId: 'generic:fxsk-mcp', oauthConfig: cfg });
  });

  test('the built-in qichacha bundle keeps its own path (regression)', () => {
    expect(
      buildSaveCredentialPayload(McpAuthMethod.OAuth, { registryId: QICHACHA_REGISTRY_ID }),
    ).toEqual({ kind: 'oauth', providerId: 'qichacha' });
  });

  test('none returns null', () => {
    expect(buildSaveCredentialPayload(McpAuthMethod.None, {})).toBeNull();
  });
});

describe('mapProbeResultToUiState', () => {
  test('authorized returns success', () => {
    const probe: McpAuthProbeResult = {
      ok: true,
      status: 'authorized',
      latencyMs: 5,
    };
    expect(mapProbeResultToUiState(probe)).toEqual({ kind: 'success', message: 'authorized' });
  });

  test('unauthorized with HTTP 401 returns unauthorized', () => {
    const probe: McpAuthProbeResult = {
      ok: false,
      status: 'unauthorized',
      latencyMs: 5,
      error: 'HTTP 401',
    };
    expect(mapProbeResultToUiState(probe)).toEqual({ kind: 'unauthorized', message: 'HTTP 401' });
  });

  test('missing-credential returns missing-credential', () => {
    const probe: McpAuthProbeResult = {
      ok: false,
      status: 'missing-credential',
      latencyMs: 5,
      error: 'Missing credential: Authorization header',
    };
    expect(mapProbeResultToUiState(probe)).toEqual({
      kind: 'missing-credential',
      message: 'Missing credential: Authorization header',
    });
  });

  test('connect-error returns connect-error', () => {
    const probe: McpAuthProbeResult = {
      ok: false,
      status: 'connect-error',
      latencyMs: 5,
      error: 'timeout after 10000ms',
    };
    expect(mapProbeResultToUiState(probe)).toEqual({
      kind: 'connect-error',
      message: 'timeout after 10000ms',
    });
  });

  test('connect-error with HTTP 401 message is upgraded to unauthorized', () => {
    const probe: McpAuthProbeResult = {
      ok: false,
      status: 'connect-error',
      latencyMs: 5,
      error: 'HTTP 401',
    };
    expect(mapProbeResultToUiState(probe)).toEqual({ kind: 'unauthorized', message: 'HTTP 401' });
  });

  test('null probe with save error returns missing-save', () => {
    expect(mapProbeResultToUiState(null, 'save failed')).toEqual({
      kind: 'missing-save',
      message: 'save failed',
    });
  });

  test('null probe with no save error falls back to connect-error', () => {
    expect(mapProbeResultToUiState(null)).toEqual({
      kind: 'connect-error',
      message: 'probe returned no result',
    });
  });

  test('probe with no error message falls back to a sensible default', () => {
    const probe: McpAuthProbeResult = { ok: false, status: 'unauthorized', latencyMs: 1 };
    expect(mapProbeResultToUiState(probe)).toEqual({ kind: 'unauthorized', message: 'HTTP 401' });
  });
});

describe('getAuthDotClass', () => {
  test('authenticated + enabled → green', () => {
    expect(getAuthDotClass('authenticated', true)).toBe('bg-green-500');
  });

  test('authenticated + disabled → gray', () => {
    expect(getAuthDotClass('authenticated', false)).toBe('bg-gray-400');
  });

  test('auth-error → red regardless of enabled', () => {
    expect(getAuthDotClass('auth-error', true)).toBe('bg-red-500');
    expect(getAuthDotClass('auth-error', false)).toBe('bg-red-500');
  });

  test('needs-auth → orange regardless of enabled', () => {
    expect(getAuthDotClass('needs-auth', true)).toBe('bg-orange-500');
    expect(getAuthDotClass('needs-auth', false)).toBe('bg-orange-500');
  });
});

describe('oauthUsesDiscovery', () => {
  test('a complete org profile needs no discovery', () => {
    expect(
      oauthUsesDiscovery(
        { authorizeUrl: 'https://idp/a', tokenUrl: 'https://idp/t', clientId: 'c' },
        true,
      ),
    ).toBe(false);
  });

  test('an empty or partial profile does', () => {
    expect(oauthUsesDiscovery(undefined, true)).toBe(true);
    expect(oauthUsesDiscovery({ authorizeUrl: 'https://idp/a' }, true)).toBe(true);
    expect(
      oauthUsesDiscovery({ authorizeUrl: 'https://idp/a', tokenUrl: 'https://idp/t' }, true),
    ).toBe(true);
  });

  test('a connector that does not use the generic flow never claims discovery', () => {
    expect(oauthUsesDiscovery(undefined, false)).toBe(false);
  });

  test('a local server with no profile at all does use discovery', () => {
    expect(oauthUsesDiscovery(undefined, true)).toBe(true);
  });
});

describe('usesGenericOAuth', () => {
  test('every connector except the qichacha bundle runs the MCP-native flow', () => {
    expect(usesGenericOAuth({ registryId: QICHACHA_REGISTRY_ID })).toBe(false);
    expect(usesGenericOAuth({ registryId: 'figma' })).toBe(true);
    expect(usesGenericOAuth({ registryId: undefined })).toBe(true);
  });
});

describe('probeLabelKey', () => {
  test('a save failure is its own label, never "missing credential"', () => {
    // The user's 纷享销客 run: the IdP rejected the token exchange
    // ("token已下发，请勿重复下发！") and the pill said 缺少认证字段 — a field
    // they could fill that does not exist.
    expect(probeLabelKey({ kind: 'missing-save', message: 'token已下发' })).toBe('mcpAuthFailedSave');
    expect(probeLabelKey({ kind: 'missing-credential', message: 'OAuth token missing' })).toBe(
      'mcpAuthFailedMissing',
    );
  });

  test('maps every outcome to its own pill label', () => {
    expect(probeLabelKey({ kind: 'success', message: 'authorized' })).toBe('mcpAuthSuccess');
    expect(probeLabelKey({ kind: 'unauthorized', message: 'HTTP 401' })).toBe(
      'mcpAuthFailedUnauthorized',
    );
    expect(probeLabelKey({ kind: 'connect-error', message: 'ECONNREFUSED' })).toBe(
      'mcpAuthFailedConnect',
    );
  });
});

describe('showsProbeDetail', () => {
  test('every failure prints the underlying reason; success does not', () => {
    expect(showsProbeDetail({ kind: 'success', message: 'authorized' })).toBe(false);
    for (const kind of ['unauthorized', 'connect-error', 'missing-credential', 'missing-save'] as const) {
      expect(showsProbeDetail({ kind, message: 'x' })).toBe(true);
    }
  });
});
