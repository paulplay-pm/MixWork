# 管理台「面板」— 设计

| | |
| --- | --- |
| 模块 | 概览 · 面板（管理台默认首页，路由 `/`） |
| 代码位置 | `enterprise_server/web` + `enterprise_server` 服务端 |
| 依据 | `WorkBuddy/2026-09-08-21-59-26/llm-config/dashboard-standalone.html`（原型）、`PRD-面板.md`（V1.0 评审稿） |
| 状态 | 待实现 |

---

## 1. 背景与动机

管理台目前把模型服务商、连接器（MCP）、智能体、用户与角色等配置分散在「能力配置 / 运行分析 / 组织管理」三个分组里。管理员登录后必须逐页点击才能拼出"平台现在是什么状态"，异常（连接器连不上、模型服务超时）也只能靠用户反馈发现。

`web/src/App.tsx` 里 `/` 路由已经存在，指向一个占位块：

```tsx
<Shell><div className="p-8"><h1 className="text-2xl font-bold">Dashboard</h1></div></Shell>
```

侧边栏（`web/src/components/Sidebar.tsx`）第一条导航项「概览 → 面板」也已经指向 `/` 且**无条件显示**。本设计把该占位替换为真正的面板页面，并在服务端补齐它所需的聚合接口。

原型是单文件 HTML，其视觉 token（`#f7f8fa / #4f6ef7 / #e8eaee / 12px 圆角`）与管理台现有的 `web/src/index.css`（`--bg-primary: #fafbfc`、`--accent-primary: #3b82f6`、`--border-subtle: #e8ecf0`、`--radius-lg: 12px`，绿橙红完全一致）几乎是同一套。**因此不引入第二套样式体系**，全部使用现有 CSS 变量 + Tailwind 工具类。

---

## 2. 目标与非目标

### 目标

- 管理员登录后一屏回答三个问题：平台整体怎么样 / 有什么异常 / 谁用得最多。
- 首屏可交互 ≤ 2s（P95）。
- 每个数据区块可一键跳转到对应明细页，并携带可用上下文。
- 无权限的调用者不会看到越权数字（服务端裁剪，不是前端隐藏）。

### 非目标（本期明确不做）

| 不做 | 原因 |
| --- | --- |
| 服务健康的后台定时巡检 | 平台从无此机制；本期只读已有的手动测试结果（见 §4.4） |
| 服务健康的「重新检测」按钮 | 同上，且按钮会对全组织每个上游发起真实请求，面板应保持只读 |
| 快捷操作区（配置模型 / 添加连接器 / 新建用户 / 角色权限） | PRD §10 已确认移除 |
| 自定义时间区间 | PRD §10 已确认移除 |
| 部门数据范围隔离 | PRD §12 列为 P1 Backlog；本期一律展示全平台 |
| 埋点（`dashboard_view` 等 6 个事件） | 管理台当前无前端埋点基建，单独排期 |
| 快捷操作区、卡片自定义、实时流式刷新 | PRD §10 已确认移除 |
| 部门排行的跳转部门预置筛选 | 用量页用户 tab 目前无部门维度筛选，新增它超出"加个面板"的范围（见 §4.7） |

### 反目标（做成了也算失败）

- 不为了贴原型而在 `index.css` 之外另起一套颜色/圆角/阴影常量。
- 不引入图表库（依赖集中没有，且 `DailyBarChart.tsx` 已经确立了手写 SVG 的先例）。
- 不让面板写入任何数据（不写 `provider_keys` / `mcp_connectors` 的检测字段，不写审计）。
- 不为了凑满 6 条而放宽异常排序：没有异常时如实少显示。

---

## 3. 全局约束

1. **路由挂载在根**。服务端所有 admin 路由以 `/admin/...` 挂载（见 `src/server.ts`），不使用 PRD 写的 `/api/dashboard/*`。
2. **orgId 永远来自 JWT claims**，不接受查询参数（与 `api/usage.ts` 的既有约定一致）。
3. **时间范围 key 复用 `UsageRangeKey`**（`today | 7d | 30d | this_month | last_month`），由服务端 `resolveUsageRange` 在组织时区解析，前端永不发日期。
4. **i18n**：`web/src/i18n.ts` 的 `en` 与 `zh` 两份字典都要加 `dashboard.*` 键，不硬编码用户可见文案。
5. **无新增数据库迁移**（见 §4.2 说明）。
6. 本仓库 lint 门禁是「改动文件的 ESLint 零 error 零 warning」；测试是 Vitest。

