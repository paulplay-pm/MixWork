import { Hono } from 'hono';

import { requireAuth } from '../auth/middleware';
import { scopeApi } from '../auth/scopeResolver';
import { pool } from '../db/pool';
import {
  type ConnectorCaller,
  connectorVisibleToCaller,
  loadConnectorDeptPath,
} from '../mcp/connectorVisibility';
import {
  COLUMNS,
  type ConnectorRow,
  mapPublicConnector,
} from '../models/connectorView';
import { Role } from '../shared/enterpriseServerConstants';

export const mcpMarketplaceRoutes = new Hono();
mcpMarketplaceRoutes.use('/api/mcp-marketplace', requireAuth);

mcpMarketplaceRoutes.get('/api/mcp-marketplace', async (c) => {
  const claims = c.get('claims');
  const orgId = claims.orgId;
  const isSuperAdmin = (claims.roles ?? []).includes(Role.SuperAdmin);

  // The caller's own (leaf) department memberships + the org's dept paths.
  // Both go through `connectorVisibility` so the gateway applies the identical
  // rule (it uses the same cached path map).
  const caller: ConnectorCaller = {
    userId: claims.sub,
    isSuperAdmin,
    deptIds: isSuperAdmin ? [] : await scopeApi.deptIdsFor(orgId, claims.sub),
  };
  const deptPath = await loadConnectorDeptPath(orgId);

  const r = await pool.query<ConnectorRow>(
    `SELECT ${COLUMNS} FROM mcp_connectors WHERE org_id = $1 AND enabled = TRUE`, [orgId]);

  const visible = r.rows.filter((row) => connectorVisibleToCaller(row, caller, deptPath));

  const catIds = Array.from(new Set(visible.map((v) => v.category_id).filter(Boolean))) as string[];
  const cats = catIds.length === 0
    ? { rows: [] as { id: string; name: string }[] }
    : await pool.query<{ id: string; name: string }>(
        `SELECT id, name FROM mcp_connector_categories WHERE org_id = $1 AND id = ANY($2) ORDER BY name`,
        [orgId, catIds]);

  return c.json({
    categories: cats.rows.map((cat) => ({ id: cat.id, name_zh: cat.name, name_en: cat.name })),
    servers: visible.map(mapPublicConnector),
  });
});
