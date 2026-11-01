// Pure helpers extracted from the McpAuthModal flow so the dispatch / mapping
// logic can be unit-tested without a DOM.
//
// This module is pure TS: no React, no DOM, no imports from the renderer store
// or services. It only depends on the shared McpAuthMethod constants and on
// the ProbeResult shape, which mirrors the shape returned by the main-process
// saveCredential / probeAuthorization IPC handlers (see
// `src/main/mcp/mcpAuthProbe.ts`).

import { McpAuthMethod, QICHACHA_REGISTRY_ID } from '../../../shared/mcp/constants';
import type { McpOAuthEndpoint } from '../../types/mcp';

export interface SaveCredentialPayloadBearer {
  kind: 'bearer';
  bearer: string;
}

export interface SaveCredentialPayloadApiKey {
  kind: 'apiKey';
  headerName: string;
  value: string;
}

export interface SaveCredentialPayloadOAuth {
  kind: 'oauth';
  providerId: string;
  /** The connector's OAuth client profile, including the redirect URI the
   *  enterprise server issued (the desktop binds its port). */
  oauthConfig?: McpOAuthEndpoint;
}

/**
 * The discriminated union of payloads the modal can submit. Kept in sync with
 * `SaveCredentialPayload` from `src/main/mcp/mcpAuthFlows.ts`. We do not import
 * that type directly because renderer files reach across process boundaries via
 * TypeScript, and the brief prefers keeping these helpers free of main-process
 * imports.
 */
export type McpAuthSaveCredentialPayload =
  | SaveCredentialPayloadBearer
  | SaveCredentialPayloadApiKey
  | SaveCredentialPayloadOAuth;

/**
 * Form-side field values collected from the auth modal. Each auth method only
 * reads the fields it cares about; the rest are ignored.
 */
export interface McpAuthFormFields {
  bearer?: string;
  headerName?: string;
  value?: string;
  /** `qichacha` marks the built-in bundle, the one connector with a bespoke
   *  login page; every other value runs the generic flow. */
  registryId?: string;
  /** The local record's id — the last-resort stable key for the generic flow
   *  when the connector has neither a catalog serverKey nor a registry id. */
  serverId?: string;
  serverKey?: string;
  oauthConfig?: McpOAuthEndpoint;
}

/**
 * Map the auth modal's `(authMethod, formFields)` to the payload the main
 * process expects, or `null` when the user shouldn't submit (authMethod 'none'
 * or a partially filled oauth form).
 */
export function buildSaveCredentialPayload(
  authMethod: McpAuthMethod,
  formFields: McpAuthFormFields,
): McpAuthSaveCredentialPayload | null {
  if (authMethod === McpAuthMethod.None) {
    return null;
  }
  if (authMethod === McpAuthMethod.Bearer) {
    const bearer = (formFields.bearer ?? '').trim();
    if (!bearer) return null;
    return { kind: 'bearer', bearer };
  }
  if (authMethod === McpAuthMethod.ApiKey) {
    const headerName = (formFields.headerName ?? '').trim();
    const value = formFields.value ?? '';
    if (!headerName || !value.trim()) return null;
    return { kind: 'apiKey', headerName, value };
  }
  if (authMethod === McpAuthMethod.OAuth) {
    // Only the built-in qichacha bundle drives a bespoke login page. Every
    // other OAuth connector — an enterprise one identified by its serverKey,
    // or a hand-added local server with neither — runs the MCP-native flow:
    // the main process discovers the provider's endpoints from the server's
    // own URL (RFC 8414/9728) and registers a public client (RFC 7591). A
    // connector with NO client profile is therefore valid, not a reason to
    // refuse the click, and must never be sent to the qichacha page.
    if (formFields.registryId === QICHACHA_REGISTRY_ID) {
      return { kind: 'oauth', providerId: QICHACHA_REGISTRY_ID };
    }
    const key =
      formFields.serverKey?.trim() ||
      formFields.serverId?.trim() ||
      formFields.registryId?.trim();
    if (!key) return null;
    const cfg = formFields.oauthConfig;
    return {
      kind: 'oauth',
      providerId: `generic:${key}`,
      ...(cfg ? { oauthConfig: cfg } : {}),
    };
  }
  return null;
}

/**
 * Does this connector run the MCP-native OAuth flow, rather than the built-in
 * qichacha login page?
 */
export function usesGenericOAuth(server: { registryId?: string | null }): boolean {
  return server.registryId !== QICHACHA_REGISTRY_ID;
}

/**
 * Does this OAuth connector rely on the main process's discovery/registration
 * (RFC 8414/9728 + 7591) to complete its client profile?
 *
 * True whenever the profile is incomplete — which is the normal shape for an
 * MCP-native provider, and for a local server with no profile at all. The
 * modal uses it to explain what the next click does.
 */
export function oauthUsesDiscovery(
  cfg: McpOAuthEndpoint | undefined,
  usesGenericFlow: boolean,
): boolean {
  if (!usesGenericFlow) return false;
  return !cfg?.authorizeUrl?.trim() || !cfg?.tokenUrl?.trim() || !cfg?.clientId?.trim();
}