---

## 4. 服务端设计

### 4.1 新增文件

| 文件 | 职责 |
| --- | --- |
| `src/analytics/dashboard.ts` | 全部聚合查询（纯 SQL + 类型，不碰 HTTP） |
| `src/routes/admin/dashboard.ts` | 两个 GET 路由、权限裁剪、响应装配 |
| `tests/analytics/dashboard.test.ts` | 查询层测试（pglite） |
| `tests/routes/dashboard.test.ts` | 路由层权限裁剪测试 |

在 `src/server.ts` 中 `app.route('/', adminUsageRoutes)` 附近注册 `app.route('/', adminDashboardRoutes)`。

### 4.2 数据来源与口径

| 区块 | 来源 | 口径 |
| --- | --- | --- |
| 总用户数 | `users` | `COUNT(*)`；副信息 `COUNT(*) FILTER (status='active')` / `status='disabled'`。`users.status` 只有这两个取值（`routes/admin/users.ts` 的 zod enum）。不随时间范围变化 |
| 活跃用户 | `token_usage` | 范围内 `COUNT(DISTINCT user_id)`。随范围联动 |
| 模型调用量 | `token_usage` | 范围内 `SUM(total_tokens)`。随范围联动 |
| 启用智能体 | `agent_marketplace_agents` | `COUNT(*) FILTER (enabled)` / `COUNT(*)`，**按 `org_id` 收窄**（迁移 053 之后）。不随范围变化 |
| 连接器（MCP） | `mcp_connectors` | 一条查询同时给出 `{ enabled, total, abnormal, firstAbnormal }`：`abnormal` = 启用中且 `last_test_status='failed'` 的行数（**全量统计，不受健康列表前 6 截断影响**），`firstAbnormal` = 这些行里 `last_test_at` 最新者的名称。不随范围变化 |
| 调用趋势 | `token_usage` | 见 §4.3 |
| 模型用量 TOP5 | `token_usage` ⋈ `model_catalog` | **从 `token_usage` 出发**（`LEFT JOIN model_catalog` 取 `display_name`），按 `(provider, model)` 合并（含 039 迁移的同名模型合并），`SUM(total_tokens)` 降序取 5。与用量表 `queryModels` 的 `FULL JOIN` **有意不同**：那张表要列出「配置了但本期没调用」的模型，而「用量 TOP5」排的是实际用量，0 token 的行是噪音。范围内无任何调用则返回空数组，前端显示空态 |
| 最近动态 | `audit_events` ⋈ `login_events`（经 `queryAudit`） | 按 `ts DESC` 取 6，附 `tone`（见 §4.6） |
| 部门用量排行 | `token_usage` ⋈ `users` ⋈ `departments` | 见 §4.5 |

**无迁移的理由**：所有查询都打在既有表上，`052_analytics_usage_audit.sql` 已经建了 `token_usage(org_id, ts)` 与 `audit_events(org_id, ts DESC, action)` 索引，本设计的访问路径与它们一致。部门聚合需要 `users.department_id`，该列无索引，但它是 `users` 上的可空外键、随用户表一次性扫描，成本可忽略。**若日后部门规模变大导致该查询变慢，再单独加索引**，本期不加。

### 4.3 时间范围、环比与趋势

**区间**：直接调 `resolveUsageRange(orgId, range)`，拿到 `{ from, to, timezone, days }`。

**环比上期**（新增 `resolvePreviousUsageRange(orgId, range)` 到 `src/analytics/range.ts`，返回同样的 `ResolvedRange`）。设 `L = resolved.days.length`，规则分两类：

| 范围 | 上期窗口 | 依据 |
| --- | --- | --- |
| `7d` / `30d` | `[fromDay - L 天, fromDay)` | 等长紧邻前区间 |
| `today` | `[昨天, 今天)`，**右界截断到当前时刻的墙钟 `HH:mm`** | 本期是「今天到现在」，拿整天「昨天」比等于半天比一整天，环比必然虚高 |
| `this_month` | `[上月 1 日, 上月 1 日 + L 天)` | PRD §5.2「本月 → 上月同期」 |
| `last_month` | `[上上月 1 日, 上月 1 日)` | PRD §5.2「上月 → 上上月同期」 |

> **两个「月」范围不能用等长规则**：`last_month` = 3 月（31 天）时，`[3/1 - 31, 3/1)` 落在
> 1/29–2/28，而不是 2 月；`this_month` 同理。所以上表把月范围单列，用**上一个月的 1 日**做锚点。

