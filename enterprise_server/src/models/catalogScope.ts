import { pool } from '../db/pool';

/**
 * Authorization scope shared by the org catalogs (skills, kits, connectors,
 * agents).
 *
 * A scope is a GRANT, never a deny: a caller sees a catalog entry when the
 * scope names the whole company, names the caller as a member exception, or
 * names a department the caller belongs to (a grant on a department covers its
 * whole subtree — granting the parent reaches the children).
 */
export interface CatalogScope {
  allCompany: boolean;
  deptIds: string[];
  userIds: string[];
}

/** A scope that grants nothing (visible to super admins only). */
export function emptyScope(): CatalogScope {
  return { allCompany: false, deptIds: [], userIds: [] };
}

/** True when the scope grants nothing at all. */
export function isEmptyScope(scope: CatalogScope | null | undefined): boolean {
  if (!scope) return true;
  return !scope.allCompany
    && (scope.deptIds?.length ?? 0) === 0
    && (scope.userIds?.length ?? 0) === 0;
}

/** Compact display string for a scope. */
export function scopeSummary(scope: CatalogScope): string {
  if (scope.allCompany) return 'all';
  const d = scope.deptIds?.length ?? 0;
  const u = scope.userIds?.length ?? 0;
  if (d === 0 && u === 0) return 'none';
  return `depts:${d}` + (u ? `,users:${u}` : '');
}

/**
 * Drop dept/user ids that do not exist in the org; keep allCompany.
 *
 * A client cannot widen its grant by naming a department or a user from
 * another org, and it cannot grant to a user that was deleted.
 */
export async function sanitizeCatalogScope(
  scope: CatalogScope,
  orgId: string,
): Promise<CatalogScope> {
  const deptIds = scope.deptIds ?? [];
  const userIds = scope.userIds ?? [];
  const deptR = deptIds.length
    ? await pool.query<{ id: string }>(
      'SELECT id FROM departments WHERE org_id = $1 AND id = ANY($2)', [orgId, deptIds])
    : { rows: [] as { id: string }[] };
  const userR = userIds.length
    ? await pool.query<{ id: string }>(
      'SELECT id FROM users WHERE org_id = $1 AND id = ANY($2)', [orgId, userIds])
    : { rows: [] as { id: string }[] };
  return {
    allCompany: scope.allCompany,
    deptIds: deptR.rows.map((r) => r.id),
    userIds: userR.rows.map((r) => r.id),
  };
}
