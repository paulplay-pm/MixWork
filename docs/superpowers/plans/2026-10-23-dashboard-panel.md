# 管理台「面板」 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `enterprise_server/web` 的 `/` 占位块替换为真正的「面板」首页——五张指标卡、双折线调用趋势、只读服务健康、模型 TOP5、最近动态、部门用量排行——并补齐其依赖的两个服务端聚合端点。

**Architecture:** 服务端新增 `src/analytics/dashboard.ts`（纯 SQL 聚合）与 `src/routes/admin/dashboard.ts`（两个 GET，按权限点裁剪 payload）。前端新增 `web/src/api/dashboard.ts` 与 `web/src/components/dashboard/` 下的五个组件，页面 `web/src/pages/DashboardPage.tsx` 用 react-query 拉两个端点。端点拆两个而非 PRD 建议的一个，是为了让没有 `usage:view` 的成员仍能拿到配置类那半边，并让两组数据各自独立降级。

**Tech Stack:** Hono + Postgres（测试用 pglite）+ Vitest；React 19 + Vite + Tailwind v4 + @tanstack/react-query + lucide-react + Testing Library。

**Spec:** `docs/superpowers/specs/2026-10-23-dashboard-panel-design.md`（与本计划一起读；本计划在 spec ��有结论的地方做取舍）

## Global Constraints

- 路由挂在根：`/admin/dashboard/summary`、`/admin/dashboard/usage`，**不是** `/api/dashboard/*`。
- `orgId` 永远来自 JWT claims，**绝不**接受查询参数。
- 时间范围 key 复用 `UsageRangeKey`（`today | 7d | 30d | this_month | last_month`），前端永不发日期字符串。
- 不新增数据库迁移。不引入任何新依赖（无图表库）。
- 颜色/圆角/阴影一律用 `web/src/index.css` 已有的 CSS 变量，不新增第二套 token。
- 不在服务端硬编码任何用户可见文案（含「未分配」「系统」）；一律 `null` + 前端 i18n 键。
- 用户可见文案必须同时写入 `web/src/i18n.ts` 的 `en` 与 `zh` 两份字典，键名前缀 `dashboard.`。
- 服务端测试**按文件跑**（整包 vitest 在本机会撞 fd 上限 EBADF）：`npx vitest run tests/<file>`。
- 每个任务结束提交一次，commit message 用 Conventional Commits（英文）。

## Review Focus

以下是 spec 暗示、但没有哪条任务显式测到的输入/失效模式。每条都在下方对应任务的步骤里补了钉住它的测试。

1. **一个只有 `agent:view` 的普通成员登录** → 面板只剩一张卡片，其余区块不渲染，且**不是**空白页（有整页说明态）。
2. **`prev === 0` 的环比**（新上线的服务当天接入）→ 显示「新增」而不是 `Infinity%`/`NaN%`。
3. **`last_month` 选 3 月（上期长度 31 天）** → 上期必须是 2 月，不是 1/29–2/28。
4. **`token_usage.total_tokens` 累计超过 `INTEGER` 上限** → `SUM` 必须 `::bigint`，否则溢出成负数。
5. **`orgs.timezone` 是一个 `Intl` 不认的字符串** → 面板不能 500，退化到浏览器时区（`analytics/range.ts` 的 `safeZone` 已覆盖，新增代码不得绕过它）。

---

### Task 1: `resolvePreviousUsageRange`（环比上期窗口）

**Files:**
- Modify: `enterprise_server/src/analytics/range.ts`（把 `addDays` / `monthStart` 从模块私有改为 `export`；新增 `resolvePreviousUsageRange`）
- Test: `enterprise_server/tests/analytics/previousRange.test.ts`（新建）

**Interfaces:**
- Consumes: 现有 `UsageRange`、`ResolvedRange`、`boundsFor`、`assemble`、`orgZone`、`daysBetween`（均在该模块内）
- Produces:
  ```ts
  export function addDays(day: string, n: number): string
  export function monthStart(day: string): string
  export async function resolvePreviousUsageRange(orgId: string, range: UsageRange): Promise<ResolvedRange>
  ```
  返回的 `ResolvedRange` 中 `days` 为上期覆盖的日键数组；`key` 沿用传入的 `range`（调用方靠 `from`/`to` 区分本期与上期）。

- [ ] **Step 1: 写失败测试**

新建 `tests/analytics/previousRange.test.ts`，照抄 `tests/analytics/range.test.ts` 的头部（`import '../helpers/setupEnv'`、`vi.mock('../../src/db/pool', …)`、`seedOrg`、`localDayIn`），然后：

```ts
import { resolvePreviousUsageRange, resolveUsageRange, UsageRange } from '../../src/analytics/range';

const NOW = new Date('2026-04-15T09:30:00Z');   // 用 UTC 组织，4/15 09:30

async function prev(range: typeof UsageRange[keyof typeof UsageRange]) {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  try { return await resolvePreviousUsageRange('o1', range); }
  finally { vi.useRealTimers(); }
}
```

断言（`seedOrg('UTC')` 后）：

```ts
test('7d 的上期是紧邻的等长 7 天', async () => {
  await seedOrg('UTC');
  const r = await prev(UsageRange.Last7Days);
  expect(r.days).toHaveLength(7);
  expect(r.days[0]).toBe('2026-04-02');   // 4/8 起往前推 7 天
  expect(r.days[6]).toBe('2026-04-08');
});

test('last_month(3月,31天) 的上期是 2 月而不是 1/29–2/28', async () => {
  await seedOrg('UTC');
  const r = await prev(UsageRange.LastMonth);
  expect(r.days[0]).toBe('2026-02-01');
  expect(r.days.at(-1)).toBe('2026-02-28');
  expect(r.days).toHaveLength(28);          // 2026 非闰年
});

test('this_month 的上期是完整的上一个月', async () => {
  // boundsFor(ThisMonth) 返回 [4/1, 5/1)，即**整月**而非已过天数 —— 这是用量页
  // 既有行为，面板必须与之一致（未来几天没有数据行，不影响聚合）。所以 L = 31，
  // 上期是 3 月整月，而不是「3/1–3/15」。
  await seedOrg('UTC');
  const r = await prev(UsageRange.ThisMonth);
  expect(r.days[0]).toBe('2026-03-01');
  expect(r.days.at(-1)).toBe('2026-03-31');
  expect(r.days).toHaveLength(31);
});

test('today 的上期右界截断到当前墙钟时刻', async () => {
  await seedOrg('UTC');
  const r = await prev(UsageRange.Today);
  const hour = r.to.getUTCHours();
  const minute = r.to.getUTCMinutes();
  expect(hour).toBe(9);
  expect(minute).toBe(30);
  expect(r.to.getTime()).toBeLessThan(NOW.getTime());
});

test('本期窗口的 to 不被截断，与用量页一致', async () => {
  await seedOrg('UTC');
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  try {
    const cur = await resolveUsageRange('o1', UsageRange.Today);
    expect(cur.to.getTime()).toBe(new Date('2026-04-16T00:00:00Z').getTime());
  } finally { vi.useRealTimers(); }
});

test('未知范围抛错', async () => {
  await seedOrg('UTC');
  await expect(prev('nope' as never)).rejects.toThrow(/unknown usage range/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd enterprise_server && npx vitest run tests/analytics/previousRange.test.ts`