- 日键运算复用该模块既有的 `addDays` / `monthStart`（**需要把这两个模块私有函数改为导出**），
  不引入 `Date` 的本地时区运算。
- **本期窗口的 `to` 不截断**：`resolveUsageRange('today')` 的 `to` 是明天 00:00，与用量页完全
  一致——这样「今天」下扫描的行与用量页逐字节相同，面板与用量页不可能对同一批数据给出不同数字。
  截断只发生在**上期**窗口。
- `now` 取服务端时钟瞬时值；响应的 `from`/`to` 沿用 `routes/admin/usage.ts` 现有的序列化方式。

**趋势粒度**：

| 范围 | 粒度 | 点数 | 标签 |
| --- | --- | --- | --- |
| `today` | 小时（`date_trunc('hour', ts AT TIME ZONE tz)`） | 当日 00:00 至当前时刻 | `HH:00` |
| 其余 | 天 | `resolved.days.length`（30/7/当月天数/上月天数） | `MM-DD` |

- 响应里带 `granularity: 'hour' | 'day'`，前端据此选 X 轴标签格式与说明文案。
- **每一天/每一小时都返回一个点，零值也返回**（与 `DailyBarChart` 的既有纪律一致：丢掉空槽会让有数据的日子显得更宽）。
- `today` 未到的小时不返回。

**取舍说明**：原型在选「今天」时仍然画最近 7 天（`TREND.slice(-Math.max(days, 7))`），与同屏指标卡的当日口径矛盾。本设计改为按小时分桶，让这张图真的回答"今天涨了还是跌了"。

### 4.4 服务健康（只读）

**数据**：`mcp_connectors` 的 `last_test_at / last_test_status / last_latency_ms`，`provider_keys` 的 `last_test_at / status / latency_ms`。这些字段目前只由管理员在配置页手动点"测试连接"时写入（`routes/mcpConnectors.ts` 的 `POST /admin/mcp-connectors/:id/test`、`routes/admin/providerKeys.ts` 的 `POST /admin/provider-keys/:id/test`）。**本期不新增任何写入路径。**

**状态判定**：

| 状态 | 判定 | 展示 |
| --- | --- | --- |
| `err` | 最近一次测试 `failed` | 红色点 + 「连接失败」 |
| `warn` | 最近一次测试 `connected` 且 `latency_ms > 3000` | 橙色点 + 「平均 xxx ms」 |
| `ok` | 最近一次测试 `connected` 且 `latency_ms <= 3000` | 绿色点 + 「平均 xxx ms」 |
| `unknown` | `last_test_at IS NULL` | 灰色点 + 「尚未检测」 |

> PRD 的 `warn` 口径是"超时率 > 3% 或 P95 > 3s"，需要一段历史采样。本期只读单次探测结果，用 `latency_ms > 3000` 近似 P95 阈值。这是**近似**，不是 PRD 口径，写在这里以免日后被当成等价实现。

**排序与条数**：`err` → `warn` → `ok` → `unknown`；同状态内按 `last_test_at DESC`；取前 6。`unknown` 排在最后意味着「从未检测」的服务只有在异常/正常项不足 6 条时才会露出——这是有意的（首页位置有限），但它意味着**一个从未测过的连接器不会被算进连接器卡的「N 个异常」**（异常只统计 `err`）。

**展示名的语言问题**：`mcp_connectors` 有 `name_zh` / `name_en` 两列，`provider_keys` 只有可空的
`label` 和 `provider`。服务端**两个语言都返回**（`name_zh` / `name_en`，沿用 `auditQuery` 的
`facets.actions` 里 `label` / `label_en` 既有先例），浏览器按 `getLang()` 选一列——服务端挑死
一列会让英文界面显示中文。MCP 取 `COALESCE(NULLIF(name_zh,''), NULLIF(name_en,''), server_key)`，
模型服务商取 `COALESCE(NULLIF(label,''), provider)`。

**`checked_at` 只统计调用方可见的行**：先按权限裁剪再取最大值，否则没有 `provider:view` 的人
能从时间戳推断出「模型服务商那边刚测过」。

**底部**：只有「全部服务 →」跳转 `/config/mcp-manage`，以及一句静态说明「检测结果来自各配置页的手动测试」。**没有巡检时间戳、没有重新检测按钮。**

### 4.5 部门用量排行

