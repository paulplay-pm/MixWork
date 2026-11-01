import { Hono } from 'hono';

import { requireAuth } from '../auth/middleware';
import { descendantsOf, scopeApi } from '../auth/scopeResolver';
import { pool } from '../db/pool';
import {
  AGENT_COLUMNS,
  type AgentRow,
  mapAgent,
} from '../models/agentMarketplaceView';
import { Role } from '../shared/enterpriseServerConstants';

export const agentMarketplaceRoutes = new Hono();
agentMarketplaceRoutes.use('/api/agent-marketplace/*', requireAuth);

/**
 * The public catalog, filtered by the caller's department scope.
 *
 * Visibility mirrors the skill marketplace (migration 038): a super admin sees
 * every enabled agent; otherwise an agent is visible iff its scope names the
 * whole company, names the caller as a member exception, or names a
 * department the caller belongs to. A grant on a department covers that
 * department's whole subtree, so granting a parent reaches its children.
 */
agentMarketplaceRoutes.get('/api/agent-marketplace', async (c) => {
  const claims = c.get('claims');
  const orgId = claims.orgId;
  const isSuperAdmin = (claims.roles ?? []).includes(Role.SuperAdmin);

  // The caller's own (leaf) department memberships.
  const callerDepts = isSuperAdmin ? [] : await scopeApi.deptIdsFor(orgId, claims.sub);
  const callerSet = new Set(callerDepts);

  // All dept paths in the org, once, to expand an agent's granted depts to
  // their subtree.
  const deptRows = await pool.query<{ id: string; path: string }>(
    `SELECT id, path FROM departments WHERE org_id = $1`, [orgId]);
  const deptPath = new Map(deptRows.rows.map((r) => [r.id, r.path]));

  const rows = await pool.query<AgentRow>(
    `SELECT ${AGENT_COLUMNS} FROM agent_marketplace_agents
      WHERE org_id = $1 AND enabled = TRUE ORDER BY agent_id`,
    [orgId],
  );

  const visible = rows.rows.filter((row) => {
    if (isSuperAdmin) return true;
    if (row.scope?.allCompany) return true;
    if ((row.scope?.userIds ?? []).includes(claims.sub)) return true;
    const grantedSubtree = descendantsOf(row.scope?.deptIds ?? [], deptPath);
    for (const d of callerSet) if (grantedSubtree.has(d)) return true;
    return false;
  });
  return c.json({ agents: visible.map(mapAgent) });
});
