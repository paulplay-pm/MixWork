import { useQuery } from '@tanstack/react-query';
import { Download, Info } from 'lucide-react';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { formatOrgDateTime } from '../analytics/datetime';
import type { AuditRangeKey } from '../analytics/range';
import { rangeOptionLabel } from '../analytics/range';
import { auditApi, type AuditFacets, type AuditListItem, badgeToneFor } from '../api/audit';
import { filenameFromDisposition } from '../api/client';
import { useAuth } from '../auth/useAuth';
import { usePermissions } from '../auth/usePermissions';
import { Pager } from '../components/analytics/Pager';
import { PayloadModal } from '../components/analytics/PayloadModal';
import { RangeSelect } from '../components/analytics/RangeSelect';
import { Badge } from '../components/Badge';
import { type Column, DataTable } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/toastStore';
import { getLang, t } from '../i18n';
import { AuditAction } from '../shared/auditActionMeta';
import { PermissionPoint } from '../shared/permissions';

/** Per spec §6.3, and the server's own default for `pageSize`. */
const PAGE_SIZE = 15;

/** Where the table shows an em dash for "none". An empty cell reads as "the
 *  export lost this" rather than "there is nothing here" — the CSV makes the
 *  same call with the same character. */
const NONE = '—';

/** Cell width for the payload summary. Long enough to be read at a glance,
 *  short enough that the object ID stays on screen. */
const PAYLOAD_SUMMARY_CHARS = 60;

/** The four list filters. They stack: narrowing by action then by user is the
 *  normal way to read this table, so each one is sent and none is folded into
 *  another. */
interface Filters {
  userId: string;
  action: string;
  targetType: string;
  targetId: string;
}

const NO_FILTERS: Filters = { userId: '', action: '', targetType: '', targetId: '' };

/** Rendered before the first response lands. */
const NO_FACETS: AuditFacets = { users: [], actions: [], target_types: [] };