- 只统计**一级部门**（`departments.parent_id IS NULL`）。子部门用递归 CTE 上卷到根：

  ```sql
  WITH RECURSIVE dept_root AS (
    SELECT id, id AS root_id FROM departments WHERE org_id = $1 AND parent_id IS NULL
    UNION ALL
    SELECT d.id, r.root_id FROM departments d JOIN dept_root r ON d.parent_id = r.id WHERE d.org_id = $1
  )
  ```

- 用户 `department_id IS NULL` 归入一个虚拟桶，正常参与排行与计数。
- 每行返回 `{ department_id, name, users, tokens }`，`users` = 该部门范围内**有过调用**的去重用户数。
- **未分配桶返回 `{ department_id: null, name: null, … }`，不下发中文字面量**。「未分配」由前端
  的 `dashboard.rank.unassigned` 渲染（§6），英文界面读同一个键。服务端硬编码中文会让英文界面
  出现中文，且与 `web/src/i18n.ts` 的单一文案来源冲突。
- 按 tokens 降序取 5。

### 4.6 最近动态

- **直接复用 `queryAudit`**（`src/analytics/auditQuery.ts`），参数固定为
  `{ from: <最近 7 天窗口>, to: now, filters: { exclude: ['provider_call'] }, includeLogin: true, page: 1, pageSize: 6 }`：
  - `includeLogin: true` 是必需的——登录失败（含原型里那条「SSO 登录失败」）在
    `login_events` 里，**不写 `audit_events`**，另写一条查询会正好漏掉管理员最想看的那类事件。
  - `exclude: ['provider_call']` 与审计页默认视图一致，否则模型调用会把 6 个位置刷满。
  - 这样 `tone` / `action_zh` / `action_en` / `user_name` 全部沿用既有解析，面板与审计页
    对同一条记录给出的措辞和颜色不可能不一致。
- **颜色语义复用既有 `AuditTone`**（`src/shared/auditActionMeta.ts`），不在本模块另建映射：
  `Failure` → 红、`Danger` → 红、`Change` → 橙、`Auth`/`Normal` → 蓝、`Success` → 绿。
- **句子由浏览器拼，服务端只给标签**。本仓库既有约定是服务端返回 label、浏览器按语言渲染
  （`auditQuery.ts` 返回 `action_zh`/`action_en`，`AuditPage` 用 `getLang()` 选一个）。服务端拼
  句子就得同时返回中英两版或硬编码中文，后者与 §6 及 CLAUDE.md 的 i18n 规则冲突。服务端因此返回
  `action / action_zh / action_en / tone / target_type / target_name_zh / target_name_en /
  user_name / user_id / ts`，前端拼成「{对象}{动作}」。
- **`target_name` 需要一次解析**：`queryAudit` 只给 `target_id`（多数是 UUID）。在 `dashboard.ts`
  内维护一张 `target_type → 取名列` 的显式映射表（`mcp_connector` / `provider_key` / `model` /
  `agent` / `user` / `dept` / `role`），按 type 分组后每种类型发一条 `= ANY($2)` 查询回填，
  同样返回 `_zh` / `_en` 两列。表里没有的 type 回落到 payload 的 `name` / `username`，仍取不到则
  `target_name_*: null`，前端退化成只显示动作与操作人——**绝不把 UUID 显示给管理员**。
- **系统动作**：`user_id IS NULL` 时服务端返回 `user_id: null`，前端渲染 `dashboard.activity.system`。
  与「未分配」同理，服务端两个语言都不下发。
- **敏感值脱敏**：`payload` 整包不下发。服务端只返回拼句子所需的
  `action / action_zh / action_en / tone / target_type / target_name / user_name / ts`，
  任何 key 命中 `/(key|secret|token|password|credential)/i` 的字段不会出现在响应里。

### 4.7 端点与权限裁剪

```
GET /admin/dashboard/summary
GET /admin/dashboard/usage?range=<UsageRangeKey>
```

**`/summary`** — `requireAuth`。按调用者的权限点逐段裁剪，无权段的键返回 `null`（用 `null` 而非省略，让前端不必靠"键在不在"猜）：

| 响应键 | 需要权限点 | 对应卡片/区块 |
| --- | --- | --- |
| `users` | `user:view` | 总用户数 |
| `agents` | `agent:view` | 启用智能体 |
| `mcp` | `mcp:view` | 连接器（MCP）卡 |
| `health` | `mcp:view`；其中的 `model` 类型条目另需 `provider:view` | 服务健康 |
| `activities` | `audit:view` | 最近动态 |

