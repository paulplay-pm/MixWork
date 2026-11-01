import type { JSX } from 'react';
import { Link } from 'react-router-dom';

import type { DashboardHealthBlock, DashboardHealthItem } from '../../api/dashboard';
import { getLang, t } from '../../i18n';

export interface ServiceHealthProps {
  /** null when the caller lacks `mcp:view`; the server trimmed the section
   *  rather than returning an empty list, so null and [] mean different
   *  things and only null hides the card. */
  health: DashboardHealthBlock | null;
  mcpAbnormal: number;
  onRetry: () => void;
}

const DOT_CLASS: Record<string, string> = {
  err: 'bg-[var(--danger-primary)]',
  warn: 'bg-[var(--warning-primary)]',
  ok: 'bg-[var(--success-primary)]',
  unknown: 'bg-[var(--text-tertiary)]',
};

/** The right-hand cell. A failure reports the failure and nothing else — a
 *  latency beside "connection failed" implies the connection was made. */
function metric(item: DashboardHealthItem): string {
  if (item.status === 'err') return t('dashboard.health.failed');
  if (item.status === 'unknown') return t('dashboard.health.untested');
  if (item.latency_ms === null) return t('dashboard.health.untested');
  return t('dashboard.health.avg').replace('{ms}', String(item.latency_ms));
}

/**
 * Service health, read-only.
 *
 * Every row's state is stated in words as well as colour — an amber dot beside
 * a name is unreadable to anyone who cannot separate amber from green, and
 * this list exists to be acted on at a glance.
 *
 * There is no "re-check" button and no "last swept N minutes ago" line,
 * because neither is true of this system: nothing sweeps. The only rows that
 * carry a result are the ones an admin produced by clicking "test connection"
 * on a config page, and the footer says so rather than implying a freshness
 * the data does not have.
 */
export function ServiceHealth(props: ServiceHealthProps): JSX.Element | null {
  const { health } = props;
  if (!health) return null;
  const lang = getLang();

  return (
    <section
      data-testid="service-health"
      className="flex h-full flex-col rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)]"
    >
      <header className="flex items-center justify-between px-4 pt-4">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">
          {t('dashboard.health.title')}
        </h2>
        <Link
          to="/config/mcp-manage"
          className="text-xs text-[var(--accent-primary)] hover:underline"
        >
          {t('dashboard.health.allServices')} →
        </Link>
      </header>

      {health.items.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-[var(--text-tertiary)]">
          {t('dashboard.health.empty')}
        </p>
      ) : (
        <ul className="mt-1 flex-1 px-4">
          {health.items.map((item) => {
            const name = lang === 'zh' ? item.name_zh || item.name_en : item.name_en || item.name_zh;
            const href = item.type === 'model' ? '/config/providers' : '/config/mcp-manage';
            return (
              <li key={`${item.type}:${item.id}`} className="border-b border-[var(--border-subtle)] last:border-b-0">
                <Link
                  to={href}
                  data-testid="health-row"
                  data-status={item.status}
                  className="flex items-center gap-2.5 py-2.5 transition-colors hover:bg-[var(--bg-hover)]/50"
                >
                  <span
                    aria-hidden="true"
                    className={`h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[item.status]}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium text-[var(--text-primary)]">
                        {name}
                      </span>
                      <span className="shrink-0 rounded bg-[var(--bg-tertiary)] px-1.5 py-px text-[10px] text-[var(--text-secondary)]">
                        {t(
                          item.type === 'model'
                            ? 'dashboard.health.type.model'
                            : 'dashboard.health.type.mcp'
                        )}
                      </span>
                    </span>
                    <span className="sr-only">
                      {/* Only for the states whose visible cell is a latency.
                          For `err` and `unknown` the right-hand cell already
                          spells the state out, and a screen reader hearing
                          "Connection failed" twice is noise, not clarity. */}
                      {item.status === 'ok' || item.status === 'warn'
                        ? t(`dashboard.health.status.${item.status}`)
                        : ''}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-[var(--text-tertiary)]">
                    {metric(item)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <p className="px-4 pb-3.5 pt-2 text-[11px] text-[var(--text-tertiary)]">
        {t('dashboard.health.source')}
      </p>
    </section>
  );
}