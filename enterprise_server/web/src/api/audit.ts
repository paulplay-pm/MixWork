/**
 * Audit endpoints.
 *
 *   GET /admin/audit?range=&from=&to=&userId=&action=&targetType=&targetId=&exclude=&page=&pageSize=
 *   GET /admin/audit/export.csv?range=&from=&to=&userId=&action=&targetType=&targetId=&exclude=
 *
 * `exclude` is a comma-separated list of action codes the server drops from the
 * list, the total, the facets' counts and the CSV alike. It is the one filter
 * that can make the page and its export disagree, so it is sent on BOTH
 * requests — filtering after the fetch would leave a file full of rows the page
 * never showed.
 *
 * There is deliberately no `orgId` parameter: the server takes the org from the
 * JWT claims, and accepting one would let any member read another org's audit
 * trail by editing a URL. Likewise no `format=csv` — the export is its own
 * route (`/admin/audit/export.csv`), mounted ahead of the `/admin/audit/*`
 * middleware so it is gated on `audit:export` rather than `audit:view`.
 *
 * `from`/`to` are sent only for `range=custom`, where the user picked both
 * days. Every other range is a key the server resolves in the org's timezone.
 */
import type { AuditRangeKey } from '../analytics/range';
// Type-only import: the mapping below is the one place the audit vocabulary
// meets the design system's, and it needs no runtime coupling to the view.
import type { BadgeTone } from '../components/Badge';
import { apiClient, buildQuery, type RawResponse } from './client';

/** Badge colouring for a row, mirroring the server's `AuditTone`
 * (`enterprise_server/src/shared/auditActionMeta.ts`). The server picks the
 * tone from the action code so the client never switches on the code itself. */
export const AuditTone = {
  Auth: 'auth',
  Success: 'success',
  Failure: 'failure',
  Change: 'change',
  Danger: 'danger',
  Normal: 'normal',
} as const;
export type AuditTone = (typeof AuditTone)[keyof typeof AuditTone];

/** `Badge` has no `auth`/`change`/`normal` tone: sign-ins and configuration
 * edits read as informational, and everything uncategorised reads as neutral.
 * `danger` keeps its own tone so revoke/disable/delete still stands out. */
export const AUDIT_BADGE_TONE: Record<AuditTone, BadgeTone> = {
  auth: 'info',
  success: 'success',
  failure: 'warning',
  change: 'info',
  danger: 'danger',
  normal: 'neutral',
};

export function badgeToneFor(tone: AuditTone): BadgeTone {
  return AUDIT_BADGE_TONE[tone] ?? 'neutral';
}

/** One row of the audit feed. Mirrors the server's `AuditListItem`. */
export interface AuditListItem {
  id: string;
  ts: string;
  user_id: string | null;
  user_name: string | null;
  action: string;
  /** Server-resolved labels, so the browser never maps action codes itself —
   * and an unregistered code is labelled as itself rather than as a blank. */
  action_zh: string;
  action_en: string;
  tone: AuditTone;
  target_type: string | null;
  target_type_zh: string | null;
  target_id: string | null;
  payload: unknown;
}

export interface AuditFacetUser {
  value: string;
  label: string;
}

export interface AuditFacetMeta {
  value: string;
  label: string;
  label_en: string;
}

/** Dropdown options, computed server-side from the rows actually in range.
 * They are NOT narrowed by the active filters — picking one must not empty the
 * others. */
export interface AuditFacets {
  users: AuditFacetUser[];
  actions: AuditFacetMeta[];
  target_types: AuditFacetMeta[];
}

export interface AuditListResponse {
  range: string;
  from: string;
  to: string;
  timezone: string;
  page: number;
  pageSize: number;
  total: number;
  items: AuditListItem[];
  facets: AuditFacets;
  /** Rows the request matched but `exclude` removed. The page renders this so
   * the default "hide model calls" is a disclosed filter, not a silent one. */
  excluded: number;
}

export interface AuditListParams {
  range: AuditRangeKey;
  /** Only meaningful with `range: 'custom'`; `YYYY-MM-DD`, both endpoints
   * inclusive. */
  from?: string;
  to?: string;
  userId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  /** Action codes to drop, sent to the server as a comma-separated list. Empty
   * list / omitted = nothing is dropped. */
  exclude?: string[];
  page?: number;
  pageSize?: number;
}

export const auditApi = {
  /** `exclude` is joined here, at the wire boundary, so the param stays a list
   * for callers and the query string carries the comma-separated spelling the
   * route documents. */
  list: (params: AuditListParams) =>
    apiClient.get<AuditListResponse>(
      `/admin/audit?${buildQuery({ ...params, exclude: params.exclude?.join(',') })}`
    ),

  /** The CSV. Paging is deliberately not forwarded — the export carries the
   * whole filtered set, so its row count is the filter's `total` and not the
   * page's length. `RawResponse` exposes `x-export-count` for the toast. */
  exportCsv: (params: Omit<AuditListParams, 'page' | 'pageSize'>): Promise<RawResponse> =>
    apiClient.getRawWithHeaders(
      `/admin/audit/export.csv?${buildQuery({ ...params, exclude: params.exclude?.join(',') })}`
    ),
};
