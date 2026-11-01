import { useQuery } from '@tanstack/react-query';
import { Download, Search } from 'lucide-react';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { formatOrgDateTimeShort } from '../analytics/datetime';
import { rangeOptionLabel, USAGE_RANGE_KEYS, type UsageRangeKey } from '../analytics/range';
import { filenameFromDisposition } from '../api/client';
import {
  usageApi,
  UsageExportTab,
  type UsageModelRow,
  type UsageUserRow,
  UsageUserSort,
} from '../api/usage';
import { useAuth } from '../auth/useAuth';
import { usePermissions } from '../auth/usePermissions';
import { GapNotice } from '../components/analytics/GapNotice';
import { MemberAvatar } from '../components/analytics/MemberAvatar';
import { Pager } from '../components/analytics/Pager';
import { RangeSelect } from '../components/analytics/RangeSelect';
import { UsageDrawer } from '../components/analytics/UsageDrawer';
import { type Column, DataTable } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { Tabs } from '../components/Tabs';
import { useToast } from '../components/toastStore';
import { t } from '../i18n';
import { PermissionPoint } from '../shared/permissions';

/** Which panel is showing. */
export const UsageTab = { Models: 'models', Users: 'users' } as const;
export type UsageTab = (typeof UsageTab)[keyof typeof UsageTab];

/** Server-side paging: 50 model rows (spec §5.4) and 8 member rows (spec §6.2). */
const MODEL_PAGE_SIZE = 50;
const USER_PAGE_SIZE = 8;

/** Long enough to skip the intermediate keystrokes, short enough that the
 *  first result lands while the user is still looking at the input. */
const SEARCH_DEBOUNCE_MS = 300;

/** `DataTable` keys rows by `id`; the wire row identifies a model by the
 * provider/model pair, because a built-in and a custom provider key can share
 * a model slug. */
type ModelRow = UsageModelRow & { id: string };
/** The users table keys by user id — one row per member, no merge involved. */
type UserRow = UsageUserRow & { id: string };

