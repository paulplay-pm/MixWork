import type { Lang } from '../../i18n';

/**
 * Number presentation for the dashboard.
 *
 * Two decisions live here rather than in a component:
 *
 *  - **The unit follows the language.** Chinese reads 万/亿, English reads
 *    K/M/B. A board is read at a glance, and "1824.0 万" on an English console
 *    is a decoding task rather than a number.
 *  - **The delta's "no previous value" case is data, not arithmetic.** A service
 *    that had no calls last period has no meaningful percentage; `0/0` is NaN
 *    and `x/0` is Infinity, and rendering either as a number is worse than
 *    saying "new". That case is why `formatDelta` returns a direction instead
 *    of a pre-formatted string.
 */

const UNITS_ZH: ReadonlyArray<{ limit: number; divisor: number; suffix: string }> = [
  { limit: 1e8, divisor: 1e8, suffix: ' 亿' },
  { limit: 1e4, divisor: 1e4, suffix: ' 万' },
];

const UNITS_EN: ReadonlyArray<{ limit: number; divisor: number; suffix: string }> = [
  { limit: 1e9, divisor: 1e9, suffix: 'B' },
  { limit: 1e6, divisor: 1e6, suffix: 'M' },
  { limit: 1e3, divisor: 1e3, suffix: 'K' },
];

/**
 * A token count at dashboard scale.
 *
 * Below 1,000 there is no unit worth showing, so the raw grouped integer is
 * returned — "999" reads better than "999.0" or "1.0K". Everything above keeps
 * one decimal, which is the precision the card has room for.
 */
export function formatTokens(n: number, lang: Lang): string {
  const abs = Math.abs(n);
  const units = lang === 'zh' ? UNITS_ZH : UNITS_EN;
  const unit = units.find((u) => abs >= u.limit);
  if (!unit) return Math.round(n).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US');
  return `${(n / unit.divisor).toFixed(1)}${unit.suffix}`;
}

export type DeltaDirection = 'up' | 'down' | 'flat' | 'new';

export interface Delta {
  direction: DeltaDirection;
  /** Signed percentage, one decimal, no sign for a rise. Empty for `new` and
   *  `flat`, where there is nothing to read. */
  text: string;
}

/**
 * Period-over-period change.
 *
 * `prev === 0` short-circuits BEFORE the division. `flat` also carries no
 * text: a "0.0%" next to an unchanged number is noise, and the neutral
 * em-dash the card renders instead says the same thing in less space.
 */
export function formatDelta(value: number, prev: number, lang: Lang): Delta {
  void lang;
  if (prev === 0) return { direction: value === 0 ? 'flat' : 'new', text: '' };
  if (value === prev) return { direction: 'flat', text: '' };
  const pct = ((value - prev) / prev) * 100;
  const rounded = pct.toFixed(1);
  return {
    direction: pct > 0 ? 'up' : 'down',
    // `toFixed` keeps the minus sign for a fall; the unit belongs on both.
    text: `${rounded}%`,
  };
}