**`/usage`** — 整个路由 `requirePermission(PP.UsageView)`，无权即 403。返回 `active / tokens / unaccounted_calls / trend / model_top / dept_top`。

**为什么是两个端点而不是 PRD §7.3 建议的单个 `/overview`**：合并后，没有 `usage:view` 的成员连配置类那半边也拿不到（与 §4.7 的分块可见性冲突）；而且 PRD §6.8 要求"单区块失败不影响其他区块"，单端点做不到。代价是降级粒度落在**组级**（用量组整体失败 ≠ 汇总组失败），这是对 PRD 的一处有意让步。

**响应形状**：

```jsonc
// GET /admin/dashboard/summary
{
  "updatedAt": "2026-10-23T09:30:00+08:00",
  "users":  { "total": 58, "enabled": 52, "disabled": 6 },
  "agents": { "enabled": 12, "total": 15 },
  "mcp":    { "enabled": 18, "abnormal": 1, "first_abnormal": "纷享销客 CRM" },
  "health": {
    "checked_at": "2026-10-23T09:25:00+08:00",   // 全表最新的 last_test_at；全为 null 时为 null
    "items": [
      { "id": "…", "name": "OpenAI", "type": "model", "status": "ok",
        "latency_ms": 420, "last_test_at": "2026-10-23T09:25:00+08:00" }
    ]
  },
  "activities": [
    { "id": "…", "ts": "2026-10-23T09:28:00+08:00", "user_name": "同步服务账号",
      "action": "mcp_connect_test", "action_zh": "…", "action_en": "…",
      "tone": "failure", "target_type": "mcp_connector", "target_name": "纷享销客 CRM" }
  ]
}

// GET /admin/dashboard/usage?range=7d
{
  "range": "7d",
  "from": "2026-10-17T00:00:00+08:00",
  "to":   "2026-10-24T00:00:00+08:00",
  "timezone": "Asia/Shanghai",
  "active": { "value": 34, "prev": 30 },
  "tokens": { "value": 1824000, "prev": 1680000 },
  "unaccounted_calls": 12,
  "trend": {
    "granularity": "day",
    "points": [ { "key": "2026-10-17", "label": "10/17", "tokens": 142000, "calls": 960 } ]
  },
  "model_top": [ { "provider": "anthropic", "model": "…", "display_name": "…",
                   "tokens": 684000, "calls": 4021 } ],
  "dept_top":  [ { "department_id": "d1", "name": "产品部", "users": 9, "tokens": 526000 } ]
}
```

**环比百分比由前端算**（`(value - prev) / prev`，`prev === 0` 显示「新增」），服务端只给两个原值。理由：四舍五入规则与「上期为 0」的呈现是纯展示决策，放在一处比在两处各写一遍更不容易漂。

### 4.8 目标页的 URL 参数支持（增量改动）

三个跳转需要在既有页面读搜索参数（目前 `UsagePage` / `AuditPage` **完全不读**）：

| 页面 | 新增支持 | 触发方 |
| --- | --- | --- |
| `/monitoring/usage` | `?range=<key>` 初始化范围（缺省仍为 `7d`） | 页头范围、模型调用量卡 |
| `/monitoring/usage` | `?model=<provider>/<model>`：切到模型 tab、只取该模型并高亮 | 模型 TOP5 行 |
| `/monitoring/audit` | `?userId=<id>&range=custom&from=<day>&to=<day>` | 最近动态单条 |

- 模型 tab 无 `?model` 时默认停在用户 tab 的既有行为不变（`UsageTab.Users` 是当前默认值）。
- 高亮用既有 `Card` 的 `selected` 形态，不引入新样式。
- **`?model=` 需要服务端配合**：模型 tab 是每页 50 行的服务端分页，榜上的模型可能根本不在
  当前页。为此给 `GET /admin/usage/models` 增加一个**可选**的 `model=<provider>/<model>`
  查询参数（一个 `WHERE (provider, model) = (...)` 谓词），命中时只返回该行。
  这是对既有端点的纯增量：不传时行为逐字节不变。
- 部门排行行**只做普通跳转** `/monitoring/usage?range=<key>`，不带部门筛选（见 §2 非目标）。

---

## 5. 前端设计

### 5.1 新增文件