Expected: FAIL —— `resolvePreviousUsageRange` 未导出（`TypeError: resolvePreviousUsageRange is not a function`）。

- [ ] **Step 3: 实现**

在 `src/analytics/range.ts` 中：

1. 给 `addDays` 与 `monthStart` 加 `export`（函数体不动）。
2. 在 `resolveUsageRange` 之后新增：

```ts
export async function resolvePreviousUsageRange(orgId: string, range: UsageRange): Promise<ResolvedRange> {
  if (!USAGE_RANGE_KEYS.has(range)) throw new Error(`unknown usage range: ${range}`);
  const zone = await orgZone(orgId);
  const today = formatInTimeZone(new Date(), zone, 'yyyy-MM-dd');
  const { fromDay, toDayExclusive } = boundsFor(range, today);
  const len = daysBetween(fromDay, toDayExclusive).length;
  if (range === UsageRange.ThisMonth || range === UsageRange.LastMonth) {
    // The two month ranges are anchored on a month boundary, NOT on an equal
    // length: shifting 3/1 back by March's 31 days lands on 1/29, not 2/1.
    const prevStart = monthStart(addMonths(fromDay, -1));
    const prevEnd = range === UsageRange.ThisMonth ? addDays(prevStart, len) : fromDay;
    return assemble(range, prevStart, prevEnd, zone);
  }
  if (range === UsageRange.Today) {
    const base = assemble(range, addDays(today, -1), today, zone);
    // Clip the right edge to the same wall clock as "now" in the org zone: a
    // full "yesterday" compared against "today so far" inflates the delta.
    const nowMinute = Number(formatInTimeZone(new Date(), zone, 'm'));
    const nowHour = Number(formatInTimeZone(new Date(), zone, 'H'));
    return { ...base, to: new Date(base.from.getTime() + (nowHour * 60 + nowMinute) * 60000) };
  }
  return assemble(range, addDays(fromDay, -len), fromDay, zone);
}
```

（`addMonths` 已是该模块内既有私有函数，直接用。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd enterprise_server && npx vitest run tests/analytics/previousRange.test.ts tests/analytics/range.test.ts`
Expected: 两个文件全部 PASS（`range.test.ts` 用来证明改 `export` 没破坏既有行为）。

- [ ] **Step 5: 提交**

```bash
git add enterprise_server/src/analytics/range.ts enterprise_server/tests/analytics/previousRange.test.ts
git commit -m "feat(analytics): resolve the previous comparison window per range"
```

---

### Task 2: 配置类聚合查询（`queryDashboardSummary`）

**Files:**
- Create: `enterprise_server/src/analytics/dashboard.ts`
- Test: `enterprise_server/tests/analytics/dashboardSummary.test.ts`

**Interfaces:**
- Consumes: `pool`（`../db/pool`）、`queryAudit` + `AuditListFilters`（`./auditQuery`）、`AuditAction`（`../shared/enterpriseServerConstants`）
- Produces:
  ```ts
  export type HealthStatus = 'ok' | 'warn' | 'err' | 'unknown';
  export type HealthKind = 'model' | 'mcp';

  export interface UserCounts   { total: number; enabled: number; disabled: number }
  export interface AgentCounts  { enabled: number; total: number }
  export interface McpCounts    { enabled: number; total: number; abnormal: number; firstAbnormal: string | null }
  export interface HealthItem   { id: string; kind: HealthKind; status: HealthStatus;
                                  nameZh: string; nameEn: string;
                                  latencyMs: number | null; lastTestAt: string | null }
  export interface HealthBlock  { checkedAt: string | null; items: HealthItem[] }
  export interface ActivityItem  { id: string; ts: string; action: string;
                                   actionZh: string; actionEn: string; tone: string;
                                   targetType: string | null; targetNameZh: string | null;
                                   targetNameEn: string | null;
                                   userId: string | null; userName: string | null }

  export interface DashboardSummary {
    users: UserCounts | null;
    agents: AgentCounts | null;
    mcp: McpCounts | null;
    health: HealthBlock | null;
    activities: ActivityItem[] | null;
  }

  export async function queryUserCounts(orgId: string): Promise<UserCounts>
  export async function queryAgentCounts(): Promise<AgentCounts>
  export async function queryMcpCounts(orgId: string): Promise<McpCounts>
  export async function queryHealth(args: { orgId: string; includeModel: boolean; includeMcp: boolean; limit?: number }): Promise<HealthBlock>
  export async function queryActivities(orgId: string, limit?: number): Promise<ActivityItem[]>
  ```

- [ ] **Step 1: 写失败测试**

新建 `tests/analytics/dashboardSummary.test.ts`。头部照抄 `tests/analytics/usageModels.test.ts`（`vi.mock('../../src/db/pool')` + `resetSchema/runMigrations/testPool`），并建这些 seed 辅助：

```ts
async function user(id: string, status = 'active', deptId: string | null = null): Promise<void>
async function dept(id: string, name: string, parentId: string | null): Promise<void>   // 写 path
async function mcp(id: string, opts: { enabled?: boolean; status?: string | null; latency?: number | null; testedAt?: string | null; zh?: string; en?: string })
async function providerKey(id: string, opts: { enabled?: boolean; status?: string; latency?: number | null; testedAt?: string | null; label?: string | null; provider?: string })
```

（`provider_keys.created_by` 与 `token_usage.user_id` 都外键引用 `users(id)`，seed 必须先建 user；`dept()` 的 `path` 按 `orgService` 的规则写：根部门 `/${name}`，子部门 `${parent.path}/${name}`。）

断言：

```ts
test('userCounts 按 status 拆分', ...)
  // 3 个 active + 2 个 disabled → { total: 5, enabled: 3, disabled: 2 }

