import { ConnectorAuthMode, type ConnectorSubmitRequest } from '../../../shared/mcp/constants';

/**
 * The part of 「申请连接器」 that decides what the org will be asked to review.
 *
 * A member declares the connector and how it authenticates; the org declares
 * the endpoints; the member's own credential is produced later, on their own
 * desktop, when they install it. So nothing here collects a secret — the two
 * modes whose credential belongs to the org (`shared-key`, `client-creds`) are
 * not offered at all, and `user-oauth` asks only for the public-client
 * identifiers the desktop drives a PKCE flow with.
 */

export type SubmitAuthMode =
  | 'none'
  | 'user-key'
  | 'user-oauth';

/** Modes a member may propose. `sso` stays admin-level, `shared-key` and
 *  `client-creds` need an org credential nobody at install time can supply. */
export const SUBMIT_AUTH_MODES: readonly SubmitAuthMode[] = [
  ConnectorAuthMode.None,
  ConnectorAuthMode.UserKey,
  ConnectorAuthMode.UserOauth,
];

const REQUIRED_AUTH_FIELDS: Record<SubmitAuthMode, readonly string[]> = {
  none: [],
  'user-key': [],
  // Nothing is required: the desktop discovers the provider's endpoints and
  // registers a PKCE client when the org leaves these empty (RFC 8414/9728,
  // 7591). A member who does know them can still fill them in as overrides.
  'user-oauth': [],
};

/** The fields the server's `missingAuthField` would 400 on. */
export function requiredAuthFields(mode: SubmitAuthMode): readonly string[] {
  return REQUIRED_AUTH_FIELDS[mode] ?? [];
}

export interface SubmitConnectorDraft {
  serverKey: string;
  url: string;
  nameEn: string;
  nameZh: string;
  version: string;
  categoryId: string; // '' = no category
  description: string;
  transport: 'http' | 'sse';
  authMode: SubmitAuthMode;
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
}

/** The non-secret config for the chosen mode; other modes' leftovers are dropped. */
export function buildConnectorAuthConfig(form: SubmitConnectorDraft): Record<string, unknown> {
  const authConfig: Record<string, unknown> = {};
  if (form.authMode === 'user-oauth') {
    // Only what the member actually typed: an empty string would read as a
    // configured (and broken) value instead of "discover it".
    const clientId = form.clientId.trim();
    const authorizeUrl = form.authorizeUrl.trim();
    const tokenUrl = form.tokenUrl.trim();
    if (clientId) authConfig.clientId = clientId;
    if (authorizeUrl) authConfig.authorizeUrl = authorizeUrl;
    if (tokenUrl) authConfig.tokenUrl = tokenUrl;
  }
  return authConfig;
}

/** The body of POST /admin/mcp-connectors/submissions (no orgId — the org is
 *  the caller's token). */
export function buildConnectorSubmitRequest(form: SubmitConnectorDraft): ConnectorSubmitRequest {
  const cfg: ConnectorSubmitRequest = {
    serverKey: form.serverKey.trim(),
    url: form.url.trim(),
    version: form.version.trim() || '1.0.0',
    categoryId: form.categoryId || null,
    transport: form.transport,
    authMode: form.authMode,
    authConfig: buildConnectorAuthConfig(form),
    // Minimal scope for P1: available to the whole company; the admin can
    // narrow it when the connector is published.
    scope: { allCompany: true },
  };
  if (form.nameEn.trim()) cfg.nameEn = form.nameEn.trim();
  if (form.nameZh.trim()) cfg.nameZh = form.nameZh.trim();
  if (form.description.trim()) cfg.description = form.description.trim();
  return cfg;
}
