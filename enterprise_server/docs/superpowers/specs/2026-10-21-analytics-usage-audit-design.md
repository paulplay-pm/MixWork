# 运行分析（用量与审计）设计

日期：2026-10-21
范围：`enterprise_server`（后端 + web 控制台）+ `providerProxy` 记账与流式 usage 解析

原型：`/Users/paulwang/WorkBuddy/2026-09-08-21-59-26/llm-config/analytics-standalone.html`
产品需求：`/Users/paulwang/WorkBuddy/2026-09-08-21-59-26/llm-config/PRD-运行分析-用量与审计.md`

> 这两个文件**不在本仓库内**，在上面那个绝对路径下。

---

## 1. 背景

控制台现有的两个「监控」页面无法支撑企业管理员的日常诉求：

- `/monitoring/usage` 是一个**配额页**：每个模型一条 `QuotaBar`，按 `quota_per_user_per_day` 画进度。没有时间范围、没有维度切换、没有导出、没有明细下钻。路由 `<AuthGuard>` 不带 `requires`，任何登录用户都能看到。
- `/monitoring/audit` 显示 **UUID**（`user_id`）而非姓名，`action` 是裸英文码，只有「用户 / 操作」两个筛选且**在前端过滤**（拉 200 条回来自己 filter），载荷不能点开，无分页。后端 CSV 用 `.replace(/,/g, '\\,')` 处理逗号，这不是 CSV 转义，payload 含逗号即串列。

新页面按 PRD 整体替换这两页。配额**拦截**逻辑保留在 proxy 中不动，仅从界面移除配额概念。

### 1.1 动手前发现的两件事

**（甲）`token_usage` 可能基本是空的。** `src/proxy/upstream.ts:20-22`：只要请求带 `stream: true`，直接 `return { usage: null, stream: res.body }`，不看上游发了什么。而 `providerProxy.ts:186` 的注释写明"OpenClaw gateway 发的就是 `stream: true`"，企业模型全部走这条路。所以"上游漏发 usage 字段"不是边缘情况，而是**主路径**。不改这里，做出来的用量页 tokens 会接近于零。见 §5.6。

**（乙）同名模型会重复出现。** migration 039 把 `model_catalog` 的唯一性改成 `(org_id, provider_key_id, model)`，所以内置服务商与同厂商的自定义 key 可以各持有一个同名模型（内置 id 为 `builtin:{orgId}:{slug}:{model}`，自定义为 `crypto.randomUUID()`，见 `src/org/builtinProviders.ts:91` 与 `src/models/modelCatalog.ts:102`）。以 `model_catalog` 为左表直接 JOIN 会让同一个模型名出现两行、数字被拆开。见 §5.2。

---

## 2. 已确定的决策

以下为与产品方确认的结论，实现时按此执行。

| # | 决策 |
|---|---|
| D1 | 新页面**整体替换** `/monitoring/usage` 与 `/monitoring/audit`，两个 URL 保持不变 |
| D2 | 界面**走双语**，接入现有 `t()` 体系；**以中文为主语言**——中文文案对齐 PRD 措辞，英文为对照翻译 |
| D3 | 新增权限点 `usage:view` / `usage:export`，授予 `super_admin`、`auditor`、`org_admin` |
| D4 | 分析页所有日期切分统一用 `orgs.timezone`；`quota_window_date` 保持按用户时区，仅服务配额。**当前 `orgs.timezone` 恒为 `'UTC'`**（全库无人写入，见 §1 补充），本期接受单时区部署，见 §5.1 |
| D5 | **修复 proxy 记账漏洞**：`stream: true` 的请求也要记 `token_usage` 与 `provider_call` 审计事件 |
| D6 | 用户用量列表**显示全部成员**，含区间内零调用的成员；**含被禁用成员** |
| D7 | 审计页**新增时间范围筛选**（PRD 原本没有） |
| D8 | 聚合**实时计算**，本期不建汇总表 |
| D9 | **解析流式 usage**：向 OpenAI 兼容端点发送 `stream_options: {include_usage: true}`，从 SSE 中提取 usage。解析不出时退到 D10 |
| D10 | 流式 usage 解析不可用时，**在页面上显式提示缺口**：展示"本周期内 N 次调用未能取得 token 统计"，不静默 |
| D11 | 模型用量**按 `provider + model` 合并成一行**，同名模型的用量相加；已删除模型的历史用量**保留在列表中** |

### D2 的含义（避免误解）

不是「这两个页面硬编码中文」。所有可见字符串进 `web/src/i18n.ts`，zh 与 en 两套 key 同时提交，key 前缀 `analytics.*`。中文是主语言，指**以中文措辞为准**去写英文译文。

---

## 3. 目标 / 非目标 / 反目标

### 目标

1. 管理员能按「今天 / 近 7 天 / 近 30 天 / 本月 / 上月」查看模型用量与成员用量，支持搜索、排序、分页、下钻、导出。
2. 管理员能按时间范围 + 用户 + 操作类型 + 对象类型追溯审计记录，查看结构化载荷并导出归档。
3. 页面上出现的每个数字，都能在同一时间窗口下由 CSV 导出复现。
4. 两个页面仅对持有相应权限点的角色可见。

### 非目标（本期明确不做）

- 模型配额、限额、额度使用率的**任何**展示（拦截逻辑保留）。
- 部门维度的数据隔离 / 部门管理员只看本部门（PRD §2.1 已确认本期可见全部）。
- 自定义起止日期在**用量页**（仅审计页有，见 D7）。
- 审计记录的人工删除 / 修改（只增不改不删，保留 ≥180 天）。
- 成本金额（`cost_usd` 字段存在但 proxy 从不写入，本期不展示）。
- **组织时区设置项**（`orgs.timezone` 的写入入口），见 §5.1。
- 英文以外的界面语言。