test('agentCounts 统计 enabled', ...)
  // agent_marketplace_agents 插 3 条（2 enabled）→ { enabled: 2, total: 3 }

test('mcpCounts 的 abnormal 只数 enabled 且 last_test_status=failed 的行，且不受列表截断影响', ...)
  // 4 个连接器：1 failed+enabled、1 failed+disabled、1 connected、1 未测
  // → { enabled: 3, total: 4, abnormal: 1, firstAbnormal: '纷享销客 CRM' }

test('health 把 failed 排第一、unknown 排最后，各状态内按 last_test_at 倒序', ...)
  // provider_keys: 1 connected(400ms) + 1 connected(5000ms) + 1 failed
  // → status 顺序 ['err','warn','ok']

test('health 的 latencyMs>3000 判为 warn、<=3000 判为 ok、last_test_at 为 null 判为 unknown', ...)

test('health 的 includeModel=false 时不返回模型服务商条目，checked_at 也只按可见行取最大', ...)

test('activities 取最近 6 条、排除 provider_call、包含 login_events 的登录失败', ...)
  // audit_events 插 8 条（其中 3 条 provider_call）+ login_events 插 1 条失败登录
  // → 6 条；没有任何一条 action === 'provider_call'；包含那条登录失败

test('activities 的 target_name 走映射表解析，未知 target_type 回落到 payload.name，都没有时为 null', ...)
  // 一条 mcp_connect_test 指向真实连接器 → targetNameZh === '纷享销客 CRM'
  // 一条 target_type='weird_thing' 且 payload 带 name → 回落取到该 name
  // 一条两者皆无 → targetNameZh === null（绝不返回 UUID 形态的 target_id）

test('activities 不下发 payload 里的密钥字段', ...)
  // payload 含 apiKey / secret_token，响应 JSON 文本里不含这两个值
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd enterprise_server && npx vitest run tests/analytics/dashboardSummary.test.ts`
Expected: FAIL —— 模块不存在（`Cannot find module '.../src/analytics/dashboard'`）。

- [ ] **Step 3: 实现**

创建 `src/analytics/dashboard.ts`。要点：

- `queryUserCounts`：`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='active')::int AS enabled, COUNT(*) FILTER (WHERE status='disabled')::int AS disabled FROM users WHERE org_id=$1`。`pg` 把 `int` 也当字符串回传，所有数值列统一过 `Number()`（照抄 `src/analytics/usage.ts` 的 `mapModelRows` 做法）。
- `queryAgentCounts`：`agent_marketplace_agents` 无 `org_id`，不接参数。
- `queryMcpCounts`：一条语句同时取四个值；`firstAbnormal` 用一个 `LEFT JOIN LATERAL` 或子查询取「启用中且 failed 的行里 `last_test_at` 最新者的 `COALESCE(NULLIF(name_zh,''), NULLIF(name_en,''), server_key)`」。
- `queryHealth`：两条查询（MCP 一条、provider 一条）后在 JS 里按 `err → warn → ok → unknown` 稳定排序（`last_test_at DESC` 作为组内排序，`null` 排组内最后），合并、切片到 `limit ?? 6`。`checkedAt` 在**裁剪之后**对可见行取 `MAX(last_test_at)`。
- `queryActivities`：调 `queryAudit({ orgId, from, to, filters: { exclude: [AuditAction.ProviderCall] }, includeLogin: true, page: 1, pageSize: limit ?? 6 })`；窗口用 `resolveUsageRange(orgId, UsageRange.Last7Days)`。然后按 `target_type` 分组，用一张显式映射表回填 `target_name_zh` / `target_name_en`：
  ```ts
  const TARGET_NAME_SQL: Record<string, string> = {
    mcp_connector: `SELECT id, COALESCE(NULLIF(name_zh,''), NULLIF(name_en,''), server_key) AS zh, COALESCE(NULLIF(name_en,''), NULLIF(name_zh,''), server_key) AS en FROM mcp_connectors WHERE org_id = $1 AND id = ANY($2)`,
    provider_key:  `SELECT id, COALESCE(NULLIF(label,''), provider) AS zh, COALESCE(NULLIF(label,''), provider) AS en FROM provider_keys WHERE org_id = $1 AND id = ANY($2)`,
    model:         `SELECT id, COALESCE(NULLIF(display_name,''), model) AS zh, COALESCE(NULLIF(display_name,''), model) AS en FROM model_catalog WHERE org_id = $1 AND id = ANY($2)`,
    agent:         `SELECT agent_id AS id, name AS zh, name AS en FROM agent_marketplace_agents WHERE agent_id = ANY($1)`,
    user:          `SELECT id, COALESCE(NULLIF(display_name,''), username) AS zh, COALESCE(NULLIF(display_name,''), username) AS en FROM users WHERE org_id = $1 AND id = ANY($2)`,
    dept:          `SELECT id, name AS zh, name AS en FROM departments WHERE org_id = $1 AND id = ANY($2)`,
    role:          `SELECT id, name AS zh, name AS en FROM roles WHERE id = ANY($1)`,
  };
  ```
  未命中的 type 回落到 `payload.name` / `payload.username`（仍没有则 `null`）。**返回对象里不包含 `payload` 字段本身。**

- [ ] **Step 4: 跑测试确认通过**

Run: `cd enterprise_server && npx vitest run tests/analytics/dashboardSummary.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add enterprise_server/src/analytics/dashboard.ts enterprise_server/tests/analytics/dashboardSummary.test.ts
git commit -m "feat(analytics): add dashboard summary aggregations"
```

---

### Task 3: 用量类聚合（`queryDashboardUsage`）

**Files:**
- Modify: `enterprise_server/src/analytics/dashboard.ts`
- Test: `enterprise_server/tests/analytics/dashboardUsage.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `resolvePreviousUsageRange`、既有 `resolveUsageRange`、`UsageRange`
- Produces:
  ```ts
  export type TrendGranularity = 'hour' | 'day';
  export interface UsageTotals  { value: number; prev: number }
  export interface TrendPoint   { key: string; label: string; tokens: number; calls: number }
  export interface TrendSeries  { granularity: TrendGranularity; points: TrendPoint[] }
  export interface ModelUsageRow{ provider: string; model: string; displayName: string; tokens: number; calls: number }
  export interface DeptUsageRow { departmentId: string | null; name: string | null; users: number; tokens: number }

  export interface DashboardUsage {
    range: string;
    from: string; to: string; timezone: string;
    active: UsageTotals;
    tokens: UsageTotals;
    unaccountedCalls: number;
    trend: TrendSeries;
    modelTop: ModelUsageRow[];
    deptTop: DeptUsageRow[];
  }

  export async function queryDashboardUsage(args: {
    orgId: string; range: UsageRange; limit?: number;
  }): Promise<DashboardUsage>
  ```