```
web/src/api/dashboard.ts                          接口封装与响应类型（镜像服务端 snake_case 线格式）
web/src/pages/DashboardPage.tsx                   页面（替换 App.tsx 的占位）
web/src/components/dashboard/StatCards.tsx         5 张指标卡
web/src/components/dashboard/TrendChart.tsx        双折线 SVG + 悬停 tooltip
web/src/components/dashboard/ServiceHealth.tsx     服务健康列表
web/src/components/dashboard/RankBars.tsx          模型 TOP5 / 部门排行共用的条形榜
web/src/components/dashboard/ActivityFeed.tsx      最近动态时间线
web/src/components/dashboard/format.ts             token 单位格式化（万/亿 ↔ K/M/B）
```

`web/src/App.tsx` 的 `/` 路由改为 `<Shell><DashboardPage /></Shell>`。`AuthGuard` 不加 `requires`（面板本身对所有登录成员开放，只是区块按权限裁剪）。

### 5.2 页面结构

```
面板                        [时间范围 ▾] [⟳ 刷新]
早上好，{用户} · 今天是 … · 数据更新于 09:30
[总用户数][活跃用户][模型调用量][启用智能体][连接器]      5 列，≤1280px 降 3+2
┌ 调用趋势 (1.9fr) ─────────┬─ 服务健康 (1fr) ─┐
┌ 模型 TOP5 (1fr) ──┬ 最近动态 (1.9fr) ───────┐
└ 部门用量排行（通栏）────────────────────────┘
```

- 复用 `PageHeader` / `Card` / `EmptyState` / `RangeSelect` / `Toast`，不自建同类组件。
- 指标卡栅格实测（1440 / 1280 / 1100 / 900 / 700 / 640 六档，均无横向滚动）：
  `xl:`(≥1280) 五列，更窄三列，<640 两列。**未采用 §8「≤1280 降 3+2」的写法**：
  1280 宽下五列实测每卡 188px、恰好不溢出，而降成两行会把下面的趋势 + 健康区
  往下推约 90px，在 §8 同时要求的「最小支持 1280×720」下会把服务健康顶出首屏。
  规则的本意是别把卡片挤到读不清，实测没有发生，故按实测放宽。
- 数据获取用 `@tanstack/react-query`（与 `UsagePage` 一致），两个 query 分别对应两个端点。**刷新按钮 = 两个 query 同时 `refetch()`**，不做单区块刷新。
- 换范围：只 `refetch` usage query，summary 不动（它本就不随范围变化），并弹 toast「已切换至「近 7 天」数据」。
- 缓存：两个 query 都显式写 `staleTime: 60_000`。**不能靠默认值**——`web/src/main.tsx` 里
  QueryClient 的默认 `staleTime` 是 30s，比 PRD 要求的 60s 短。刷新按钮用 `refetch()` 绕过缓存。

### 5.3 图表

`TrendChart.tsx` 手写 SVG，沿用 `DailyBarChart` 的固定 `viewBox` 做法（无图表库、无 ResizeObserver、jsdom 与浏览器渲染一致）：

- 蓝色实线 = Tokens（含约 6% 透明度面积填充），绿色实线 = 调用次数（右轴按最大值归一化，不画刻度）。
- 左轴 Tokens，4 条水平虚线网格；刻度上限取"向上取整到 1/2/5×10ⁿ"（复用 `DailyBarChart` 的 `niceCeil` 思路，抽到共享位置或各自保留一份随实现定）。
- 每个数据点画空心圆点（白底 + 2px 描边）。
- X 轴标签最多 7 个（首尾必显示，其余按 `ceil(n/7)` 间隔）。
- **悬停 tooltip**：日期、Tokens、调用次数。PRD R-6.3.2 点名说原型没做、本期必须补。用每个点一个透明 `<rect>` 命中区 + 绝对定位的浮层实现，不引图表库。
- 图下方一行注释：左轴 Tokens、右轴调用次数按归一化展示。
- 卡片右上角「查看明细 →」跳 `/monitoring/usage?range=<key>`。
- 全区间无数据（非零点数为 0）时不渲染坐标轴，改为居中显示空态「所选范围内暂无调用数据」。
- 无障碍：`role="img"` + `aria-label`，并保留一份隐藏的数据表兜底。

### 5.4 数值格式

- `format.ts` 导出一个 `formatTokens(n, lang)`：中文 `万 / 亿`，英文 `K / M / B`，保留 1 位小数（`< 1000` 时原样带千分位）。PRD §8 要求单位随语言切换。
- 指标卡数值加 `tabular-nums`，避免刷新时跳动。
- 卡片顺序固定为 PRD R-6.2.1 的五项，不可调整。

### 5.5 状态与边界