### 反目标（做到这些也算失败）

- **数字对不上**：页面显示的用量与导出的 CSV 不一致，或同一链接不同管理员看到不同数字。
- **假精确**：漏记的调用让「调用次数」静默偏低，或 tokens 系统性偏低却看不出来——D9/D10 就是冲这个来的。
- **重复行**：同名模型在列表里出现两次（§1.1 乙）。
- **接口需二次实现**：页面需要的聚合维度不能靠前端拉原始行自己算。

---

## 4. 约束

- `web/` 无图表库依赖（仅 `react` / `react-query` / `tailwind` / `lucide-react` / `dayjs`）。图表**手写 SVG**，与原型一致。
- **`date-fns-tz` 当前不是 `enterprise_server/package.json` 的声明依赖**，是靠 monorepo 根的 hoist 解析到的。`src/org/timezone.ts` 已经在 import 它，但 `src/analytics/range.ts` 新建文件继续依赖这个隐式 hoist 是脆的——**必须把它显式加进 `enterprise_server/package.json` 的 `dependencies`**，并确认 Docker 构建（`npm ci`）后仍能解析。
- **`web/` 不能 import `enterprise_server/src/`**。`web/tsconfig.json` 的 `include` 是 `["src","tests"]`（相对 `web/`），且 `web/src/shared/permissions.ts:1-9` 明确记录了镜像约定："hand-kept mirror of `enterprise_server/src/shared/permissionPoints.ts`… the SPA does not import from the server's src/"。本次新增的 `auditActionMeta` / `auditTargetTypeMeta` 按**镜像 + 奇偶校验测试**处理，不引入 vite alias。
- 运行时为 pglite（测试）与 PostgreSQL（生产），迁移需对 pglite 重放幂等。
- 前端已有**细粒度权限门禁** `web/src/auth/usePermissions.ts`（基于 `useMe()` → `/me` 返回的 `permissions`），`KitManagePage` 已在用。见 §7.4。
- CI 只 lint 变更的 TS 文件；测试入口为 `npm test`（根 vitest，`include: ['tests/**/*.test.ts']`，node 环境）。**web 侧测试不在这个配置里**，见 §8。
- **已知基线**：`tests/enterprise-agent-sync` 有 5 个既有失败，非本次引入。

---

## 5. 后端设计

### 5.1 时间范围解析

新增 `src/analytics/range.ts`：

```ts
export const UsageRange = {
  Today: 'today',
  Last7Days: '7d',
  Last30Days: '30d',
  ThisMonth: 'this_month',
  LastMonth: 'last_month',
} as const;
export type UsageRange = (typeof UsageRange)[keyof typeof UsageRange];

export const AuditRange = { ...UsageRange, Custom: 'custom' } as const;

async function resolveRange(orgId: string, range: UsageRange, custom?: { from?: string; to?: string })
  : Promise<{ from: Date; to: Date; timezone: string; key: UsageRange }>
```

规则：

- 时区取自 `orgs.timezone`（D4）。**该列 `NOT NULL DEFAULT 'UTC'` 且当前无人写入**，所以实际值恒为 `'UTC'`；本期不做设置入口，接受单时区部署。
- **取值失败不抛异常**：`org/timezone.ts:10` 的 `resolveZone` 遇到非法 IANA 值会 `throw`，一旦有人手动写坏 `orgs.timezone`，会让所有分析请求 500。`range.ts` 必须**包一层 try/catch，解析失败退回 `'UTC'`**，绝不把异常冒泡成 500。（`resolveZone` 本身保持原样，`quotaWindowDate` 的既有行为不动。）
- 区间一律是左闭右开 `[from, to)`。
- `today`：`[当天 00:00, 次日 00:00)`。
- `7d` / `30d`：含今天在内的最近 N 个自然日，`[今天-(N-1) 的 00:00, 次日 00:00)`。
- `this_month`：本月 1 日 00:00 → 次月 1 日 00:00。
- `last_month`：上月 1 日 00:00 → 本月 1 日 00:00。
- `custom`（仅审计）：读 `from` / `to`（`YYYY-MM-DD`，含当日两端），缺一报 400。
- 按天序列的**天数**由区间推导，与抽屉柱状图柱数一致（验收标准第 2 条）：`today`→1、`7d`→7、`30d`→30、`this_month`→当月已过天数、`last_month`→上月总天数。

**客户端只传 `range` key，不传起止时间**（`custom` 除外）。这样页面与导出走同一条解析路径，避免两边算窗口漂移（目标 3 / 反目标第 1 条）。

### 5.2 用量查询

新文件 `src/analytics/usage.ts`，路由挂 `/admin/usage`。四个接口全部要求 `PP.UsageView`。

#### 合并模型（D11）

模型用量**不按 `model_catalog.id` 分行**，而是按 `(provider, model)` 分行。同名的多个 catalog 条目（内置 + 自定义 key）的用量相加，显示名取非空的 `display_name`（优先内置条目，其次任一）。

因此左表是一个**并集**，不是 `model_catalog`：

```sql
WITH agg AS (
  SELECT provider, model,
         SUM(total_tokens) AS total_tokens,
         COUNT(*)          AS call_count
  FROM token_usage
  WHERE org_id = $1 AND ts >= $2 AND ts < $3
  GROUP BY provider, model
)
SELECT COALESCE(c.provider, a.provider) AS provider,
       COALESCE(c.model,   a.model)   AS model,
       ... display_name ...,
       COALESCE(a.total_tokens, 0) AS total_tokens,
       COALESCE(a.call_count, 0)    AS call_count
FROM (SELECT provider, model, MAX(display_name) ... FROM model_catalog
      WHERE org_id = $1 GROUP BY provider, model) c
FULL JOIN agg a USING (provider, model)
ORDER BY total_tokens DESC
```