- [ ] **Step 1: 写失败测试**

新建 `tests/analytics/dashboardUsage.test.ts`，seed 辅助复用 Task 2 那个文件的写法（`user()` / `dept()` / `model_catalog` + `token_usage`，`token_usage` 的 seed 照抄 `tests/analytics/usageModels.test.ts` 的 `usage()` helper，它已处理 `model_catalog` 外键与 `::bigint` 需求）。

```ts
test('active 与 tokens 同时给出本期与上期', ...)
  // 固定 now = 2026-04-15T09:30Z，组织 UTC
  // 7 天窗口内：u1 用 3 次共 300 tokens，u2 用 1 次共 100
  // 上一个 7 天窗口内：u1 用 2 次共 200
  // → active { value: 2, prev: 1 }，tokens { value: 400, prev: 200 }

test('trend 的 granularity：today 为 hour，其余为 day', ...)
  // today → 'hour'，点数 = 已过的整点数（09:30 → 10 个：00..09）
  // 7d   → 'day'，点数恒为 7

test('trend 补齐零值日：范围内没有任何调用的日子仍返回一个 point', ...)
  // 只在第 1 天和第 5 天有数据 → 仍返回 7 个 point，中间为 { tokens: 0, calls: 0 }

test('trend 的 day 标签是 MM-DD，hour 标签是 HH:00', ...)
  // points[0].label === '04/09'（day）/ '00:00'（hour）

test('modelTop 只含有调用的模型，按 tokens 降序取 limit 条', ...)
  // model_catalog 有 3 个模型，范围内只有 2 个被调用过
  // → modelTop.length === 2，未被调用的那个不出现

test('modelTop 把同 provider+model 的多次调用合并求和', ...)
  // 同一模型 3 行 → 1 行，tokens 为三者之和，calls 为 3

test('deptTop 把子部门上卷到一级部门', ...)
  // 根部门「产品部」+ 子部门「产品部/平台组」；两名用户分别在根与子部门
  // → 只有一行 departmentId === 根部门 id，users === 2，tokens 为两者之和

test('deptTop 的未分配桶返回 departmentId:null 与 name:null', ...)
  // 一名 department_id IS NULL 的用户有调用
  // → 存在一行 { departmentId: null, name: null, users: 1 }

test('deptTop 按 tokens 降序取 limit 条', ...)

test('unaccountedCalls 统计 usage_missing 的行数', ...)

test('SUM 不因 INTEGER 上限溢出', ...)
  // 单行 total_tokens 用 INTEGER 上限附近的值，两行相加后 total 正确（::bigint）
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd enterprise_server && npx vitest run tests/analytics/dashboardUsage.test.ts`
Expected: FAIL —— `queryDashboardUsage` 未导出。

- [ ] **Step 3: 实现**

在 `src/analytics/dashboard.ts` 追加：

- 一次 `resolveUsageRange` + 一次 `resolvePreviousUsageRange`，得到四个 `Date` 边界。
- `active`：`SELECT COUNT(DISTINCT user_id)::bigint FROM token_usage WHERE org_id=$1 AND ts>=$2 AND ts<$3`，本期与上期各一条（或一条带 `CASE` 的语句）。
- `tokens`：`SELECT COALESCE(SUM(total_tokens),0)::bigint …`，同样两个窗口。**必须 `::bigint`**。
- `unaccountedCalls`：`COUNT(*) FILTER (WHERE usage_missing)`，本期窗口。
- `trend`：一个参数化的桶查询，`granularity='hour'` 时用 `date_trunc('hour', ts AT TIME ZONE $tz)`，否则用 `to_char(ts AT TIME ZONE $tz, 'YYYY-MM-DD')`；在 JS 里按 `resolved.days`（或 `today` 的整点序列）补齐零值点并生成 label。**SQL 骨架共用，`date_trunc` 的单位是唯一变量。**
- `modelTop`：`FROM token_usage t LEFT JOIN model_catalog m ON m.id = t.model_id`，`GROUP BY t.provider, m.model, m.display_name`，`ORDER BY SUM(t.total_tokens) DESC LIMIT $n`。**不从 `model_catalog` 起表**。
- `deptTop`：用 spec §4.5 的 `WITH RECURSIVE dept_root`，`LEFT JOIN users`、`LEFT JOIN dept_root`，`GROUP BY root_id`，`users` 用 `COUNT(DISTINCT t.user_id)`，`department_id IS NULL` 的用户用 `COALESCE(root_id, NULL)` 归到虚拟桶且 `name` 保持 `NULL`。
- `from`/`to`/`timezone` 的序列化照抄 `src/routes/admin/usage.ts` 里既有的写法（不要自创格式）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd enterprise_server && npx vitest run tests/analytics/dashboardUsage.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add enterprise_server/src/analytics/dashboard.ts enterprise_server/tests/analytics/dashboardUsage.test.ts
git commit -m "feat(analytics): add dashboard usage aggregations with trend series"
```

---

### Task 4: 路由与权限裁剪

**Files:**
- Create: `enterprise_server/src/routes/admin/dashboard.ts`
- Modify: `enterprise_server/src/server.ts`（注册）
- Test: `enterprise_server/tests/routes/dashboard.test.ts`

**Interfaces:**
- Consumes: Task 2/3 的全部查询、`roleResolver.pointsFor`、`Role.SuperAdmin`、`PermissionPoint`、`requireAuth`、`requirePermission`、`UsageRange`
- Produces: `export const adminDashboardRoutes: Hono`，挂载两个路径：
  - `GET /admin/dashboard/summary`（`requireAuth`）
  - `GET /admin/dashboard/usage?range=<key>`（`requirePermission(PermissionPoint.UsageView)`）

- [ ] **Step 1: 写失败测试**

新建 `tests/routes/dashboard.test.ts`。照抄 `tests/routes/admin/audit.test.ts` 的鉴权样板（`signToken` + 直接 `app.request()`）：

```ts
test('无 usage:view 时 /usage 返回 403', ...)
test('无 usage:view 时 /summary 仍返回配置段（users/agents/mcp/health）', ...)
test('缺 user:view 时 summary.users 为 null，其余段照常', ...)
test('缺 mcp:view 时 summary.mcp 与 summary.health 均为 null', ...)
test('有 mcp:view 但无 provider:view 时，health 只含 MCP 条目且 checkedAt 不含模型侧时间', ...)
test('缺 audit:view 时 summary.activities 为 null', ...)
test('super_admin 全段可见', ...)
test('orgId 查询参数被忽略：?orgId=其他组织 不改变返回数据', ...)
test('usage 的非法 range 返回 400', ...)
test('两个端点都不接受 orgId 参数', ...)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd enterprise_server && npx vitest run tests/routes/dashboard.test.ts`
Expected: FAIL —— 路由不存在（404）。

- [ ] **Step 3: 实现**

创建 `src/routes/admin/dashboard.ts`：

```ts
export const adminDashboardRoutes = new Hono();

