import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import type { JSX } from 'react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { formatOrgDate, formatOrgHour } from '../analytics/datetime';
import { type AuditRangeKey, rangeOptionLabel, type UsageRangeKey } from '../analytics/range';
import {
  type DashboardActivity,
  dashboardApi,
  type DashboardUsageResponse,
} from '../api/dashboard';
import { useAuth } from '../auth/useAuth';
import { useMe } from '../auth/useMe';
import { usePermissions } from '../auth/usePermissions';
import { GapNotice } from '../components/analytics/GapNotice';
import { RangeSelect } from '../components/analytics/RangeSelect';
import { ActivityFeed } from '../components/dashboard/ActivityFeed';
import { RankBars } from '../components/dashboard/RankBars';
import { ServiceHealth } from '../components/dashboard/ServiceHealth';
import { StatCards } from '../components/dashboard/StatCards';
import { TrendChart } from '../components/dashboard/TrendChart';
import { useToast } from '../components/toastStore';
import { t } from '../i18n';

/** The spec asks for a 60s cache so re-entering the page within the minute
 *  does not refetch. The app-wide default in `main.tsx` is 30s, which is
 *  shorter — so this has to be stated per query rather than inherited. */
const STALE_MS = 60_000;

const CARD =
  'rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)]';
const CARD_HEAD = 'flex items-center justify-between px-5 pt-4 pb-1';

function Section({
  title,
  action,
  children,
  className,
  testId,
}: {
  title: string;
  action?: JSX.Element;
  children: React.ReactNode;
  className?: string;
  testId?: string;
}): JSX.Element {
  return (
    <section data-testid={testId} className={`${CARD} ${className ?? ''}`}>
      <header className={CARD_HEAD}>
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h2>
        {action}
      </header>
      <div className="px-5 pb-4 pt-1">{children}</div>
    </section>
  );
}

function Failed({ onRetry, testId }: { onRetry: () => void; testId?: string }): JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onRetry}
      className="flex h-[120px] w-full items-center justify-center rounded-lg border border-dashed border-[var(--border-default)] text-xs text-[var(--text-tertiary)] transition-colors hover:text-[var(--accent-primary)]"
    >
      {t('dashboard.error.retry')}
    </button>
  );
}

/** Morning / afternoon / evening, from the ORG's clock — the reader's own
 *  timezone would greet them about a day off when they are travelling. */
function greeting(nowIso: string | undefined, timezone: string | undefined): string {
  const hourText = formatOrgHour(nowIso ?? new Date().toISOString(), timezone);
  const hour = hourText ? Number(hourText.slice(0, 2)) : new Date().getHours();
  const key =
    hour < 12 ? 'dashboard.greeting.morning' : hour < 18 ? 'dashboard.greeting.afternoon' : 'dashboard.greeting.evening';
  return t(key);
}

/**
 * The console landing page.
 *
 * Two queries, deliberately not one. The blocks come from two permission
 * worlds, and the server refuses `/usage` with a 403 for a caller without
 * `usage:view`; merging them would mean a member with only `mcp:view` sees an
 * error page instead of the half of the board they are entitled to. The cost
 * is that a failure degrades a group rather than a single card.
 *
 * The `summary` query key deliberately carries no range: users, agents,
 * connectors and health are point-in-time facts, and re-fetching them on every
 * range change is a request that cannot change the answer.
 */
