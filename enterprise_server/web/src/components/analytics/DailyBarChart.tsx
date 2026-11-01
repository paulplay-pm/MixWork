import type { JSX } from 'react';

import { t } from '../../i18n';

interface Props {
  /** One entry per day in the range, zero days included — the server's array,
   * never a locally computed day count. */
  days: { date: string; tokens: number }[];
}

/** Plot box inside the viewBox. The labels live outside it, so the bars never
 *  sit under the y-axis text. */
const PAD = { top: 12, right: 8, bottom: 26, left: 56 };
const W = 720;
const H = 200;
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

/** Above this many slots, labelling every day collides; label every fifth. */
const DENSE_SLOT_THRESHOLD = 10;

/** Round `v` up to the next 1/2/5 × 10ⁿ. The y-axis top has to be a round
 *  number, otherwise the topmost gridline reads `9231`. */
function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  const exp = Math.floor(Math.log10(v));
  const mag = 10 ** exp;
  const f = v / mag;
  const mult = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return mult * mag;
}

/** `2026-10-16` → `10/16`. Sliced rather than parsed: a `Date` built from a
 *  bare date string is UTC midnight, which renders as the previous day for
 *  anyone west of Greenwich. These strings are already org-local day labels. */
function shortDate(date: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(date);
  return m ? `${m[1]}/${m[2]}` : date;
}

/**
 * Daily token usage as hand-written SVG.
 *
 * There is no chart library in this app's dependency set, so this is raw SVG
 * against a fixed viewBox — which also means it needs no ResizeObserver and
 * renders identically in jsdom and in the browser.
 *
 * The slot count is `days.length`, verbatim. A day with no usage keeps its
 * slot and simply draws no bar: dropping the slot would shrink the plot under
 * the quiet days, so a member who used one model on Tuesday would show a
 * Tuesday bar that is twice as wide as everyone else's. The x-axis therefore
 * always spans exactly the range the server resolved.
 *
 * An all-zero series is NOT rendered here. The caller shows an empty-state
 * line instead — an axis with no data on it reads as a broken chart.
 */
export function DailyBarChart({ days }: Props): JSX.Element {
  const peak = days.reduce((m, d) => Math.max(m, d.tokens), 0);
  const top = niceCeil(peak);
  const slot = PLOT_W / days.length;
  // Leave a gap between bars so a run of equal values still reads as discrete
  // days rather than one solid block.
  const barW = Math.max(2, Math.min(slot - 2, 26));
  const y = (tokens: number): number => PAD.top + PLOT_H - (tokens / top) * PLOT_H;
  const dense = days.length > DENSE_SLOT_THRESHOLD;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      role="img"
      aria-label={t('analytics.usage.chart.daily')}
      data-testid="daily-chart"
    >
      {/* Gridlines and y ticks. */}
      {[0, 0.25, 0.5, 0.75, 1].map((f) => {
        const value = top * f;
        const gy = y(value);
        return (
          <g key={f}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={gy}
              y2={gy}
              stroke="var(--border-default)"
              strokeDasharray="3 3"
            />
            <text
              x={PAD.left - 8}
              y={gy + 3}
              textAnchor="end"
              fontSize="9"
              fill="var(--text-tertiary)"
            >
              {value.toLocaleString()}
            </text>
          </g>
        );
      })}

      {days.map((d, i) => {
        const x = PAD.left + i * slot + (slot - barW) / 2;
        // The slot is unconditional; only the rect is conditional.
        return (
          <g key={d.date} data-testid="daily-slot" data-tokens={d.tokens}>
            {d.tokens > 0 && (
              <rect
                data-testid="daily-bar"
                x={x}
                y={y(d.tokens)}
                width={barW}
                height={PAD.top + PLOT_H - y(d.tokens)}
                rx="2"
                fill="var(--accent-primary)"
              >
                <title>{`${d.date} · ${d.tokens.toLocaleString()}`}</title>
              </rect>
            )}
            {(!dense || i % 5 === 0) && (
              <text
                x={PAD.left + i * slot + slot / 2}
                y={H - 8}
                textAnchor="middle"
                fontSize="9"
                fill="var(--text-tertiary)"
              >
                {shortDate(d.date)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}