/**
 * `error` codes the enterprise server returns in the body of a rejected
 * login, plus the two codes the desktop synthesizes locally.
 *
 * The server codes are a wire contract — keep them in sync with:
 *   - server: `enterprise_server/src/shared/enterpriseServerConstants.ts` (`LoginErrorCode`)
 *   - web console: `enterprise_server/web/src/shared/loginErrorCodes.ts`
 *
 * The server names the failure cause so the client can tell the user WHICH
 * part of the credential was wrong instead of showing a bare HTTP status.
 */
export const LoginErrorCode = {
  // --- server wire codes ---
  /** The submitted org name does not exist. */
  OrgNotFound: 'org_not_found',
  /** The username does not exist in that org. */
  UserNotFound: 'user_not_found',
  /** The username exists but the password does not match. */
  InvalidPassword: 'invalid_password',
  /** The account exists but has been disabled by an admin. */
  UserDisabled: 'user_disabled',
  /** Too many failed attempts for this org+username (HTTP 429). */
  RateLimited: 'rate_limited',
  /** The server hosts several orgs and the client did not pick one (HTTP 400). */
  OrgRequired: 'org_required',
  /** Generic failure — unknown org, unknown user, or wrong password. */
  Invalid: 'invalid',
  // --- client-side codes (never sent by the server) ---
  /** The server could not be reached at all. */
  Network: 'network',
  /** The server answered with a 5xx. */
  Server: 'server',
} as const;

export type LoginErrorCode = typeof LoginErrorCode[keyof typeof LoginErrorCode];
