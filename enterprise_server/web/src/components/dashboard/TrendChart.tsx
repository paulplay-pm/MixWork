import type { JSX } from 'react';
import { useState } from 'react';

import type { UsageRangeKey } from '../../analytics/range';
import type { DashboardTrend } from '../../api/dashboard';
import { getLang, t } from '../../i18n';
import { formatTokens } from './format';

export interface TrendChartProps {
  series: DashboardTrend;
  range: UsageRangeKey;
}

/** Fixed viewBox: hand-written SVG against a fixed coordinate system, exactly
 *  as `DailyBarChart` does. No chart library is in the dependency set, and
 *  this needs neither a ResizeObserver nor real layout to render identically
 *  in jsdom and in the browser. */
const W = 720;
const H = 240;
const PAD = { top: 12, right: 10, bottom: 26, left: 52 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

const COLOR_TOKENS = '#3b82f6';
const COLOR_CALLS = '#10b981';
const AXIS_TEXT = '#8a9bad';

/** At most this many x labels; the axis stays readable at 30 points. */
const MAX_X_LABELS = 7;

/** Round `v` up to the next 1/2/5 × 10ⁿ so the topmost gridline reads `200`
 *  rather than `187`. */
function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  const exp = Math.floor(Math.log10(v));
  const mag = 10 ** exp;
  const f = v / mag;
  const mult = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return mult * mag;
}

/**
 * Tokens against calls.
 *
 * The two series are different units — a token count and a request count — so
 * they cannot share one axis without one of them reading as "wrong". They are
 * drawn against their own maxima, mapped onto the same plot box, and the
 * caption says so: the second line's SHAPE is meaningful, its position against
 * the left axis is not. The exact numbers are in the tooltip and in the table
 * beneath the chart for anyone who needs them.
 *
 * An all-zero series is not drawn at all. A flat line pinned to the axis floor
 * reads as "measured, and nothing happened"; an explicit empty state reads as
 * "there is nothing here", which is what is true.
 */