/**
 * Mirrors `ProbeResult` from `src/main/mcp/mcpAuthProbe.ts`.
 *
 * Kept structurally compatible (and loosely typed so the renderer can fall
 * through to a generic `connect-error` when the main process returns something
 * unexpected).
 */
export interface McpAuthProbeResult {
  ok: boolean;
  status: 'authorized' | 'unauthorized' | 'connect-error' | 'missing-credential';
  latencyMs: number;
  serverInfo?: { name: string; version?: string };
  error?: string;
}

/**
 * The discriminated union the modal renders as the result pill.
 * - `success` — green pill, modal auto-closes after a brief delay.
 * - `unauthorized` — red pill ("check your token"), keep modal open with Retry.
 * - `connect-error` — red pill ("connection failed"), keep modal open with Retry.
 * - `missing-credential` — red pill ("missing field"), keep modal open with Retry.
 * - `missing-save` — red pill ("save failed before probe"), keep modal open with Retry.
 */
export type McpAuthUiState =
  | { kind: 'success'; message: string }
  | { kind: 'unauthorized'; message: string }
  | { kind: 'connect-error'; message: string }
  | { kind: 'missing-credential'; message: string }
  | { kind: 'missing-save'; message: string };

const UNAUTHORIZED_PREFIXES = ['HTTP 401', 'HTTP 403'] as const;
const MISSING_CREDENTIAL_PREFIXES = [
  'Missing credential',
  'OAuth token missing',
  'Missing URL',
  'Missing command',
] as const;

function startsWithAny(text: string, prefixes: ReadonlyArray<string>): boolean {
  return prefixes.some((prefix) => text.startsWith(prefix));
}

/**
 * Decide which UI pill the modal should show.
 *
 * Priority order:
 * 1. `saveError` set → `missing-save` (the probe never ran).
 * 2. probe.status `unauthorized` → `unauthorized`.
 * 3. probe.status `missing-credential` → `missing-credential`.
 * 4. probe.status `connect-error` (or probe.ok === false) → `connect-error`.
 * 5. probe.status `authorized` (or probe.ok === true) → `success`.
 * 6. fall-through → `connect-error`.
 */
export function mapProbeResultToUiState(
  probeResult: McpAuthProbeResult | null | undefined,
  saveError?: string | null,
): McpAuthUiState {
  if (saveError) {
    return { kind: 'missing-save', message: saveError };
  }
  if (!probeResult) {
    return { kind: 'connect-error', message: 'probe returned no result' };
  }
  if (probeResult.status === 'authorized') {
    return { kind: 'success', message: 'authorized' };
  }
  if (probeResult.status === 'unauthorized') {
    return { kind: 'unauthorized', message: probeResult.error ?? 'HTTP 401' };
  }
  if (probeResult.status === 'missing-credential') {
    return { kind: 'missing-credential', message: probeResult.error ?? 'missing credential' };
  }
  // `connect-error` or any unexpected shape falls here.
  const error = probeResult.error ?? 'connect-error';
  if (startsWithAny(error, UNAUTHORIZED_PREFIXES)) {
    return { kind: 'unauthorized', message: error };
  }
  if (startsWithAny(error, MISSING_CREDENTIAL_PREFIXES)) {
    return { kind: 'missing-credential', message: error };
  }
  return { kind: 'connect-error', message: error };
}

/**
 * Which i18n key labels a probe outcome.
 *
 * `missing-save` is its own label on purpose: it means the flow never produced
 * a credential at all (discovery failed, the IdP refused the token exchange),
 * not that a field the user could fill is empty. Reusing "missing credential"
 * for it told the user the wrong thing — a 纷享销客 token-exchange rejection
 * ("token已下发，请勿重复下发！") was reported as a missing field.
 */
export function probeLabelKey(state: McpAuthUiState): string {
  switch (state.kind) {
    case 'success':
      return 'mcpAuthSuccess';
    case 'unauthorized':
      return 'mcpAuthFailedUnauthorized';
    case 'missing-credential':
      return 'mcpAuthFailedMissing';
    case 'missing-save':
      return 'mcpAuthFailedSave';
    default:
      return 'mcpAuthFailedConnect';
  }
}

/** Should the pill also print the underlying message? Always for failures: the
 *  main process's reason (an IdP error, an HTTP status) is the only thing that
 *  makes a failed authorization diagnosable. */
export function showsProbeDetail(state: McpAuthUiState): boolean {
  return state.kind !== 'success';
}

/**
 * Compute the Tailwind color class for the auth-status dot on a card. Pure
 * helper so the McpManager renderer doesn't need to inline this branch tree.
 *
 * Returns `null` when no dot should be rendered (e.g. unauthenticated and not
 * enabled, which is the rest state and already reads "off").
 */
export function getAuthDotClass(
  authStatus: 'authenticated' | 'needs-auth' | 'auth-error',
  enabled: boolean,
): string | null {
  if (authStatus === 'authenticated') {
    return enabled ? 'bg-green-500' : 'bg-gray-400';
  }
  if (authStatus === 'auth-error') {
    return 'bg-red-500';
  }
  // needs-auth
  return 'bg-orange-500';
}