- **FULL JOIN** 保证两件事同时成立：目录里有但没调用的模型（`total_tokens = 0`，PRD §4.1.2 要求展示）出现；已经从 `model_catalog` 硬删除的模型，其历史用量**仍在 `agg` 里**，不会消失（D11）。
- `display_name` 用聚合取（`MAX(display_name)` 或按 `provider_key_id` 排序取首个非空），不要 `GROUP BY display_name`——那会把同名模型拆开，正好是反目标第 3 条。
- `token_usage.provider` 与 `model_catalog.provider` 都是写入时冗余存储的，join 键用它们即可，不需要回查 catalog。
- **分页在服务端做**，默认 `pageSize = 50`（覆盖"超过 20 条启用分页"的要求，同时让表格与 CSV 的「共 N 个模型」可证明是同一集合）。响应带 `total`。

#### `GET /admin/usage/models?range=7d&page=1&pageSize=50`

```jsonc
{
  "range": "7d", "from": "...", "to": "...", "timezone": "UTC",
  "page": 1, "pageSize": 50, "total": 12,
  "items": [{
    "provider": "anthropic", "model": "claude-opus-4",
    "display_name": "Claude Opus 4",
    "total_tokens": 1234567, "call_count": 890
  }]
}
```

`call_count` 语义：`COUNT(*)`，包含 429 超额、502 上游失败、以及所有流式调用（这些行 token 可能为 0 但调用确实发生过）。

#### `GET /admin/usage/users?range=7d&q=&sort=desc&page=1&pageSize=8`

以 `users` 为左表 LEFT JOIN 聚合，**显示全部成员**（D6）：

- 不按 `status` 过滤，禁用成员（`status != 'active'`）同样列出。
- 不按归档过滤。`user_archives` 存的是工作区快照，与用户行是否在册无关。
- `q` 对 `display_name` 与 `username` 做 `ILIKE '%'||$q||'%'`（忽略大小写）。搜索命中时前端重置到第 1 页。
- `sort`：`desc`（默认）/ `asc`。
- **必须有确定性排序 tiebreaker**：零用量成员之间数值完全相同，若无次级键，分页边界会随请求漂移（用户翻页时同一个人可能出现在两页）。排序写死为 `ORDER BY total_tokens <dir>, COALESCE(display_name, username) ASC, user_id ASC`。
- 零用量成员：`total_tokens = 0`、`last_used_at = null`（前端显示「—」）。

```jsonc
{
  "range": "7d", "from": "...", "to": "...", "timezone": "UTC",
  "page": 1, "pageSize": 8, "total": 137,
  "items": [{
    "user_id": "u_1", "username": "zhangwei", "display_name": "张伟",
    "department_name": "研发中心" /* 或 null */,
    "total_tokens": 98211, "last_used_at": "2026-10-21T14:23:11.000Z" /* 或 null */
  }]
}
```

#### `GET /admin/usage/users/:userId?range=7d`

抽屉数据。

```jsonc
{
  "range": "7d", "from": "...", "to": "...", "timezone": "UTC",
  "user": { "user_id": "u_1", "display_name": "张伟", "department_name": "研发中心" },
  "daily": [{ "date": "2026-10-15", "tokens": 0 }, { "date": "2026-10-16", "tokens": 8123 }],
  "by_model": [{ "provider": "anthropic", "model": "claude-opus-4",
                 "display_name": "Claude Opus 4", "tokens": 80000, "pct": 81.5 }],
  "unaccounted_calls": 0
}
```

- `daily` **必须返回区间内每一天**，包括 0 值的天（前端只对 `tokens > 0` 画柱，但数组长度决定柱数与 x 轴刻度）。验收标准第 2 条。
- 按天分组用 `date_trunc('day', ts AT TIME ZONE $tz)::date`。
- `by_model` 按 tokens 降序，`pct` = 该模型 tokens / 该成员区间总 tokens × 100（一位小数）；总 tokens 为 0 时 `pct` 全 0。合并规则同 D11。
- `unaccounted_calls`：该成员区间内 `usage_missing = true` 的调用数（D10）。

#### `GET /admin/usage/export.csv?range=7d&tab=models|users`

要求 `PP.UsageExport`。见 §5.4。导出**不受表格分页限制**——与当前筛选/排序下的全量一致。

### 5.3 审计查询

改造 `src/routes/admin/audit.ts` 与 `src/audit/auditStore.ts`。

#### `GET /admin/audit?range=30d&userId=&action=&targetType=&targetId=&page=1&pageSize=15`

要求 `PP.AuditView`。

```jsonc
{
  "page": 1, "pageSize": 15, "total": 428,
  "range": "30d", "from": "...", "to": "...",
  "items": [{
    "id": "...", "ts": "2026-10-21T14:23:11.000Z",
    "user_id": "u_1", "user_name": "张伟",
    "action": "model_config_updated",
    "action_zh": "模型配置更新", "action_en": "Model config updated", "tone": "change",
    "target_type": "model", "target_type_zh": "模型",
    "target_id": "...", "payload": { }
  }],
  "facets": {
    "users": [{ "value": "u_1", "label": "张伟" }],
    "actions": [{ "value": "model_config_updated", "label": "模型配置更新", "label_en": "Model config updated" }],
    "target_types": [{ "value": "model", "label": "模型", "label_en": "Model" }]
  }
}
```

要点：

