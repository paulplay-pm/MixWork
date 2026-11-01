import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { DashboardActivity } from '../../../src/api/dashboard';
import { ActivityFeed } from '../../../src/components/dashboard/ActivityFeed';
import { RankBars } from '../../../src/components/dashboard/RankBars';
import { setLang } from '../../../src/i18n';

beforeEach(() => setLang('en'));
afterEach(() => setLang('en'));

const ROWS = [
  { id: 'a', name: 'Claude Opus 4', tokens: 684_000 },
  { id: 'b', name: 'DeepSeek V4', tokens: 412_000 },
  { id: 'c', name: 'Doubao Seed 1.8', tokens: 306_000 },
  { id: 'd', name: 'GPT-5.2', tokens: 248_000 },
  { id: 'e', name: 'Qwen3 Max', tokens: 174_000 },
];

describe('dashboard/RankBars', () => {
  test('条形宽度相对第一名归一化，而不是占总量的百分比', () => {
    render(<RankBars rows={ROWS} emptyText="none" />);
    const widths = screen
      .getAllByTestId('rank-fill')
      .map((el) => (el as HTMLElement).style.width);
    expect(widths[0]).toBe('100%');
    // 412000 / 684000 = 60.2%, NOT 412000 / 1824000 = 22.6%
    expect(widths[1]).toBe('60.2%');
  });

  test('只有一行时该行占满 100%', () => {
    render(<RankBars rows={[{ id: 'x', name: 'Only', tokens: 7 }]} emptyText="none" />);
    expect((screen.getByTestId('rank-fill') as HTMLElement).style.width).toBe('100%');
  });

  test('全部为 0 时不产生 NaN 宽度', () => {
    render(
      <RankBars
        rows={[
          { id: 'x', name: 'A', tokens: 0 },
          { id: 'y', name: 'B', tokens: 0 },
        ]}
        emptyText="none"
      />
    );
    screen.getAllByTestId('rank-fill').forEach((el) => {
      expect((el as HTMLElement).style.width).not.toContain('NaN');
    });
  });

  test('前 3 名徽标样式不同，第 4 名起用默认样式', () => {
    render(<RankBars rows={ROWS} emptyText="none" />);
    const ranks = screen.getAllByTestId('rank-badge');
    expect(ranks.map((r) => r.textContent)).toEqual(['1', '2', '3', '4', '5']);
    expect(ranks[0].className).not.toBe(ranks[3].className);
    expect(ranks[3].className).toBe(ranks[4].className);
  });

  test('空数组渲染 emptyText 而不是空白', () => {
    render(<RankBars rows={[]} emptyText="暂无模型用量数据" />);
    expect(screen.getByText('暂无模型用量数据')).toBeInTheDocument();
    expect(screen.queryAllByTestId('rank-row')).toHaveLength(0);
  });

  test('数值走 formatTokens（中文万 / 英文 M）', () => {
    setLang('zh');
    const { unmount } = render(<RankBars rows={ROWS} emptyText="none" />);
    expect(screen.getByText('68.4 万')).toBeInTheDocument();
    unmount();
    setLang('en');
    render(<RankBars rows={ROWS} emptyText="none" />);
    expect(screen.getByText('684.0K')).toBeInTheDocument();
  });

  test('副信息（部门人数）渲染在名称旁', () => {
    setLang('zh');
    render(
      <RankBars rows={[{ id: 'd', name: '产品部', tokens: 100, sublabel: '9 人' }]} emptyText="none" />
    );
    expect(screen.getByTestId('rank-sublabel')).toHaveTextContent('9 人');
  });

  test('点击行触发 onRowClick 并带上 id', () => {
    const seen: string[] = [];
    render(<RankBars rows={ROWS} emptyText="none" onRowClick={(id) => seen.push(id)} />);
    screen.getAllByTestId('rank-row')[1].click();
    expect(seen).toEqual(['b']);
  });
});

