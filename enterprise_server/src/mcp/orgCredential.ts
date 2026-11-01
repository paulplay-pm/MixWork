/**
 * The upstream request headers that carry the org's own key.
 *
 * Shared by the admin probe (`routes/mcpConnectors.ts`) and the gateway, so a
 * probe and a real call authenticate identically — a probe that succeeds while
 * the gateway is rejected is worse than no probe at all.
 *
 * Takes the already-decrypted config; it never touches `__enc__` ciphertext,
 * so a stored ciphertext can never be forwarded as a key.
 */
export function buildOrgCredentialHeaders(
  authMode: string,
  plainAuthConfig: Record<string, unknown>,
): Record<string, string> {
  if (authMode !== 'shared-key') return {};
  const apiKey = plainAuthConfig.apiKey;
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) return {};
  const headerName = plainAuthConfig.apiKeyHeaderName;
  if (typeof headerName === 'string' && headerName.trim().length > 0) {
    // A named header carries the key verbatim: upstreams that pick their own
    // header (X-API-Key and friends) do not want a "Bearer " prefix.
    return { [headerName.trim()]: apiKey };
  }
  return { Authorization: `Bearer ${apiKey}` };
}