- **时间范围是新加的（D7）**：同 §5.1，含 `custom`。
- **筛选器**：`userId` / `action` / `targetType` / `targetId`，可叠加。
- **`targetId` 是为 `DeptDetail` 加的**（见 §6.5），前端审计页不使用，但接口必须支持，否则部门详情页的审计 tab 无法正确重接。
- **`facets` 随列表一起返回**，避免为填下拉框再发一轮请求。选项来源是**区间内**出现过的非空值。`actions` / `target_types` 的选项必须来自映射表（§5.5），保证下拉里不会出现没有中文名的裸码。
- **用户显示姓名**：LEFT JOIN `users` 取 `display_name`，为空回退 `username`。匿名行（未登录的 SSO 登录失败）`user_id` 与 `user_name` 均 `null`，前端显示「—」。
- **表格「用户」列只渲染 `user_name`**，`user_id` 仅作为筛选值在内部流转，绝不显示 UUID（验收标准第 4 条）。
- 默认按 `ts DESC, id DESC` 倒序（`id` 兜底保证同一时间戳下的确定性分页）。分页 `pageSize` 默认 15。
- **`include=login` 保留**。它把 `login_events`（含失败尝试）并入列表并与 `audit_events` 的 `login` 行去重。仓库里目前只有测试调它，但 PRD §4.2.3 明确要求审计页能看到 `sso_login_failed`，而失败登录主要落在 `login_events`。因此**审计页默认带 `include=login`**，且合并后统一做 count / 分页 / facets。代价是两个数据源的 UNION 三处都要写对，实现时注意 `total` 不能只数一边。

#### 载荷列

`payload` 原样返回 JSON。表格里渲染为单行摘要（序列化后截断 + 省略号），点击打开弹框显示完整格式化 JSON（缩进 2 空格）。**摘要与弹框必须来自同一份响应数据**，弹框不再发请求（否则可能与列表不一致，验收标准第 6 条）。

### 5.4 CSV 导出

新增 `src/analytics/csv.ts`，四个导出全部走它。现有 `/admin/audit?format=csv` 的实现删除。

```ts
function csvCell(v: unknown): string   // 含 , " 换行 → 双引号包裹并把 " 翻倍
function toCsv(rows: unknown[][], meta: { rangeLabel: string }): string
  // → '﻿' + `统计范围：${rangeLabel}\r\n` + 表头 + 数据行
```

**UTF-8 BOM** 必须在前（Excel 打开中文不乱码，验收标准第 7 条）。所有单元格无条件走 `csvCell`，不再手写逗号替换。

| 导出 | 路由 | 权限 | 首行 | 列 |
|---|---|---|---|---|
| 模型用量 | `GET /admin/usage/export.csv?range=&tab=models` | `UsageExport` | `统计范围：近 7 天` | 模型提供商、模型名称、模型用量(tokens)、调用次数 |
| 用户用量 | `GET /admin/usage/export.csv?range=&tab=users` | `UsageExport` | `统计范围：近 7 天` | 用户名称、部门、用量、最近使用时间 |
| 审计 | `GET /admin/audit/export.csv?range=&userId=&action=&targetType=&targetId=&from=&to=` | `AuditExport` | `统计范围：近 30 天` | 时间、用户、操作（中文名）、对象类型、对象ID、载荷（JSON 字符串） |

- 模型用量导出的行是**合并后**的 `(provider, model)`（D11），与表格同一份查询代码路径，不允许两边各写一套 SQL。
- 审计导出按**当前筛选条件**导出全量（不受分页限制），同样带 `include=login`。
- 文件名 `{范围key}-{模型用量|用户用量|审计记录}.csv`（用 key 如 `7d`，避免 URL 编码问题；界面展示才用中文 label）。
- 时间格式：用户用量的「最近使用时间」`MM/DD HH:mm`；审计的「时间」`YYYY/MM/DD HH:mm:ss`。
- 载荷列是 JSON 字符串，走标准 CSV 转义。

**导出行数的回传**：服务端在响应头 `X-Export-Count` 里给出导出行数，前端据此 toast「已导出 N 条…」。`web/src/api/client.ts:113` 的 `getRaw()` 目前返回 `res.text()` 并丢弃所有头，需要扩展为 `{ text, headers }`（或加一个 `getRawWithHeaders`）。顺带记录：`getRaw` 是唯一绕过 `call()` 的 401 刷新重试的动词，扩展时确认导出在 token 过期时的行为（要么一并走刷新，要么明确接受重新登录）。

### 5.5 操作码与对象类型映射表

新增 `enterprise_server/src/shared/auditActionMeta.ts`，**服务端与 web 各一份镜像**（§4 的镜像约定），web 侧加奇偶校验测试。

```ts
// enterprise_server/src/shared/auditActionMeta.ts
export const AuditTone = { Auth:'auth', Success:'success', Failure:'failure',
                          Change:'change', Danger:'danger', Normal:'normal' } as const;
export type AuditTone = (typeof AuditTone)[keyof typeof AuditTone];

export const AUDIT_ACTION_META: Record<AuditAction, { zh: string; en: string; tone: AuditTone }>;
export function auditActionMeta(action: string): { zh: string; en: string; tone: AuditTone };
// 未登记 → { zh: action, en: action, tone: Normal }（回退原始英文码，不留空白）
```

**必须覆盖 `src/shared/enterpriseServerConstants.ts:22` 里全部 71 个 `AuditAction`。** PRD §4.2.3 给了 13 个，其中与现有常量对得上的 7 个作为风格样例：

| 码 | 中文 | 色调 |
|---|---|---|
| `login` | 登录 | auth |
| `sso_login_failed` | SSO 登录失败 | failure |
| `model_config_updated` | 模型配置更新 | change |
| `user_disabled` | 停用用户 | danger |
| `api_key_revoked` | 吊销 API 密钥 | danger |
| `mcp_created` | 创建 MCP 服务 | normal |
| `enterprise_models_sync` | 企业模型同步 | success |

