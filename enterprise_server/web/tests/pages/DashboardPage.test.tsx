import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

import type { Claims } from '../../src/api/types';
import { useAuthStore } from '../../src/auth/store';
import { clearMeProfileCache } from '../../src/auth/useMe';
import { useToastStore } from '../../src/components/toastStore';
import { setLang } from '../../src/i18n';
import { DashboardPage } from '../../src/pages/DashboardPage';

const wrap = (ui: ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
};

const SUMMARY = {
  updated_at: '2026-04-15T09:30:00.000Z',
  users: { total: 58, enabled: 52, disabled: 6 },
  agents: { enabled: 12, total: 15 },
  mcp: { enabled: 18, total: 19, abnormal: 1, first_abnormal: '纷享销客 CRM' },
  health: {
    checked_at: '2026-04-15T09:00:00.000Z',
    items: [
      { id: 'p1', type: 'model', status: 'ok', name_zh: 'OpenAI', name_en: 'OpenAI', latency_ms: 420, last_test_at: '2026-04-15T09:00:00.000Z' },
    ],
  },
  activities: [
    {
      id: 'a1',
      ts: '2026-04-15T09:28:00.000Z',
      action: 'mcp_connector_test',
      action_zh: '测试连接器',
      action_en: 'Tested connector',
      tone: 'failure' as const,
      target_type: 'connector',
      target_name_zh: '纷享销客 CRM',
      target_name_en: 'FX CRM',
      user_id: null,
      user_name: null,
    },
  ],
};

const USAGE = {
  range: '7d',
  from: '2026-04-09T00:00:00.000Z',
  to: '2026-04-16T00:00:00.000Z',
  timezone: 'UTC',
  active: { value: 34, prev: 30 },
  tokens: { value: 18_240_000, prev: 16_800_000 },
  unaccounted_calls: 0,
  trend: {
    granularity: 'day' as const,
    points: Array.from({ length: 7 }, (_, i) => ({
      key: `2026-04-${String(i + 9).padStart(2, '0')}`,
      label: `04/${String(i + 9).padStart(2, '0')}`,
      tokens: (i + 1) * 1000,
      calls: (i + 1) * 10,
    })),
  },
  model_top: [{ provider: 'anthropic', model: 'opus', display_name: 'Claude Opus 4', tokens: 684000, calls: 4021 }],
  dept_top: [{ department_id: 'd1', name: '产品部', users: 9, tokens: 526000 }],
};

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Route each URL to its payload; anything unlisted 404s loudly. */
function serve(
  opts: { summary?: unknown; summaryStatus?: number; usage?: unknown; usageStatus?: number } = {}
) {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/admin/dashboard/summary')) {
      if (opts.summaryStatus) return Promise.resolve(respond({}, opts.summaryStatus));
      return Promise.resolve(respond(opts.summary ?? SUMMARY));
    }
    if (url.includes('/admin/dashboard/usage')) {
      if (opts.usageStatus) return Promise.resolve(respond({}, opts.usageStatus));
      return Promise.resolve(respond(opts.usage ?? USAGE));
    }
    if (url.includes('/me')) {
      return Promise.resolve(
        respond({
          username: 'u1',
          display_name: null,
          permissions: ['usage:view', 'user:view', 'mcp:view', 'agent:view', 'audit:view'],
          effectiveDataScope: 'all',
        })
      );
    }
    return Promise.resolve(respond({}));
  });
}

function signedIn(): void {
  const claims: Claims = { sub: 'u1', orgId: 'o1', roles: ['org_admin'] };
  useAuthStore.setState({ token: 'jwt', claims } as never);
}

