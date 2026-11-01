/**
 * JWT reading helpers that work in a browser.
 *
 * Must NOT use `Buffer` — it is a Node-only global that is `undefined` in the
 * browser, so `Buffer.from(..., 'base64url')` threw a `ReferenceError` on every
 * login (masked as "Sign-in failed" by LoginPage's try/catch even though the
 * POST returned 200). `atob` + `TextDecoder` work in both the browser and the
 * jsdom test environment.
 */
export function base64UrlDecode(b64url: string): string {
  // base64url -> base64 (RFC 4648 §5: swap alphabet, re-add padding)
  let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  if (pad) b64 += '='.repeat(4 - pad);
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Decode the `exp` claim (seconds, per RFC 7519) from a JWT without verifying
 * it, in milliseconds. Returns null when the payload is absent or unparseable.
 */
export function readJwtExpMs(jwt: string): number | null {
  const segments = jwt.split('.');
  if (segments.length < 2) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(segments[1])) as { exp?: number };
    if (typeof payload.exp !== 'number') return null;
    return payload.exp * 1000;
  } catch {
    return null;
  }
}
