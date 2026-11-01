import { EnterpriseApiErrorCode } from '../../shared/enterpriseAccount/constants';
import type { EnterpriseMembershipRevocationSource } from './membershipRevocation';

/**
 * A process-wide hook for the revocation handler `main.ts` builds.
 *
 * The real handler is a closure over main's live state (media scopes, account
 * generation, the config sync). Modules that are not `main.ts` — the MCP
 * gateway path is one — cannot see that closure, and importing `main.ts` would
 * be circular. So main registers here once at startup and everything else
 * calls through this bridge.
 */
type MembershipRevocationHandler = (source: EnterpriseMembershipRevocationSource) => void;

let handler: MembershipRevocationHandler | null = null;

export function setMembershipRevocationHandler(fn: MembershipRevocationHandler | null): void {
  handler = fn;
}

/**
 * Sign the member out if `code` is the server's membership-revoked code.
 *
 * Returns whether a handler ran, so a caller can log or fall through. The
 * comparison lives here so every caller passes the raw code it just read off
 * a response body without re-learning which number means what.
 */
export function handleEnterpriseMembershipRevocation(
  code: unknown,
  source: EnterpriseMembershipRevocationSource,
): boolean {
  if (code !== EnterpriseApiErrorCode.NotMember) return false;
  if (!handler) return false;
  handler(source);
  return true;
}

/** Test helper: forget the installed handler. */
export function _resetMembershipRevocationHandlerForTest(): void {
  handler = null;
}