> 注意 PRD 的这 7 个里有几个**在现有常量中不存在**（`sso_login_failed` / `model_config_updated` / `user_disabled` / `api_key_revoked` / `mcp_created`），现有的是 `user_disable` / `mcp_connector_create` / `login_failed` 这类命名。**以 `AuditAction` 常量的实际码为准**，PRD 的中文名可以沿用，实现者负责对齐命名。

其余 64 个按同样风格补齐。色调归类原则（PRD §4.2.3）：认证类→`auth`，成功类→`success`，失败类→`failure`，配置变更类→`change`，吊销/停用/删除类→`danger`，其余常规操作→`normal`。

`Record<AuditAction, …>` 的类型标注使遗漏在编译期暴露——这是刻意的，不要改成 `Partial<Record<…>>`。

#### 对象类型（同样需要中文标签）

`target_type` 的取值来自各业务模块写审计时传的字符串，代码里实际出现 **21 种**：

```
agent_references  agent  archive  connector_category  connector  dept
enterprise_models_sync  html_share  kit_category  kit  model  org
provider_key  release  role  route  skill_category  skill  sso_connection
submission  user
```

外加两处不在上面清单里的：`login_events` 合成的 `'login'`（`src/routes/admin/audit.ts:51`），以及 `POST /audit` 允许**任意登录用户自报**的任意字符串（`src/routes/audit.ts:9-33`）。

因此：

```ts
export const AUDIT_TARGET_TYPE_META: Record<KnownTargetType, { zh: string; en: string }>;
export function auditTargetTypeMeta(t: string | null): { value: string; zh: string; en: string } | null;
// 未知值 → { value: t, zh: t, en: t }（回退原始值，不留空白、不崩）
```

`KnownTargetType` 是上列 22 个值的联合类型 + `string` 之外的显式枚举。**这里不能用 `Record<AuditAction, …>` 那种穷尽标注**——客户端可自报任意值，穷尽性无法在编译期保证。正确做法是：显式枚举已知值 + 一个查不到就回退的访问函数；web 侧镜像同样处理。

`null`（无对象）不进入映射，由前端渲染「—」。

### 5.6 Proxy 记账与流式 usage 解析

#### 问题

`src/proxy/upstream.ts:20-22` 对 `stream: true` 的请求无条件返回 `usage: null`；`providerProxy.ts:150` 的 `if (upstream.usage)` 使记账整块被跳过——`token_usage` 不写行，`provider_call` 审计事件也不写。企业流量走 OpenClaw gateway，默认流式，所以这不是边缘情况（§1.1 甲）。

#### 修复 A：流式 usage 提取（D9）

1. **请求侧**：`stream: true` 时在 body 里加 `stream_options: { include_usage: true }`。OpenAI 兼容端点据此在最后一个 SSE chunk 里附带 `usage`。
2. **响应侧**：不能为了读 usage 把整个流缓冲下来——`providerProxy.ts:186` 以下的逻辑依赖 `upstream.stream` 逐块转发给客户端。改用 **`res.body.pipeThrough(new TransformStream(...))`**：
   - 透传逻辑原样 `enqueue(chunk)`，客户端收到的字节流**完全不变**（SSE 分帧不受影响）。
   - 旁路维护一个行缓冲，按 `\n\n`（SSE 事件边界）切分，对每个 `data:` 行尝试 `JSON.parse`，命中 `usage` 字段就记下 `prompt_tokens` / `completion_tokens`，**解析到即停止扫描**（通常在流末尾）。
3. **能力降级**：不是所有兼容端点都接受 `stream_options`。若上游因此返回 4xx，则**去掉该字段重试一次**，并把该 `provider_key_id` 记为一个「不支持 stream_usage」的provider（落 `provider_keys` 的一个布尔列，或进程内 `Set` + 持久化，二选一由实现者定，但必须**跨重启不反复试错**）。这是必要的，否则每笔流式请求都要多付一次 4xx 往返。
4. 流未结束就断开（客户端取消）时，若已解析到 usage 照样记账；没有则记 `usage_missing = true`。

#### 修复 B：无条件记账（D5）

去掉 `if (upstream.usage)` 条件：

```ts
const usageMissing = usage === null;
const tokenIn  = usage?.tokenIn  ?? 0;
const tokenOut = usage?.tokenOut ?? 0;

await tokenUsage.write({ ..., tokenIn, tokenOut, resultCode: upstream.status, usageMissing });
// 配额告警检查与 provider_call 审计事件同样无条件执行
```

配额告警检查保持无条件执行（reservation 已在更早的事务完成），但 `usage` 缺失时本次调用不计入 `usageInWindow` 的 total，告警可能略偏迟——既有语义，不额外处理。

`provider_call` 的 payload 在缺失时带 `"usage_missing": true`。

#### 修复 C：让缺口可见（D10）

`token_usage` 加一列 `usage_missing BOOLEAN NOT NULL DEFAULT false`。所有用量接口在响应里返回区间内的缺口计数：

```jsonc
{ "unaccounted_calls": 37 }   // 用量 models 接口：区间总量；users 接口：总量；users/:id：该成员
```

前端在页面顶部渲染一条**中性提示条**（不是错误色）：「本周期内 N 次调用未能取得 token 统计，实际用量可能偏低」。点击展开说明这是哪些 provider 不支持流式 usage 统计。

**这是 D9 的兜底**：流式 usage 解析若在某环境失效，页面会自己说，而不是安静地少算。

### 5.7 数据库迁移

新增 `src/db/migrations/052_analytics_usage_audit.sql`，对 pglite 重放幂等：

```sql
-- 1. 流式 usage 缺失标记（§5.6）
ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS usage_missing BOOLEAN NOT NULL DEFAULT false;

-- 2. 按 ts 过滤的索引（现有索引都在 quota_window_date 上，本页按 ts 切窗口）
CREATE INDEX IF NOT EXISTS token_usage_org_ts ON token_usage(org_id, ts);

-- 3. 审计列表的组合筛选索引
CREATE INDEX IF NOT EXISTS audit_events_org_ts_action ON audit_events(org_id, ts DESC, action);
```