| 状态 | 表现 |
| --- | --- |
| 加载中 | 各卡片骨架屏；图表区占位矩形 |
| 单组失败 | 该组卡片显示「加载失败，点击重试」，另一组正常渲染 |
| 无数据 | 按 PRD 各区块空态文案，不隐藏卡片 |
| 无权限 | 对应卡片/区块整体不渲染（服务端已裁剪，前端不画占位） |
| 无任何可见区块 | 不留空白页：整页渲染一个说明态（`dashboard.empty.noAccess`），列出该用户有权进入的管理页入口 |
| `usage_missing` | 若 `unaccounted_calls > 0`，在趋势图下方复用既有 `GapNotice` 提示（与用量页同一 honesty 口径） |

---

## 6. i18n

新增 `dashboard.*` 键，`en` 与 `zh` 两份字典都要写。命名空间：

`dashboard.title` / `.greeting.{morning,afternoon,evening}` / `.updatedAt` / `.range.*`（复用 `analytics.range.*`，不重复定义）/ `.stat.{users,active,tokens,agents,mcp}.*` / `.trend.*` / `.health.*` / `.rank.*` / `.activity.*` / `.empty.*` / `.error.*` / `.toast.*`

问候语按组织时区下的当前小时数选 `早上好 / 下午好 / 晚上好`；日期与时间一律经
`analytics/datetime.ts` 的组织时区格式化路径渲染，不直接 `new Date()`。该模块目前只有两个
带时刻的导出（`formatOrgDateTime` / `formatOrgDateTimeShort`），**需要新增一个纯日期导出**
`formatOrgDate(iso, timeZone): string`（`YYYY年M月D日` / `en` 下 `MMM D, YYYY`），
页头「今天是 …」和喂给问候语的小时数都由它派生，不另开一条格式化路径。

---

## 7. 测试策略

### 服务端（`npm test`，vitest + pglite）

| 文件 | 覆盖 |
| --- | --- |
| `tests/analytics/dashboard.test.ts` | 区间解析；环比窗口四个范围各一条：`7d`/`30d` 的等长回退、`today` 的墙钟右界截断、`this_month` 锚到上月 1 日、`last_month` 锚到上上月 1 日（**用 31 天的 3 月当样本**，正是等长规则会算错的那个case）；趋势零值补点；模型 TOP5 的 `(provider, model)` 合并口径与 039 同名模型场景；部门递归上卷与「未分配」桶；健康排序 `err→warn→ok→unknown` 与前 6 截断 |
| `tests/routes/dashboard.test.ts` | 权限裁剪：无 `usage:view` 时 `/usage` 403 且 `/summary` 仍返回配置段；缺 `user:view` 时 `users` 为 `null`；`super_admin` 全通；`orgId` 不接受查询参数 |

> 注意：`enterprise_server` 整包 vitest 在本机会撞 fd 上限（EBADF），**按文件跑**：`npx vitest run tests/analytics/dashboard.test.ts`。

### 前端（`web` 的 `npm test`）

| 文件 | 覆盖 |
| --- | --- |
| `tests/api/dashboard.test.ts` | 两个请求的 URL 与参数 |
| `tests/components/dashboard/format.test.ts` | 万/亿 ↔ K/M/B 边界值 |
| `tests/components/dashboard/RankBars.test.tsx` | 条形宽度相对第一名归一化；1–3 名徽标 |
| `tests/components/dashboard/TrendChart.test.tsx` | 网格线 4 条、X 轴标签 ≤7、空态、tooltip 命中 |
| `tests/pages/DashboardPage.test.tsx` | 五卡顺序；无 `usage:view` 时用量区块不渲染；换范围只刷 usage 组；刷新按钮双 refetch |
| `tests/pages/UsagePageModels.test.tsx`（增量） | `?model=` 高亮定位 |
| `tests/pages/AuditPage.test.tsx`（增量） | `?userId=` + 自定义区间预置筛选 |

### Lint

```bash
cd enterprise_server && npx eslint --ext ts --report-unused-disable-directives --max-warnings 0 <改动文件>
cd enterprise_server/web && npx tsc --noEmit && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <改动文件>
```

### 手工验证

`npm run web:dev` + `npm run dev`（:5173 → :8787），登录后确认首屏、切换范围、点各跳转、造一条异常连接器验证红色态与排序。

---

## 8. 与 PRD 的偏离（逐条）