adminDashboardRoutes.get('/admin/dashboard/summary', requireAuth, async c => {
  const claims = c.get('claims');
  const points = claims.roles.includes(Role.SuperAdmin)
    ? new Set(PERMISSION_POINTS)
    : await roleResolver.pointsFor(claims.roles);
  const can = (p: PermissionPoint) => points.has(p);

  const [users, agents, mcp, health, activities] = await Promise.all([
    can(PermissionPoint.UserView)   ? queryUserCounts(claims.orgId)   : null,
    can(PermissionPoint.AgentView)  ? queryAgentCounts()              : null,
    can(PermissionPoint.McpView)    ? queryMcpCounts(claims.orgId)    : null,
    can(PermissionPoint.McpView)
      ? queryHealth({ orgId: claims.orgId,
                      includeMcp: true,
                      includeModel: can(PermissionPoint.ProviderView) })
      : null,
    can(PermissionPoint.AuditView)  ? queryActivities(claims.orgId)   : null,
  ]);
  return c.json({ updatedAt: new Date().toISOString(), users, agents, mcp, health, activities });
});
```

（`Promise.all` 里非权限项直接给 `null`，不要写成 `Promise.resolve(null)` 混进去。）

```ts
adminDashboardRoutes.get('/admin/dashboard/usage', requirePermission(PermissionPoint.UsageView), async c => {
  const claims = c.get('claims');
  const key = c.req.query('range') ?? UsageRange.Last7Days;
  if (!Object.values(UsageRange).includes(key as UsageRange)) {
    return c.json({ error: 'invalid_range' }, 400);
  }
  return c.json(await queryDashboardUsage({ orgId: claims.orgId, range: key as UsageRange }));
});
```

在 `src/server.ts` 的 `app.route('/', adminUsageRoutes);` 之后加 `app.route('/', adminDashboardRoutes);` 与对应 import。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd enterprise_server && npx vitest run tests/routes/dashboard.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add enterprise_server/src/routes/admin/dashboard.ts enterprise_server/src/server.ts enterprise_server/tests/routes/dashboard.test.ts
git commit -m "feat(admin): add permission-trimmed dashboard endpoints"
```

---

### Task 5: `GET /admin/usage/models` 的可选 `model` 过滤

**Files:**
- Modify: `enterprise_server/src/analytics/usage.ts`（`queryModels` 加可选 `model` 谓词）
- Modify: `enterprise_server/src/routes/admin/usage.ts`（读并校验查询参数）
- Test: `enterprise_server/tests/analytics/usageModels.test.ts`（增量）

**Interfaces:**
- Consumes: 既有 `queryModels({ orgId, from, to, page, pageSize })`
- Produces: `queryModels(args: { …; model?: string })`，其中 `model` 形如 `<provider>/<model>`；不传时行为与今天逐字节相同。

- [ ] **Step 1: 写失败测试**

在 `tests/analytics/usageModels.test.ts` 追加：

```ts
test('model 过滤只返回该 (provider, model) 行', ...)
test('model 过滤下 total 也只计该行', ...)      // 避免表格分页与高亮打架
test('不传 model 时结果与既有行为一致', ...)    // 回归
test('provider 与 model 中含斜杠时按第一个斜杠切分', ...)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd enterprise_server && npx vitest run tests/analytics/usageModels.test.ts`
Expected: FAIL —— 传了 `model` 仍返回全部行。

- [ ] **Step 3: 实现**

- `src/analytics/usage.ts`：给 `modelsQuery(paging)` 的模板与 `queryModels` 的参数各加一个可选谓词。谓词必须落在 **`joined` CTE 之后**，这样 `AGGREGATES_QUERY` 的 `total` 也能一起收窄——否则深链高亮的行可能在第 2 页，而 `total` 仍报全量。
- `src/routes/admin/usage.ts`：读 `c.req.query('model')`，用**第一个** `/` 切成 `provider` 与 `model` 两段分别绑定（模型名本身可能含 `/`）；格式不合法时返回 400 `{ error: 'invalid_model' }`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd enterprise_server && npx vitest run tests/analytics/usageModels.test.ts tests/routes/admin/usage.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add enterprise_server/src/analytics/usage.ts enterprise_server/src/routes/admin/usage.ts enterprise_server/tests/analytics/usageModels.test.ts
git commit -m "feat(usage): support filtering the models table by provider and model"
```

---

### Task 6: 前端 API 客户端、token 格式化、组织时区日期

**Files:**
- Create: `enterprise_server/web/src/api/dashboard.ts`
- Create: `enterprise_server/web/src/components/dashboard/format.ts`
- Modify: `enterprise_server/web/src/analytics/datetime.ts`（新增 `formatOrgDate`）
- Test: `enterprise_server/web/tests/api/dashboard.test.ts`、`enterprise_server/web/tests/components/dashboard/format.test.ts`

**Interfaces:**
- Consumes: `apiClient` / `buildQuery`、`UsageRangeKey`、`getLang`
- Produces:
  ```ts
  // api/dashboard.ts —— 类型镜像服务端线格式（snake_case）
  export const dashboardApi = {
    summary: () => apiClient.get<DashboardSummaryResponse>('/admin/dashboard/summary'),
    usage: (range: UsageRangeKey) =>
      apiClient.get<DashboardUsageResponse>(`/admin/dashboard/usage?${buildQuery({ range })}`),
  };
  // components/dashboard/format.ts
  export function formatTokens(n: number, lang: Lang): string
  export function formatDelta(value: number, prev: number, lang: Lang): { direction: 'up'|'down'|'flat'|'new'; text: string }
  // analytics/datetime.ts
  export function formatOrgDate(iso: string | null | undefined, timeZone?: string): string
  export function formatOrgHour(iso: string | null | undefined, timeZone?: string): string | null
  ```

- [ ] **Step 1: 写失败测试**

`tests/api/dashboard.test.ts`（照抄 `tests/api/analyticsClients.test.ts` 的 fetch mock 方式）：

```ts
test('summary 打到 /admin/dashboard/summary 且不带任何查询参数', ...)
test('usage 把 range 原样作为查询参数发送，不发日期', ...)
```

`tests/components/dashboard/format.test.ts`：

```ts
test.each([
  [999,      'zh', '999'],
  [1_234,    'zh', '1234'],
  [18_240_000,'zh','1824.0 万'],
  [123_456_789_012, 'zh', '1234.6 亿'],
  [1_824_000,'en', '1.8M'],
  [999,      'en', '999'],
])('formatTokens(%i, %s) === %s', ...)
test('formatDelta 在 prev 为 0 时返回 new 而不是 Infinity', ...)
test('formatDelta 在相等时返回 flat', ...)
test('formatDelta 的百分比保留 1 位小数', ...)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd enterprise_server/web && npx vitest run tests/api/dashboard.test.ts tests/components/dashboard/format.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