export function UsagePage(): JSX.Element {
  const { claims } = useAuth();
  const { hasPermission } = usePermissions();
  const toast = useToast();
  const orgId = claims?.orgId ?? 'default-org';
  // The route is gated on `usage:export`; a caller without it would get a
  // permanently failing button, so the affordance is not offered at all.
  const canExport = hasPermission(PermissionPoint.UsageExport);

  // Deep link from the dashboard: `?range=` carries the window the reader was
  // looking at, and `?model=` names the row they clicked. An unknown range
  // falls back to the default rather than throwing — a stale bookmark should
  // land on a working page, not an error boundary.
  const [params] = useSearchParams();
  const initialRange = USAGE_RANGE_KEYS.includes(params.get('range') as UsageRangeKey)
    ? (params.get('range') as UsageRangeKey)
    : '7d';
  const initialModel = params.get('model');

  const [range, setRange] = useState<UsageRangeKey>(initialRange);
  const [model, setModel] = useState<string | undefined>(initialModel ?? undefined);
  const [tab, setTab] = useState<UsageTab>(initialModel ? UsageTab.Models : UsageTab.Users);
  const [page, setPage] = useState(1);
  // The search box is uncontrolled-by-query: `search` is what the input holds
  // and `committedQ` is what the request carries, so typing does not fire a
  // query per keystroke.
  const [search, setSearch] = useState('');
  const [committedQ, setCommittedQ] = useState('');
  const [sort, setSort] = useState<UsageUserSort>(UsageUserSort.Desc);
  // The member drawer reads this. The state lives here so the range and tab
  // handlers can close it in one place: a drawer left open across a range
  // switch would be showing yesterday's numbers under today's heading
  // (spec §4.1.1).
  const [drawerUserId, setDrawerUserId] = useState<string | null>(null);

  // A new search or a new sort invalidates the current page number: page 4 of
  // the old result set has no meaning in the new one. Both land in this one
  // effect so the two paths cannot drift apart.
  useEffect(() => {
    const id = setTimeout(() => {
      setCommittedQ(search.trim());
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [search]);

  const modelsQuery = useQuery({
    queryKey: ['usage', 'models', orgId, range, page, model],
    queryFn: () => usageApi.models({ range, page, pageSize: MODEL_PAGE_SIZE, model }),
    enabled: tab === UsageTab.Models,
  });

  const usersQuery = useQuery({
    queryKey: ['usage', 'users', orgId, range, committedQ, sort, page],
    queryFn: () =>
      usageApi.users({
        range,
        q: committedQ || undefined,
        sort,
        page,
        pageSize: USER_PAGE_SIZE,
      }),
    enabled: tab === UsageTab.Users,
  });

  const models = modelsQuery.data;
  const modelRows: ModelRow[] = (models?.items ?? []).map((r) => ({
    ...r,
    id: `${r.provider}/${r.model}`,
  }));
  // From `total`, never from `rows.length`: the footer has to agree with what
  // the CSV exports, and the CSV holds every match, not this page of them.
  const modelPageCount = Math.max(1, Math.ceil((models?.total ?? 0) / MODEL_PAGE_SIZE));

  const users = usersQuery.data;
  const userRows: UserRow[] = (users?.items ?? []).map((r) => ({ ...r, id: r.user_id }));
  const userPageCount = Math.max(1, Math.ceil((users?.total ?? 0) / USER_PAGE_SIZE));

  // Each tab's own gap notice, so the count belongs to the list on screen.
  const unaccounted =
    tab === UsageTab.Models ? (models?.unaccounted_calls ?? 0) : (users?.unaccounted_calls ?? 0);

  const applyRange = (next: UsageRangeKey): void => {
    setRange(next);
    setPage(1);
    setDrawerUserId(null);
    // The deep-linked row filter belongs to the window it was linked from.
    // Keeping it across a range change would leave the table showing one row
    // for a different period, which reads as "that model is the only one used".
    setModel(undefined);
  };

  const applyTab = (next: UsageTab): void => {
    setTab(next);
    setPage(1);
    setDrawerUserId(null);
    setModel(undefined);
  };

  const applySort = (next: UsageUserSort): void => {
    setSort(next);
    setPage(1);
  };

  const exportCsv = async (): Promise<void> => {
    // The export follows the visible tab and carries the members tab's
    // filters, so the file matches what is on screen (spec §5.4).
    const isUsers = tab === UsageTab.Users;
    try {
      const { text, headers } = await usageApi.exportCsv(
        range,
        isUsers ? UsageExportTab.Users : UsageExportTab.Models,
        isUsers ? { q: committedQ || undefined, sort } : undefined
      );
      const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // The route builds a filename deliberately (`7d-模型用量.csv`) and the
      // range key in it is what makes an archived file self-describing; a
      // client-invented name drifts the moment either side changes.
      a.download = filenameFromDisposition(
        headers,
        `usage-${isUsers ? 'users' : 'models'}-${range}.csv`
      );
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      // The route stamps `x-export-count` with the rows it actually wrote, so
      // the toast reports the file's size rather than the table's.
      const count = headers.get('x-export-count');
      toast.success(
        t('analytics.usage.toast.exported')
          .replace('{count}', count ?? String(isUsers ? (users?.total ?? 0) : (models?.total ?? 0)))
          .replace('{range}', rangeOptionLabel(range))
      );
    } catch (e) {
      toast.error(t('analytics.usage.toast.failed').replace('{error}', (e as Error).message));
    }
  };

  const modelColumns: Column<ModelRow>[] = [
    {
      key: 'provider',
      header: t('analytics.usage.col.provider'),
      render: (r) => <span className="font-mono text-xs">{r.provider}</span>,
    },
    {
      key: 'display_name',
      header: t('analytics.usage.col.model'),
      render: (r) => <span className="text-[var(--text-primary)]">{r.display_name || r.model}</span>,
    },
    {
      key: 'total_tokens',
      header: t('analytics.usage.col.tokens'),
      render: (r) => <span className="tabular-nums">{r.total_tokens.toLocaleString()}</span>,
    },
    {
      key: 'call_count',
      header: t('analytics.usage.col.calls'),
      render: (r) => <span className="tabular-nums">{r.call_count.toLocaleString()}</span>,
    },
  ];

  const userColumns: Column<UserRow>[] = [
    {
      key: 'display_name',
      header: t('analytics.usage.col.member'),
      render: (r) => (
        <div className="flex items-center gap-2.5">
          <MemberAvatar userId={r.user_id} displayName={r.display_name} username={r.username} />
          {/* No display name falls back to the username rather than rendering
              an empty cell that looks like missing data. */}
          <span className="truncate text-[var(--text-primary)]">
            {r.display_name || r.username}
          </span>
        </div>
      ),
    },
    {
      key: 'department_name',
      header: t('analytics.usage.col.department'),
      render: (r) => r.department_name ?? '—',
    },
    {
      key: 'total_tokens',
      // `col.usage`, not `col.tokens`: the model tab's header reads
      // 「模型用量(tokens)」 and that is a different metric.
      header: t('analytics.usage.col.usage'),
      render: (r) => <span className="tabular-nums">{r.total_tokens.toLocaleString()}</span>,
    },
    {
      key: 'last_used_at',
      header: t('analytics.usage.col.lastUsed'),
      // An em dash for "never", matching the CSV's empty cell marker: a blank
      // would read as a missing value rather than a known zero. Rendered in
      // the org's zone, which is the zone the CSV uses for this column.
      render: (r) => (
        <span className="tabular-nums" data-testid="user-last-used">
          {formatOrgDateTimeShort(r.last_used_at, users?.timezone)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: t('analytics.usage.col.action'),
      render: (r) => (
        <button
          type="button"
          onClick={() => setDrawerUserId(r.user_id)}
          className="text-xs font-medium text-[var(--accent-primary)] hover:underline"
        >
          {t('analytics.usage.users.detail')}
        </button>
      ),
    },
  ];

  const tabItems = [
    { key: UsageTab.Users, label: t('analytics.usage.tab.users') },
    { key: UsageTab.Models, label: t('analytics.usage.tab.models') },
  ];

  return (
    <div className="p-8">
      <PageHeader
        title={t('analytics.usage.title')}
        subtitle={t('analytics.usage.subtitle')}
        actions={
          <>
            <RangeSelect value={range} onChange={(k) => applyRange(k as UsageRangeKey)} />
            {canExport && (
              <button
                type="button"
                onClick={() => void exportCsv()}
                className="flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--border-default)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
              >
                <Download className="h-3.5 w-3.5" />
                {t('analytics.usage.export')}
              </button>
            )}
          </>
        }
      />

      {unaccounted > 0 && (
        <div className="mb-4">
          <GapNotice count={unaccounted} />
        </div>
      )}

      <div className="mb-3">
        <Tabs items={tabItems} value={tab} onChange={(k) => applyTab(k as UsageTab)} />
      </div>

      {tab === UsageTab.Models ? (
        <>
          {modelsQuery.isLoading ? (
            <div className="text-sm text-[var(--text-secondary)]">{t('common.loading')}</div>
          ) : modelsQuery.isError ? (
            // Not the empty state: "no usage recorded" would be a claim about
            // the org's data, and we failed to fetch it.
            <div className="text-sm text-[var(--text-secondary)]">{t('common.error')}</div>
          ) : modelRows.length === 0 ? (
            <EmptyState title={t('analytics.usage.empty')} />
          ) : (
            <div className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--border-subtle)]">
              <DataTable columns={modelColumns} rows={modelRows} />
            </div>
          )}

          {models && (
            <Pager
              page={page}
              pageCount={modelPageCount}
              onChange={setPage}
              summary={t('analytics.usage.footer')
                .replace('{count}', String(models.total))
                .replace('{range}', rangeOptionLabel(range))}
            />
          )}
        </>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <label className="relative flex items-center">
              <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-[var(--text-tertiary)]" />
              <input
                type="search"
                aria-label={t('analytics.usage.users.search')}
                placeholder={t('analytics.usage.users.searchHint')}
                title={t('analytics.usage.users.searchHint')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-64 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-white py-1.5 pl-8 pr-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:border-[var(--accent-primary)] focus:outline-none"
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
              {t('analytics.usage.users.sort')}
              <select
                aria-label={t('analytics.usage.users.sort')}
                value={sort}
                onChange={(e) => applySort(e.target.value as UsageUserSort)}
                className="rounded-[var(--radius-md)] border border-[var(--border-default)] bg-white px-2 py-1 text-xs text-[var(--text-primary)] focus:border-[var(--accent-primary)] focus:outline-none"
              >
                <option value={UsageUserSort.Desc}>{t('analytics.usage.users.sortDesc')}</option>
                <option value={UsageUserSort.Asc}>{t('analytics.usage.users.sortAsc')}</option>
              </select>
            </label>
          </div>

          {usersQuery.isLoading ? (
            <div className="text-sm text-[var(--text-secondary)]">{t('common.loading')}</div>
          ) : usersQuery.isError ? (
            <div className="text-sm text-[var(--text-secondary)]">{t('common.error')}</div>
          ) : userRows.length === 0 ? (
            <EmptyState title={t('analytics.usage.users.empty')} />
          ) : (
            <div className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--border-subtle)]">
              <DataTable columns={userColumns} rows={userRows} />
            </div>
          )}

          {users && (
            <Pager
              page={page}
              pageCount={userPageCount}
              onChange={setPage}
              summary={t('analytics.usage.users.footer')
                .replace('{count}', String(users.total))
                .replace('{range}', rangeOptionLabel(range))}
            />
          )}
        </>
      )}

      {drawerUserId && (
        <UsageDrawer userId={drawerUserId} range={range} onClose={() => setDrawerUserId(null)} />
      )}
    </div>
  );
}