import { Bot, Plug2, Users, Zap } from 'lucide-react';
import type { JSX, ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type { UsageRangeKey } from '../../analytics/range';
import type {
  DashboardAgentCounts,
  DashboardMcpCounts,
  DashboardUsageTotals,
  DashboardUserCounts,
} from '../../api/dashboard';
import { getLang, t } from '../../i18n';
import { formatDelta, formatTokens } from './format';

export interface StatCardsProps {
  users: DashboardUserCounts | null;
  active: DashboardUsageTotals | null;
  tokens: DashboardUsageTotals | null;
  agents: DashboardAgentCounts | null;
  mcp: DashboardMcpCounts | null;
  /** Whether the caller may see the usage half at all. The server already
   *  refuses `usage:view` with a 403, so without this the two cards would
   *  render as permanent zeros — which reads as "nobody used anything". */
  hasUsage: boolean;
  range: UsageRangeKey;
}

/** Substitutes `{name}` placeholders. The dashboard's copy is parameterised
 *  ("已启用 52 · 停用 6"), and a string replace per card is cheaper than a real
 *  i18n interpolation layer this app does not otherwise have. */
function fill(template: string, vars: Record<string, string | number>): string {
  return Object.entries(vars).reduce(
    (acc, [k, v]) => acc.replaceAll(`{${k}}`, String(v)),
    template
  );
}

const CARD_BASE =
  'relative rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-4 py-3.5';

function Card({
  id,
  icon,
  label,
  value,
  unit,
  foot,
  to,
  tone,
}: {
  id: string;
  icon: ReactNode;
  label: string;
  value: string;
  unit?: string;
  foot?: ReactNode;
  to: string;
  tone: string;
}): JSX.Element {
  return (
    <Link
      to={to}
      data-testid={`stat-link-${id}`}
      className={`${CARD_BASE} block transition-colors hover:border-[var(--border-default)] hover:bg-[var(--bg-hover)]/40`}
    >
      <span
        className={`absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-lg [&_svg]:h-4 [&_svg]:w-4 ${tone}`}
        aria-hidden="true"
      >
        {icon}
      </span>
      <div data-testid="stat-label" className="pr-9 text-xs font-medium text-[var(--text-secondary)]">
        {label}
      </div>
      <div className="mt-1.5 text-2xl font-bold tabular-nums tracking-tight text-[var(--text-primary)]">
        {value}
        {unit && <span className="ml-1 text-xs font-medium text-[var(--text-tertiary)]">{unit}</span>}
      </div>
      <div className="mt-1.5 min-h-[16px] text-[11px] leading-4 text-[var(--text-tertiary)]">
        {foot}
      </div>
    </Link>
  );
}

/** The period-over-period line. Renders nothing when there is no previous
 *  period to compare against, rather than a bare dash that reads as data. */
function Delta({
  id,
  totals,
}: {
  id: string;
  totals: DashboardUsageTotals;
}): JSX.Element {
  const lang = getLang();
  const delta = formatDelta(totals.value, totals.prev, lang);
  const tone =
    delta.direction === 'up'
      ? 'text-[var(--success-primary)]'
      : delta.direction === 'down'
        ? 'text-[var(--danger-primary)]'
        : 'text-[var(--text-tertiary)]';
  return (
    <span className="flex items-center gap-1.5" data-testid={`stat-delta-${id}`} data-direction={delta.direction}>
      <span className={tone}>
        {delta.direction === 'flat'
          ? '—'
          : delta.direction === 'new'
            ? t('dashboard.delta.new')
            : `${delta.direction === 'up' ? '▲' : '▼'} ${delta.text}`}
      </span>
      <span className="text-[var(--text-tertiary)]">{t('dashboard.stat.period')}</span>
    </span>
  );
}

const ICON_TONE: Record<string, string> = {
  blue: 'bg-[var(--accent-light)] text-[var(--accent-primary)]',
  green: 'bg-[var(--success-light)] text-[var(--success-primary)]',
  purple: 'bg-[#f1ecff] text-[#7a5af8]',
  orange: 'bg-[var(--warning-light)] text-[var(--warning-primary)]',
};

/**
 * The five headline numbers.
 *
 * Order is fixed by the spec and is not user-configurable, so it is written out
 * literally rather than derived from an array — the sequence IS the
 * requirement, and an array plus a sort key would make it look negotiable.
 * A card whose section came back `null` (permission denied) is omitted entirely
 * rather than rendered as zero.
 */
export function StatCards(props: StatCardsProps): JSX.Element | null {
  const lang = getLang();
  const { users, active, tokens, agents, mcp, hasUsage, range } = props;
  const usageHref = `/monitoring/usage?range=${range}`;
  const cards: JSX.Element[] = [];

  if (users) {
    cards.push(
      <Card
        key="users"
        id="users"
        icon={<Users />}
        tone={ICON_TONE.blue}
        label={t('dashboard.stat.users')}
        value={users.total.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US')}
        unit={t('dashboard.unit.people')}
        to="/orgs/users"
        foot={fill(t('dashboard.stat.users.sub'), {
          enabled: users.enabled,
          disabled: users.disabled,
        })}
      />
    );
  }

  if (hasUsage && active) {
    cards.push(
      <Card
        key="active"
        id="active"
        icon={<Users />}
        tone={ICON_TONE.blue}
        label={t('dashboard.stat.active')}
        value={active.value.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US')}
        unit={t('dashboard.unit.people')}
        to="/orgs/users"
        foot={<Delta id="active" totals={active} />}
      />
    );
  }

  if (hasUsage && tokens) {
    cards.push(
      <Card
        key="tokens"
        id="tokens"
        icon={<Zap />}
        tone={ICON_TONE.green}
        label={t('dashboard.stat.tokens')}
        value={formatTokens(tokens.value, lang)}
        unit={lang === 'zh' ? t('dashboard.stat.tokens.unit') : ''}
        to={usageHref}
        foot={<Delta id="tokens" totals={tokens} />}
      />
    );
  }

  if (agents) {
    cards.push(
      <Card
        key="agents"
        id="agents"
        icon={<Bot />}
        tone={ICON_TONE.purple}
        label={t('dashboard.stat.agents')}
        value={String(agents.enabled)}
        unit={lang === 'zh' ? t('dashboard.unit.count') : ''}
        to="/config/agents"
        foot={fill(t('dashboard.stat.agents.sub'), {
          total: agents.total,
          disabled: Math.max(0, agents.total - agents.enabled),
        })}
      />
    );
  }

  if (mcp) {
    const abnormal = mcp.abnormal > 0;
    cards.push(
      <Card
        key="mcp"
        id="mcp"
        icon={<Plug2 />}
        tone={ICON_TONE.orange}
        label={t('dashboard.stat.mcp')}
        value={String(mcp.enabled)}
        unit={lang === 'zh' ? t('dashboard.unit.count') : ''}
        to="/config/mcp-manage"
        foot={
          <span className="flex flex-wrap items-center gap-1.5">
            <span
              data-testid="stat-mcp-abnormal"
              className={
                abnormal
                  ? 'inline-flex items-center gap-1 text-[var(--danger-primary)]'
                  : 'inline-flex items-center gap-1 text-[var(--success-primary)]'
              }
            >
              {abnormal
                ? fill(t('dashboard.stat.mcp.abnormal'), { n: mcp.abnormal })
                : t('dashboard.stat.mcp.ok')}
            </span>
            {abnormal && mcp.first_abnormal && (
              <span data-testid="stat-mcp-hint" className="truncate text-[var(--text-tertiary)]">
                {mcp.first_abnormal}
              </span>
            )}
          </span>
        }
      />
    );
  }

  if (cards.length === 0) return null;
  return (
    <div
      data-testid="stat-cards"
      className="mb-3.5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5"
    >
      {cards}
    </div>
  );
}