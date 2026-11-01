import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import type { JSX } from 'react';
import { useEffect } from 'react';

import { rangeOptionLabel, type UsageRangeKey } from '../../analytics/range';
import { usageApi } from '../../api/usage';
import { useAuth } from '../../auth/useAuth';
import { t } from '../../i18n';
import { DailyBarChart } from './DailyBarChart';
import { GapNotice } from './GapNotice';
import { MemberAvatar } from './MemberAvatar';
import { ModelShareBars } from './ModelShareBars';

interface Props {
  userId: string;
  range: UsageRangeKey;
  onClose: () => void;
}

/**
 * The member detail drawer.
 *
 * Data comes from `usageApi.userDetail`, whose `daily` already carries one
 * entry per day in the range including the zero days — the chart draws a slot
 * per entry rather than deriving a day count, because deriving it locally
 * means `(to - from) / 86400000`, and a DST transition makes a day 23 or 25
 * hours long. That off-by-one is invisible until it is not.
 *
 * Both sections fall back to a sentence when the member has no rows. An axis
 * with nothing on it reads as a broken chart; a sentence reads as the fact it
 * is. `pct` arrives from the server (see ModelShareBars), so a member who used
 * nothing shows 0 rather than NaN.
 */
export function UsageDrawer({ userId, range, onClose }: Props): JSX.Element {
  const { claims } = useAuth();
  const orgId = claims?.orgId ?? 'default-org';

  const detailQuery = useQuery({
    queryKey: ['usage', 'user', orgId, userId, range],
    queryFn: () => usageApi.userDetail(userId, range),
  });

  // Escape closes, like every other overlay in the app. Bound to the document
  // because the drawer itself is not focused — the button that opened it keeps
  // focus, and that button may unmount when the range changes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const data = detailQuery.data;
  const name = data?.user.display_name ?? userId;
  const dept = data?.user.department_name ?? null;
  const daily = data?.daily ?? [];
  const byModel = data?.by_model ?? [];
  // A member is "quiet" when the range holds no usage at all. `daily` still
  // lists every day, so this cannot be a length check.
  const quiet = daily.every((d) => d.tokens === 0) && byModel.length === 0;
  const label = rangeOptionLabel(range);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-[var(--text-primary)]/40"
      data-testid="drawer-mask"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={name}
        data-testid="usage-drawer"
        className="h-full w-[860px] max-w-[calc(100vw-60px)] overflow-y-auto bg-[var(--bg-secondary)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-start justify-between border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-6 py-4">
          <div className="flex items-center gap-3">
            <MemberAvatar userId={userId} displayName={data?.user.display_name ?? null} username={userId} size={40} />
            <div>
              <h2 className="text-base font-semibold text-[var(--text-primary)]">{name}</h2>
              {/* The separator belongs to the department, not to the title, so
                  a member with no department gets the sentence without a
                  dangling ` ·`. */}
              <p className="text-xs text-[var(--text-secondary)]">
                {dept
                  ? t('analytics.usage.drawer.subtitle')
                      .replace('{range}', label)
                      .replace('{department}', dept)
                  : t('analytics.usage.drawer.subtitleNoDept').replace('{range}', label)}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('analytics.usage.drawer.close')}
            className="rounded-[var(--radius-md)] p-1 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-6 px-6 py-5">
          {detailQuery.isError ? (
            // Not the empty state: "no usage recorded" would be a claim about
            // the member, and we failed to fetch it.
            <div className="text-sm text-[var(--text-secondary)]">{t('common.error')}</div>
          ) : detailQuery.isLoading ? (
            <div className="text-sm text-[var(--text-secondary)]">{t('common.loading')}</div>
          ) : (
            <>
              {(data?.unaccounted_calls ?? 0) > 0 && (
                <GapNotice count={data?.unaccounted_calls ?? 0} />
              )}

              <section data-testid="drawer-daily">
                <h3 className="mb-2 text-sm font-medium text-[var(--text-primary)]">
                  {t('analytics.usage.chart.daily')}
                </h3>
                {quiet ? (
                  <p data-testid="chart-empty" className="text-xs text-[var(--text-secondary)]">
                    {t('analytics.usage.empty')}
                  </p>
                ) : (
                  <>
                    <DailyBarChart days={daily} />
                    <p className="mt-1 text-[11px] text-[var(--text-tertiary)]">
                      {t('analytics.usage.chart.range').replace('{range}', label)}
                    </p>
                  </>
                )}
              </section>

              <section data-testid="drawer-models">
                <h3 className="mb-2 text-sm font-medium text-[var(--text-primary)]">
                  {t('analytics.usage.chart.models')}
                </h3>
                {byModel.length === 0 ? (
                  <p data-testid="chart-empty" className="text-xs text-[var(--text-secondary)]">
                    {t('analytics.usage.empty')}
                  </p>
                ) : (
                  <ModelShareBars rows={byModel} />
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}