import { Hono } from 'hono';

import {
  queryActivities,
  queryAgentCounts,
  queryDashboardUsage,
  queryHealth,
  queryMcpCounts,
  queryUserCounts,
} from '../../analytics/dashboard';
import { UsageRange } from '../../analytics/range';
import { requireAuth, requirePermission } from '../../auth/middleware';
import { roleResolver } from '../../auth/roleResolver';
import { Role } from '../../shared/enterpriseServerConstants';
import {
  PERMISSION_POINTS,
  PermissionPoint,
  type PermissionPoint as Point,
} from '../../shared/permissionPoints';

/**
 * Two endpoints, split by permission point rather than merged into one.
 *
 * The dashboard's blocks come from two different worlds: configuration counts
 * (users, agents, connectors, health) and usage aggregates (tokens, active
 * users, rankings), and they are guarded by different points. A single merged
 * `/overview` could only answer one of those two questions for a given caller —
 * a member with `mcp:view` but no `usage:view` would get nothing at all, which
 * is the opposite of what the dashboard is for. It would also make the
 * spec's "one block failing does not take the others down" unimplementable:
 * there is only one request to fail.
 *
 * The cost is stated rather than hidden: a failure degrades a GROUP, not a
 * single card.
 */
export const adminDashboardRoutes = new Hono();

/** camelCase domain shape → the snake_case wire every other admin route uses. */
function healthItemWire(item: {
  id: string;
  kind: string;
  status: string;
  nameZh: string;
  nameEn: string;
  latencyMs: number | null;
  lastTestAt: string | null;
}): Record<string, unknown> {
  return {
    id: item.id,
    type: item.kind,
    status: item.status,
    name_zh: item.nameZh,
    name_en: item.nameEn,
    latency_ms: item.latencyMs,
    last_test_at: item.lastTestAt,
  };
}

/**
 * Run one section's query, degrading THAT section to `null` when it throws.
 *
 * The sections are independent facts, so they are fetched together — but a
 * shared `Promise.all` also makes them share a failure: one broken feed
 * answered 500 and the admin's board lost every card, which is worse than the
 * one card that was actually unusable. A missing section is already a
 * legitimate state (permission denied), so a failure reuses it — but it is
 * logged, because a silently empty section is a bug nobody ever reports.
 */
type SectionName = 'users' | 'agents' | 'mcp' | 'health' | 'activities';

async function section<T>(
  section: SectionName,
  run: (() => Promise<T>) | null,
): Promise<T | null> {
  if (!run) return null;
  try {
    return await run();
  } catch (err) {
    console.error('[Dashboard] summary section failed', { section, err });
    return null;
  }
}

adminDashboardRoutes.get('/admin/dashboard/summary', requireAuth, async c => {
  const claims = c.get('claims');
  // super_admin short-circuits the point check everywhere else too; resolving it
  // to the full set here means the trimming below has one code path.
  const points: ReadonlySet<Point> = claims.roles.includes(Role.SuperAdmin)
    ? new Set(PERMISSION_POINTS)
    : await roleResolver.pointsFor(claims.roles);
  const can = (p: Point): boolean => points.has(p);

  const canMcp = can(PermissionPoint.McpView);
  const [users, agents, mcp, health, activities] = await Promise.all([
    section('users', can(PermissionPoint.UserView) ? () => queryUserCounts(claims.orgId) : null),
    section('agents', can(PermissionPoint.AgentView) ? () => queryAgentCounts(claims.orgId) : null),
    section('mcp', canMcp ? () => queryMcpCounts(claims.orgId) : null),
    section('health', canMcp
      ? () =>
          queryHealth({
            orgId: claims.orgId,
            includeMcp: true,
            includeModel: can(PermissionPoint.ProviderView),
          })
      : null),
    section('activities', can(PermissionPoint.AuditView) ? () => queryActivities(claims.orgId) : null),
  ]);

  return c.json({
    updated_at: new Date().toISOString(),
    users,
    agents,
    mcp: mcp && {
      enabled: mcp.enabled,
      total: mcp.total,
      abnormal: mcp.abnormal,
      first_abnormal: mcp.firstAbnormal,
    },
    health: health && {
      checked_at: health.checkedAt,
      items: health.items.map(healthItemWire),
    },
    activities:
      activities &&
      activities.map((a) => ({
        id: a.id,
        ts: a.ts,
        action: a.action,
        action_zh: a.actionZh,
        action_en: a.actionEn,
        tone: a.tone,
        target_type: a.targetType,
        target_name_zh: a.targetNameZh,
        target_name_en: a.targetNameEn,
        user_id: a.userId,
        user_name: a.userName,
      })),
  });
});

adminDashboardRoutes.get(
  '/admin/dashboard/usage',
  requirePermission(PermissionPoint.UsageView),
  async c => {
    const claims = c.get('claims');
    const raw = c.req.query('range') ?? UsageRange.Last7Days;
    if (!Object.values(UsageRange).includes(raw as UsageRange)) {
      return c.json({ error: 'invalid_range' }, 400);
    }
    const r = await queryDashboardUsage({ orgId: claims.orgId, range: raw as UsageRange });
    return c.json({
      range: r.range,
      from: r.from,
      to: r.to,
      timezone: r.timezone,
      active: r.active,
      tokens: r.tokens,
      unaccounted_calls: r.unaccountedCalls,
      trend: r.trend,
      model_top: r.modelTop.map((m) => ({
        provider: m.provider,
        model: m.model,
        display_name: m.displayName,
        tokens: m.tokens,
        calls: m.calls,
      })),
      dept_top: r.deptTop.map((d) => ({
        department_id: d.departmentId,
        name: d.name,
        users: d.users,
        tokens: d.tokens,
      })),
    });
  }
);

// Referenced only for its type in the signature above; kept as a named import so
// the Hono router's overload resolution stays happy under `verbatimModuleSyntax`.
export type AdminDashboardRoutes = Hono;