**已知的既有问题，本次不修但需知晓**：`token_usage.model_id REFERENCES model_catalog(id)` 没有 `ON DELETE`，而 `modelCatalog.remove()`（`src/models/modelCatalog.ts:185`）是硬 `DELETE`。因此**有流量的模型今天就删不掉**，会撞外键。D11 让左表变成 `token_usage` ∪ `model_catalog` 后，这个限制不影响用量历史展示（历史本来就查得到），但删除动作本身仍会失败。若管理员在试用中撞到，属于既有缺陷，另开单处理，不在本设计范围。

---

## 6. 前端设计

### 6.1 路由与导航

- 路由路径不变：`/monitoring/usage`、`/monitoring/audit`。
- 侧边栏分组 `monitor` 的标题 key `nav.groups.monitor` 文案改为 **运行分析 / Analytics**；组内两项的可见性改为按权限点判断（§7.4）。
- `UsagePage.tsx`、`AuditPage.tsx` 整体重写；`QuotaBar.tsx` 失去唯一调用方，随本次一并删除（先确认无其他引用）。

### 6.2 用量页

```
页头：运行分析 › 用量          右上：[时间范围 ▾] [⬇ 导出用量]
（若 unaccounted_calls > 0）提示条：本周期内 N 次调用未能取得 token 统计 ▾
Tab：模型用量 | 用户用量
─────────────────────────────────────────────
Tab 工具栏（仅"用户用量"显示）：[🔍 搜索成员] [用量排序 ▾]
表格
分页
```

- 时间范围下拉在页面右上、导出按钮左侧（PRD §4.1.1）。
- 切换范围：两个 Tab 的列表、抽屉、导出内容**全部联动刷新**；抽屉打开时**自动关闭**（PRD §4.1.1）。
- **模型用量 Tab**：四列（模型提供商 / 模型名称 / 模型用量(tokens) / 调用次数），按用量降序。列表下方显示「共 N 个模型 · 统计范围：{范围}」。服务端分页（默认 50）。
- **用户用量 Tab**：五列（成员 / 部门 / 用量 / 最近使用时间 / 操作）。成员列 = 圆形头像（姓氏首字，取角色色板颜色）+ 姓名，姓名为空回退 `username`。搜索忽略大小写，搜索时重置到第 1 页。每页 8 条，底部居中「当前页 / 总页数」，边界时上一页/下一页禁用。
- 零用量成员的「最近使用时间」显示「—」。

#### 明细抽屉

宽度 860px（`max-width: calc(100vw - 60px)`），右侧滑出，带遮罩。关闭：右上 ✕ / 点遮罩 / ESC。

- 头部：头像 + 姓名（标题）；副标题 `{范围}用量与每日趋势 · {部门}`，部门为空时省略分隔符。
- 内容一：**按天用量柱状图**。手写 SVG。柱数 = 区间天数（§5.1）。虚线网格线与 y 轴刻度；x 轴标签 `MM/DD`，天数 > 10 时每 5 天一个标签，否则每天一个；**值为 0 的天不画柱体**（但保留位置）；图下提示「统计范围：{范围}」。
- 内容二：**按模型用量条形图**。横向，按用量降序。每行：模型名称 / 比例条 / `数值 · 占比 %`。合并规则同 D11。
- **空态**：成员区间内零用量时，两个图表区各显示一句空态文案（如「该周期内没有用量记录」），不画空坐标系。
- 抽屉内**不出现**任何配额、额度、使用率字样。
- 成员若 `unaccounted_calls > 0`，抽屉里也显示同一条提示。

#### 图表实现

无图表库，手写 SVG + `ResizeObserver` 或固定 viewBox。y 轴刻度取「好看的整数」（1/2/5 × 10^n）。颜色沿用 Tailwind 主题变量（`var(--accent-primary)`）。

### 6.3 审计页

```
页头：运行分析 › 审计           右上：[⬇ 导出 CSV]
─────────────────────────────────────────────
筛选：[全部用户 ▾] [全部操作 ▾] [全部对象类型 ▾] [时间范围 ▾]（custom 时展开 [起] [止]）
表格（六列）
分页：‹  第 1 / 29 页 · 共 428 条记录  ›
```

- 六列：时间 / 用户 / 操作 / 对象类型 / 对象 ID / 载荷。
  - 时间 `YYYY/MM/DD HH:mm:ss`
  - 用户**只显示姓名**（验收标准第 4 条），匿名显示「—」
  - 操作：中文名徽标，按 §5.5 色调着色；徽标带文字，不单独依赖颜色（PRD §6 无障碍）
  - 对象类型：中文标签（来自 `target_type_zh`），无对象显示「—」
  - 对象 ID：等宽字体；无对象显示「—」
  - 载荷：等宽字体单行摘要，超长截断 + 省略号，**可点击**
- 默认按时间倒序；每页 15 条。
- 筛选器叠加生效；任一变更重置到第 1 页；空结果显示「当前筛选条件下暂无审计记录」。
- 时间范围含 `custom`，选自定义时展开两个日期输入。

#### 载荷弹框

- 触发：点击载荷列任意单元格。
- 内容：元信息区（时间、用户、操作中文名、对象类型、对象 ID）+ 明细区（完整 payload 的格式化 JSON，缩进 2 空格，等宽，可滚动）。
- **数据来自列表响应中已持有的那一行**，不再发请求（§5.3）。
- 关闭：右上 ✕ / 点遮罩 / ESC。

### 6.4 导出与反馈

