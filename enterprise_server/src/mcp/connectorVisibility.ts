import { descendantsOf } from '../auth/scopeResolver';
import { pool } from '../db/pool';
import type { ConnectorScope } from '../models/connectorView';

/** Who is asking. Built once per request from the caller's claims. */
export interface ConnectorCaller {
  userId: string;
  isSuperAdmin: boolean;
  deptIds: string[];
}

/**
 * May this caller see (and therefore use) this connector?
 *
 * The single implementation: the marketplace route and the MCP gateway both
 * call it, so a connector can never be listed but unusable — or, worse,
 * usable but unlisted. The check order is the marketplace's original one and
 * must stay that way; `isSuperAdmin` first is not an optimization, it is the
 * rule that a super admin is never filtered by scope.
 */
export function connectorVisibleToCaller(
  row: { scope?: ConnectorScope | null },
  caller: ConnectorCaller,
  deptPath: Map<string, string>,
): boolean {
  if (caller.isSuperAdmin) return true;
  if (row.scope?.allCompany) return true;
  if ((row.scope?.userIds ?? []).includes(caller.userId)) return true;
  // A connector granted to a parent dept is visible to any user in that dept's
  // subtree: expand the GRANTED depts to their descendants and check whether
  // the caller's own depts intersect that subtree.
  const grantedSubtree = descendantsOf(row.scope?.deptIds ?? [], deptPath);
  for (const d of caller.deptIds) if (grantedSubtree.has(d)) return true;
  return false;
}

const DEPT_PATH_TTL_MS = 30_000;
const deptPathCache = new Map<string, { value: Map<string, string>; at: number }>();

/**
 * The org's `dept id -> path` map, cached briefly.
 *
 * The gateway consults visibility on every request; an uncached read would
 * scan `departments` per call. 30 s matches the member-status window, so an
 * org restructure reaches both checks on the same cadence.
 */
export async function loadConnectorDeptPath(orgId: string): Promise<Map<string, string>> {
  const now = Date.now();
  const cached = deptPathCache.get(orgId);
  if (cached && now - cached.at < DEPT_PATH_TTL_MS) return cached.value;
  const rows = await pool.query<{ id: string; path: string }>(
    `SELECT id, path FROM departments WHERE org_id = $1`,
    [orgId],
  );
  const value = new Map(rows.rows.map((r) => [r.id, r.path]));
  deptPathCache.set(orgId, { value, at: now });
  return value;
}

// Test helper: clear the per-org cache between cases.
export function _resetConnectorDeptPathCacheForTest(): void {
  deptPathCache.clear();
}
