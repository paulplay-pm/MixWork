import { Info } from 'lucide-react';
import type { JSX } from 'react';

import { t } from '../../i18n';

interface Props {
  count: number;
}

/**
 * The `unaccounted_calls` strip.
 *
 * These are calls whose provider reported no token usage, which means the
 * totals beside it are known to be low. Deliberately neutral — an error colour
 * would say "something is broken", and nothing is: the server is reporting an
 * honest limitation of the data it was given. Suppressing it would be worse
 * still, since a quietly short total reads as a complete one.
 *
 * Callers render this only when `count > 0`.
 */
export function GapNotice({ count }: Props): JSX.Element {
  return (
    <div className="flex items-start gap-2 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-3 py-2">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)]" />
      <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
        {t('analytics.usage.gap').replace('{count}', String(count))}
      </p>
    </div>
  );
}