- `format.ts`：
  - `formatTokens`：`zh` 走 万（`n/1e4`）→ 亿（`n/1e8`）；`en` 走 K（`/1e3`）→ M（`/1e6`）→ B（`/1e9`）；`|n| < 1000` 时返回千分位整数；结果一律 `toFixed(1)`（`<1000` 分支除外）。
  - `formatDelta`：`prev === 0` → `{ direction: 'new' }`；`value === prev` → `flat`；否则 `((value-prev)/prev*100)` 取一位小数，`up`/`down`。
- `datetime.ts`：新增 `formatOrgDate`（`en` → `MMM D, YYYY`，`zh` → `YYYY年M月D日`）与 `formatOrgHour`（`HH:mm`，用于问候语分档）。**必须复用既有的 `formatInOrgZone`**，它已经处理了不可解析的时区字符串与非法日期。

  对应测试（Review Focus #5）：

  ```ts
  test('formatOrgDate 在时区字符串无法解析时退化为浏览器时区而不抛错', () => {
    expect(formatOrgDate('2026-04-15T09:30:00Z', 'Not/AZone')).not.toBe('—');
  });
  test('formatOrgDate 对非法日期返回 —', () => {
    expect(formatOrgDate('not-a-date', 'UTC')).toBe('—');
    expect(formatOrgDate(null, 'UTC')).toBe('—');
  });
  test('formatOrgHour 在时区字符串无法解析时同样不抛错', () => {
    expect(() => formatOrgHour('2026-04-15T09:30:00Z', 'Not/AZone')).not.toThrow();
  });
  ```
- `api/dashboard.ts`：类型逐字段镜像服务端（`users/agents/mcp/health/activities` 与 `active/tokens/unaccounted_calls/trend/model_top/dept_top`），可空段写成 `| null`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd enterprise_server/web && npx vitest run tests/api/dashboard.test.ts tests/components/dashboard/format.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add enterprise_server/web/src/api/dashboard.ts enterprise_server/web/src/components/dashboard/format.ts enterprise_server/web/src/analytics/datetime.ts enterprise_server/web/tests
git commit -m "feat(web): add dashboard API client and token formatting helpers"
```

---

### Task 7: 指标卡与服务健康组件

**Files:**
- Create: `enterprise_server/web/src/components/dashboard/StatCards.tsx`
- Create: `enterprise_server/web/src/components/dashboard/ServiceHealth.tsx`
- Test: `enterprise_server/web/tests/components/dashboard/StatCards.test.tsx`、`.../ServiceHealth.test.tsx`

**Interfaces:**
- Consumes: Task 4 的响应类型、`formatTokens` / `formatDelta`、`Card`、`Badge`、`EmptyState`
- Produces:
  ```tsx
  export interface StatCardsProps {
    users: UserCountsResponse | null;
    active: UsageTotalsResponse | null;
    tokens: UsageTotalsResponse | null;
    agents: AgentCountsResponse | null;
    mcp: McpCountsResponse | null;
    hasUsage: boolean;                       // = usage 端点是否有权/是否成功
    range: UsageRangeKey;
  }
  export function StatCards(props: StatCardsProps): JSX.Element | null

  export interface ServiceHealthProps {
    health: HealthBlockResponse | null;
    mcpAbnormal: number;
    onRetry: () => void;
  }
  export function ServiceHealth(props: ServiceHealthProps): JSX.Element
  ```

- [ ] **Step 1: 写失败测试**

```ts
// StatCards
test('五张卡按固定顺序渲染：总用户数 → 活跃用户 → 模型调用量 → 启用智能体 → 连接器', ...)
test('总用户数副信息展示「已启用 N · 停用 M」', ...)
test('没有 usage 权限时不渲染活跃用户与模型调用量两张卡', ...)   // Review Focus #1
test('连接器卡有异常时副信息首段为红色且含异常名，无异常时为绿色「全部正常」', ...)
test('环比为新增时渲染「新增」而不是 NaN%', ...)                    // Review Focus #2

// ServiceHealth
test('按 err → warn → ok → unknown 渲染，状态点带文字说明而非只靠颜色', ...)  // 无障碍
test('last_test_at 为 null 的行显示「尚未检测」', ...)
test('底部只有「全部服务 →」，没有重新检测按钮', ...)
test('health 为 null（无 mcp:view）时整块不渲染', ...)
test('加载失败时显示「加载失败，点击重试」且点击触发 onRetry', ...)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd enterprise_server/web && npx vitest run tests/components/dashboard/`
Expected: FAIL —— 组件不存在。

- [ ] **Step 3: 实现**

- `StatCards`：网格 `grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3`；数值加 `tabular-nums`；整卡包 `<Link to=…>`（React Router）承载跳转（`to` 由 `range` 拼出，`/monitoring/usage?range=${range}`）。**连接器卡的异常提示不包在链接里**。
- `ServiceHealth`：状态点用 `<span>` + 文案（`sr-only` 或同行文字），满足 spec §8 无障碍要求；行点击跳 `/config/mcp-manage`（模型条目跳 `/config/providers`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd enterprise_server/web && npx vitest run tests/components/dashboard/`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add enterprise_server/web/src/components/dashboard enterprise_server/web/tests/components/dashboard
git commit -m "feat(web): add dashboard stat cards and service health list"
```

---

### Task 8: 条形榜与最近动态组件

**Files:**
- Create: `enterprise_server/web/src/components/dashboard/RankBars.tsx`
- Create: `enterprise_server/web/src/components/dashboard/ActivityFeed.tsx`
- Test: `enterprise_server/web/tests/components/dashboard/RankBars.test.tsx`、`.../ActivityFeed.test.tsx`

**Interfaces:**
- Consumes: `formatTokens`、`AuditTone`（`api/audit.ts`）、`badgeToneFor`、`getLang`、`EmptyState`
- Produces:
  ```tsx
  export interface RankBarsProps {
    rows: { id: string; name: string; tokens: number; sublabel?: string }[];
    emptyText: string;
    onRowClick?: (id: string) => void;
  }
  export function RankBars(props: RankBarsProps): JSX.Element

  export interface ActivityFeedProps {
    activities: ActivityItemResponse[];
    onItemClick?: (item: ActivityItemResponse) => void;
  }
  export function ActivityFeed(props: ActivityFeedProps): JSX.Element
  ```
  `ActivityFeed` 自己按 `getLang()` 选 `actionZh`/`actionEn` 与 `targetNameZh`/`targetNameEn`，`userId === null` 渲染 `t('dashboard.activity.system')`。

- [ ] **Step 1: 写失败测试**

```ts
// RankBars
test('条形宽度相对第一名归一化：第二名 = 其 tokens / 第一名 tokens', ...)
test('只有一行时该行占满 100%', ...)
test('前 3 名徽标样式不同，第 4 名起用默认样式', ...)
test('空数组渲染 emptyText 而不是空白', ...)
test('数值走 formatTokens（中文万 / 英文 M）', ...)