export function TrendChart({ series, range }: TrendChartProps): JSX.Element {
  const lang = getLang();
  const [hover, setHover] = useState<number | null>(null);
  const points = series.points;
  const hasData = points.some((p) => p.tokens > 0 || p.calls > 0);

  if (!hasData) {
    return (
      <p
        data-testid="trend-empty"
        className="flex h-[200px] items-center justify-center text-xs text-[var(--text-tertiary)]"
      >
        {t('dashboard.trend.empty')}
      </p>
    );
  }

  const topTokens = niceCeil(Math.max(...points.map((p) => p.tokens)));
  const topCalls = Math.max(...points.map((p) => p.calls), 1);
  const slot = PLOT_W / points.length;
  // Single point: centre it, otherwise a lone point sits on the axis with the
  // whole plot to its right.
  const x = (i: number): number =>
    points.length === 1 ? PAD.left + PLOT_W / 2 : PAD.left + i * slot + slot / 2;
  const yTokens = (v: number): number => PAD.top + PLOT_H - (v / topTokens) * PLOT_H;
  const yCalls = (v: number): number => PAD.top + PLOT_H - (v / topCalls) * PLOT_H;

  const path = (project: (v: number) => number, pick: (p: DashboardTrend['points'][number]) => number) =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${project(pick(p)).toFixed(1)}`).join(' ');

  const step = Math.max(1, Math.ceil(points.length / MAX_X_LABELS));
  const labelIdx = points
    .map((_, i) => i)
    .filter((i) => i % step === 0 || i === points.length - 1)
    .filter((v, i, arr) => arr.indexOf(v) === i);

  const areaPath =
    points.length > 1
      ? `${path(yTokens, (p) => p.tokens)} L${x(points.length - 1).toFixed(1)},${PAD.top + PLOT_H} L${x(0).toFixed(1)},${PAD.top + PLOT_H} Z`
      : '';

  const hovered = hover === null ? null : points[hover];

  return (
    <div className="relative">
      <div
        data-testid="trend-legend"
        className="mb-1 flex items-center justify-end gap-3 text-[11px] text-[var(--text-secondary)]"
      >
        <span className="flex items-center gap-1">
          <i className="inline-block h-2 w-2 rounded-sm" style={{ background: COLOR_TOKENS }} />
          {t('dashboard.trend.tokens')}
        </span>
        <span className="flex items-center gap-1">
          <i className="inline-block h-2 w-2 rounded-sm" style={{ background: COLOR_CALLS }} />
          {t('dashboard.trend.calls')}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={`${t('dashboard.trend.title')} — ${t('dashboard.trend.tokens')} / ${t('dashboard.trend.calls')}`}
      >
        {/* Four dashed gridlines, per spec §6.3 and the acceptance list. The
            baseline is a solid axis, not a fifth gridline — that is what keeps
            the count at four while the labels stay on round quarters. */}
        {[0.25, 0.5, 0.75, 1].map((f) => {
          const value = topTokens * f;
          const gy = yTokens(value);
          return (
            <g key={f}>
              <line
                data-testid="trend-gridline"
                x1={PAD.left}
                x2={W - PAD.right}
                y1={gy}
                y2={gy}
                stroke="#e8ecf0"
                strokeDasharray="3 4"
              />
              <text x={PAD.left - 8} y={gy + 3} textAnchor="end" fontSize="10" fill={AXIS_TEXT}>
                {formatTokens(value, lang)}
              </text>
            </g>
          );
        })}
        <line
          data-testid="trend-axis-line"
          x1={PAD.left}
          x2={W - PAD.right}
          y1={PAD.top + PLOT_H}
          y2={PAD.top + PLOT_H}
          stroke="#dde3ea"
        />

        {labelIdx.map((i) => (
          <text
            key={i}
            data-testid="trend-xlabel"
            x={x(i)}
            y={H - 8}
            textAnchor="middle"
            fontSize="10"
            fill={AXIS_TEXT}
          >
            {points[i].label}
          </text>
        ))}

        {areaPath && <path d={areaPath} fill={COLOR_TOKENS} opacity="0.06" />}
        <path
          data-testid="trend-line-tokens"
          d={path(yTokens, (p) => p.tokens)}
          fill="none"
          stroke={COLOR_TOKENS}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <path
          data-testid="trend-line-calls"
          d={path(yCalls, (p) => p.calls)}
          fill="none"
          stroke={COLOR_CALLS}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {points.map((p, i) => (
          <g key={p.key}>
            <circle data-testid="trend-dot" cx={x(i)} cy={yTokens(p.tokens)} r="3" fill="#fff" stroke={COLOR_TOKENS} strokeWidth="2" />
            <circle data-testid="trend-dot" cx={x(i)} cy={yCalls(p.calls)} r="3" fill="#fff" stroke={COLOR_CALLS} strokeWidth="2" />
            {/* One transparent hit target per slot, focusable so the tooltip is
                reachable without a pointer. */}
            <rect
              data-testid="trend-hit"
              x={PAD.left + i * slot}
              y={PAD.top}
              width={slot}
              height={PLOT_H}
              fill="transparent"
              tabIndex={0}
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onBlur={() => setHover(null)}
            >
              <title>{`${p.label} · ${formatTokens(p.tokens, lang)} · ${p.calls}`}</title>
            </rect>
          </g>
        ))}
      </svg>

      {hovered && (
        <div
          data-testid="trend-tooltip"
          role="status"
          className="pointer-events-none absolute z-10 rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] px-2 py-1.5 text-[11px] shadow-md"
          style={{
            left: `${((x(hover!) - PAD.left) / PLOT_W) * 100}%`,
            top: 0,
            transform: 'translate(-50%, -100%)',
          }}
        >
          <div className="font-medium text-[var(--text-primary)]">{hovered.label}</div>
          <div className="text-[var(--text-secondary)]">
            {t('dashboard.trend.tokens')}: {formatTokens(hovered.tokens, lang)}
          </div>
          <div className="text-[var(--text-secondary)]">
            {t('dashboard.trend.calls')}: {hovered.calls}
          </div>
        </div>
      )}

      <p data-testid="trend-axis-note" className="mt-1 text-[11px] text-[var(--text-tertiary)]">
        {t('dashboard.trend.axisNote')}
        {series.granularity === 'hour' ? ` ${t('dashboard.trend.untilNow').replace('{time}', points.at(-1)?.label ?? '')}` : ''}
      </p>

      <table className="sr-only" data-testid="trend-table">
        <caption>{t('dashboard.trend.title')}</caption>
        <thead>
          <tr>
            <th scope="col">{range}</th>
            <th scope="col">{t('dashboard.trend.tokens')}</th>
            <th scope="col">{t('dashboard.trend.calls')}</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.key}>
              <td>{p.label}</td>
              <td>{p.tokens}</td>
              <td>{p.calls}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}