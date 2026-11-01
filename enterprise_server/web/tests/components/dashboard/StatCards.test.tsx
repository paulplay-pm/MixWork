import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  DashboardAgentCounts,
  DashboardHealthBlock,
  DashboardMcpCounts,
  DashboardUserCounts,
} from '../../../src/api/dashboard';
import { ServiceHealth } from '../../../src/components/dashboard/ServiceHealth';
import { StatCards } from '../../../src/components/dashboard/StatCards';
import { setLang } from '../../../src/i18n';

const RANGE = '7d' as const;

// `i18n.ts` keeps the active language in module state, so without this an
// assertion reads whatever the previous test happened to leave behind.
beforeEach(() => setLang('en'));
afterEach(() => setLang('en'));

function renderCards(props: Partial<React.ComponentProps<typeof StatCards>> = {}) {
  return render(
    <MemoryRouter>
      <StatCards
        users={null}
        active={null}
        tokens={null}
        agents={null}
        mcp={null}
        hasUsage
        range={RANGE}
        {...props}
      />
    </MemoryRouter>
  );
}

const USERS: DashboardUserCounts = { total: 58, enabled: 52, disabled: 6 };
const AGENTS: DashboardAgentCounts = { enabled: 12, total: 15 };
const MCP_OK: DashboardMcpCounts = { enabled: 18, total: 18, abnormal: 0, first_abnormal: null };
const MCP_BAD: DashboardMcpCounts = {
  enabled: 18,
  total: 19,
  abnormal: 1,
  first_abnormal: '纷享销客 CRM',
};

describe('dashboard/StatCards', () => {
  test('五张卡按固定顺序渲染', () => {
    setLang('zh');
    renderCards({
      users: USERS,
      active: { value: 34, prev: 30 },
      tokens: { value: 18_240_000, prev: 16_800_000 },
      agents: AGENTS,
      mcp: MCP_OK,
    });
    const labels = screen
      .getAllByTestId('stat-label')
      .map((el) => el.textContent);
    expect(labels).toEqual([
      '总用户数',
      '活跃用户',
      '模型调用量',
      '启用智能体',
      '连接器（MCP）',
    ]);
  });

  test('总用户数副信息展示启用/停用拆分', () => {
    setLang('zh');
    renderCards({ users: USERS });
    expect(screen.getByText('已启用 52 · 停用 6')).toBeInTheDocument();
  });

  test('没有 usage 权限时不渲染活跃用户与模型调用量两张卡', () => {
    setLang('zh');
    renderCards({ users: USERS, agents: AGENTS, mcp: MCP_OK, hasUsage: false });
    const labels = screen.getAllByTestId('stat-label').map((el) => el.textContent);
    expect(labels).toEqual(['总用户数', '启用智能体', '连接器（MCP）']);
  });

  test('连接器卡有异常时副信息为红色并含首个异常名', () => {
    setLang('zh');
    renderCards({ mcp: MCP_BAD });
    const abnormal = screen.getByTestId('stat-mcp-abnormal');
    expect(abnormal).toHaveTextContent('1 个异常');
    expect(abnormal).toHaveClass('text-[var(--danger-primary)]');
    expect(screen.getByTestId('stat-mcp-hint')).toHaveTextContent('纷享销客 CRM');
  });

  test('连接器卡无异常时显示绿色「全部正常」', () => {
    setLang('zh');
    renderCards({ mcp: MCP_OK });
    const ok = screen.getByTestId('stat-mcp-abnormal');
    expect(ok).toHaveTextContent('全部正常');
    expect(ok).toHaveClass('text-[var(--success-primary)]');
  });

  test('环比为新增时渲染「新增」而不是 NaN 或 Infinity', () => {
    setLang('zh');
    renderCards({ active: { value: 12, prev: 0 } });
    expect(screen.getByTestId('stat-delta-active')).toHaveTextContent('新增');
  });

  test('环比为上升时展示带符号的百分比与「较上一周期」', () => {
    setLang('zh');
    renderCards({ active: { value: 34, prev: 30 } });
    const delta = screen.getByTestId('stat-delta-active');
    expect(delta).toHaveTextContent('13.3%');
    expect(delta).toHaveAttribute('data-direction', 'up');
    expect(screen.getAllByText('较上一周期').length).toBeGreaterThan(0);
  });

  test('环比为下降时使用危险色', () => {
    setLang('zh');
    renderCards({ active: { value: 20, prev: 30 } });
    expect(screen.getByTestId('stat-delta-active')).toHaveAttribute('data-direction', 'down');
  });

  test('指标卡链接带上当前时间范围', () => {
    setLang('zh');
    renderCards({ tokens: { value: 100, prev: 50 } });
    const link = screen.getByTestId('stat-link-tokens');
    expect(link).toHaveAttribute('href', '/monitoring/usage?range=7d');
  });
});