| # | PRD 要求 | 本设计 | 原因 |
| --- | --- | --- | --- |
| 1 | 服务健康每 5 分钟自动巡检 | 不做，只读手动测试结果 | 平台无此基建；用户决定 |
| 2 | 「重新检测」按钮 | 去掉 | 同上；面板保持只读 |
| 3 | `warn` = 超时率>3% 或 P95>3s | 近似为单次 `latency_ms > 3000` | 无历史采样可算超时率与 P95 |
| 4 | 6 个接口 | 2 个（summary / usage） | 权限分块可见性 + 降级粒度（§4.7） |
| 5 | 单区块失败隔离 | 组级降级 | 同上 |
| 6 | 时间范围 5 项（§5.3）／3 项（§10） | **5 项** | 原型 `<select>` 是 5 项；`RangeSelect` 与两套 i18n 已有这 5 个键。若要按 §10 砍成 3 项，改两个数组即可 |
| 7 | 「今天」趋势 | 按小时分桶 | 原型的"今天也画 7 天"与指标卡口径矛盾 |
| 8 | 部门排行跳转带部门筛选 | 普通跳转 | 用量页无部门维度筛选，新增它超出本期范围 |
| 9 | 面板仅对超管/部门管理员开放 | 对所有登录成员开放，按权限点裁剪区块 | 侧边栏「面板」本就无条件显示；越权数字由服务端挡住 |
| 10 | 埋点 6 个事件 | 不做 | 管理台无埋点基建 |
| 11 | 模型 TOP5 与用量表口径一致 | TOP5 只含**范围内有调用**的模型 | 用量表要列出"配置了但没调用"的模型；排行榜排的是实际用量，0 值是噪音 |
| 12 | 「启用智能体」按组织统计 | ✅ 已按组织统计 | 原表无 `org_id`；迁移 053 补齐，并顺带修复了一个跨租户越权洞（见 §9） |
| 13 | 服务端拼接动态文案 | 服务端只给 zh/en 标签，句子由浏览器拼 | 与本仓库既有 i18n 约定一致；服务端拼句必须硬编码中文或返回双份句子 |
| 14 | 未分配部门 / 系统操作人显示为中文名 | 服务端返回 `null`，由前端 i18n 键渲染 | 同上，英文界面不得出现中文 |

---

## 9. 风险

| 风险 | 缓解 |
| --- | --- |
| 「服务健康」长期无数据（全平台都没人手动测过） | 空态明确写「尚未检测」而不是假装正常；连接器卡的异常数为 0 时显示绿色「全部正常」，但健康列表会同时列出灰色「尚未检测」行，不自相矛盾 |
| 权限裁剪后页面区块数量随角色变化，布局可能塌 | 用 CSS grid 的固定列定义 + 缺项不渲染，不用固定高度容器 |
| `today` 的小时分桶 SQL 与日分桶不同，容易写成两份 | 聚合查询用一个函数，`granularity` 参数切换 `date_trunc` 的单位，SQL 骨架共用 |
| 环比在 `today` 下的截断逻辑写错会静默失真 | 专门写一条测试断言"上期右界 = 本期右界的同一墙钟时刻" |
| i18n.ts 已 15 万字符，新增键容易插错字典 | 两份字典的 `dashboard.*` 块都放在文件末尾同一位置，便于 diff |
| ~~智能体目录是全平台的~~ | **已修复**：迁移 053 给 `agent_marketplace_agents` 加了 `org_id`（存量归到最老的组织，沿用 035 的做法）。这不只是计数口径问题——管理端列表原本是无条件 `SELECT`，任一组织的管理员都能改删别家的智能体（实测跨组织 DELETE 曾返回 204）。全部 agent 路由已按 `claims.orgId` 收窄，跨组织访问一律 404 |
| `orgs.timezone` 目前恒为 `'UTC'` 且无 setter，「今天」因此是 UTC 日 | 与用量页完全一致（同一个 `resolveUsageRange`），**不为面板单独偏移**；一旦将来加了时区设置，两处会一起变正确 |
| `token_usage.total_tokens` 是 `INTEGER`，`SUM` 会溢出 | 所有聚合显式 `::bigint`，与 `queryModels` 既有写法一致 |
| 低权限成员登录后落到近乎空白的面板 | 无可见区块时渲染整页说明态并列出可进入的管理页，而不是留白 |

---

## 10. 待确认

无阻塞项。§8 的 10 条偏离均已在与需求方确认后写定；其中第 6 条（时间范围 5 项 vs 3 项）是 PRD 内部自相矛盾，按原型与既有代码取 5 项，若判断有误改两处数组即可回退。