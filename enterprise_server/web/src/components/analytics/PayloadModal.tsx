import { X } from 'lucide-react';
import type { JSX } from 'react';
import { useEffect } from 'react';

import { formatOrgDateTime } from '../../analytics/datetime';
import type { AuditListItem } from '../../api/audit';
import { badgeToneFor } from '../../api/audit';
import { getLang, t } from '../../i18n';
import { Badge } from '../Badge';

interface Props {
  /** The row, already in memory. There is deliberately no fetch here: the
   *  summary in the cell and the detail in this modal are the same object, so
   *  they cannot disagree about what happened. */
  item: AuditListItem;
  /** The org's zone, from the list response. Passed in rather than re-derived:
   *  the modal renders the same instant as the row behind it, in the same
   *  zone, and a `Date` method here would read the browser's. */
  timezone?: string;
  onClose: () => void;
}

/** Where the table shows an em dash for "none". Matched here so the modal
 *  reads as the same row rather than as a second, terser rendering. */
const NONE = '—';

/**
 * The payload detail modal.
 *
 * Takes the `AuditListItem` the list already holds and formats its `payload`
 * with `JSON.stringify(…, null, 2)`. It issues no request: the alternative
 * would be a second fetch whose answer could differ from the row the user
 * clicked — a payload that changed between the table and the modal, shown with
 * no indication that anything was re-read.
 */
export function PayloadModal({ item, timezone, onClose }: Props): JSX.Element {
  // Escape closes, like every other overlay in the app. Bound to the document
  // because the modal itself is not focused — the cell button that opened it
  // keeps focus, and that button unmounts with the row behind a re-fetch.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const meta: [string, string][] = [
    [t('analytics.audit.col.time'), formatOrgDateTime(item.ts, timezone)],
    // The name, or an em dash for an anonymous event. `user_id` is a filter
    // value, never a label: a UUID in this table is unreadable.
    [t('analytics.audit.col.user'), item.user_name ?? NONE],
    [t('analytics.audit.col.targetType'), item.target_type_zh ?? NONE],
    [t('analytics.audit.col.targetId'), item.target_id ?? NONE],
  ];
  // `null` is "no payload", not the four letters `null` — the same distinction
  // the CSV's `jsonCell` makes.
  const body =
    item.payload === null || item.payload === undefined
      ? null
      : JSON.stringify(item.payload, null, 2);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--text-primary)]/40 p-6"
      data-testid="payload-mask"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('analytics.audit.payload.title')}
        className="flex max-h-[80vh] w-[720px] max-w-full flex-col overflow-hidden rounded-[var(--radius-lg)] bg-[var(--bg-secondary)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-[var(--border-subtle)] px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-[var(--text-primary)]">
              {t('analytics.audit.payload.title')}
            </h2>
            <div className="mt-1.5">
              {/* Labelled and coloured, never colour alone (spec §6). */}
              <Badge tone={badgeToneFor(item.tone)}>
                {getLang() === 'zh' ? item.action_zh : item.action_en}
              </Badge>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('analytics.audit.payload.close')}
            className="rounded-[var(--radius-md)] p-1 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="overflow-y-auto px-6 py-4">
          <dl className="mb-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-xs">
            {meta.map(([label, value]) => (
              <div key={label} className="col-span-2 grid grid-cols-subgrid">
                <dt className="text-[var(--text-tertiary)]">{label}</dt>
                <dd
                  className={
                    label === t('analytics.audit.col.targetId')
                      ? 'font-mono text-[var(--text-primary)]'
                      : 'text-[var(--text-primary)]'
                  }
                >
                  {value}
                </dd>
              </div>
            ))}
          </dl>

          {body === null ? (
            <p className="text-sm text-[var(--text-secondary)]">
              {t('analytics.audit.payload.empty')}
            </p>
          ) : (
            // Monospace and scrollable: a payload is JSON, and it is routinely
            // taller than the modal.
            <pre
              data-testid="payload-json"
              className="max-h-[45vh] overflow-auto whitespace-pre-wrap break-all rounded-[var(--radius-md)] bg-[var(--bg-tertiary)] p-3 font-mono text-xs leading-relaxed text-[var(--text-primary)]"
            >
              {body}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}