/**
 * Dashboard endpoints.
 *
 *   GET /admin/dashboard/summary
 *   GET /admin/dashboard/usage?range=today|7d|30d|this_month|last_month
 *
 * The response types mirror `enterprise_server/src/routes/admin/dashboard.ts`
 * field for field — snake_case included, because that is the wire shape and not
 * a domain model. Every section is `| null` when the caller lacks the
 * permission point that guards it; the server trims, so a null here means
 * "not permitted", never "zero" and never "not loaded yet".
 *
 * `summary` takes no parameters at all — the org comes from the JWT, and it
 * does not vary with the page's range selector (users, agents, connectors and
 * health are point-in-time facts). `usage` sends the range KEY verbatim for the
 * same reason `api/usage.ts` does: the server resolves the window in the org's
 * timezone, so the dashboard and the usage page cannot disagree about which
 * days a range covers.
 */
import type { UsageRangeKey } from '../analytics/range';
import { apiClient, buildQuery } from './client';

export interface DashboardUserCounts {
  total: number;
  enabled: number;
  disabled: number;
}

export interface DashboardAgentCounts {
  enabled: number;
  total: number;
}

export interface DashboardMcpCounts {
  enabled: number;
  total: number;
  /** Enabled connectors whose last manual test failed. Counted over all of
   *  them, not over the six rows the health list shows. */
  abnormal: number;
  first_abnormal: string | null;
}

export type DashboardHealthStatus = 'ok' | 'warn' | 'err' | 'unknown';

export interface DashboardHealthItem {
  id: string;
  type: 'model' | 'mcp';
  status: DashboardHealthStatus;
  name_zh: string;
  name_en: string;
  latency_ms: number | null;
  last_test_at: string | null;
}

export interface DashboardHealthBlock {
  /** Newest probe among the rows this caller may see. */
  checked_at: string | null;
  items: DashboardHealthItem[];
}

export interface DashboardActivity {
  id: string;
  ts: string;
  action: string;
  action_zh: string;
  action_en: string;
  tone: 'auth' | 'success' | 'failure' | 'change' | 'danger' | 'normal';
  target_type: string | null;
  target_name_zh: string | null;
  target_name_en: string | null;
  /** null = a system action; the label comes from the dashboard dictionary. */
  user_id: string | null;
  user_name: string | null;
}

export interface DashboardSummaryResponse {
  updated_at: string;
  users: DashboardUserCounts | null;
  agents: DashboardAgentCounts | null;
  mcp: DashboardMcpCounts | null;
  health: DashboardHealthBlock | null;
  activities: DashboardActivity[] | null;
}

export interface DashboardUsageTotals {
  value: number;
  prev: number;
}

export interface DashboardTrendPoint {
  key: string;
  label: string;
  tokens: number;
  calls: number;
}

export interface DashboardTrend {
  granularity: 'hour' | 'day';
  points: DashboardTrendPoint[];
}

export interface DashboardModelUsageRow {
  provider: string;
  model: string;
  display_name: string;
  tokens: number;
  calls: number;
}

export interface DashboardDeptUsageRow {
  /** null = the member has no department; `name` is null too and the label
   *  comes from the dashboard dictionary. */
  department_id: string | null;
  name: string | null;
  users: number;
  tokens: number;
}

export interface DashboardUsageResponse {
  range: string;
  from: string;
  to: string;
  timezone: string;
  active: DashboardUsageTotals;
  tokens: DashboardUsageTotals;
  /** Calls in range whose provider reported no token usage, so the totals
   *  beside them are known to be low. Mirrors the usage page's gap notice. */
  unaccounted_calls: number;
  trend: DashboardTrend;
  model_top: DashboardModelUsageRow[];
  dept_top: DashboardDeptUsageRow[];
}

export const dashboardApi = {
  summary: () => apiClient.get<DashboardSummaryResponse>('/admin/dashboard/summary'),
  usage: (range: UsageRangeKey) =>
    apiClient.get<DashboardUsageResponse>(`/admin/dashboard/usage?${buildQuery({ range })}`),
};