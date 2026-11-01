import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { JSX } from 'react';

import { t } from '../../i18n';

interface Props {
  page: number;
  pageCount: number;
  onChange: (page: number) => void;
  /** Optional line above the controls — what the list below them counted. */
  summary?: string;
}

/**
 * Prev / page / next, centred under the list.
 *
 * `pageCount` is derived from the server's `total`, never from the rows on
 * screen, so "第 3 / 9 页" cannot promise a page that does not exist. Both
 * buttons disable at their boundary rather than wrapping around: a user who
 * clicked "next" past the end lost track of where they were.
 */
export function Pager({ page, pageCount, onChange, summary }: Props): JSX.Element {
  const prev = t('analytics.pager.prev');
  const next = t('analytics.pager.next');
  const buttonClass =
    'rounded-[var(--radius-md)] border border-[var(--border-default)] p-1 text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent';

  return (
    <div className="mt-4 flex flex-col items-center gap-2">
      {summary && (
        <p className="text-xs text-[var(--text-secondary)]" data-testid="pager-summary">
          {summary}
        </p>
      )}
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-label={prev}
          onClick={() => onChange(page - 1)}
          disabled={page <= 1}
          className={buttonClass}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="text-xs tabular-nums text-[var(--text-secondary)]">
          {t('analytics.pager.info')
            .replace('{page}', String(page))
            .replace('{count}', String(pageCount))}
        </span>
        <button
          type="button"
          aria-label={next}
          onClick={() => onChange(page + 1)}
          disabled={page >= pageCount}
          className={buttonClass}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}