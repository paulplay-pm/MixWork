import type { JSX } from 'react';

import { getLang } from '../../i18n';
import { formatTokens } from './format';

export interface RankRow {
  id: string;
  name: string;
  tokens: number;
  /** Headcount for the department ranking; absent on the model ranking. */
  sublabel?: string;
}

export interface RankBarsProps {
  rows: RankRow[];
  emptyText: string;
  onRowClick?: (id: string) => void;
}

const RANK_TONE = [
  'bg-[var(--warning-light)] text-[var(--warning-primary)]',
  'bg-[var(--accent-light)] text-[var(--accent-primary)]',
  'bg-[var(--success-light)] text-[var(--success-primary)]',
  'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]',
];

/**
 * A horizontal bar ranking, used by both 模型用量 TOP 5 and 部门用量排行.
 *
 * Bar width is **relative to the leader**, not to the total. A "share of
 * total" bar makes the fifth row a sliver nobody can compare, and the number
 * beside it already carries the absolute value; normalising to the leader is
 * what makes the gap between rows 1 and 2 readable at a glance.
 *
 * A ranking whose tokens are all zero has no leader to divide by, so every bar
 * renders empty rather than `NaN%` — which the browser drops, silently
 * collapsing the rows to nothing.
 */
export function RankBars({ rows, emptyText, onRowClick }: RankBarsProps): JSX.Element {
  const lang = getLang();
  const top = rows.reduce((m, r) => Math.max(m, r.tokens), 0);

  if (rows.length === 0) {
    return (
      <p className="py-6 text-center text-xs text-[var(--text-tertiary)]" data-testid="rank-empty">
        {emptyText}
      </p>
    );
  }

  return (
    <ul data-testid="rank-list">
      {rows.map((row, i) => (
        <li key={row.id}>
          <button
            type="button"
            data-testid="rank-row"
            onClick={() => onRowClick?.(row.id)}
            className="flex w-full items-center gap-2.5 rounded px-1 py-2 text-left transition-colors hover:bg-[var(--bg-hover)]/50"
          >
            <span
              data-testid="rank-badge"
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-[11px] font-semibold ${
                RANK_TONE[Math.min(i, RANK_TONE.length - 1)]
              }`}
            >
              {i + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-1.5">
                <span
                  className="truncate text-[13px] text-[var(--text-primary)]"
                  title={row.name}
                >
                  {row.name}
                </span>
                {row.sublabel && (
                  <span
                    data-testid="rank-sublabel"
                    className="shrink-0 text-[11px] text-[var(--text-tertiary)]"
                  >
                    {row.sublabel}
                  </span>
                )}
              </span>
              <span className="mt-1 block h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
                <span
                  data-testid="rank-fill"
                  className="block h-full rounded-full bg-gradient-to-r from-[var(--accent-primary)] to-[var(--accent-primary)]/70"
                  style={{ width: top > 0 ? `${((row.tokens / top) * 100).toFixed(1)}%` : '0%' }}
                />
              </span>
            </span>
            <span className="w-[76px] shrink-0 text-right text-xs tabular-nums text-[var(--text-secondary)]">
              {formatTokens(row.tokens, lang)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}