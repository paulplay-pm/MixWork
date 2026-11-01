import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { DashboardTrend } from '../../../src/api/dashboard';
import { TrendChart } from '../../../src/components/dashboard/TrendChart';
import { setLang } from '../../../src/i18n';

beforeEach(() => setLang('en'));
afterEach(() => setLang('en'));

function daySeries(n: number, tokens = 100): DashboardTrend {
  return {
    granularity: 'day',
    points: Array.from({ length: n }, (_, i) => ({
      key: `2026-04-${String(i + 1).padStart(2, '0')}`,
      label: `04/${String(i + 1).padStart(2, '0')}`,
      tokens: (i + 1) * tokens,
      calls: (i + 1) * 10,
    })),
  };
}

const ZERO: DashboardTrend = { granularity: 'day', points: [] };

describe('dashboard/TrendChart', () => {
  test('渲染 4 条水平网格线', () => {
    render(<TrendChart series={daySeries(7)} range="7d" />);
    expect(screen.getAllByTestId('trend-gridline')).toHaveLength(4);
  });

  test('X 轴标签不超过 7 个，且首尾必显示', () => {
    render(<TrendChart series={daySeries(30)} range="30d" />);
    const labels = screen.getAllByTestId('trend-xlabel').map((el) => el.textContent);
    expect(labels.length).toBeLessThanOrEqual(7);
    expect(labels[0]).toBe('04/01');
    expect(labels.at(-1)).toBe('04/30');
  });

  test('Tokens 为蓝、调用次数为绿，两条线各有一个点集', () => {
    render(<TrendChart series={daySeries(7)} range="7d" />);
    expect(screen.getByTestId('trend-line-tokens')).toHaveAttribute('stroke', '#3b82f6');
    expect(screen.getByTestId('trend-line-calls')).toHaveAttribute('stroke', '#10b981');
  });

  test('每个数据点有空心圆点（白底 + 描边）', () => {
    render(<TrendChart series={daySeries(7)} range="7d" />);
    const dots = screen.getAllByTestId('trend-dot');
    expect(dots).toHaveLength(14); // 7 points × 2 series
    expect(dots[0]).toHaveAttribute('fill', '#fff');
    expect(dots[0].getAttribute('stroke')).toBeTruthy();
  });

  test('全部为零时不渲染坐标轴，改为显示空态', () => {
    render(<TrendChart series={ZERO} range="7d" />);
    expect(screen.getByTestId('trend-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('trend-gridline')).not.toBeInTheDocument();
  });

  test('granularity 为 hour 时 X 轴标签是 HH 形式', () => {
    render(
      <TrendChart
        series={{
          granularity: 'hour',
          points: Array.from({ length: 5 }, (_, i) => ({
            key: `2026-04-15T0${i}`,
            label: `0${i}:00`,
            tokens: 10 * (i + 1),
            calls: i + 1,
          })),
        }}
        range="today"
      />
    );
    expect(screen.getAllByTestId('trend-xlabel')[0]).toHaveTextContent('00:00');
    // The caption names the last bucket, so the reader knows the window stops
    // there rather than at midnight.
    expect(screen.getByTestId('trend-axis-note')).toHaveTextContent('04:00');
  });

  test('可访问性：role=img 与 aria-label，并附数据表兜底', () => {
    render(<TrendChart series={daySeries(7)} range="7d" />);
    expect(screen.getByRole('img')).toHaveAttribute('aria-label');
    expect(screen.getByTestId('trend-table')).toBeInTheDocument();
  });

  test('图例区分 Tokens 与调用次数', () => {
    setLang('zh');
    render(<TrendChart series={daySeries(7)} range="7d" />);
    expect(screen.getByTestId('trend-legend')).toHaveTextContent('Tokens');
    expect(screen.getByTestId('trend-legend')).toHaveTextContent('调用次数');
  });

  test('只有一个数据点时仍渲染（今日范围在 00:00 后立刻打开就是这个形状）', () => {
    render(
      <TrendChart
        series={{
          granularity: 'hour',
          points: [{ key: '2026-04-15T00', label: '00:00', tokens: 4200, calls: 3 }],
        }}
        range="today"
      />
    );
    expect(screen.getByTestId('trend-line-tokens')).toBeInTheDocument();
    // One point is one dot per series, not two, and it is centred rather than
    // pinned to the left axis with the whole plot empty to its right.
    expect(screen.getAllByTestId('trend-dot')).toHaveLength(2);
    expect(screen.getAllByTestId('trend-xlabel')).toHaveLength(1);
    expect(screen.getAllByTestId('trend-gridline')).toHaveLength(4);
  });

  test('全零序列也走空态而不是画一条贴底的平线', () => {
    render(
      <TrendChart
        series={{
          granularity: 'day',
          points: Array.from({ length: 5 }, (_, i) => ({
            key: `2026-04-0${i + 1}`,
            label: `0${i + 1}`,
            tokens: 0,
            calls: 0,
          })),
        }}
        range="7d"
      />
    );
    expect(screen.getByTestId('trend-empty')).toBeInTheDocument();
  });
});