function activity(over: Partial<DashboardActivity> = {}): DashboardActivity {
  return {
    id: 'x',
    ts: '2026-04-15T09:00:00.000Z',
    action: 'provider_key_update',
    action_zh: '更新服务商密钥',
    action_en: 'Updated provider key',
    tone: 'change',
    target_type: 'provider_key',
    target_name_zh: 'OpenAI',
    target_name_en: 'OpenAI',
    user_id: 'u1',
    user_name: '张伟',
    ...over,
  };
}

describe('dashboard/ActivityFeed', () => {
  test('按活动数渲染，每条含动作与操作人', () => {
    setLang('zh');
    render(<ActivityFeed activities={[activity()]} />);
    expect(screen.getByTestId('activity-item')).toHaveTextContent('更新服务商密钥');
    expect(screen.getByTestId('activity-item')).toHaveTextContent('张伟');
  });

  test('tone 映射到四种语义颜色', () => {
    render(
      <ActivityFeed
        activities={[
          activity({ id: '1', tone: 'failure' }),
          activity({ id: '2', tone: 'danger' }),
          activity({ id: '3', tone: 'change' }),
          activity({ id: '4', tone: 'auth' }),
          activity({ id: '5', tone: 'success' }),
          activity({ id: '6', tone: 'normal' }),
        ]}
      />
    );
    const tones = screen.getAllByTestId('activity-dot').map((d) => d.dataset.tone);
    expect(new Set(tones)).toEqual(
      new Set(['failure', 'danger', 'change', 'auth', 'success', 'normal'])
    );
  });

  test('userId 为 null 时操作人渲染 i18n 的系统文案', () => {
    setLang('zh');
    render(<ActivityFeed activities={[activity({ user_id: null, user_name: null })]} />);
    expect(screen.getByTestId('activity-item')).toHaveTextContent('系统');
  });

  test('目标名为 null 时不渲染 UUID，只显示动作与操作人', () => {
    setLang('zh');
    render(
      <ActivityFeed
        activities={[
          activity({
            target_type: 'unknown_type',
            target_name_zh: null,
            target_name_en: null,
            action_zh: '检测到一次登录失败',
          }),
        ]}
      />
    );
    const item = screen.getByTestId('activity-item');
    expect(item).not.toHaveTextContent('undefined');
    expect(item).not.toHaveTextContent('null');
    expect(item).toHaveTextContent('检测到一次登录失败');
  });

  test('英文界面读 action_en 与 target_name_en', () => {
    render(
      <ActivityFeed
        activities={[
          activity({ action_en: 'Updated provider key', target_name_en: 'OpenAI' }),
        ]}
      />
    );
    const item = screen.getByTestId('activity-item');
    expect(item).toHaveTextContent('Updated provider key');
    expect(item).toHaveTextContent('OpenAI');
  });

  test('时间按 HH:mm / 昨天 HH:mm / MM-DD HH:mm 三档', () => {
    // Built from LOCAL components, not ISO strings: this label is relative to
    // the reader's own clock, so an ISO fixture silently means a different
    // hour on a machine in another zone.
    setLang('zh');
    const at = (y: number, m: number, d: number, h: number): string =>
      new Date(y, m - 1, d, h, 0, 0, 0).toISOString();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 15, 18, 0, 0, 0));
    try {
      render(
        <ActivityFeed
          activities={[
            activity({ id: 'today', ts: at(2026, 4, 15, 9) }),
            activity({ id: 'yday', ts: at(2026, 4, 14, 9) }),
            activity({ id: 'old', ts: at(2026, 3, 20, 9) }),
          ]}
        />
      );
      const times = screen.getAllByTestId('activity-time').map((el) => el.textContent);
      expect(times).toEqual(['09:00', '昨天 09:00', '03-20 09:00']);
    } finally {
      vi.useRealTimers();
    }
  });

  test('空数组不渲染条目', () => {
    const { container } = render(<ActivityFeed activities={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('点击单条触发 onItemClick', () => {
    const seen: string[] = [];
    render(<ActivityFeed activities={[activity()]} onItemClick={(a) => seen.push(a.id)} />);
    screen.getByTestId('activity-item').click();
    expect(seen).toEqual(['x']);
  });
});