// ActivityFeed
test('最多渲染 6 条', ...)
test('按 tone 映射到四种颜色：failure/danger 红、change 橙、auth/normal 蓝、success 绿', ...)
test('userId 为 null 时操作人渲染 i18n 的系统文案', ...)
test('target 名为 null 时不渲染 UUID，只显示动作与操作人', ...)
test('时间按 HH:mm / 昨天 HH:mm / MM-DD HH:mm 三档', ...)
test('最后一条不画时间线延长线', ...)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd enterprise_server/web && npx vitest run tests/components/dashboard/`
Expected: FAIL —— 组件不存在。

- [ ] **Step 3: 实现**

- `RankBars`：`width = tokens / rows[0].tokens * 100`，用 `data-testid="rank-fill"` + `style={{ width }}` 便于断言；徽标复用 `Badge` 的 tone（第 1 名 `warning`、第 2 名 `info`、第 3 名 `success`、其余 `neutral`）。
- `ActivityFeed`：竖向时间线用一个绝对定位的 `::before`/`::after` 等价实现（Tailwind `relative` + 末项 `overflow-hidden`），**不引入全局 CSS**。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd enterprise_server/web && npx vitest run tests/components/dashboard/`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add enterprise_server/web/src/components/dashboard enterprise_server/web/tests/components/dashboard
git commit -m "feat(web): add dashboard rank bars and activity feed"
```

---

### Task 9: 双折线趋势图

**Files:**
- Create: `enterprise_server/web/src/components/dashboard/TrendChart.tsx`
- Test: `enterprise_server/web/tests/components/dashboard/TrendChart.test.tsx`

**Interfaces:**
- Consumes: `TrendSeriesResponse`、`formatTokens`
- Produces:
  ```tsx
  export interface TrendChartProps {
    series: TrendSeriesResponse;
    range: UsageRangeKey;
  }
  export function TrendChart(props: TrendChartProps): JSX.Element
  ```

- [ ] **Step 1: 写失败测试**

```ts
test('渲染 4 条水平虚线网格 + 左轴刻度', ...)
test('X 轴标签不超过 7 个，且首尾必显示', ...)          // 30 天输入 → ≤7 个
test('Tokens 为蓝、调用次数为绿，各数据点有空心圆点', ...)
test('全部为零时不渲染坐标轴，改为显示空态文案', ...)
test('悬停数据点显示 tooltip，含日期、Tokens、调用次数', ...)   // PRD R-6.3.2
test('granularity 为 hour 时 X 轴标签是 HH 形式', ...)
test('有 role="img" 与 aria-label', ...)
test('渲染一份隐藏的数据表兜底', ...)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd enterprise_server/web && npx vitest run tests/components/dashboard/TrendChart.test.tsx`
Expected: FAIL —— 组件不存在。

- [ ] **Step 3: 实现**

- 固定 `viewBox`（`720×240`），照 `DailyBarChart.tsx` 的做法不引 ResizeObserver。
- `niceCeil` 取整到 1/2/5×10ⁿ（与 `DailyBarChart` 同思路；**不要**把它的私有函数复制一份过来，导出复用或在图内独立实现并注释原因）。
- 两个归一化：`yTokens` 按左轴上限，`yCalls` 按 `max(calls)` 归一化到同一绘图区。
- tooltip：每个点叠一个透明 `<rect>` 命中区（`onMouseEnter` 记录索引），浮层绝对定位；键盘可达（命中区可 `focus`，`onFocus` 同样触发）。
- 数据表兜底：`<table className="sr-only">`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd enterprise_server/web && npx vitest run tests/components/dashboard/TrendChart.test.tsx`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add enterprise_server/web/src/components/dashboard/TrendChart.tsx enterprise_server/web/tests/components/dashboard/TrendChart.test.tsx
git commit -m "feat(web): add dual-line dashboard trend chart with tooltips"
```

---

### Task 10: 页面组装、路由接线与 i18n

**Files:**
- Create: `enterprise_server/web/src/pages/DashboardPage.tsx`
- Modify: `enterprise_server/web/src/App.tsx`（`/` 路由换成 `<DashboardPage />`）
- Modify: `enterprise_server/web/src/i18n.ts`（`en` + `zh` 各加 `dashboard.*` 块，放在两份字典末尾同一位置）
- Test: `enterprise_server/web/tests/pages/DashboardPage.test.tsx`

**Interfaces:**
- Consumes: Task 6–9 的全部组件与 API、`RangeSelect`、`PageHeader`、`EmptyState`、`useToast`、`useAuth`、`usePermissions`
- Produces: `export function DashboardPage(): JSX.Element`

- [ ] **Step 1: 写失败测试**

```ts
test('两个 query 都显式 staleTime 60_000', ...)                  // 不能靠全局默认的 30s
test('切换时间范围只 refetch usage，summary 不重新请求，并弹 toast', ...)
test('刷新按钮同时 refetch 两个 query', ...)
test('usage 403 或失败时，用量区块显示失败态而配置区块照常渲染', ...)
test('usage 失败时刷新按钮仍可用', ...)
test('无任何可见区块时渲染整页说明态而不是空白', ...)            // Review Focus #1
test('页头问候语按组织时区的小时数选择三档文案', ...)
test('「查看明细」链接带上当前 range', ...)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd enterprise_server/web && npx vitest run tests/pages/DashboardPage.test.tsx`
Expected: FAIL —— 页面不存在。

- [ ] **Step 3: 实现**

- 两个 `useQuery`：`['dashboard','summary']` 与 `['dashboard','usage',orgId,range]`，均 `staleTime: 60_000`。
- `summary` query **不看 range**（它不随范围变化），因此 `queryKey` 里没有 range——这是「切范围不重取配置段」的实现方式。
- `usage` 失败时：`StatCards` 传 `hasUsage={false}`，`TrendChart` 位置换成失败态；`ServiceHealth` 等配置区块不受影响。
- 权限：`usePermissions().hasPermission(...)` 决定渲染哪些区块（服务端已裁剪，前端这层是为了不画空壳）。
- i18n：在 `en` 与 `zh` 两份字典末尾各加一段 `// --- Dashboard ---`，键覆盖 `dashboard.title`、`.greeting.{morning,afternoon,evening}`、`.updatedAt`、`.stat.*`、`.trend.*`、`.health.*`、`.rank.*`、`.activity.*`、`.empty.*`、`.error.*`、`.toast.*`、`.rank.unassigned`、`.activity.system`。
- `App.tsx`：`/` 路由改为 `<Shell><DashboardPage /></Shell>`，保留 `AuthGuard` 不加 `requires`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd enterprise_server/web && npx vitest run tests/pages/DashboardPage.test.tsx`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add enterprise_server/web/src/pages/DashboardPage.tsx enterprise_server/web/src/App.tsx enterprise_server/web/src/i18n.ts enterprise_server/web/tests/pages/DashboardPage.test.tsx
git commit -m "feat(web): mount the dashboard page as the console landing page"
```