- 四个导出按钮各自触发对应接口，`Blob` + `URL.createObjectURL` 下载，成功后按 `X-Export-Count` toast：
  - 用量：「已导出 N 条用量记录（{范围}）」
  - 审计：「已导出 N 条审计记录」

### 6.5 `DeptDetail` 的连带改动（必须做，否则部门页回归）

`web/src/components/DeptDetail.tsx:64-71` 现在这样拉审计：

```ts
auditApi.list({ orgId, limit: 200 }).then((events) =>
  events.filter((e) => e.target_type === 'dept' && e.target_id === detail?.id))
```

它期望裸数组 `AuditEvent[]`，并把 200 条全拉回来在前端过滤。新的响应是 `{page, pageSize, total, items, facets}`，没有 `limit`。**若不处理，部门详情页的审计 tab 会静默地最多只显示 15 条**——一个和本次改动无关的回归。

处理方式：改用服务端筛选（`targetType: 'dept'` + `targetId: detail.id`，§5.3 新增的 `targetId` 参数），从 `.items` 取数据。默认时间范围用 `7d`；若该 tab 需要看更久的历史，在筛选器上加一个小的范围选择。**范围给多大由实现者定**，但必须让用户看得见当前范围。

### 6.6 i18n

新增 `analytics.*` key **约 110 个，zh 与 en 同时提交**（D2）。中文为主语言：中文文案对齐 PRD 用语（如「用量明细」「模型用量」「用户用量」「运行分析」「统计范围」「查看明细」「暂无审计记录」「未能取得 token 统计」），英文为对照。

原型中的硬编码中文（原型是纯中文单文件）在此**不适用**——全部走 `t()`。

---

## 7. 权限

### 7.1 权限点

`src/shared/permissionPoints.ts`：

```ts
UsageView: 'usage:view', UsageExport: 'usage:export',
```

加入 `PERMISSION_POINTS`（`Object.values` 自动收录），并在 `PERMISSION_MODULES` 新增分组：

```ts
const usage = [PermissionPoint.UsageView, PermissionPoint.UsageExport];
// { key: 'usage', name: '用量查看', desc: '查看组织用量明细并导出', points: usage }
```

`BUILTIN_ROLE_POINTS`：

```ts
super_admin: PERMISSION_POINTS,                    // 自动包含
auditor: [AuditView, AuditExport, UsageView, UsageExport],
org_admin: [...orgAdmin, UsageView, UsageExport],
```

后端路由门禁（`requirePermission`）：

| 路由 | 权限点 |
|---|---|
| `GET /admin/usage/models` `…/users` `…/users/:id` | `UsageView` |
| `GET /admin/usage/export.csv` | `UsageExport` |
| `GET /admin/audit` | `AuditView` |
| `GET /admin/audit/export.csv` | `AuditExport` |

注意现有 `adminAuditRoutes.use('/admin/audit', requirePermission(PP.AuditView))` 是路径级中间件，会把 `/admin/audit/export.csv` 也拦成 `AuditView`。导出需要 `AuditExport`，得把中间件拆开（按具体路径分别 `use`）。

### 7.2 角色种子

新增迁移按 `037_grant_sso_points_to_org_admin.sql` 的写法补齐已存在的行：

```sql
UPDATE roles SET permissions = permissions || '["usage:view","usage:export"]'::jsonb
WHERE name IN ('super_admin','auditor','org_admin')
  AND NOT (permissions @> '["usage:view"]'::jsonb);
```

**注意**：`029_seed_roles_v2.sql` 的种子数据里没有新点。已部署的实例靠上面的 UPDATE；全新实例跑 029 时同样没有这些点，也靠这条 UPDATE 兜住。两条路径都要覆盖，加测试断言三种角色都有这两个点。

### 7.3 前端门禁：用现成的 `usePermissions()`，不动 JWT

**不用**往 JWT 里加 `perms` claim。`web/src/auth/usePermissions.ts` 已经存在且正是干这个的：它基于 `useMe()`（session 缓存，不重复请求）读 `/me` 返回的 `permissions`，暴露 `hasPermission(point)`，`KitManagePage` 已在用。加 JWT claim 会造出第二套权限真相来源、让 token 变大、且在刷新前是陈旧的。

做法：

1. `/monitoring/usage` 与 `/monitoring/audit` 的 `AuthGuard` 改为按权限点判断（`UsageView` / `AuditView`）。
2. `Sidebar` 对应两项的 `requires` 同样改为权限点。
3. `/me` 已经返回 `permissions`（`src/routes/me.ts:64`），**无需改动**。
4. `hasCapability`（角色名）保留给其余既有入口。

**已知的加载态问题**：`useMe()` 是异步的，`AuthGuard` 在它 resolve 之前会拿到空 `permissions`，若直接判会先闪一下「无权限」再跳走。处理方式由实现者选（`useMe` 已有 loading 态，可先渲染 spinner；或 `AuthGuard` 在 loading 时不重定向）。

**顺带记录（不在本次范围）**：`KitManagePage.tsx:32-36` 把 `PermissionPoint.KitView` 这种**权限点**传给了判**角色名**的 `hasCapability`，因此那五个 `canXxx` 对除 `super_admin` 外的所有人恒为 `false`。这是既有 bug，本次不动，另开单。

---

## 8. 测试

**后端**（`tests/analytics/`，跑在根 `npm test`）

- `range` 解析：五种用量范围 + 审计 `custom` 的 `[from, to)` 边界；跨月、跨年；`orgs.timezone` 为非法值时**退回 UTC 而非 500**。
- `GET /admin/usage/models`：
  - **合并**：同名模型（内置 id + 自定义 key 的 UUID）只出现一行且用量相加（反目标第 3 条）。
  - **历史保留**：从 `model_catalog` 删除后，仅存在于 `token_usage` 的模型仍在结果里。
  - 0 用量模型仍出现（FULL JOIN 的 `c` 侧）。
  - `call_count` 含 429 / 502 / 流式行。