export function DashboardPage(): JSX.Element {
  const { claims } = useAuth();
  const { hasPermission } = usePermissions();
  // The JWT carries no display name; `/me` does.
  const { profile } = useMe();
  const navigate = useNavigate();
  const toast = useToast();
  const orgId = claims?.orgId ?? 'default-org';

  const [range, setRange] = useState<UsageRangeKey>('7d');
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => new Date().toISOString());

  const canUsage = hasPermission('usage:view');

  const summary = useQuery({
    queryKey: ['dashboard', 'summary', orgId],
    queryFn: dashboardApi.summary,
    staleTime: STALE_MS,
  });

  const usage = useQuery({
    queryKey: ['dashboard', 'usage', orgId, range],
    queryFn: () => dashboardApi.usage(range),
    staleTime: STALE_MS,
    enabled: canUsage,
  });

  const data = summary.data;
  const usageData: DashboardUsageResponse | undefined = usage.data;

  // `RangeSelect` is shared with the audit page, whose handler accepts the
  // `custom` key too; narrow before storing.
  const applyRange = (next: UsageRangeKey | AuditRangeKey): void => {
    if (next === 'custom') return;
    setRange(next);
    toast.info(t('dashboard.toast.rangeChanged').replace('{range}', rangeOptionLabel(next)));
  };

  const refresh = (): void => {
    setRefreshing(true);
    setNow(new Date().toISOString());
    void Promise.all([summary.refetch(), canUsage ? usage.refetch() : Promise.resolve()]).finally(() =>
      setRefreshing(false)
    );
    toast.success(t('dashboard.toast.refreshed'));
  };

  const openModel = (id: string): void => {
    const row = usageData?.model_top.find((m) => `${m.provider}/${m.model}` === id);
    if (row) navigate(`/monitoring/usage?range=${range}&model=${encodeURIComponent(id)}`);
  };

  const openDepartment = (id: string): void => {
    // No department pre-filter: the usage page has no department dimension, and
    // adding one is a change to THAT page's contract, not this one's.
    void id;
    navigate(`/monitoring/usage?range=${range}`);
  };

  const openActivity = (item: DashboardActivity): void => {
    if (!item.user_id) {
      navigate('/monitoring/audit');
      return;
    }
    const day = new Date(item.ts).toISOString().slice(0, 10);
    navigate(`/monitoring/audit?range=custom&userId=${item.user_id}&from=${day}&to=${day}`);
  };

  const timezone = usageData?.timezone;
  const hasAnyBlock =
    Boolean(data?.users || data?.agents || data?.mcp || data?.health || data?.activities) ||
    canUsage;
  // The right-hand column is the health card. It is absent in two different
  // situations — a caller without `mcp:view`, and the summary request having
  // failed — and in both the trend card must take the whole row rather than
  // leaving a dead gutter beside it.
  const showsHealthColumn = summary.isError || Boolean(data?.health);

  if (summary.isLoading) {
    return (
      <div data-testid="dashboard-loading" className="p-8">
        <div className="h-6 w-24 animate-pulse rounded bg-[var(--bg-tertiary)]" />
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="h-[92px] animate-pulse rounded-[var(--radius-lg)] bg-[var(--bg-tertiary)]" />
          ))}
        </div>
      </div>
    );
  }

  if (!hasAnyBlock) {
    return (
      <div data-testid="dashboard-no-access" className="p-8">
        <h1 className="text-xl font-semibold text-[var(--text-primary)]">{t('dashboard.title')}</h1>
        <p className="mt-3 text-sm text-[var(--text-secondary)]">{t('dashboard.empty.noAccess')}</p>
        <Link
          to="/orgs/users"
          className="mt-4 inline-block text-sm text-[var(--accent-primary)] hover:underline"
        >
          {t('nav.users')} →
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1120px] p-6 lg:px-9">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">
            {t('dashboard.title')}
          </h1>
          <p data-testid="dashboard-greeting" className="mt-1 text-[13px] text-[var(--text-secondary)]">
            {greeting(now, timezone)}
            {profile?.display_name ? `，${profile.display_name}` : ''}
            {' · '}
            {t('dashboard.greeting.today').replace('{date}', formatOrgDate(now, timezone))}
            {' · '}
            {t('dashboard.updatedAt').replace(
              '{time}',
              formatOrgHour(data?.updated_at ?? now, timezone) ?? ''
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span data-testid="range-select">
            <RangeSelect value={range} onChange={applyRange} />
          </span>
          <button
            type="button"
            data-testid="refresh-btn"
            onClick={refresh}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-1.5 text-xs text-[var(--text-primary)] transition-colors hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)] disabled:opacity-60"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            {t('dashboard.refresh')}
          </button>
        </div>
      </div>

      <StatCards
        users={data?.users ?? null}
        active={usageData?.active ?? null}
        tokens={usageData?.tokens ?? null}
        agents={data?.agents ?? null}
        mcp={data?.mcp ?? null}
        hasUsage={canUsage}
        range={range}
      />

      <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-[1.9fr_1fr]">
        <Section
          testId="trend-section"
          className={showsHealthColumn ? '' : 'lg:col-span-2'}
          title={t('dashboard.trend.title')}
          action={
            <Link
              to={`/monitoring/usage?range=${range}`}
              data-testid="trend-detail-link"
              className="text-xs text-[var(--accent-primary)] hover:underline"
            >
              {t('dashboard.trend.detail')} →
            </Link>
          }
        >
          {!canUsage ? null : usage.isError ? (
            <div data-testid="usage-error">
              <Failed onRetry={() => void usage.refetch()} />
            </div>
          ) : usageData ? (
            <>
              <TrendChart series={usageData.trend} range={range} />
              {usageData.unaccounted_calls > 0 && (
                <div className="mt-2">
                  <GapNotice count={usageData.unaccounted_calls} />
                </div>
              )}
            </>
          ) : (
            <div className="h-[200px] animate-pulse rounded bg-[var(--bg-tertiary)]" />
          )}
        </Section>

        {summary.isError ? (
          // Without this the configuration group failed SILENTLY: the cards it
          // would have filled simply were not there, and the admin reads a
          // missing dashboard as lost data rather than a failed request.
          <Failed testId="summary-error" onRetry={() => void summary.refetch()} />
        ) : (
          <ServiceHealth
            health={data?.health ?? null}
            mcpAbnormal={data?.mcp?.abnormal ?? 0}
            onRetry={() => void summary.refetch()}
          />
        )}
      </div>

      <div className="mt-3.5 grid grid-cols-1 gap-3.5 lg:grid-cols-[1fr_1.9fr]">
        {canUsage && (
          <Section
            title={t('dashboard.rank.modelTitle')}
            action={
              <Link
                to={`/monitoring/usage?range=${range}`}
                className="text-xs text-[var(--accent-primary)] hover:underline"
              >
                {t('dashboard.rank.detail')} →
              </Link>
            }
          >
            <RankBars
              emptyText={t('dashboard.rank.emptyModel')}
              rows={(usageData?.model_top ?? []).map((m) => ({
                id: `${m.provider}/${m.model}`,
                name: m.display_name,
                tokens: m.tokens,
              }))}
              onRowClick={openModel}
            />
          </Section>
        )}

        {data?.activities && (
          <Section
            title={t('dashboard.activity.title')}
            className={canUsage ? '' : 'lg:col-span-2'}
            action={
              <Link
                to="/monitoring/audit"
                className="text-xs text-[var(--accent-primary)] hover:underline"
              >
                {t('dashboard.activity.auditLink')} →
              </Link>
            }
          >
            <ActivityFeed activities={data.activities} onItemClick={openActivity} />
          </Section>
        )}
      </div>

      {canUsage && (
        <div className="mt-3.5">
          <Section
            title={t('dashboard.rank.deptTitle')}
            action={
              <Link
                to={`/monitoring/usage?range=${range}`}
                className="text-xs text-[var(--accent-primary)] hover:underline"
              >
                {t('dashboard.rank.userDetail')} →
              </Link>
            }
          >
            <RankBars
              emptyText={t('dashboard.rank.emptyDept')}
              rows={(usageData?.dept_top ?? []).map((d) => ({
                id: d.department_id ?? '__unassigned__',
                name: d.name ?? t('dashboard.rank.unassigned'),
                sublabel:
                  d.department_id === null
                    ? undefined
                    : t('dashboard.rank.people').replace('{n}', String(d.users)),
                tokens: d.tokens,
              }))}
              onRowClick={openDepartment}
            />
          </Section>
        </div>
      )}
    </div>
  );
}