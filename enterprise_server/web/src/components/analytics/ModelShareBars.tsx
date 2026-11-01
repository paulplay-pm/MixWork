import type { JSX } from 'react';

import { t } from '../../i18n';

interface Props {
  /** The server's `by_model` rows, already merged per (provider, model) and
   *  already carrying `pct`. Nothing here recomputes the share. */
  rows: { display_name: string; tokens: number; pct: number }[];
}

/** Bar height in px. The row is a flex line, so the bar is an SVG that keeps
 *  its aspect while the label and the numbers sit beside it as real text. */
const BAR_H = 8;

/**
 * Per-model usage as horizontal bars.
 *
 * `pct` is the server's number, not one computed here: the browser has no
 * reliable total to divide by (the roster page and the drawer can disagree on
 * rounding), and a member who used nothing gets `0` from the server rather
 * than a `NaN` this component would have to special-case.
 *
 * Bars are scaled against the largest row rather than against 100%, so a
 * member whose top model is 30% still gets a readable chart instead of three
 * stubby bars in an empty box.
 */
export function ModelShareBars({ rows }: Props): JSX.Element {
  const peak = rows.reduce((m, r) => Math.max(m, r.tokens), 0);

  return (
    <ul className="space-y-2" data-testid="model-share">
      {rows.map((r) => (
        <li key={r.display_name} className="flex items-center gap-3" data-testid="model-share-row">
          <span
            className="w-40 shrink-0 truncate text-xs text-[var(--text-secondary)]"
            title={r.display_name}
          >
            {r.display_name}
          </span>
          <svg
            viewBox="0 0 100 8"
            preserveAspectRatio="none"
            className="h-2 min-w-0 flex-1"
            aria-hidden
          >
            {/* Track, then fill. A percentage alone is ambiguous without the
                track behind it — a 9% bar and a 90% bar are the same mark. */}
            <rect x="0" y="0" width="100" height={BAR_H} rx="4" fill="var(--bg-tertiary)" />
            {peak > 0 && r.tokens > 0 && (
              <rect
                x="0"
                y="0"
                width={(r.tokens / peak) * 100}
                height={BAR_H}
                rx="4"
                fill="var(--accent-primary)"
              />
            )}
          </svg>
          <span className="w-40 shrink-0 text-right text-xs tabular-nums text-[var(--text-secondary)]">
            {t('analytics.usage.chart.share')
              .replace('{tokens}', r.tokens.toLocaleString())
              .replace('{pct}', String(r.pct))}
          </span>
        </li>
      ))}
    </ul>
  );
}