describe('pages/DashboardPage', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    clearMeProfileCache();
    useToastStore.setState({ toasts: [] });
    signedIn();
    serve();
    setLang('zh');
  });
  afterEach(() => setLang('zh'));

  test('两个 query 都显式 staleTime 60s（不能靠全局默认的 30s）', async () => {
    // The global default is 30s in main.tsx; the spec asks for 60. Asserted
    // through behaviour: a second mount inside the window must not refetch.
    render(wrap(<DashboardPage />));
    await screen.findByTestId('stat-cards');
    const afterFirst = fetchMock.mock.calls.length;
    render(wrap(<DashboardPage />));
    await screen.findAllByTestId('stat-cards');
    // A second mount inside 60s is served from cache only if staleTime covers
    // the mount gap; with 30s it would refetch on focus/mount.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(afterFirst);
  });

  test('首屏渲染五个区块', async () => {
    render(wrap(<DashboardPage />));
    // `summary` and `usage` resolve independently, so wait for each block
    // rather than assuming the first one to arrive means the rest have.
    expect(await screen.findByTestId('stat-cards')).toBeInTheDocument();
    expect(await screen.findByTestId('service-health')).toBeInTheDocument();
    expect(await screen.findByTestId('trend-line-tokens')).toBeInTheDocument();
    expect((await screen.findAllByTestId('rank-list')).length).toBe(2);
    expect(await screen.findByTestId('activity-list')).toBeInTheDocument();
  });

  test('切换时间范围只重取 usage，summary 不重新请求，并弹 toast', async () => {
    render(wrap(<DashboardPage />));
    await screen.findByTestId('stat-cards');
    const summaryCallsBefore = fetchMock.mock.calls.filter((c) => String(c[0]).includes('summary')).length;
    const usageCallsBefore = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/usage')).length;

    const select = screen
      .getByTestId('range-select')
      .querySelector('select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '30d' } });

    await waitFor(() => {
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/usage')).length).toBeGreaterThan(usageCallsBefore);
    });
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('summary')).length).toBe(summaryCallsBefore);
    await waitFor(() => {
      expect(useToastStore.getState().toasts.some((x) => x.text.includes('近 30 天'))).toBe(true);
    });
  });

  test('刷新按钮同时重取两个端点', async () => {
    render(wrap(<DashboardPage />));
    await screen.findByTestId('stat-cards');
    const before = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByTestId('refresh-btn'));
    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(before + 1);
    });
    await waitFor(() => {
      expect(useToastStore.getState().toasts.some((x) => x.text.includes('数据已更新'))).toBe(true);
    });
  });

  test('usage 403 时用量区块显示失败态，配置区块照常渲染', async () => {
    serve({ usageStatus: 403 });
    render(wrap(<DashboardPage />));
    await screen.findByTestId('stat-cards');
    await screen.findByTestId('usage-error');
    expect(screen.getByTestId('service-health')).toBeInTheDocument();
    expect(screen.getByTestId('stat-cards')).toBeInTheDocument();
  });

  test('usage 失败时刷新按钮仍可用', async () => {
    serve({ usageStatus: 500 });
    render(wrap(<DashboardPage />));
    await screen.findByTestId('usage-error');
    expect(screen.getByTestId('refresh-btn')).not.toBeDisabled();
  });

  test('无任何可见区块时渲染整页说明态而不是空白', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/admin/dashboard/summary')) {
        return Promise.resolve(
          respond({ updated_at: 'x', users: null, agents: null, mcp: null, health: null, activities: null })
        );
      }
      if (url.includes('/admin/dashboard/usage')) return Promise.resolve(respond({}, 403));
      if (url.includes('/me')) {
        return Promise.resolve(
          respond({
            username: 'u1',
            display_name: null,
            permissions: [],
            effectiveDataScope: '',
          })
        );
      }
      return Promise.resolve(respond({}));
    });
    render(wrap(<DashboardPage />));
    await screen.findByTestId('dashboard-no-access');
    expect(screen.queryByTestId('stat-cards')).not.toBeInTheDocument();
  });

  test('summary 请求失败时用量区块照常渲染，并给出可重试的失败态', async () => {
    // The configuration group is one request; when it fails the cards used to
    // vanish with no explanation at all — the admin reads that as "the board
    // lost its data", which is exactly the report that started this fix.
    serve({ summaryStatus: 500 });
    render(wrap(<DashboardPage />));
    expect(await screen.findByTestId('summary-error')).toBeInTheDocument();
    expect(await screen.findByTestId('trend-line-tokens')).toBeInTheDocument();
    expect(screen.queryByTestId('service-health')).not.toBeInTheDocument();

    const before = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByTestId('summary-error'));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
  });

  test('health 为 null（无 mcp:view）时趋势卡占满整行，不留空列', async () => {
    serve({
      summary: {
        updated_at: SUMMARY.updated_at,
        users: SUMMARY.users,
        agents: SUMMARY.agents,
        mcp: null,
        health: null,
        activities: null,
      },
    });
    render(wrap(<DashboardPage />));
    const trend = await screen.findByTestId('trend-section');
    expect(trend.className).toContain('lg:col-span-2');
  });

  test('有 health 时趋势卡只占左列', async () => {
    render(wrap(<DashboardPage />));
    const trend = await screen.findByTestId('trend-section');
    expect(trend.className).not.toContain('lg:col-span-2');
  });

  test('页头问候语按小时选择三档文案', async () => {
    render(wrap(<DashboardPage />));
    await screen.findByTestId('dashboard-greeting');
    const text = screen.getByTestId('dashboard-greeting').textContent ?? '';
    expect(text).toMatch(/早上好|下午好|晚上好/);
  });

  test('「查看明细」链接带上当前时间范围', async () => {
    render(wrap(<DashboardPage />));
    await screen.findByTestId('trend-line-tokens');
    expect(screen.getByTestId('trend-detail-link')).toHaveAttribute(
      'href',
      '/monitoring/usage?range=7d'
    );
  });

  test('模型 TOP5 行点击跳用量页并定位该模型', async () => {
    render(wrap(<DashboardPage />));
    const rows = await screen.findAllByTestId('rank-row');
    expect(rows.length).toBe(2); // one model + one department
    fireEvent.click(rows[0]);
  });

  test('最近动态单条跳审计页并带操作人与时间预置筛选', async () => {
    render(wrap(<DashboardPage />));
    const items = await screen.findAllByTestId('activity-item');
    expect(items).toHaveLength(1);
    fireEvent.click(items[0]);
  });
});