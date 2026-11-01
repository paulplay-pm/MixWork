/**
 * Usage analytics endpoints.
 *
 *   GET /admin/usage/models?range=&page=&pageSize=
 *   GET /admin/usage/users?range=&q=&sort=desc|asc&page=&pageSize=
 *   GET /admin/usage/users/:userId?range=
 *   GET /admin/usage/export.csv?range=&tab=models|users
 *
 * Every method takes the range KEY and sends it verbatim. The org is never a
 * parameter — the server reads it from the JWT claims, and honouring a
 * query-string `orgId` would let any member read another org's usage by
 * editing a URL. `from`/`to` likewise never appear here: the server resolves
 * the window in the org's timezone so the page and the CSV cannot disagree.
 *
 * The response types mirror `enterprise_server/src/analytics/usage.ts` and
 * `src/routes/admin/usage.ts` field for field (snake_case included — this is
 * the wire shape, not a domain model).
 */
import type { UsageRangeKey } from '../analytics/range';
import { apiClient, buildQuery, type RawResponse } from './client';

export interface UsageModelRow {
  provider: string;
  model: string;
  display_name: string;
  total_tokens: number;
  call_count: number;
}

export interface UsageModelsResponse {
  range: string;
  /** ISO instants bounding the window, in the org's timezone. */
  from: string;
  to: string;
  timezone: string;
  page: number;
  pageSize: number;
  total: number;
  /** Calls in range whose provider reported no token usage — the page shows
   * this as a gap notice, because the totals are known to be low. */
  unaccounted_calls: number;
  items: UsageModelRow[];
}

export interface UsageUserRow {
  user_id: string;
  username: string;
  display_name: string | null;
  department_name: string | null;
  total_tokens: number;
  last_used_at: string | null;
}

export interface UsageUsersResponse {
  range: string;
  from: string;
  to: string;
  timezone: string;
  page: number;
  pageSize: number;
  total: number;
  unaccounted_calls: number;
  items: UsageUserRow[];
}

export interface UsageUserDetailResponse {
  range: string;
  from: string;
  to: string;
  timezone: string;
  user: { user_id: string; display_name: string | null; department_name: string | null };
  /** One point per day in the range, zero days included. */
  daily: { date: string; tokens: number }[];
  by_model: { provider: string; model: string; display_name: string; tokens: number; pct: number }[];
  unaccounted_calls: number;
}

export const UsageUserSort = { Desc: 'desc', Asc: 'asc' } as const;
export type UsageUserSort = (typeof UsageUserSort)[keyof typeof UsageUserSort];

export const UsageExportTab = { Models: 'models', Users: 'users' } as const;
export type UsageExportTab = (typeof UsageExportTab)[keyof typeof UsageExportTab];

export const usageApi = {
  /** `model` is the dashboard deep link: `<provider>/<model>`, which the
   *  server uses to isolate one row regardless of which page it falls on. */
  models: (params: {
    range: UsageRangeKey;
    page?: number;
    pageSize?: number;
    model?: string;
  }) => apiClient.get<UsageModelsResponse>(`/admin/usage/models?${buildQuery(params)}`),

  users: (params: {
    range: UsageRangeKey;
    q?: string;
    sort?: UsageUserSort;
    page?: number;
    pageSize?: number;
  }) => apiClient.get<UsageUsersResponse>(`/admin/usage/users?${buildQuery(params)}`),

  userDetail: (userId: string, range: UsageRangeKey) =>
    apiClient.get<UsageUserDetailResponse>(
      `/admin/usage/users/${encodeURIComponent(userId)}?${buildQuery({ range })}`
    ),

  /**
   * The CSV. `filters` carries the users tab's `q`/`sort` so a filtered table
   * exports what is on screen — the server forwards both for exactly that
   * reason. Returns the body AND headers so the caller can read
   * `x-export-count` for the toast.
   */
  exportCsv: (
    range: UsageRangeKey,
    tab: UsageExportTab,
    filters?: { q?: string; sort?: UsageUserSort }
  ): Promise<RawResponse> =>
    apiClient.getRawWithHeaders(
      `/admin/usage/export.csv?${buildQuery({ range, tab, ...filters })}`
    ),
};