---

### Task 11: 目标页的 URL 深链

**Files:**
- Modify: `enterprise_server/web/src/pages/UsagePage.tsx`（读 `?range=` 与 `?model=`）
- Modify: `enterprise_server/web/src/pages/AuditPage.tsx`（读 `?userId=` + `from`/`to`）
- Modify: `enterprise_server/web/src/api/usage.ts`（`models()` 增加可选 `model`）
- Test: `enterprise_server/web/tests/pages/UsagePageModels.test.tsx`（增量）、`enterprise_server/web/tests/pages/AuditPage.test.tsx`（增量）

**Interfaces:**
- Consumes: Task 5 的服务端 `?model=` 支持；react-router 的 `useSearchParams`
- Produces: 无新导出，行为变化见下

- [ ] **Step 1: 写失败测试**

```ts
// UsagePage
test('?range=30d 初始化为近 30 天而非默认的 7d', ...)
test('?range= 非法时回落到 7d 而不是抛错', ...)
test('?model=provider/model 切到模型 tab、带上该过滤并高亮该行', ...)
test('无 ?model 时默认仍停在用户 tab', ...)

// AuditPage
test('?userId=…&from=…&to=… 预置为 custom 区间并按操作人过滤', ...)
test('缺 from/to 时只用 userId 过滤', ...)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd enterprise_server/web && npx vitest run tests/pages/UsagePageModels.test.tsx tests/pages/AuditPage.test.tsx`
Expected: FAIL —— 搜索参数被忽略。

- [ ] **Step 3: 实现**

- `UsagePage`：`const [params] = useSearchParams()`；`range` 初值 = 合法则用之，否则 `'7d'`；`model` 存在时把初值 tab 设为 `UsageTab.Models` 并把 `model` 传进 `usageApi.models({ range, model, page, pageSize })`；命中行加 `Card selected`。
- `AuditPage`：`userId` / `from` / `to` 三个参数齐备时用 `range: 'custom'`，否则只带 `userId`。**不要**把 `?range=` 之外的未知参数透传给服务端。
- `api/usage.ts`：`models()` 的参数类型加 `model?: string`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd enterprise_server/web && npx vitest run tests/pages/UsagePageModels.test.tsx tests/pages/AuditPage.test.tsx`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add enterprise_server/web/src/pages/UsagePage.tsx enterprise_server/web/src/pages/AuditPage.tsx enterprise_server/web/src/api/usage.ts enterprise_server/web/tests
git commit -m "feat(web): accept range, model and user deep links on usage and audit"
```

---

### Task 12: 全量验证

**Files:** 无新增

- [ ] **Step 1: 服务端类型与 lint**

Run:
```bash
cd enterprise_server && npx tsc -p tsconfig.build.json --noEmit
cd enterprise_server && npx eslint --ext ts --report-unused-disable-directives --max-warnings 0 \
  src/analytics/dashboard.ts src/analytics/range.ts src/routes/admin/dashboard.ts src/routes/admin/usage.ts src/server.ts
```
Expected: 无输出（0 error 0 warning）。

- [ ] **Step 2: 服务端测试按文件跑**

Run:
```bash
cd enterprise_server
npx vitest run tests/analytics/previousRange.test.ts tests/analytics/range.test.ts \
  tests/analytics/dashboardSummary.test.ts tests/analytics/dashboardUsage.test.ts \
  tests/analytics/usageModels.test.ts tests/routes/dashboard.test.ts
```
Expected: 全部 PASS。**不要**跑整包 `npm test`（本机 fd 上限会 EBADF）。

- [ ] **Step 3: 前端类型、lint 与测试**

Run:
```bash
cd enterprise_server/web && npx tsc --noEmit
cd enterprise_server/web && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 \
  src/pages/DashboardPage.tsx src/components/dashboard src/api/dashboard.ts src/App.tsx
cd enterprise_server/web && npx vitest run
```
Expected: `tsc` 无错误；eslint 无输出；vitest 全绿（若出现**改动前就已存在**的失败，如 `enterprise-agent-sync` 那 5 条基线失败，单独列出不要追）。

- [ ] **Step 4: 手工验证**

```bash
cd enterprise_server && npm run dev     # :8787
cd enterprise_server/web && npm run dev # :5173
```
登录后逐项确认：首屏五卡顺序正确；切「今天」趋势变小时分桶且注明截至时刻；切范围时配置区块不重新加载；点模型 TOP5 行跳用量页并高亮；点动态跳审计页且带筛选；服务健康里造一条 `last_test_status='failed'` 的连接器后它排到第一位并显示红色「连接失败」；窗口宽度 1280 时指标卡降为 3+2 且无横向滚动。

- [ ] **Step 5: 提交（若有leftover）**

```bash
git add -A && git commit -m "chore(dashboard): verification fixes"
```