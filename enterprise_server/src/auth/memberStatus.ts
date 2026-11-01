import { pool } from '../db/pool';
import { Role } from '../shared/enterpriseServerConstants';

/**
 * Is this user still an active member of their org?
 *
 * Shared by `requireActiveMember` (the LLM proxy gate) and the MCP gateway,
 * which authenticates a different token family but must apply the same
 * membership rule — two implementations would drift, and the one that drifted
 * would be the one nobody tested.
 */
export type MemberStatusResult =
  | { kind: 'missing' } // row gone → revoked / not a member
  /** Row present. `isSuperAdmin` comes from `users.extra_roles`, which is the
   *  authoritative copy at call time — a role frozen into a token would let a
   *  demoted admin keep a wide view until that token expired. */
  | { kind: 'status'; status: string; isSuperAdmin: boolean }
  | { kind: 'error' }; // DB read failed → fail open, do not revoke

export const MEMBER_STATUS_TTL_MS = 30_000;
const memberStatusCache = new Map<string, { value: MemberStatusResult; at: number }>();

function cacheFresh(
  userId: string,
  now: number,
): Extract<MemberStatusResult, { kind: 'status' }> | { kind: 'missing' } | { kind: 'error' } | null {
  const cached = memberStatusCache.get(userId);
  if (cached && now - cached.at < MEMBER_STATUS_TTL_MS) {
    return cached.value;
  }
  return null;
}

export async function resolveMemberStatus(userId: string): Promise<MemberStatusResult> {
  const now = Date.now();
  const cached = cacheFresh(userId, now);
  if (cached) return cached;

  let result: MemberStatusResult;
  try {
    const r = await pool.query<{ status: string; extra_roles: string[] | null }>(
      `SELECT status, extra_roles FROM users WHERE id = $1`,
      [userId],
    );
    const row = r.rows[0];
    result = row
      ? {
          kind: 'status',
          status: row.status,
          isSuperAdmin: (row.extra_roles ?? []).includes(Role.SuperAdmin),
        }
      : { kind: 'missing' };
  } catch {
    // Fail-open: a transient DB problem must surface as a normal proxy error
    // (and be investigated there), not as a 401 the desktop would read as
    // "revoked" and use to kick an innocent user out.
    result = { kind: 'error' };
  }
  // Cache every outcome, including 'error': a fresh TTL on the error path keeps
  // a flapping DB from stampeding on every LLM turn.
  memberStatusCache.set(userId, { value: result, at: now });
  return result;
}

// Test helper: clear the status cache between cases so a re-seeded user with a
// changed status is re-read rather than served from a stale TTL entry.
export function _resetMemberStatusCacheForTest(): void {
  memberStatusCache.clear();
}