const HEALTH: DashboardHealthBlock = {
  checked_at: '2026-04-15T09:00:00.000Z',
  items: [
    { id: 'p1', type: 'model', status: 'err', name_zh: 'Anthropic', name_en: 'Anthropic', latency_ms: 0, last_test_at: '2026-04-15T09:00:00.000Z' },
    { id: 'c1', type: 'mcp', status: 'warn', name_zh: '分贝通报销', name_en: 'Denbi', latency_ms: 4200, last_test_at: '2026-04-15T08:00:00.000Z' },
    { id: 'p2', type: 'model', status: 'ok', name_zh: 'OpenAI', name_en: 'OpenAI', latency_ms: 420, last_test_at: '2026-04-15T07:00:00.000Z' },
    { id: 'c2', type: 'mcp', status: 'unknown', name_zh: 'GitLab', name_en: 'GitLab', latency_ms: null, last_test_at: null },
  ],
};

function renderHealth(props: Partial<React.ComponentProps<typeof ServiceHealth>> = {}) {
  return render(
    <MemoryRouter>
      <ServiceHealth health={HEALTH} mcpAbnormal={1} onRetry={vi.fn()} {...props} />
    </MemoryRouter>
  );
}

describe('dashboard/ServiceHealth', () => {
  test('按 err → warn → ok → unknown 渲染', () => {
    setLang('zh');
    renderHealth();
    expect(screen.getAllByTestId('health-row').map((r) => r.dataset.status)).toEqual([
      'err',
      'warn',
      'ok',
      'unknown',
    ]);
  });

  test('状态不只靠颜色传达：每行都有文字说明', () => {
    setLang('zh');
    renderHealth();
    expect(screen.getByText('连接失败')).toBeInTheDocument();
    expect(screen.getByText('尚未检测')).toBeInTheDocument();
  });

  test('延迟以「平均 xxx ms」展示，失败行不展示延迟', () => {
    setLang('zh');
    renderHealth();
    expect(screen.getByText('平均 420 ms')).toBeInTheDocument();
  });

  test('每行带类型标签', () => {
    setLang('zh');
    renderHealth();
    expect(screen.getAllByText('模型')).toHaveLength(2);
    expect(screen.getAllByText('MCP')).toHaveLength(2);
  });

  test('底部只有「全部服务」跳转，没有重新检测按钮', () => {
    setLang('zh');
    renderHealth();
    // The link renders "全部服务 →", so match on the anchor's own text.
    const all = screen.getByRole('link', { name: /全部服务/ });
    expect(all).toHaveAttribute('href', '/config/mcp-manage');
    expect(screen.queryByText('重新检测')).not.toBeInTheDocument();
    expect(screen.getByText('检测结果来自各配置页的手动测试。')).toBeInTheDocument();
  });

  test('health 为 null（无 mcp:view）时整块不渲染', () => {
    const { container } = renderHealth({ health: null });
    expect(container).toBeEmptyDOMElement();
  });

  test('条目为空时显示空态', () => {
    setLang('zh');
    renderHealth({ health: { checked_at: null, items: [] } });
    expect(screen.getByText('暂无服务可展示。')).toBeInTheDocument();
  });

  test('模型条目跳模型配置页，MCP 条目跳连接器页', () => {
    setLang('zh');
    renderHealth();
    const rows = screen.getAllByTestId('health-row');
    expect(rows[0].closest('a')).toHaveAttribute('href', '/config/providers');
    expect(rows[1].closest('a')).toHaveAttribute('href', '/config/mcp-manage');
  });
});