- `GET /admin/usage/users`：零用量成员出现；禁用成员出现；`q` 忽略大小写；`sort=asc/desc`；**分页边界在零用量成员之间稳定**（同样的请求两次拿到同一批 id）。
- `GET /admin/usage/users/:id`：`daily` 数组长度 = 区间天数且含 0 值天；`pct` 计算；总 tokens 为 0 时 `pct` 全 0；`unaccounted_calls` 正确。
- 审计接口：筛选器（含 `targetId`）叠加；分页；`facets` 只含区间内出现过的值；`user_name` 回退；匿名行；`include=login` **合并后**的 `total` / 分页 / facets 都正确（不只数 `audit_events` 一边）。
- CSV：四个导出都带 `﻿`；含逗号 / 双引号 / 换行的字段不串列；首行是 `统计范围：…`；导出行数 = 当前筛选下的全量（不受分页限制）；`X-Export-Count` 与实际行数一致。
- 权限：无 `usage:view` 调 `/admin/usage/*` 得 403；只有 `UsageView` 无 `UsageExport` 时导出得 403；有 `AuditView` 无 `AuditExport` 时审计导出得 403。
- `AUDIT_ACTION_META` 覆盖全部 71 个 `AuditAction`（用 `Object.values(AuditAction)` 断言 key 集合相等）；`auditTargetTypeMeta` 对未知值回退不抛。
- 迁移 052 幂等：连跑两次结果一致；`roles` 表三种角色都拿到新点。
- **流式 usage（核心）**：
  - 上游 SSE 流里含 `usage` chunk 时，`token_usage` 写入**真实 token 数**且 `usage_missing = false`。
  - 上游流里没有 `usage` 时，仍写入一行（tokens 为 0、`usage_missing = true`）、`provider_call` 审计事件仍写入。
  - `stream_options` 导致上游 4xx 时，去掉该字段重试成功，且该 provider 第二次不再带该字段（降级只发生一次）。
  - **透传不变**：加了 TransformStream 后，客户端 `res.body` 收到的字节与上游原始字节逐字节一致（SSE 分帧不被破坏）。

**前端**（`web/tests/**/*.test.tsx`）

> **根 `npm test` 不跑这些。** 根 `vitest.config.ts` 的 `include` 只有 `tests/**/*.test.ts` 且是 node 环境；web 侧有自己的 vitest 配置。测试放在 `web/tests/` 下由 web 项目自己的 runner 执行。
>
> **本次要把 web 测试接进 CI**（已确认）。做法：在根 CI 工作流里补一个独立步骤跑 `web` 项目的测试（`npm --prefix web test`，或等价的 workdir 指定），**不要**把 `web/tests` 塞进根 `vitest.config.ts`——那是 jsdom + React Testing Library 的环境，与后端测试的 node 环境不同，混在一起会让两边都要开互斥的 setup 配置。接进去时确认跑的是 `web/tests/**/*.test.tsx` 而非空转。

- 时间范围切换后两个 Tab 的 `queryKey` 都变化、抽屉自动关闭。
- `unaccounted_calls > 0` 时提示条出现，为 0 时不出现。
- 用户用量搜索 / 排序 / 分页组合使用，边界按钮 `disabled`。
- 零用量成员行显示「—」而非崩溃。
- 审计页筛选 + 时间范围叠加后重置到第 1 页。
- 载荷弹框 JSON 与列表行数据一致（断言用的是同一响应对象，未二次请求）。
- 导出成功按 `X-Export-Count` 触发 toast。
- **奇偶校验测试**：`web/src/shared/auditActionMeta.ts` 与 `enterprise_server/src/shared/auditActionMeta.ts` 的 key 集合与文案一致（§4 的镜像约定要求）。
- `DeptDetail` 的审计 tab 用服务端 `targetType` + `targetId` 筛选，能正确渲染（回归防护）。

**不要引入的行为**：不在本次做部门数据隔离、不做用量页的自定义起止日期、不做组织时区设置项——都写在非目标里。

---

## 9. 留给实现者的判断

以下是可以在不回头问人的前提下自行决定的：

- SQL 里 JOIN / FULL JOIN 的具体写法与别名。
- 71 个操作码中未被 PRD 点名的那些中文名与色调归类（按 §5.5 的原则推）。
- `AUDIT_TARGET_TYPE_META` 里 22 个已知值的具体中文措辞。
- 手写 SVG 图表的坐标轴刻度算法与具体配色。
- `analytics.*` i18n key 的具体命名（建议 `analytics.usage.tabModels` 这种层级）。
- 「不支持 stream_usage 的 provider」记在 `provider_keys` 新列还是进程内缓存（但必须跨重启不反复试错）。
- `DeptDetail` 审计 tab 的默认时间范围（§6.5）。
- 是否把前端权限门禁迁到其他页面（§7.3 只要求迁这两个）。

以下是**明确不可自作主张**的，若发现与本文冲突请先回来确认：

- D4 的 `orgs.timezone` 切分（不要改成 per-user 或管理员本地时区）。
- D6 的「显示全部成员、含禁用成员」（不要加 status 过滤）。
- D11 的「按 provider+model 合并 + 保留已删除模型历史」（不要退回按 catalog id 分行）。
- D9/D10：流式 usage 解析失败时**必须**退回可见的缺口提示，不允许静默少算。
- §5.5 的映射表必须全覆盖（不要为了少写几个而改成部分覆盖）。
- 反目标第 1 条：页面与导出必须走同一套 `resolveRange` 与同一份查询代码，不允许前端另算窗口、两端各写一套 SQL。