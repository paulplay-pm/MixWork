/**
 * `error` codes the server returns in the body of a rejected login.
 *
 * This is a wire contract — keep the strings in sync with:
 *   - server: `enterprise_server/src/shared/enterpriseServerConstants.ts` (`LoginErrorCode`)
 *   - desktop: `src/shared/enterpriseAccount/loginErrorCodes.ts`
 *
 * The SPA maps each code to a localized message so the user learns WHICH
 * part of the credential was wrong instead of seeing a bare HTTP status.
 */
export const LoginErrorCode = {
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
} as const;
export type LoginErrorCode = typeof LoginErrorCode[keyof typeof LoginErrorCode];