export function AuditPage(): JSX.Element {
  const { claims } = useAuth();
  const { hasPermission } = usePermissions();
  const toast = useToast();
  const orgId = claims?.orgId ?? 'default-org';
  // The route is gated on `audit:view`; the export is a separate point, so a
  // read-only auditor is not offered a button that would 403 on click.
  const canExport = hasPermission(PermissionPoint.AuditExport);

  // Deep link from the dashboard's 最近动态: `?userId=&from=&to=` narrows the
  // list to the one actor and the one day the reader clicked. `custom` is the
  // only range that carries explicit days, so a from/to pair without it would
  // be silently ignored by the request.
  const [params] = useSearchParams();
  const linkUserId = params.get('userId') ?? '';
  const linkFrom = params.get('from') ?? '';
  const linkTo = params.get('to') ?? '';

  const [range, setRange] = useState<AuditRangeKey>(
    linkUserId && linkFrom && linkTo ? 'custom' : '7d'
  );
  const [from, setFrom] = useState(linkFrom);
  const [to, setTo] = useState(linkTo);
  const [filters, setFilters] = useState<Filters>({ ...NO_FILTERS, userId: linkUserId });
  // The one filter the page starts with. Model calls are written for every
  // proxied request and the gateway streams essentially all enterprise traffic,
  // so an unfiltered feed is a wall of 「调用模型服务商」 with the SSO failures and
  // key revocations an admin came for somewhere below the fold. The rows are
  // still on the server — the checkbox puts them back, and they are still
  // exportable — this is only about making the DEFAULT view readable.
  const [hideModelCalls, setHideModelCalls] = useState(true);
  const [page, setPage] = useState(1);
  const [payloadFor, setPayloadFor] = useState<AuditListItem | null>(null);
  // Held across refetches. The facet selects are the page's only route to a
  // second and third filter, so a dropdown that emptied itself while its own
  // request was in flight would take those filters with it — and the server
  // computes facets from the rows in range, NOT from the active filters, so
  // the previous set is still the correct set. Keeping the last non-empty
  // value costs one render of staleness and saves the user a reload.
  const [facets, setFacets] = useState<AuditFacets>(NO_FACETS);

  // Derived once and shared by the list and the export, so the two cannot drift
  // apart: a CSV taken with model calls hidden must hold exactly the rows the
  // page was showing. `undefined` = nothing excluded.
  const exclude = hideModelCalls ? [AuditAction.ProviderCall] : undefined;

  const auditQuery = useQuery({
    queryKey: [
      'audit',
      orgId,
      range,
      from,
      to,
      filters.userId,
      filters.action,
      filters.targetType,
      filters.targetId,
      hideModelCalls,
      page,
    ],
    queryFn: () =>
      auditApi.list({
        range,
        // Only `custom` carries dates; every other key is resolved by the
        // server in the org's own timezone.
        from: range === 'custom' && from ? from : undefined,
        to: range === 'custom' && to ? to : undefined,
        userId: filters.userId || undefined,
        action: filters.action || undefined,
        targetType: filters.targetType || undefined,
        targetId: filters.targetId || undefined,
        exclude,
        page,
        pageSize: PAGE_SIZE,
      }),
  });

  const data = auditQuery.data;
  useEffect(() => {
    if (!data?.facets) return;
    // A refetch leaves `data` undefined for a tick (new query key, nothing
    // cached), which would blank every dropdown. Only overwrite once a real
    // response has arrived.
    setFacets(data.facets);
  }, [data]);

  // Facets come back on the same response as the rows, computed from what is
  // in range. They are deliberately NOT narrowed by the active filters — a
  // dropdown that emptied itself as you narrowed would leave you unable to
  // widen back without clearing everything first.
  const userFacets = facets.users;
  const actionFacets = facets.actions;
  const typeFacets = facets.target_types;
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Page 4 of the previous result set has no meaning in the new one, so every
  // filter and range change lands back on page 1. One helper, so the two paths
  // cannot drift apart.
  const applyFilter = (patch: Partial<Filters>): void => {
    setFilters((prev) => ({ ...prev, ...patch }));
    setPage(1);
  };

  const applyRange = (next: AuditRangeKey): void => {
    setRange(next);
    setPage(1);
    setPayloadFor(null);
  };

  const applyRangeDate = (setter: (v: string) => void) => (value: string): void => {
    setter(value);
    setPage(1);
  };

  const exportCsv = async (): Promise<void> => {
    try {
      const { text, headers } = await auditApi.exportCsv({
        range,
        from: range === 'custom' && from ? from : undefined,
        to: range === 'custom' && to ? to : undefined,
        userId: filters.userId || undefined,
        action: filters.action || undefined,
        targetType: filters.targetType || undefined,
        targetId: filters.targetId || undefined,
        exclude,
      });
      const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // The route names the file deliberately (`7d-审计记录.csv`) and the range
      // key in it is what makes an archived file self-describing; a
      // client-invented name drifts the moment either side changes.
      a.download = filenameFromDisposition(headers, `audit-${range}.csv`);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      // Both headers, always. The server caps an export at 10,000 rows, so a
      // file holding 10,000 out of 12,000 matches must not read as complete —
      // `x-export-count` is what was written, `x-export-total` is what the
      // query matched.
      const count = Number(headers.get('x-export-count'));
      const exportTotal = Number(headers.get('x-export-total') ?? headers.get('x-export-count'));
      const safeCount = Number.isFinite(count) ? count : exportTotal;
      const safeTotal = Number.isFinite(exportTotal) ? exportTotal : safeCount;
      if (safeCount < safeTotal) {
        toast.error(
          t('analytics.audit.toast.capped')
            .replace('{count}', String(safeCount))
            .replace('{total}', String(safeTotal))
        );
      } else {
        toast.success(
          t('analytics.audit.toast.exported')
            .replace('{count}', String(safeCount))
            .replace('{total}', String(safeTotal))
        );
      }
    } catch (e) {
      toast.error(t('analytics.audit.toast.failed').replace('{error}', (e as Error).message));
    }
  };

  const selectClass =
    'rounded-[var(--radius-md)] border border-[var(--border-default)] bg-white px-2 py-1 text-xs text-[var(--text-primary)] focus:border-[var(--accent-primary)] focus:outline-none';

  const columns: Column<AuditListItem>[] = [
    {
      key: 'ts',
      header: t('analytics.audit.col.time'),
      render: (r) => (
        <span className="text-xs tabular-nums text-[var(--text-secondary)]">{formatOrgDateTime(r.ts, data?.timezone)}</span>
      ),
    },
    {
      key: 'user_name',
      header: t('analytics.audit.col.user'),
      // The NAME, or an em dash. `user_id` exists for filtering and must never
      // reach this cell: a failed SSO sign-in has no user at all, and falling
      // back to the id would put a UUID where a reader expects a person.
      render: (r) => (
        <span className="text-xs text-[var(--text-primary)]">{r.user_name ?? NONE}</span>
      ),
    },
    {
      key: 'action',
      header: t('analytics.audit.col.action'),
      // Labels and tone are resolved server-side, so an unregistered action
      // code still reads as itself instead of as a blank cell. The badge
      // carries text, so colour is never the only signal (spec §6).
      render: (r) => (
        <Badge tone={badgeToneFor(r.tone)}>{getLang() === 'zh' ? r.action_zh : r.action_en}</Badge>
      ),
    },
    {
      key: 'target_type_zh',
      header: t('analytics.audit.col.targetType'),
      render: (r) => (
        <span className="text-xs text-[var(--text-secondary)]">{r.target_type_zh ?? NONE}</span>
      ),
    },
    {
      key: 'target_id',
      header: t('analytics.audit.col.targetId'),
      render: (r) => (
        <span className="font-mono text-xs text-[var(--text-secondary)]">{r.target_id ?? NONE}</span>
      ),
    },
    {
      key: 'payload',
      header: t('analytics.audit.col.payload'),
      render: (r) => {
        // No payload is not an empty button: there is nothing to open.
        if (r.payload === null || r.payload === undefined) {
          return <span className="text-xs text-[var(--text-tertiary)]">{NONE}</span>;
        }
        const json = JSON.stringify(r.payload);
        const summary =
          json.length > PAYLOAD_SUMMARY_CHARS
            ? `${json.slice(0, PAYLOAD_SUMMARY_CHARS)}…`
            : json;
        return (
          // The cell opens the modal for the row ALREADY in memory — no
          // refetch, so the summary here and the detail there are the same
          // object and cannot disagree.
          <button
            type="button"
            aria-label={t('analytics.audit.payload.view')}
            title={summary}
            onClick={() => setPayloadFor(r)}
            className="max-w-[240px] truncate rounded-[var(--radius-sm)] px-1 py-0.5 text-left font-mono text-xs text-[var(--accent-primary)] hover:bg-[var(--bg-hover)] hover:underline"
          >
            {summary}
          </button>
        );
      },
    },
  ];

  return (
    <div className="p-8">
      <PageHeader
        title={t('analytics.audit.title')}
        subtitle={t('analytics.audit.subtitle')}
        actions={
          <>
            <RangeSelect value={range} onChange={(k) => applyRange(k as AuditRangeKey)} allowCustom />
            {canExport && (
              <button
                type="button"
                onClick={() => void exportCsv()}
                className="flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--border-default)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
              >
                <Download className="h-3.5 w-3.5" />
                {t('analytics.audit.export')}
              </button>
            )}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
          {t('analytics.audit.filter.user')}
          <select
            aria-label={t('analytics.audit.filter.user')}
            className={selectClass}
            value={filters.userId}
            onChange={(e) => applyFilter({ userId: e.target.value })}
          >
            <option value="">{t('analytics.audit.filter.userAll')}</option>
            {userFacets.map((u) => (
              <option key={u.value} value={u.value}>
                {u.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
          {t('analytics.audit.filter.action')}
          <select
            aria-label={t('analytics.audit.filter.action')}
            className={selectClass}
            value={filters.action}
            onChange={(e) => applyFilter({ action: e.target.value })}
          >
            <option value="">{t('analytics.audit.filter.actionAll')}</option>
            {actionFacets.map((a) => (
              <option key={a.value} value={a.value}>
                {getLang() === 'zh' ? a.label : a.label_en}
              </option>
            ))}
          </select>
        </label>

        <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--text-secondary)]">
          <input
            type="checkbox"
            checked={hideModelCalls}
            onChange={(e) => {
              setHideModelCalls(e.target.checked);
              setPage(1);
            }}
            className="h-3.5 w-3.5 accent-[var(--accent-primary)]"
          />
          {t('analytics.audit.filter.hideProviderCalls')}
        </label>

        <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
          {t('analytics.audit.filter.targetType')}
          <select
            aria-label={t('analytics.audit.filter.targetType')}
            className={selectClass}
            value={filters.targetType}
            onChange={(e) => applyFilter({ targetType: e.target.value })}
          >
            <option value="">{t('analytics.audit.filter.targetTypeAll')}</option>
            {typeFacets.map((tp) => (
              <option key={tp.value} value={tp.value}>
                {getLang() === 'zh' ? tp.label : tp.label_en}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
          {t('analytics.audit.filter.targetId')}
          <input
            type="search"
            aria-label={t('analytics.audit.filter.targetId')}
            placeholder={t('analytics.audit.filter.targetIdHint')}
            title={t('analytics.audit.filter.targetIdHint')}
            value={filters.targetId}
            onChange={(e) => applyFilter({ targetId: e.target.value })}
            className="w-44 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-white px-2 py-1 font-mono text-xs text-[var(--text-primary)] placeholder:font-sans placeholder:text-[var(--text-tertiary)] focus:border-[var(--accent-primary)] focus:outline-none"
          />
        </label>

        {range === 'custom' && (
          <>
            <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
              {t('analytics.audit.range.from')}
              <input
                type="date"
                aria-label={t('analytics.audit.range.from')}
                value={from}
                onChange={(e) => applyRangeDate(setFrom)(e.target.value)}
                className="rounded-[var(--radius-md)] border border-[var(--border-default)] bg-white px-2 py-1 text-xs text-[var(--text-primary)] focus:border-[var(--accent-primary)] focus:outline-none"
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
              {t('analytics.audit.range.to')}
              <input
                type="date"
                aria-label={t('analytics.audit.range.to')}
                value={to}
                onChange={(e) => applyRangeDate(setTo)(e.target.value)}
                className="rounded-[var(--radius-md)] border border-[var(--border-default)] bg-white px-2 py-1 text-xs text-[var(--text-primary)] focus:border-[var(--accent-primary)] focus:outline-none"
              />
            </label>
          </>
        )}
      </div>

      {data && data.excluded > 0 && (
        // Disclosed, not silent: the server reports how many matched rows the
        // exclusion removed, and this strip says so. Without it the checkbox
        // above would be a filter the reader can only discover by knowing it is
        // there. Deliberately neutral (see GapNotice): nothing is broken, the
        // data is deliberately out of view.
        <div className="mb-4 flex items-start gap-2 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-3 py-2">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)]" />
          <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
            {t('analytics.audit.hidden').replace('{count}', String(data.excluded))}
          </p>
        </div>
      )}

      {auditQuery.isLoading ? (
        <div className="text-sm text-[var(--text-secondary)]">{t('common.loading')}</div>
      ) : auditQuery.isError ? (
        // Not the empty state: "no audit records" would be a claim about the
        // org's history, and we failed to fetch it.
        <div className="text-sm text-[var(--text-secondary)]">{t('common.error')}</div>
      ) : (data?.items.length ?? 0) === 0 ? (
        <EmptyState title={t('analytics.audit.empty')} />
      ) : (
        <div className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--border-subtle)]">
          <DataTable columns={columns} rows={data?.items ?? []} />
        </div>
      )}

      {data && (
        <Pager
          page={page}
          pageCount={pageCount}
          onChange={setPage}
          // From `total`, never from `rows.length`: the footer has to agree with
          // what the CSV exports, and the CSV holds every match.
          summary={t('analytics.audit.footer')
            .replace('{count}', String(total))
            .replace('{range}', rangeOptionLabel(range))}
        />
      )}

      {payloadFor && (
        <PayloadModal
          item={payloadFor}
          timezone={data?.timezone}
          onClose={() => setPayloadFor(null)}
        />
      )}
    </div>
  );
}