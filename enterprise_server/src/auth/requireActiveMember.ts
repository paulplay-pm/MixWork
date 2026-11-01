import type { MiddlewareHandler } from 'hono';

import {
  EnterpriseApiErrorCode,
  ProviderProxyWireError,
} from '../shared/enterpriseServerConstants';
import { type Claims, verifyToken } from './jwt';
import { _resetMemberStatusCacheForTest, resolveMemberStatus } from './memberStatus';

declare module 'hono' {
  interface ContextVariableMap {
    claims: Claims;
  }
}

/**
 * LLM-proxy membership gate.
 *
 * `requireAuth` only proves the bearer token verifies (HS256, stateless). A
 * member whose `users.status` has been flipped to `disabled` — or whose row
 * was deleted — still holds a signed, unexpired JWT and would sail through
 * `requireAuth`; and because `/auth/refresh` re-signs without checking status,
 * the desktop's proactive refresh would keep renewing that JWT forever. This
 * middleware is what actually bounces a revoked member.
 *
 * It is a SEPARATE middleware applied only to the `/proxy/*` routes, not a DB
 * query inside `requireAuth`: `requireAuth` is shared by ~20 non-LLM routes
 * (`/me`, `/models`, `/usage`, admin, …) and this is the one place the
 * per-request cost matters (every LLM turn). The status lookup is a
 * `users.id` PRIMARY KEY point query, and a short TTL cache keeps it off the
 * hot path for repeat calls within a window. The cache is a bounded
 * enforcement delay, not a correctness hole: a newly-disabled member is
 * bounced on their next request once the TTL lapses (≤ 30s).
 */
/**
 * Bearer-auth + active-member gate for the LLM proxy. Emits the distinct
 * `{ error: 'not_member' }` 401 a revoked member sees — which the desktop maps
 * to a membership revocation — as opposed to the generic `unauthorized` a
 * merely-expired or invalid token sees.
 */
type NotMemberEnvelope = 'wire' | 'numeric';

/**
 * The gate body, shared by both envelopes.
 *
 * 'wire' is the historical LLM-proxy shape (`{ error: 'not_member' }`) and is
 * left exactly as it was: changing the proxy's 401 body would be a behaviour
 * change on the hot path, and the desktop reads that string.
 *
 * 'numeric' adds `code: 41602` to the SAME body, so a client that keys on
 * the number (the desktop's revocation hook does) also fires. It is additive,
 * not a replacement: the string is still there for the string-keyed readers.
 */
const activeMemberGate =
  (envelope: NotMemberEnvelope): MiddlewareHandler =>
  async (c, next) => {
    const h = c.req.header('authorization');
    if (!h?.startsWith('Bearer ')) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    let claims: Claims;
    try {
      claims = await verifyToken(h.slice(7));
    } catch {
      return c.json({ error: 'unauthorized' }, 401);
    }
    c.set('claims', claims);

    const notMember = () =>
      envelope === 'numeric'
        ? c.json(
            { error: ProviderProxyWireError.NotMember, code: EnterpriseApiErrorCode.NotMember },
            401,
          )
        : c.json({ error: ProviderProxyWireError.NotMember }, 401);

    const status = await resolveMemberStatus(claims.sub);
    if (status.kind === 'missing') {
      return notMember();
    }
    if (status.kind === 'status' && status.status !== 'active') {
      return notMember();
    }
    // 'active' or 'error' (fail-open) → proceed to the handler.
    await next();
  };

export const requireActiveMember: MiddlewareHandler = activeMemberGate('wire');

/** Same gate, but the 401 body also carries the numeric not-member code. */
export const requireActiveMemberNumeric: MiddlewareHandler = activeMemberGate('numeric');

// Test helper: kept under its historical name because existing suites import
// it; the cache it clears now lives in `auth/memberStatus.ts`.
export function _resetRequireActiveMemberCacheForTest(): void {
  _resetMemberStatusCacheForTest();
}
