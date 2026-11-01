# MCP 共享密钥（组织统一）认证方式 —— Enterprise ↔ 桌面端 完整实现设计

日期：2026-10-28
状态：**已实现**（2026-10-28，分支 `feat/mcp-shared-key-gateway`；计划见
`docs/superpowers/plans/2026-10-28-mcp-shared-key-auth.md`）

实现与本文档的差异（两处，均为计划评审时已裁定，见计划的 Ruling）：

- `buildOrgCredentialHeaders` 取 `(authMode, authConfig)` 两个参数，而不是只取配置：
  认证方式无法从解密后的配置里推出来（一条退役的 `client-creds` 记录上也可能有
  `apiKey`），由调用方传入才不会被猜错。
- 本地记录多出第四个字段 `gatewayTokenExpiresAt`（比计划 §6.3 的三字段多一个）：
  15 天刷新规则需要剩余寿命，而为了拿 `exp` 去解一个未验签的 JWT，比直接存下
  token 端点已经返回的 `expiresAt` 更糟。
前序设计：
- `docs/superpowers/specs/2026-09-26-mcp-connector-management-design.md`（连接器子系统与六种鉴权方式的数据模型）
- `docs/superpowers/specs/2026-09-27-mcp-connector-desktop-consumption-design.md`（§2 消费矩阵、§6 MCP 网关 —— 本设计是它的 M2 落地）
- `docs/superpowers/specs/2026-10-26-connector-auth-governance-design.md`（D4 把组织凭据模式改为"诚实的预留"；本设计兑现 D4）

---

## 1. 意图

"组织买一份、全员共用同一个凭据"这个场景真实存在：一个企业买了纷享销客（或任何按席位计费的 MCP 服务）的一份授权，用**一个组织统一的 API Key** 让全公司的人都能用这个 MCP。

这类凭据的性质与成员自己的凭据根本不同：

| | 成员凭据（`user-key` / `user-oauth`） | 组织统一密钥（`shared-key`） |
|---|---|---|
| 归属 | 员工个人 | 组织 |
| 数量 | 每人一份 | 全组织一份 |
| 泄露后果 | 一个人的账号 | 全组织的额度 / 一次泄露即全员失效 |
| 轮换 | 员工自己重授权 | 管理员改一行，全员立即生效 |

因此实现的核心不是"多一种填 key 的方式"，而是**在不破坏这条安全边界的前提下把凭据用起来**：组织密钥必须留在企业服务端，由服务端在出站时注入；员工机器上不出现这个密钥。

## 2. 现状盘点（已核对源码）

| 位置 | 现状 | 缺口 |
|---|---|---|
| 数据模型 | `mcp_connectors.auth_mode` 六值含 `shared-key`；`auth_config.apiKey` 加密存为 `__enc__apiKey`（`vault/connectorSecret.ts`） | 无缺口 |
| 企业端表单 | `ConnectorAuthFields.tsx` 的 `shared-key` 分支显示"预留"提示 + 一个 API Key 输入框 | 提示是假的；表单没有"这个 key 会被怎么用"的说明 |
| 企业端探测 | `routes/mcpConnectors.ts` 的 `/test` 用 `Authorization: Bearer <apiKey>` 真实握手，工具清单自动发现 | 无缺口（`serverCanDiscoverTools('shared-key') === true`） |
| 公共视图 | `mapPublicConnector` 只发非机密字段，`shared-key` 不发任何 `authConfig` | 无缺口（本来就不该发密钥） |
| 桌面端安装 | `enterpriseAuthMode.ts`：`shared-key` → `McpAuthMethod.None`；`isOrgManagedAuthMode` 把卡片安装入口禁用，徽标"组织统一授权 · 暂未开放" | **这是主要缺口** |
| 桌面端运行时 | `openclawConfigSync` → `buildOpenClawMcpServers` 写 `mcp.servers.<key>.{url,headers}`；URL 与 header 全部来自本地记录 | 网关模式下需要一个"改写目标"的环节 |
| 桌面端探测 | `mcpToolCatalog.listServerTools` 按本地记录的 `url` + `headers` 直连目标 | 网关模式下会直连上游（必然 401），状态点失真 |

已有的正确部分（不改）：密钥加密存储与"空值=保留旧值"的写入语义、公共视图永不下发密钥、按部门/成员的可见性过滤（`scopeMatches` + 子树展开）、连接器的草稿/版本/逐工具开关。

## 3. 目标 / 非目标 / 反目标

**目标**

1. 管理员在企业端配置一个组织统一密钥，发布连接器后，**组织内的员工能在自己的桌面上直接使用这个 MCP**，不需要任何额外操作。
2. 组织密钥**永不**出现在员工机器上（磁盘、内存、OpenClaw 配置、日志都不出现）。
3. 成员能不能用、用哪些工具，由企业端决定并在**服务端强制**执行，不依赖客户端自觉。
4. 密钥轮换是管理员改一个字段，全员下一次调用即生效，不需要重装、不需要通知。
5. 端到端可观测：谁在什么时候通过组织密钥调了哪个工具，企业端查得到。

**非目标**

- `client-creds`（组织 OAuth 客户端）：D7 已退役，本轮不动。
- `sso`：D7 已并入 `user-oauth`，本轮不动。
- SSE（旧版 MCP 传输）在共享密钥下的支持：见 D5，本轮明确不做。
- 每席位密钥 / 密钥分发协议 / 密钥使用配额限流。
- 把组织密钥以任何形式（含加密）下发到桌面。
- 改变另外五种鉴权方式的既有行为。

**反目标（做成什么样算失败）**

- 员工电脑的 `openclaw.json` / SQLite / 日志里能搜到组织密钥。
- 员工绕过桌面端直接用 curl 调企业端，就能调用组织策略禁用的工具。
- 密钥轮换后必须让每个员工手动重装或重新登录。
- 某个成员离职后，其桌面上的凭据（GSJ）仍能**长期**继续通过网关调用组织付费的连接器（D18 的 30 秒缓存窗口除外）。
- 一台机器换人用（A 登出、B 登录）之后，B 还能靠 A 留下的 GSJ 用上 A 的组织权限（D19）。

## 4. 架构

```
┌─ 员工桌面 ────────────────────────────────────────────────┐
│  OpenClaw 网关 (node)                                      │
│    mcp.servers.<key> = {                                    │
│      url: "<企业端>/mcp/gateway/<serverKey>",              │
│      headers: { authorization: "McpGateway <GSJ>" },       │
│      transport: "streamable-http", toolFilter, timeout     │
│    }                                                        │
│         │  POST / GET(SSE) / DELETE   JSON-RPC            │
└─────────┼──────────────────────────────────────────────────┘
          ▼
┌─ 企业服务端 ──────────────────────────────────────────────┐
│  /mcp/gateway/:serverKey                                  │
│    1. 验 GSJ：签名 / purpose / serverKey / 未过期           │
│    2. 成员仍有效？                                          │
│    3. 按 (orgId, serverKey) 取连接器（跨组织 = 404）        │
│    4. enabled？scope 命中？（部门子树 + 成员例外）           │
│    5. tools/call 的工具名在组织的工具策略里？（空清单=全拒）  │
│    6. 解密组织密钥 → 注入上游请求头                         │
│    7. 中继：状态码 / content-type / mcp-session-id / 流     │
└─────────┼──────────────────────────────────────────────────┘
          ▼
┌─ 上游 MCP 服务 ──────────────────────────────────────────┐
│  （组织统一密钥真正生效的地方）                              │
└───────────────────────────────────────────────────────────┘
```

这里有三种凭据，各司其职，**不能互相顶替**：

| 凭据 | 谁持有 | 承担什么 | 到期/吊销 |
|---|---|---|---|
| 成员的企业 JWT | 桌面（会话存储） | **身份**：你是谁、哪个部门、账号还有效吗 | 1 小时，桌面自动续期 |
| 网关服务令牌 GSJ | 桌面（本地 MCP 记录 + OpenClaw 配置） | **准入**：允许用组织密钥去调用**这一个**连接器 | 90 天，桌面自动换发 |
| 组织密钥 | **只在企业端** | **授权**：这个组织买了这个服务 | 管理员手动改，服务端即时生效 |

三者合成一个出站请求：GSJ 证明"你被允许用这个连接器"，成员状态证明"你还在职"，组织密钥让上游认账。

## 5. 决策

**D1 — 组织密钥不下发桌面。桌面连网关，网关在出站时注入密钥。**

备选方案是"桌面登录企业端换取组织密钥，然后直连上游"。否决理由不是保守，而是三条具体的：

1. **泄露面**：组织密钥落进每台员工电脑的 `openclaw.json` 与 SQLite，等于把一份全组织额度的凭据复制成 N 份；离职员工带走 laptop 就带走一份活的组织凭据，而员工离职后其成员身份会被服务端立刻吊销 —— 密钥不会。
2. **轮换**：密钥在 N 台机器上，改一次要重新分发 N 次，且旧密钥在被替换前一直有效。放在服务端，改一行，下一次调用即生效。
3. **可观测性**：密钥在服务端，服务端才知道"是谁在用这把密钥"。密钥在桌面，服务端只知道"有人用了我们的上游"，无法回答"部门经理上周三下午用组织密钥导出了什么"。

这条与 2026-09-27 设计的 §2 消费矩阵、§6 网关一致，本设计是它的落地。

**D2 — 桌面不直连上游。**

共享密钥连接器的**本地记录**里，`url` 仍然是上游地址（保持现有语义，便于显示与排查），但真正拨号的地方必须改写成网关地址。改写发生在**唯一的一处**（D12），配置同步与详情页探测都走它。

**D3 — 桌面侧的网关凭据是一枚"网关服务令牌"（GSJ），不是成员的企业 JWT。**

先说为什么**不能**直接用企业 JWT —— 这不是偏好问题，是一条已核实的硬约束：

> 企业 JWT 每 4 分钟续一次（`ENTERPRISE_JWT_REFRESH_INTERVAL_MS = 4 * 60 * 1000`，`main.ts:12455`），续期后触发 `syncOpenClawConfig({ reason: 'enterprise-jwt-refresh' })`（`main.ts:3120`）→ 配置里的 JWT 变了 → **`openclaw.json` 的 `mcp` 段变了** → `openclawConfigSync` 判定 `changedTopLevelKeys.includes('mcp')` → `restartImpact: OpenClawConfigImpact.Restart`（`openclawConfigSync.ts:2647`）→ `needsHardRestart` → **OpenClaw 网关硬重启**。
>
> 也就是说，把会轮换的凭据写进 `mcp.servers.*.headers`，等于让**每个企业用户的网关每 4 分钟重启一次**。而且企业 JWT 只有 1 小时有效期，写死在配置里的那份必然过期。
>
> 对照组：今天企业 JWT 就**明文**写在 `openclaw.json` 的 `models.providers["mixcwork-server"].apiKey` 里（`openclawConfigSync.ts:1574` → `buildProviderSelection` 的 `apiKey` 是字面量），它同样 4 分钟一变 —— 但 `models` 段变化**不**触发重启判定（重启条件只有 `changedTopLevelKeys.includes('mcp')` 与 `modelCompatRestartRequired`），所以现状是"配置变了 → `config.set` 热应用 → 不重启"。差别只在 `mcp` 段：它一变就重启。

结论：**写进 OpenClaw 配置的凭据必须稳定**。所以引入 GSJ：

| 属性 | 值 |
|---|---|
| 形态 | 一枚 JWT：`{ sub(成员id), orgId, serverKey, purpose: 'mcp_gateway', exp }` |
| 签名 | HS256，**独立于企业 JWT 的密钥**（见下方"两族令牌绝不互认"） |
| 有效期 | 90 天（`exp`） |
| 换发 | 桌面在剩余有效期 < 15 天时主动换发；换发会让 `mcp` 段变一次 → 一次硬重启（约每 75 天一次，可接受） |
| 换发端点 | `POST /mcp/gateway/:serverKey/token` —— 用成员的企业 JWT 认证 + 连接器可见 + `shared-key` 模式 → 返回 GSJ |
| 桌面存储 | 本地 MCP 记录 `config_json.gatewayToken`（与 `user-key` 的 API Key 同一类本地凭据） |
| 写入 OpenClaw 配置 | `mcp.servers.<key>.headers.authorization = "McpGateway <GSJ>"` |

**两族令牌绝不互认**（防止权限混淆）：

- 企业 JWT 用 `JWT_SECRET` 签名，GSJ 用**派生的另一个密钥**：`sha256(JWT_SECRET + '::mcp_gateway')`。因此一枚企业 JWT 永远验不过 GSJ 的校验，反之亦然。
- 派生物里带 `purpose: 'mcp_gateway'`，校验时必须显式检查 —— 双保险。
- 网关**只接受** `Authorization: McpGateway <GSJ>`，不接受 `Bearer`。用不同的 scheme，认证分支就是显式的一行，不用去猜令牌是哪一族的。

**GSJ 的权限边界**：只能让网关"代持组织密钥去调用**这一个**连接器"。读不出组织密钥、用不到别的连接器、用不到别的组织（`orgId` 在签名里）、工具策略另算（D6）。

**吊销路径**（GSJ 是无状态的，不能单独吊销 —— 但真正需要的路径都成立）：

1. 成员被禁用/离职 → 网关**每次请求**都查成员状态（与 `requireActiveMember` 同款，30 秒 TTL 缓存）→ GSJ 立即失去作用。这是"离职员工带走 laptop"这条风险的兜底。
2. 管理员停用连接器 → 网关 404。
3. 管理员改掉组织密钥 → GSJ 依旧有效，但网关出站时用的是新密钥 —— 这正是 D14 要的"轮换即时生效、不用重装"。

**已核对 OpenClaw 侧的接线**（`../openclaw/src/agents/mcp-transport.ts:247-256`）：`transport: 'streamable-http'` 时 `requestInit.headers` 会被 SDK 用于**每一个**请求（POST / GET 流 / DELETE）；只有 `auth: 'oauth'` 才会剥掉 Authorization 头 —— 本方案不设 `auth`，头原样发出。OpenClaw 的 MCP schema 把 `headers` 的值登记进 `sensitive` 注册表（`zod-schema.ts:368`），配置被外发时脱敏。

**取舍（明写）**：GSJ 是一枚 90 天有效的长期凭据，会以明文落在桌面本地记录与 `openclaw.json` 里（与 `user-key` 的 API Key 同一暴露级别）。换来的是"配置稳定 → 网关不重启"。组织密钥本身**仍然一步都不出企业端**（目标 2 不受影响）。

**D4 — 网关是透明中继，逐请求鉴权，无会话状态。**

- 入站：`Authorization: McpGateway <GSJ>` → 验签（独立密钥）→ 必须有 `purpose === 'mcp_gateway'` → 必须未过期 → `serverKey` 必须与请求路径一致（不一致 = 404，防止"用 A 连接器的令牌访问 B"）→ 再查成员是否仍在职（与 `requireActiveMember` 同款，30 秒 TTL 缓存；被禁用/已离职的成员立刻被拒）。
- 授权：按 `(orgId, serverKey)` 取连接器；**跨组织一律 404**（不泄露"存在但无权限"）；`enabled=false` → 404；scope 不命中 → 403。
- **可见性判定只有一份实现**：市场路由 `routes/mcpMarketplace.ts` 现在把"部门子树 ∩ 成员部门"的判定内联在路由里（一次 `SELECT id, path FROM departments WHERE org_id = $1` + `descendantsOf`）。网关必须用**同一份**判定，否则"市场里看得见但网关 403"或反过来。做法：抽 `mcp/connectorVisibility.ts` 的 `connectorVisibleToCaller(row, caller)`，市场路由与网关都调它（判定步骤见 §7 的变更清单，super admin 的无条件放行别漏）；部门 path 映射按 org 缓存 30 秒（与 `scopeResolver` 的 TTL 同量级），避免网关热路径每次全表扫。
- 工具策略：`tools/call` 的 `params.name` 必须命中组织策略（`toolFilterFor(tools)`），否则 JSON-RPC 错误。
- 注入：解密 `__enc__apiKey` → 构造上游请求头（D9 的规则）。
- 中继：状态码、`content-type`、`mcp-session-id` 原样回传；响应体**以流的形式**原样回传（不缓冲），这样服务端主动推送与长连接不会被网关截断。
- **不转发桌面请求里的 `authorization` 头给上游**（那枚是 GSJ），上游永远只看到组织凭据。
- `mcp-session-id` 原样中继 → 网关无状态。成员拿到的上游 session id 不构成越权：网关对**每一个**请求都重新校验范围与工具策略，别人即使捡到这个 id 也过不了范围检查。

**D5 — 本轮只支持 Streamable HTTP（`transport: 'http'`）。SSE 明确不做。**

旧版 SSE 传输的客户端会 GET `/sse` 拿事件流、再 POST 到流里公布的**另一个**地址。要代理它，网关必须改写那个地址并维护 `sessionId → 上游消息地址` 的映射（还要把 SSE 流里的响应写回上游通道），是一套有状态的中继，复杂度和泄漏面都与"透明中继"相悖。

因此：

- 控制台**不允许**发布 `shared-key` + `sse` 的连接器。控制台已有一套机制（`ConnectorConnConfig.tsx` 的 `SSE_INCOMPATIBLE_AUTH_MODES`：选 `sse` 时把不兼容的鉴权方式重置为 `none`），把 `shared-key` 加进去即可。后端 `sseOauthCombination`（`routes/mcpConnectors.ts`）也加上 `shared-key` —— 否则这个组合"非法"却能发布，注释与行为就对不上了。
- **存量 `shared-key` + `sse` 记录**：后端拒绝发布后，管理员改一个无关字段也会撞上 400。控制台在打开这类记录时给出明确提示（"该连接器的传输方式暂不支持组织统一授权，请改为 Streamable HTTP 或更换鉴权方式"），让管理员一眼知道要改什么；网关运行时对它返回 `400 unsupported_transport`，桌面显示同样的原因。
- `none` / `user-key` 的 SSE 直连不受影响。

**D6 — 工具策略在网关侧强制执行，不能只靠桌面的 `toolFilter`。**

桌面的 `toolFilter` 是给 agent 看的（少暴露、少误用），但它是**客户端**约束：网关是一个普通的 HTTP 端点，成员完全可以用 curl 直接构造 `tools/call` 请求绕过桌面。所以组织策略的权威执行点必须在服务端。

- 桌面侧照旧写 `mcp.servers.<key>.toolFilter`（OpenClaw 侧过滤）。
- 网关侧对 `tools/call` 再查一次组织策略：不在允许集合内的工具 → JSON-RPC 错误 `-32601`（"方法未找到"是隐藏工具存在性的常规做法），消息写清"该工具已被组织策略禁用"。允许集合怎么算见下 —— **不复用 `toolFilterFor` 的返回值**。

**空工具清单必须 fail-closed（不能把"没策略"当成"全放行"）。**

`toolFilterFor(tools)`（`models/connectorView.ts:285`）在两种**成因不同**的情况下都返回 `undefined`：

| 输入 | 返回 | 真实含义 |
|---|---|---|
| `live.length === 0`（`tools` 为空，或全部 `removed`） | `undefined` | **策略还没初始化** —— 这个连接器从未探测成功过 |
| 所有 live 工具都 `enabled` | `undefined` | 不限制 —— 所有工具都开着 |

对桌面侧这两种 `undefined` 可以合并（"没有白名单就是全给"）。**对网关侧不行**：一个刚建好、还没跑过探测的 `shared-key` 连接器，`tools` 是空的 → `undefined` → 网关放行全部工具 —— 这是"策略缺失 = 全开"，恰恰是最不该发生的事。

因此网关**不能**拿 `toolFilterFor` 的返回值当放行判据，它自己按 `ToolEntry[]` 判：

| `tools` 状态 | 网关允许调用的工具 |
|---|---|
| `live.length === 0`（从未探测 / 全部移除） | **一个都不允许** → `-32601`，"该连接器的工具策略尚未初始化，请联系管理员" |
| 有手工声明的工具（无 `syncedAt`） | 声明列表里 `enabled` 的那些 |
| 全部 live 工具都启用 | 全部 live 工具 |
| 启用数 = 0 | 一个都不允许 |
| 其余 | `enabled` 的那些 |

`mcp/gatewayPolicy.ts` 按这张表实现：纯函数，直接吃 `ToolEntry[]`，**不复用 `toolFilterFor` 的返回值** —— 那两个 `undefined` 分支携带的信息已经被它吃掉了。

**D7 — 网关的错误必须能区分"谁的错"。**

桌面详情页要能告诉用户到底该做什么，所以网关的错误分类是接口的一部分：

| HTTP | body | 含义 | 桌面该说什么 |
|---|---|---|---|
| 401 | `{"error":"unauthorized"}` | GSJ 无效 / 过期 / scheme 不对 | 网关凭据失效，桌面换发一次 GSJ 后重试 |
| 401 | `{"error":"not_member","code":41602}` | 成员已被禁用 / 离职 / 记录被删 | 沿用桌面既有的成员吊销提示（`code === 41602` 触发 `membershipRevocation`） |
| 403 | `{"error":"forbidden"}` | scope 不命中 | 你所在的部门/你本人没有该连接器的权限 |
| 404 | `{"error":"not_found"}` | 连接器不存在、已停用、或属于别的组织 | 连接器不可用 |
| 400 | `{"error":"unsupported_transport"}` | 该连接器是 SSE | 该连接器的传输方式暂不支持组织统一授权 |
| 502 | `{"error":"upstream_unauthorized"}` | **上游拒绝组织密钥** | 组织密钥失效，请联系管理员 |
| 502 | `{"error":"upstream_insecure"}` | 上游不是 https（组织密钥不能走明文） | 连接器地址不安全，请联系管理员 |
| 502 | `{"error":"upstream_failed"}` | 上游其它失败（含网络错误） | 上游连接失败 |

**401 与 502 的区分是关键**：401 是"你进不来"，502 是"组织的密钥坏了"（桌面无能为力，只能提示联系管理员）。

**两个 401 必须分开。** 桌面端已经有一套现成的语义可以直接利用 —— `requireActiveMember` 对"令牌无效"返回 `{error:'unauthorized'}`，对"成员已被吊销"返回 `{error:'not_member'}`（数字版还带 `code: 41602`，见 `auth/requireActiveMember.ts:113-119`）；而桌面端 `src/main/enterpriseAccount/membershipRevocation.ts` 正是按 `code === 41602` 触发成员吊销流程的。所以网关：

- GSJ 本身的问题（签名不对 / 过期 / scheme 不对） → `{error:'unauthorized'}`，桌面**换发一次 GSJ 再重试**即可（D13）。
- 成员被吊销 → `{error:'not_member', code:41602}`，桌面据此走成员吊销流程。

换发后仍然 401（`unauthorized`）→ 说明不是 GSJ 的问题，是成员本身 → 提示联系管理员。

**但桌面端要自己接上这条线 —— 现有钩子不会自动触发。** 吊销钩子目前只挂在 `enterpriseFetchWithAuth`（`main.ts:4935-4958`，ASR / 媒体 / 分享走的那条）上。而 MCP 这条路根本不走它：GSJ 换发走 `enterpriseClient.call()`（`enterpriseClient.ts:118`，普通 `fetch`），网关中继探测走 `mcpToolCatalog.listViaHttp`（同样是普通 `fetch`），OpenClaw 自己发起的 MCP 请求更是完全在桌面进程之外。

所以桌面端要**显式**接：在网关的 401 响应体上跑 `readEnterpriseApiErrorCode(body)`，命中 41602 时调用吊销处理器。而那个处理器现在是 `main.ts:4880` 里的一个闭包（`handleEnterpriseMembershipRevocation`），MCP 模块够不着 —— 需要把它提成一个模块级入口，例如 `src/main/enterpriseAccount/membershipRevocationBridge.ts`：

```ts
/** 模块级入口：main.ts 的 enterpriseFetchWithAuth 与 MCP 网关错误路径共用。 */
export function handleEnterpriseMembershipRevocation(
  code: number,
  source: EnterpriseMembershipRevocationSource,
): boolean;
```

`main.ts` 现有那处调用改成走这个模块（行为不变），MCP 路径也调它。**只改它被谁调用，不改吊销语义。**

**D8 — 网关调用写审计。**

新增 `AuditAction.McpGatewayCall = 'mcp_gateway_call'`，记录：`orgId`、`userId`、`serverKey`、`method`、`params.name`（工具名）、结果状态、耗时。

- **只审计 `tools/call`**：`initialize` / `tools/list` / `notifications/*` 是协议噪声，每次探测都写会把审计表冲垮。
- 工具调用是组织真正关心的"谁用组织密钥做了什么"。
- 审计写入失败**不能**影响调用本身（工具已经执行完了），只记日志。

**D9 — 上游请求头的构造规则只有一处，探测与网关共用。**

现状：企业端探测写死 `Authorization: Bearer <apiKey>`。这不够 —— 真实的上游有用 `X-API-Key: <key>` 的，也有用 `Authorization: <key>`（不带 Bearer）的。

因此给 `shared-key` 增加一个可选字段 `auth_config.apiKeyHeaderName`，规则是：

| `apiKeyHeaderName` | 上游请求头 |
|---|---|
| 未设置（默认，向后兼容存量记录） | `Authorization: Bearer <apiKey>` |
| 设为 `X-API-Key` 等其它名字 | `<该名字>: <apiKey>`（原值，不加前缀） |

只有一个旋钮，覆盖两种主流形态，且**存量记录的语义不变**（探测与网关都用同一函数，所以存量记录不会出现"探测通过但网关失败"的漂移）。

**D10 — 公共视图新增两个字段，桌面据此知道"走网关"与"密钥配了没有"。**

```ts
/** 桌面端消费该连接器的方式。'gateway' = 组织凭据由企业端注入，
 *  桌面必须连网关地址，绝不能直连 url。 */
consumption?: 'direct' | 'gateway';
/** 仅 shared-key：组织是否已经保存了密钥（非机密，只是一个就绪状态）。
 *  false 时桌面直接告诉用户"组织密钥尚未配置"，而不是让人对着
 *  一个 502 猜。 */
orgCredentialReady?: boolean;
```

`consumption` 的取值：`shared-key` → `'gateway'`；其余 → `'direct'`。这是显式的契约，不靠"看到 `authMode` 是 shared-key 就自己推断"。

`orgCredentialReady` 只看 `auth_config.__enc__apiKey` 是否为字符串，**不解密**，不泄露任何机密。

> 注意：不要直接用 `hasStoredSecret(auth_config)` —— 它的判据是
> `__enc__apiKey` **或** `__enc__clientSecret` 存在。对 `shared-key` 来说，
> 客户端凭据不是它的凭据；一条只留了 `clientSecret` 的存量记录会被误报成
> "密钥已就绪"，然后在网关里 502。这里需要的是只看 `__enc__apiKey` 的判据
> （可以新写一个 `hasStoredOrgKey(authConfig)`，或在视图层直接判断）。

> `apiKeyHeaderName` 对 `shared-key` **不发布到公共视图** —— 网关在服务端
> 构造上游请求头，桌面不需要知道它。它只留在 `auth_config` 里。
> `mapPublicConnector` 现有的 `apiKeyHeaderName` 分支只对 `user-key` 生效，
> 保持原样即可。

**D11 — 桌面端的安装与本地记录。**

- **安装入口解禁**：`shared-key` 的卡片不再禁用安装，徽标从"组织统一授权 · 暂未开放"改为"组织统一授权 · 经企业网关"。`client-creds` 保持禁用（退役模式，仍显示"暂未开放"）。
- **本地记录**：新增 `consumption?: 'direct' | 'gateway'`（存在 `mcp_servers.config_json` 这个 JSON blob 里，**不需要 SQLite 迁移**）。安装时从公共视图的 `consumption` 落库。
- `authMethod` 保持 `McpAuthMethod.None`（本地没有任何凭据），`enterpriseAuthMode` 保持 `'shared-key'`。成员不需要任何授权动作 —— 这是"组织统一"的核心体验：**装了就能用**。
- **安装时后台自动换发一枚 GSJ 并落库**（D12 规则 1）。这是**后台动作，用户看不到任何授权界面**：换发用的是成员已有的登录态（企业 JWT），不弹窗、不需要用户粘贴任何东西。换发失败才算安装失败（错误按 D7 翻译成人话，例如"你的账号已被停用，请联系管理员"）。"装了就能用"指的是**没有用户可见的授权步骤**。
- 安装表单：共享密钥连接器的 URL 展示为只读并标注"经企业网关访问"，避免成员改 URL 后直连上游（直连必然 401，是安全的失败，但要给出解释）。

**D12 — 目标解析只有一个来源：配置同步与详情页探测必须命中同一个 URL。**

新增纯函数（主进程）：

```ts
export interface McpTarget {
  url: string;
  headers: Record<string, string>;
}

export function resolveMcpTarget(
  record: {
    url?: string;
    headers?: Record<string, string>;
    consumption?: 'direct' | 'gateway';
    serverKey?: string;
    gatewayToken?: string;
  },
  ctx: { enterpriseBaseUrl: string | null },
): McpTarget | null
```

行为：

- `consumption === 'gateway'`：
  - 缺 `serverKey`、缺 `enterpriseBaseUrl`、缺 `gatewayToken` → 返回 `null`（该服务器不写进 OpenClaw 配置，日志说明原因）。返回一个指向上游的 URL 才是危险的 —— 那会让桌面在没有组织授权的情况下直连上游。
  - 正常 → `{ url: `${enterpriseBaseUrl}/mcp/gateway/${encodeURIComponent(serverKey)}`, headers: { authorization: `McpGateway ${gatewayToken}` } }`。
- 其余 → `{ url: record.url ?? '', headers: record.headers ?? {} }`。

> `ctx` 里**没有** token —— 网关凭据来自本地记录（GSJ），不来自会话里的企业 JWT。

**`ctx.enterpriseBaseUrl` 的来源**：用 `getServerApiBaseUrl()`（`src/main/libs/endpoints.ts`）—— 它就是 `getEnterpriseServerUrl()` 的别名，读 `process.env.ENTERPRISE_SERVER_URL` 并去掉尾部斜杠。**不要**给 `enterpriseClient` 加新的 getter：`enterpriseClient` 里的 `baseUrl` 是模块私有变量，没有公开访问器（`src/main/auth/enterpriseClient.ts`）。

注意 `getServerApiBaseUrl()` 在环境变量未设置时**会抛异常**（打包应用里 `ENTERPRISE_SERVER_URL` 是构建期烘进去的，恒在；但非企业版客户端 / 本地开发环境里不在）。所以调用方包一层：

```ts
function enterpriseBaseUrlOrNull(): string | null {
  try {
    return getServerApiBaseUrl();
  } catch {
    return null;   // 非企业版客户端 → 网关模式无法解析 → 该服务器跳过，不回退直连上游
  }
}
```

**`resolveMcpTarget` 保持同步**：它要的 GSJ 来自本地记录（`config_json.gatewayToken`），不来自会话里的企业 JWT。需要企业 JWT 的是**换发**那一步（`ensureGatewayToken`），它是异步的 —— 调用方先 `await ensureGatewayToken(record)` 拿到/刷新令牌，再调同步的 `resolveMcpTarget`。

**取不到 GSJ 时，不能让这台服务器从 OpenClaw 配置里消失。** `mcp` 段一变就是一次硬重启（D3）。如果"换发失败 → 没有令牌 → 服务器被跳过 → 配置少了这台 → 下次同步又有了"，配置就会在**有/无之间抖动**，每 4 分钟的重启节奏会被放大成连续重启。三条规则：

1. **GSJ 在安装时就换发并落库。** 安装流程（`McpServerFormModal` → `mcpStore`）在写入本地记录**之前**先 `await ensureGatewayToken(...)`；换发失败 → **安装失败并给出原因**，不落库、不产生半成品记录。这样稳态下"本地有记录但没有 GSJ"几乎不会发生。
2. **运行期换发失败时，退回用现有的令牌。** `ensureGatewayToken` 抛错不等于令牌失效 —— 网络抖动、服务端 500 都可能是临时的。若本地已有 `gatewayToken`（哪怕快过期），继续用它并记 `console.warn`；配置不变 ⇒ 不重启。
3. **只有"本地根本没有令牌"才跳过这台服务器**，记日志说明原因，等下一次同步再试。这一步是唯一的例外，正常情况下由规则 1 保证不会触发。

> `getResolvedServers()` 本来就是 `async`（`mcpRuntime.ts:211`），由 `refreshResolvedServersCache()` await（`main.ts:2480`），所以在它里面 await 换发没有结构性问题。

调用点只有两处，必须都走它：

1. `mcpRuntime.getResolvedServers()` —— 组装 `ResolvedMcpServer` 时改写 `url` / `headers`。
2. `mcpToolCatalog.listServerTools()` → 里面的 `listViaHttp()`（详情页探测；它现在直接读 `record.url`（`:209`）与 `record.headers`（`:216`））—— 同样改写。`checkMissingCredential` 对 `authMethod: 'none'` 的网关记录本来就返回 null，不用动。

> 注意：网关记录的 `authMethod` 是 `none`，所以 `checkMissingCredential` 不会拦它（它只对 `oauth`/`bearer`/`api-key` 报"缺凭据"）。**不要**给网关记录补一个本地凭据检查 —— 网关模式的凭据是 GSJ，存在 `config_json.gatewayToken` 里，与 `authMethod` 无关。

**这两处不一致就是 2026-09-27 设计 §12 列出的头号风险**：详情页显示"已连接"而实际调不通。

**D13 — 详情页的连接状态经网关探测。**

详情页的"连接状态"是一次真实的 `initialize` + `tools/list`（由 `mcpToolCatalog.listServerTools` 发起）。共享密钥连接器上，这次探测必须走网关（带 GSJ），因此：

- 探测结果为**已连接** → 说明"GSJ 有效 + 成员仍在职 + 组织密钥有效 + 上游可达"。
- 探测返回 401 `{"error":"unauthorized"}` → GSJ 失效。桌面先用成员的企业 JWT **换发一次 GSJ** 再重试；重试成功 → 静默恢复（用户无感）；仍失败 → 显示"组织授权已失效，请联系管理员"。
- 探测返回 401 `{"error":"not_member","code":41602}` → **不是 GSJ 的问题**，是成员被吊销。换发没有意义，桌面读出 `code` 后触发成员吊销流程（D7 的接线）。
- 探测返回 502 `upstream_unauthorized` → 详情页显示"组织密钥失效"，与"未连接"区分开。
- 探测返回 403 → 显示"你没有该连接器的权限"。

详情页新增两行：**授权方式**（组织统一密钥 · 经企业网关）与**组织密钥状态**（已配置 / 未配置，来自 `orgCredentialReady`）。上游地址照旧显示。

**D14 — 密钥轮换不需要重装。**

管理员在控制台改掉 API Key → 密文被覆盖 → 网关下一次请求解密出的就是新密钥 → 全员立即生效。桌面端没有任何东西需要更新（本地记录里从来没有密钥）。这是 D1 相对"下发密钥"方案最直接的收益。

**D15 — 企业端的 node:http 适配层必须支持流式响应，否则网关的 SSE 中继会挂死。**

这一条是实现前必须先解决的**既有阻塞点**，与本特性无关但挡在路上：

`enterprise_server/src/server.ts` 自己写的 node:http 适配层把**每一个**响应体都缓冲成内存 Buffer：

```ts
const buf = Buffer.from(await honoRes.arrayBuffer());
res.end(buf);
```

唯一的流式分支被 `accept-ranges` 门控（安装包下载用）。而 MCP 的服务端→客户端消息通道是一条 **SSE 长连接**：上游会一直开着不返回。缓冲它等于永不返回 → 网关的 `GET /mcp/gateway/:serverKey` 挂死 → 桌面端连不上这个连接器。

修法：

- 把"这个响应要不要流式"抽成纯函数 `shouldStreamResponse(headers): boolean`（放进可测试的模块，例如 `src/http/responseStreaming.ts` —— 不叫 `src/server/responseStreaming.ts` 是因为 `src/server.ts` 已经存在，同名目录会让人分不清）：现有 `accept-ranges` 分支保留，**新增** `content-type: text/event-stream`。
- 其余响应维持缓冲路径不变（JSON 响应体量小，缓冲没有代价）。
- 上游若带 `content-encoding`，中继时剥掉（见 §6.4）。

**D16 — 组织密钥只发往管理员确认过的地址；成员不能提议组织凭据方式。**

网关会把组织密钥放进**出站请求头**，所以"这个连接器的 URL 指向哪里"从此是一个安全决策，而不再只是配置项。成员提交连接器是允许的（`mcpSubmissions.ts`），而提交表单里 URL 是成员填的。

风险链条：成员提议一个指向他自己服务器的 URL（`serverKey` + `url`），管理员在审批队列里看到它并批准 → 管理员填入组织密钥 → 网关把组织密钥发到了成员的服务器。

对策（三条，缺一不可）：

1. **成员不能提议组织凭据方式。** 桌面端的 `SUBMIT_AUTH_MODES` 已经只允许 `none` / `user-key` / `user-oauth`，但**服务端没有拦** —— `connectorCfgSchema` 的 `authMode` 枚举包含 `shared-key`/`client-creds`，成员直接 POST 就能提。服务端补一条校验：成员提交里出现组织凭据方式 → 400。（这条在网关落地之前是"瑕疵"，落地之后是"漏洞"。）
2. **审批界面必须把地址摆到管理员眼前。** 审批 `shared-key` 连接器时，控制台明确提示"发布后组织密钥会被发送到这个地址，请确认地址可信"，并把 URL 显示在提示语里。
3. **组织凭据方式只有管理员能创建，且密钥只能由管理员填写。** 成员提交一旦被批准，管理员仍需在抽屉里亲自填密钥 —— 这个动作本身就是"我确认这个地址可信"的一次显式表态。

**D17 — 组织密钥的"可信地址"边界还包含协议。**

明文 `http://` 的上游意味着组织密钥在网络上裸奔。控制台已有 `PLAINTEXT_RISK_MODES`（含 `shared-key`）会对明文 URL 给出警告 —— 本轮把它升级为**硬阻断**：发布 `shared-key` 连接器时 URL 必须是 `https://`（回环地址除外）。网关侧同样拒绝把组织密钥发往非 https 的上游。

**D18 — 网关服务令牌（GSJ）的签发、换发与两族密钥的隔离。**

这是 D3 的落地细则，三件事：

**（1）签发 / 换发**

```
POST /mcp/gateway/:serverKey/token
```

| 前置 | 判定 |
|---|---|
| 认证 | 成员的企业 JWT（`Authorization: Bearer <orgJWT>`，`requireAuth`） |
| 连接器存在且属于该组织 | 否则 404 |
| 连接器 `enabled` | 否则 404 |
| 连接器可见（部门子树 / 成员例外） | 否则 403 |
| 连接器 `authMode === 'shared-key'` | 否则 400（其它模式没有 GSJ 这回事） |
| 上游是 https（或回环） | 否则 400（D17） |

通过 → `{ token: "<GSJ>", expiresAt: "<ISO>" }`。

换发规则：桌面在 GSJ 剩余有效期 < 15 天时调用一次；换发得到的是**新** GSJ（旧 GSJ 仍然有效到自然过期 —— 无状态令牌无法单独吊销，所以宁可留一个短尾，也不要在换发瞬间打断正在跑的会话）。

**（2）GSJ 的校验（网关入口）**

```
Authorization: McpGateway <GSJ>
```

1. 解析 scheme：不是 `McpGateway` → 401（**不是** `Bearer`；成员的企业 JWT 打过来也 401 —— 它不是网关凭据）。
2. 用派生的网关密钥验签（`sha256(JWT_SECRET + '::mcp_gateway')`）→ 失败 401。
3. `purpose === 'mcp_gateway'` → 否则 401。
4. `exp` 未过期 → 否则 401。
5. `serverKey` 与请求路径一致 → 否则 404（防止拿 A 的令牌访问 B）。
6. 成员仍在职 → 否则 401 `{error:'not_member', code:41602}`（成员状态检查与 `requireActiveMember` 同款，见下方"成员状态检查必须复用"）。

**（3）两族密钥绝不互认**

企业 JWT 用 `JWT_SECRET`；GSJ 用 `sha256(JWT_SECRET + '::mcp_gateway')`。两把密钥不同 ⇒ 一枚企业 JWT 在 GSJ 校验处必然验签失败，反之亦然。这条是**权限混淆的防线**：如果两族共用一把密钥，一枚 GSJ 就能被当成企业 JWT 去调任意成员级 API（`verifyToken` 只读 `sub`/`orgId`/`roles`，`roles` 为空也不拦）。

因此 `auth/jwt.ts` 里新增的两族函数必须**互不调用**：

```ts
// 现有，不动
export async function signToken(c: Claims): Promise<string>          // 1h，JWT_SECRET
export async function verifyToken(token: string): Promise<Claims>     // JWT_SECRET

// 新增，GSJ 专用
export async function signGatewayToken(c: {
  orgId: string; sub: string; serverKey: string;
}): Promise<{ token: string; expiresAt: string }>                    // 90d，派生密钥
export async function verifyGatewayToken(token: string): Promise<{
  orgId: string; sub: string; serverKey: string; purpose: string;
} | null>                                                            // 派生密钥
```

`verifyGatewayToken` 返回 `null` 而不是抛异常 —— 网关把 `null` 统一映射成 401。

**（4）成员状态检查必须复用，不能重写一套**

`requireActiveMember` **不能**直接用在网关上：它校验的是 `Bearer <企业 JWT>`（`auth/requireActiveMember.ts:101-110`），而网关收的是 `McpGateway <GSJ>` —— scheme 不同、签名密钥也不同。网关能复用的是它里面的**成员状态查询**那一半：`resolveMemberStatus(userId)`（`auth/requireActiveMember.ts:54-77`）。

做法：把 `resolveMemberStatus` 与它的 30 秒 TTL 缓存抽到新模块 `auth/memberStatus.ts`：

```ts
export type MemberStatusResult =
  | { kind: 'missing' }               // 行没了 → 已离职 / 不是成员
  | { kind: 'status'; status: string } // 行在，带状态
  | { kind: 'error' };                // DB 读失败 → fail open

export async function resolveMemberStatus(userId: string): Promise<MemberStatusResult>;
export function _resetMemberStatusCacheForTest(): void;
```

`requireActiveMember.ts` 改为 import 它（`requireActiveMember` / `requireActiveMemberNumeric` 两个导出与 wire/numeric 两种 body 形状**一字不改**，只是状态查询换了住处）；网关直接 `await resolveMemberStatus(gsj.sub)`，按 `kind` 判：`missing` 或 `status !== 'active'` → 401 `not_member`；`error` → 放行。

**必须照抄的语义（不要"顺手修好"）**：DB 读失败时 `resolveMemberStatus` 返回 `{kind:'error'}` 并**放行**（fail open）。这是 `requireActiveMember.ts:67-72` 的既有设计，理由就写在注释里：一次瞬时 DB 故障不应该让桌面读成"你被吊销了"从而把无辜用户踢下线。网关继承同一语义 —— 否则一个 DB 抖动会让全员突然掉线。

代价要说清楚：被吊销的成员在**最多 30 秒**内仍能通过网关（状态有 TTL 缓存）；DB 故障期间是**无限期**放行。这与 LLM 代理是同一道门禁、同一个窗口，不是本设计新开的口子。

**D19 — 桌面本地的 GSJ 必须绑定签发它的那个成员。**

这是设计自查时发现的一个真实漏洞，不是假设：

- `mcp_servers` 是**机器级**的（`src/main/mcp/mcpStore.ts` 里没有任何 account 维度），而 GSJ 里绑的是成员（`sub`）。
- `clearLocalAuthSession()`（`main.ts:6301`）只在**成员被吊销**时调用；**手动登出**走的是 `enterpriseClient.logout()` → `sessionStorage.clear()`（`enterpriseClient.ts:680-682`），根本不碰 MCP 记录。

于是：一台机器上 A 登出、B 登录之后，OpenClaw 配置里仍然是 `authorization: McpGateway <A 的 GSJ>` → 网关按 A 的 `sub` 鉴权 → **B 用上了 A 的组织权限**，审计也记在 A 头上。这正是 D18 花力气防的权限混淆，从另一扇门进来。

修法不靠"在登出处加一句清理"（登出路径今天就有两条，将来还会有第三条；漏一条就是漏洞），而是**让判据成为数据本身的属性**：

```ts
gatewayToken?: string;
/** 这枚 GSJ 是为哪个成员签发的（= 企业会话的 `userId`）。 */
gatewayTokenOwner?: string;
```

`ensureGatewayToken(record)` 的可用判据变成三条同时成立：

```
record.gatewayToken
&& record.gatewayTokenOwner === sessionStorage.load()?.userId
&& 剩余有效期 >= 15 天
```

任一不成立 → **先清掉**本地这两个字段，再换发。没登录（`sessionStorage.load()` 为 `null`）→ 视为无令牌 → `resolveMcpTarget` 返回 `null`（D12 规则 3）→ 该服务器不进配置。

登出处**仍然**顺手清一遍（`clearLocalAuthSession` 里对 `consumption === 'gateway'` 的记录清掉这两个字段），但这只是"带走一份不该留在磁盘上的东西"，正确性由 owner 比较保证。

副作用要说清楚：换人之后第一次配置同步会改变 `mcp` 段 → 一次硬重启（这是 D3 的规则，也正是我们要的）。

**D20 — 中继实现的三条硬细节（不写清，构建者一定踩）。**

**（1）JSON-RPC 批量请求。** MCP Streamable HTTP 允许把多个 JSON-RPC 消息打包成一个数组。网关解析请求体时必须处理 `Array.isArray`：逐个检查每个 `tools/call` 元素的 `params.name`；**任何一个**越过工具策略 → **整批**返回 `-32601`（不能只拦那一个：只拦一部分会让上游收到半批，客户端的响应就对不上了）。

**（2）审计写在"上游响应头到达时"，不是"响应体读完时"。** 想记 JSON-RPC 的 `result.isError` 就得读完响应体，而读完就违背了 D15 的"不缓冲"。所以审计记的是 `method` + `params.name` + **HTTP 状态码** + 耗时，**不记** `result.isError`。HTTP 状态码已经足够区分"网关拒了"（401/403/404/400）与"上游接了"（200/5xx）。审计写失败只记日志（D8）。

**（3）`GET` 的 SSE 流只在建连时鉴权一次。** 建连后成员被吊销，这条流不会主动断 —— 明确接受，因为：流里只有服务端→客户端的消息（通知、以及**已经通过鉴权**的那次请求的响应），所有 `tools/call` 都是独立的 POST、逐请求重新鉴权；上游凭据是全组织一份，流里没有"别的成员的数据"可读。若日后要求长连接也随吊销断开，做法是在网关上给流加一个 60 秒的成员状态复检，读到 `missing` 就中止流 —— 本轮不做。

## 6. 数据契约

### 6.1 企业端 `mcp_connectors.auth_config`（`shared-key`）

| 字段 | 机密 | 说明 |
|---|---|---|
| `apiKey` | 是（存为 `__enc__apiKey`） | 组织统一密钥 |
| `apiKeyHeaderName` | 否 | 可选；缺省 = `Authorization: Bearer <apiKey>`；填了 = 该头名 + 原值 |
| `timeoutSeconds` | 否 | 既有字段（2026-09-26 设计的 D8），透传给 OpenClaw |

### 6.2 公共视图（`ConnectorPublicView`，桌面消费）

既有字段不变，新增：

```ts
consumption?: 'direct' | 'gateway';   // shared-key → 'gateway'，其余 → 'direct'
orgCredentialReady?: boolean;          // 仅 shared-key 有意义
```

### 6.3 桌面本地记录（`McpServerRecord` / `McpServerFormData` / `McpConfigJson`）

```ts
consumption?: 'direct' | 'gateway';
/** 仅 gateway 模式：网关服务令牌（GSJ）。桌面连网关时用它当 Authorization。
 *  它不是组织密钥 —— 组织密钥一步都不出企业端。 */
gatewayToken?: string;
/** 这枚 GSJ 的签发对象（企业会话的 userId）。换人登录后必须重新换发（D19）。 */
gatewayTokenOwner?: string;
```

存储在 `mcp_servers.config_json` JSON blob 内 —— **无 SQLite 迁移**。

`gatewayToken` 是长期凭据，明文存在本地（与 `user-key` 的 API Key 同一暴露级别）。

### 6.4 网关路由

```
ALL         /mcp/gateway/:serverKey        （中继）
POST        /mcp/gateway/:serverKey/token  （签发 / 换发 GSJ）
```

| 方法 | 用途 | 处理 |
|---|---|---|
| POST | JSON-RPC 请求与通知 | 中继请求体；回传状态码/头/流 |
| GET | 服务端 → 客户端的 SSE 流 | 中继上游的 SSE 流（不缓冲） |
| DELETE | 终止会话 | 中继 |

请求头：中继除 `authorization`、`host`、`content-length`、`connection`、`accept-encoding` 之外的全部头（含 `mcp-session-id`、`accept`、`content-type`）。

响应头：回传除 `content-encoding`、`content-length`、`transfer-encoding`、`set-cookie` 之外的全部头（含 `content-type`、`mcp-session-id`）。

> 去掉 `content-encoding` / `content-length`：Node 的 fetch 会自动解压上游的 gzip，回传原始编码头会导致客户端解码失败或长度不符。

### 6.5 桌面 ↔ 企业端的 MCP 公共视图

`ConnectorPublicView` 新增两个字段（见 D10），桌面据此决定"能不能装、走不走网关、密钥配了没有"：

```ts
consumption?: 'direct' | 'gateway';   // shared-key → 'gateway'，其余 → 'direct'
orgCredentialReady?: boolean;          // 仅 shared-key 有意义
```

GSJ **不在**公共视图里 —— 它是装完之后按连接器单独换发的，不是目录信息。

## 7. 变更清单

### 企业端 `enterprise_server/src`

- **`mcp/orgCredential.ts`（新建）**：`buildOrgCredentialHeaders(authConfig: Record<string, unknown>): Record<string, string>` —— 按 D9 的规则构造上游请求头。纯函数，企业端探测与网关**共用**。`shared-key` 以外的模式返回 `{}`。
- **`mcp/connectorVisibility.ts`（新建）**：`connectorVisibleToCaller(row, caller)` —— 把市场路由内联的判定抽出来，市场路由与网关共用。抽的时候要**逐条搬全**，现有实现（`routes/mcpMarketplace.ts:20-44`）的判定顺序是：
  1. `isSuperAdmin` → 可见（**super admin 无条件可见，别漏这一条**）；
  2. `scope.allCompany` → 可见；
  3. `scope.userIds` 含调用者 → 可见；
  4. 否则：`descendantsOf(scope.deptIds, deptPath)`（把**被授予的**部门展开成子树）与调用者自己的部门集合求交，命中即可见。

  入参：`caller = { userId, isSuperAdmin, deptIds }`；`deptIds` 来自 `scopeApi.deptIdsFor(orgId, userId)`（调用者自己的叶子部门），`deptPath`（全组织的 `id → path` 映射）按 org 缓存 30 秒，避免网关热路径每次全表扫。
- **`mcp/gatewayPolicy.ts`（新建）**：`toolAllowedByPolicy(tools: ToolEntry[], toolName: string): boolean` —— 直接吃 `ToolEntry[]` 自己判，**不复用 `toolFilterFor` 的返回值**（它把"策略未初始化"和"不限制"都压成 `undefined`，D6 的判据表才是判据）。纯函数。**可见性判定不在这里**（在 `connectorVisibility.ts`），别把两件事混在一个模块里。
- **`auth/jwt.ts`**：新增 `signGatewayToken` / `verifyGatewayToken`（D18）—— 与 `signToken`/`verifyToken` **互不调用**，用派生的独立密钥。
- **`auth/memberStatus.ts`（新建）**：把 `requireActiveMember.ts` 里的 `resolveMemberStatus` 与 30 秒 TTL 缓存抽出来共用（D18(4)）。`requireActiveMember.ts` 改为 import 它，两个既有导出与 wire/numeric 两种 401 body 形状**一字不变**；`auth/memberStatus.ts` 另导出 `_resetMemberStatusCacheForTest()`（原 `_resetRequireActiveMemberCacheForTest` 的能力搬过来）。
- **`routes/mcpGateway.ts`（新建）**：
  - `ALL /mcp/gateway/:serverKey`：验 GSJ（D18 的 6 步）→ 查成员在职 → 取连接器 → `enabled` → scope → 工具策略 → 注入凭据 → 中继。
  - `POST /mcp/gateway/:serverKey/token`：签发 / 换发 GSJ（D18 的前置判定表）。
  - 错误分类按 D7（**两个 401 分开**：GSJ 本身的问题 = `unauthorized`；成员被吊销 = `not_member` + `code:41602`）。
  - 成员在职检查用 `resolveMemberStatus`（`auth/memberStatus.ts`），fail-open 语义原样继承（D18(4)）。
  - 请求体解析要处理 JSON-RPC 批量数组；审计写在上游响应头到达时、只记 HTTP 状态码（D20）。
  - `tools/call` 写审计（D8）。
  - 出站 URL 必须是 https（回环例外），否则拒绝注入组织密钥（D17）。
- **`routes/mcpConnectors.ts`**：探测路径改用 `buildOrgCredentialHeaders`（不再写死 `Authorization: Bearer`）；`missingAuthField('shared-key')` 保持"必须有 apiKey"不变；`sseOauthCombination` 加 `shared-key`（该组合非法，发布 400）。
- **`routes/mcpSubmissions.ts`**：成员提交若带组织凭据方式（`shared-key` / `client-creds`）→ 400（D16.1）。
- **`models/connectorView.ts`**：公共视图加 `consumption` 与 `orgCredentialReady`；`orgCredentialReady` 只看 `__enc__apiKey`（不要用 `hasStoredSecret`，见 D10）。
- **`shared/enterpriseServerConstants.ts`**：`AuditAction.McpGatewayCall`。
- **`server.ts`**：挂载网关路由。**必须挂在 SPA fallback 之前** —— `server.ts:226` 有 `app.get('*', (c) => c.html(readFileSync(indexHtml, 'utf8')))`，它会吞掉所有没匹配上的 GET。Hono 按注册顺序匹配，所以网关的 `app.all('/mcp/gateway/:serverKey')` 必须与其它 API 路由（`:63`-`:122` 那一段）放在一起，落在 SPA 块之前；否则 POST/DELETE 能过、GET（SSE 流）却会被回成 index.html。路径本身与既有的 `/admin/mcp-connectors/*`、`/api/mcp-marketplace` 不重叠。
- **`src/http/responseStreaming.ts`（新建）** + **`src/server.ts`**：按 D15 把"响应是否流式"抽成纯函数，并让 SSE 响应走流式路径（现有 `accept-ranges` 分支保留）。
  > 新模块放 `src/http/` 而不是 `src/server/` —— `src/server.ts` 已经存在，再建一个同名目录会让人分不清。
- 测试：`tests/mcp/orgCredential.test.ts`（新建）、`tests/mcp/gatewayPolicy.test.ts`（新建）、`tests/routes/mcpGateway.test.ts`（新建）、`tests/auth/gatewayToken.test.ts`（新建）、`tests/models/connectorView.test.ts`（新增两个字段）、`tests/routes/mcpConnectors.test.ts`（探测头随 `apiKeyHeaderName` 变化）。

### 控制台 `enterprise_server/web`

- **`pages/mcpManage/ConnectorAuthFields.tsx`**：`shared-key` 分支去掉"预留"提示，改为说明"组织统一密钥保存在企业服务端，桌面端经企业网关访问，员工机器上不会出现该密钥"；新增"API Key 请求头名称"输入（可选，placeholder 写清两种默认行为）。
- **`pages/mcpManage/ConnectorConnConfig.tsx`**：`SSE_INCOMPATIBLE_AUTH_MODES` 加 `shared-key`（选 `sse` 时重置为 `none`）；打开存量 `shared-key` + `sse` 记录时给出"请改传输或改方式"的提示。
- **`pages/mcpManage/ConnectorBasicInfo.tsx`**：共享密钥连接器的"测试连接"提示改为"用组织密钥握手"（探测逻辑不变）；`shared-key` 的明文 http URL 从警告升级为阻断（D17）。
- **`pages/mcpManage/ReviewDetailDrawer.tsx`**：审批 `shared-key` 提交时，在已有的 URL 与授权方式两行旁边加一句"发布后组织密钥会发送到上面这个地址，请确认地址可信"（D16.2）。
- **`i18n.ts`**：`mcp.authHint.sharedKey`（"组织统一的一个密钥。"）改写成"经企业网关访问，员工机器上不会出现该密钥"；新增/改写中英文案（密钥说明、请求头名称、网关说明、SSE 不支持提示、审批警告、GSJ / 令牌失效）。
- 测试：`tests/pages/mcpManage/*` 补 `shared-key` 表单形状与校验。

### 桌面端（repo root）

- **`src/shared/mcp/constants.ts`**：`ConnectorConsumption = { Direct: 'direct', Gateway: 'gateway' }` + 类型。
- **`src/main/enterpriseAccount/membershipRevocationBridge.ts`（新建）**：把 `main.ts:4880` 的 `handleEnterpriseMembershipRevocation` 提成一个模块级入口，供 `enterpriseFetchWithAuth`（现状）与 MCP 网关错误路径（D7）共用。**吊销语义不变，只改它被谁调用。**
- **`src/main/mcp/mcpTarget.ts`（新建）**：`resolveMcpTarget`（D12 的签名）+ `gatewayUrlFor(baseUrl, serverKey)`。企业端 base URL 用 `getServerApiBaseUrl()`（`src/main/libs/endpoints.ts`），未配置时传 `null`；**不要**给 `enterpriseClient` 加 getter（D12）。
- **`src/main/mcp/mcpGatewayToken.ts`（新建）**：`ensureGatewayToken(record): Promise<string>` —— 本地 `gatewayToken` 满足"未过期 + 剩余 >= 15 天 + `gatewayTokenOwner === sessionStorage.load()?.userId`"时直接返回；否则先清掉这两个字段再换发（D19）。换发用成员的企业 JWT 调 `POST /mcp/gateway/:serverKey/token`，把 `token` 与 `owner = 当前 userId` 一起写回本地记录。**异步**（要用会话里的企业 JWT）；调用方 `await` 它之后才调同步的 `resolveMcpTarget`（D12）。
- **`src/main/mcp/mcpRuntime.ts`**：`getResolvedServers()` 的远程分支改用 `resolveMcpTarget`；返回 `null` 的服务器跳过并记日志。
- **`src/main/mcp/mcpToolCatalog.ts`**：`listViaHttp`（`:209` 读 `record.url`、`:216` 读 `record.headers`）改用 `resolveMcpTarget`（探测与运行时同源）；探测收到 401 时先 `ensureGatewayToken` 换发再重试一次；401 body 里读到 `code === 41602` 时调用 `handleEnterpriseMembershipRevocation`（D7 的接线）。
- **`src/main/mcp/mcpStore.ts`**：`McpServerRecord` / `McpServerFormData` / `McpConfigJson` 增加 `consumption`、`gatewayToken`、`gatewayTokenOwner`；企业更新时以目录为准（缺省 = 清除）。另加 `clearGatewayTokens()`：把所有 `consumption === 'gateway'` 记录的 `gatewayToken` / `gatewayTokenOwner` 清掉，供登出处调用（D19，兜底而非正确性来源）。
- **`src/main/auth/enterpriseClient.ts`**：公共视图类型加 `consumption` / `orgCredentialReady`；新增 `issueGatewayToken(serverKey)`（复用文件里既有的私有 `call()` —— 它会自动带上成员的企业 JWT 作为 `Bearer`，正好是 D18 换发端点要的前置）。
- **`src/renderer/components/mcp/enterpriseAuthMode.ts`**：把"组织凭据"这个二合一判断拆成两个 —— `isGatewayAuthMode(mode)`（只有 `shared-key`）与 `isRetiredAuthMode(mode)`（只有 `client-creds`）。`isOrgManagedServer(record, catalog)` 同样要拆成 `isGatewayServer` / `isRetiredServer`：它今天对 `shared-key` 与 `client-creds` 一律返回 true，而 `shared-key` 装上之后是**能用**的，继续被它挡住就等于功能没做。`mapEnterpriseAuthModeToMcpAuthMethod` 不变（`shared-key` → `None` 依旧正确）。
- **`src/renderer/components/mcp/McpServerFormModal.tsx`**：企业安装时把 `consumption` 落库；共享密钥连接器的 URL 只读并标注经网关。**安装时先换发 GSJ 再落库**（D12 规则 1）—— 换发失败则安装失败，不留半成品记录。
- **`src/renderer/components/mcp/McpManager.tsx`**：三个门禁点分流（下面逐条列）。
  三个门禁点的具体改法（`McpManager.tsx`）：

  | 位置 | 现状 | 改后 |
  |---|---|---|
  | `:1835` 市场卡片的 `actions` | `isOrgManagedAuthMode(entry.authMode)` 为真 → 只渲染"组织统一授权"徽标，不给安装按钮 | 只有 `client-creds` 仍只给徽标；`shared-key` 走正常的安装按钮分支 |
  | `:1838` 市场卡片的 `meta` | 只有传输方式徽标 | `shared-key` 时补一枚"经企业网关"徽标（`McpCard` 已有 `meta` 槽） |
  | `:989`/`:1034` 已安装卡片的 `orgManaged` | `shared-key` 与 `client-creds` 都挂"组织统一授权"徽标 | `shared-key` 的文案改成"组织统一授权 · 经企业网关"；`client-creds` 保持原样 |
  | `:996` 缺凭据时的"配置"按钮 | `!orgManaged` 才显示 | `shared-key` 记录的 `authMethod` 是 `None`，本来就不满足 `authMethod !== None`，行为不变；拆函数后不要把它改回显示 |
  | `:1232` 详情页"重新授权"按钮 | `!isOrgManagedServer(...)` 才显示 | 同上，`authMethod === None` 已经挡掉，行为不变 |

- **`src/renderer/types/mcp.ts`** / **`src/renderer/types/electron.d.ts`**：类型同步。
- **`src/renderer/services/i18n.ts`**：新增中英文案。
- 测试：`mcpTarget.test.ts`（新建）、`enterpriseAuthMode.test.ts`（改）、`mcpRuntime` / `mcpToolCatalog` 的改写用例、`mcpStore` 往返用例。

## 8. 行为规格（可验收）

1. 管理员在控制台创建一个 `shared-key` 连接器，填入 API Key，发布 → 卡片不再显示"暂未开放"，显示"组织统一授权 · 经企业网关"。
2. 员工在桌面端的企业市场看到该连接器 → **可以安装，安装后没有任何授权动作**（不弹授权窗，不进"待授权"计数）。
3. 员工安装后，详情页「连接」= 已连接，「工具清单」列出上游真实工具。
4. 员工的 `openclaw.json`、SQLite、日志里**搜不到组织密钥**（可用 grep 验证）。
5. 员工 A（部门 X）能通过网关调用连接器的工具；员工 B（部门 Y，无授权）在桌面端看不到该连接器；拿 B 的 GSJ 直接 curl 网关 → 403。
6. 管理员在工具面板关掉工具 T → 员工 A 的 agent 看不到 T；拿 A 的 GSJ 直接构造 `tools/call(T)` 请求 → JSON-RPC 错误 `-32601`。
7. 管理员改掉 API Key → 员工端无需任何操作，下一次调用即使用新密钥（旧密钥立即失效）。
8. 管理员停用连接器 → 网关返回 404，桌面端显示"连接器不可用"。
9. 成员被禁用/离职 → 网关返回 401 `{"error":"not_member","code":41602}`，桌面读出 `code === 41602` 后触发成员吊销流程（D7 的接线）。沿用 `requireActiveMember` 的既有语义：状态缓存 30 秒，所以最迟 30 秒内被拒；DB 读失败时 fail open（放行）—— 与 LLM 代理同一道门禁、同一扇门。
10. 上游拒绝组织密钥 → 网关返回 502 `upstream_unauthorized`，桌面显示"组织密钥失效，请联系管理员"（与"未连接"区分）。
11. 用成员的企业 JWT（`Bearer`）直接打网关 → 401（它不是网关凭据）；用别家组织的 GSJ → 404。
12. 管理员删掉组织密钥 → 公共视图 `orgCredentialReady=false`，桌面详情页显示"组织密钥未配置"。
13. 桌面 GSJ 剩余有效期 < 15 天 → 自动换发一次，`openclaw.json` 的 `mcp` 段变一次 → 网关重启一次；其余时间**不会**因为凭据而重启。
14. `shared-key` + `sse` 在控制台不可选（选 `sse` 时方式重置为 `none`）；存量 `shared-key`+`sse` 记录在控制台打开时提示改传输或改方式，经网关访问返回 400 `unsupported_transport`。
15. 共享密钥连接器在 OpenClaw 配置里是 `transport: 'streamable-http'`（不是 `sse`）。
16. 成员提交一个 `authMode: 'shared-key'` 的连接器 → 服务端 400（"组织凭据方式只能由管理员创建"）。
17. 管理员在审批队列里看到一个 `shared-key` 提交 → 界面明确提示"发布后组织密钥会发送到 <URL>"。
18. `shared-key` 连接器的 URL 是明文 `http://` → 控制台阻断发布；绕过控制台直接写库 → 网关拒绝把组织密钥发往该地址（返回 502 `upstream_insecure`）。
19. 装好之后 `openclaw.json` 里是 `headers.authorization = "McpGateway <GSJ>"`；`grep` 整个桌面数据目录**搜不到组织密钥**（也搜不到企业 JWT）。
20. 一枚 GSJ 不能当企业 JWT 用（拿它去调任意成员级 API → 401）；一枚企业 JWT 也不能当 GSJ 用。
21. GSJ 无效 / 过期 / 拿 `Bearer` 冒充 → 401 `{"error":"unauthorized"}`；桌面换发一次 GSJ 后重试成功（不打扰用户）。
22. 一个从未探测过的 `shared-key` 连接器（`tools` 为空）→ 网关对**任何** `tools/call` 返回 `-32601`（"策略未初始化"），而不是放行全部工具。
23. 桌面未配置 `ENTERPRISE_SERVER_URL`（非企业版客户端）→ `resolveMcpTarget` 返回 `null` → 该服务器不进 OpenClaw 配置，日志说明原因（不崩、不回退直连上游）。
24. 安装共享密钥连接器时换发 GSJ 失败 → 安装失败并给出原因（不落库）；运行期换发失败但本地已有 GSJ → 继续用旧令牌（配置不变 ⇒ OpenClaw 网关不重启），记一条 `console.warn`。
25. 同一台机器上 A 登出、B 登录 → B 的配置同步**不会**继续使用 A 的 GSJ：owner 不匹配 → 清掉并重新换发为 B；A 的 GSJ 从 `openclaw.json` 中消失（一次硬重启，符合预期）。
26. 未登录（`sessionStorage.load()` 为 null）→ 网关模式服务器不进 OpenClaw 配置，`openclaw.json` 里搜不到任何 GSJ。
27. 客户端把两个 JSON-RPC 消息打包成数组发来，其中一个是越权工具 → **整批** `-32601`，上游一个字节都收不到。
28. 审计记录写在响应头到达时：一次 `tools/call` 无论上游响应体多大、是不是流，审计都在 HTTP 状态码确定的那一刻落库，不读响应体。

## 9. 安全不变量

1. 组织密钥只出现在：企业端进程内存、`mcp_connectors.auth_config.__enc__apiKey`、上游请求头。**不出现在**桌面端任何持久化位置、日志、错误消息、审计 payload、响应体。
2. 桌面持有的 GSJ **不能读出组织密钥**，也不能用于组织密钥之外的任何东西 —— 它只是"允许用组织密钥调用这一个连接器"的准入票。
3. 两族令牌互不通用（独立的签名密钥 + 不同的 scheme），因此不存在"拿一枚令牌当另一枚用"的权限混淆。
4. 成员的企业 JWT 永远不被转发给上游；上游只看得到组织凭据。
5. 网关对每个请求独立鉴权：无状态中继不意味着无鉴权。
6. 跨组织访问一律 404；GSJ 的 `serverKey` 与请求路径不符一律 404。
7. 组织的工具策略在服务端强制（D6），客户端过滤只是第二道。
8. 密钥在服务端 → 轮换即时生效，无需下发、无需重装。
9. 组织密钥只发往 **https**（回环例外）的、**管理员确认过的**地址；成员不能提议组织凭据方式（D16/D17）。
10. 写进 `openclaw.json` 的网关凭据必须稳定 —— 轮换的凭据会让 OpenClaw 网关反复重启（D3）。
11. 桌面绝不使用不属于**当前登录成员**的 GSJ：`gatewayTokenOwner` 与当前会话的 `userId` 不符即视为无令牌（D19）。换人登录不继承上一个人的组织权限。
12. 工具策略的默认是"拒绝"：`tools` 为空（从未探测）时拒绝**所有** `tools/call`，而不是放行（D6）。批量 JSON-RPC 里任何一个越权元素让整批被拒（D20）。
13. 网关从不为写审计而缓冲响应体：审计在响应头到达时落库，流式响应照常透传（D20）。

## 10. 测试策略

**企业端（逐文件跑，sandbox fd 限制）**

- `orgCredential.test.ts`：默认 → `Authorization: Bearer <key>`；自定义头名 → 原值无前缀；无 key → 空对象；非 `shared-key` → 空对象。
- `gatewayPolicy.test.ts`：白名单命中/未命中；exclude 命中；纯发现清单（全启用 → 不过滤）；人工声明清单；**`tools` 为空 → 全部拒绝**（fail-closed）；全部 `removed` → 全部拒绝；手工声明且全部禁用 → 全部拒绝。
- `memberStatus.test.ts`（新建）：`missing` / `status !== 'active'` / `active` / DB 错误（fail open）四种结果；30 秒 TTL 内不重复查库；`_resetMemberStatusCacheForTest` 清缓存。
- `gatewayToken.test.ts`（新建）：`signGatewayToken` → `verifyGatewayToken` 往返；**企业 JWT 在 `verifyGatewayToken` 处必然失败**；GSJ 在 `verifyToken` 处必然失败；`purpose` 缺失 / `serverKey` 不符 / 过期 → 各自被拒。
- `mcpGateway.test.ts`（路由级）：GSJ + 共享密钥连接器 → 上游收到注入的密钥、桌面收到中继结果；scope 不命中 → 403；跨组织 → 404；GSJ 的 serverKey 与路径不符 → 404；停用 → 404；上游 401 → 502 `upstream_unauthorized`；企业 JWT（`Bearer`）打过来 → 401；禁用工具的 `tools/call` → `-32601`；**批量数组里有一个越权工具 → 整批 `-32601` 且上游零请求**（D20(1)）；**审计在上游响应头到达时落库，且响应体未被读完就能返回流**（D20(2)）；响应体/日志不含密钥明文。
- `mcpGateway.test.ts` 的签发路由：成员 JWT → 拿到 GSJ；非 `shared-key` 连接器 → 400；不可见连接器 → 403；未认证 → 401。
- `connectorView.test.ts`：`consumption` 与 `orgCredentialReady` 的取值。
- `connectorVisibility.test.ts`（新建）：授予父部门时子部门成员可见（子树展开）、成员例外命中、外部门不可见、super admin 全可见；市场路由与网关对同一行给出**相同**结论（防漂移）。
- `responseStreaming.test.ts`（新建）：`text/event-stream` → 流式；`accept-ranges` → 流式（既有行为）；普通 JSON → 缓冲。
  > 注意：路由级测试走的是 Hono 的 `app.request()`，**不经过 node:http 适配层**，所以适配层的流式行为单测测不到。适配层本身要一个真起 http 服务的集成测试（起 node 服务 → curl 一个 SSE 路由 → 断言 chunk 边到边回），列入 P3 端到端。
- `mcpConnectors.test.ts`：探测头随 `apiKeyHeaderName` 变化。

**桌面端**

- `mcpTarget.test.ts`（纯函数，最重要的一个）：网关模式 → 网关 URL + `McpGateway <token>` 头；缺 base/serverKey/gatewayToken → `null`；缺企业端 base URL（非企业版客户端）→ `null`；直连模式 → 原样。
- `enterpriseAuthMode.test.ts`：`shared-key` 不再是"退役"模式；`client-creds` 仍是。
- `mcpToolCatalog.test.ts`：共享密钥记录探测时命中网关 URL 而不是上游 URL；401 `unauthorized` → 换发一次 GSJ 后重试；401 `not_member` + `code:41602` → **不**换发，改为触发成员吊销钩子。
- `mcpGatewayToken.test.ts`（新建）：owner 匹配 + 未临期 → 直接返回、不发请求；owner 不匹配 → 清掉并重新换发；临期 → 换发；未登录 → 返回空/抛错且不写回；换发失败时 `ensureGatewayToken` 的上层能拿到错误并按 D12 规则 2 退回旧令牌。
- `mcpRuntime` / `openclawMcpServers`：网关记录的 `ResolvedMcpServer` 的 url/headers 正确。

**端到端（P3）**：起一个假的共享密钥上游 MCP（本地 HTTP），配置一个 `shared-key` 连接器，桌面安装 → 探测到工具 → agent 调用成功 → 审计表出现 `mcp_gateway_call`。

## 11. 风险与回退

| 风险 | 缓解 |
|---|---|
| 流式中继被缓冲，长连接卡死 | **既有阻塞点**：node:http 适配层当前缓冲一切响应体，必须先按 D15 打开 SSE 流式路径；响应体以 `ReadableStream` 原样回传（照抄 `proxy/providerProxy.ts` 的 `new Response(upstream.stream, ...)` 写法）；DELETE/GET 都要测。 |
| 成员提议的 URL 拿到组织密钥（经管理员批准） | 服务端禁止成员提交组织凭据方式（D16.1）+ 审批界面明示目标地址（D16.2）+ 只有管理员能填密钥（D16.3）+ 明文 http 阻断（D17）。 |
| 网关与市场的可见性判定漂移 | 判定只有一份实现（`connectorVisibility`），两边共用；单测直接断言"同一行在两处结论一致"。 |
| 写进 `openclaw.json` 的凭据一旦轮换 → 网关反复重启 | 已核实并规避：`mcp` 段变化会被判为 `Restart`（`openclawConfigSync.ts:2647`），因此配置里放的是 90 天有效的 **GSJ** 而不是 4 分钟一变的企业 JWT（D3）。GSJ 换发约每 75 天一次。 |
| GSJ 是长期凭据，落在桌面磁盘上 | 与 `user-key` 的 API Key 同一暴露级别；GSJ 只能调用那一个连接器、且受 scope / 工具策略 / 成员在职状态三重限制；成员离职后 30 秒内失效（D18）。 |
| 两族令牌互认导致权限混淆 | 独立的派生签名密钥 + 不同的 scheme + `purpose` 显式校验，三重隔离（D18）；单测直接断言互相验不过。 |
| `mcp-session-id` 中继后被成员跨用户复用 | 网关逐请求按 JWT 校验 scope/工具策略，复用 id 也过不了范围检查。 |
| SSE 连接器被组织密钥模式选中 | 控制台禁用 + 网关返回明确的 400（D5）。 |
| 网关成为单点 | 网关无状态（不持有会话），可多实例部署；无数据库写入（审计写入失败不阻塞调用）。 |
| GSJ 换发抖动 → OpenClaw 配置有/无来回变 → 反复重启 | 安装时换发并落库（失败即安装失败）；运行期换发失败退回用现有令牌；只有"本地根本没有令牌"才跳过服务器（D12 三条规则）。 |
| 网关把"策略未初始化"当成"不限制" | `toolFilterFor` 的 `undefined` 有两种成因，网关自己按 `ToolEntry[]` 判（fail-closed，D6）；单测钉住"空工具清单 → 全部拒绝"。 |
| 成员状态查询被复制成第二套（缓存 / 语义漂移） | 复用 `requireActiveMember` 的实现：抽到 `auth/memberStatus.ts`，两边共用（D18(4)）。 |
| 被吊销的成员在 30 秒内仍能调用（DB 故障时无限期） | 与 LLM 代理同一道门禁、同一个窗口（既有语义，非本设计引入）；成员状态查询与 fail-open 行为都从 `requireActiveMember` 原样复用，不"顺手修好"。 |
| 换人登录后沿用上一个人的 GSJ → 权限混淆 | GSJ 与签发对象绑定（`gatewayTokenOwner`），owner 不匹配即清掉重发（D19）；登出处另做一次清理兜底。 |
| 批量 JSON-RPC 里夹带越权工具 | 批量数组逐个检查、一个越权整批拒（D20(1)）；单测断言"上游零请求"。 |
| 为记审计而缓冲响应体，把流打断 | 审计只记 HTTP 状态码与工具名，写在响应头到达时（D20(2)）；单测断言不读响应体也能返回。 |
| 企业端服务不可达时桌面表现 | 网关 URL 拨号失败 → OpenClaw 报连接错误；详情页显示"未连接"。与现在的直连失败表现一致。 |
| 范围/工具策略每次请求都查库 | 范围判定需要部门子树（一次查询 + 30 秒 TTL 缓存，`scopeResolver` 已有）；连接器行按 `(orgId, serverKey)` 一次点查。可接受。 |
| 回退 | 网关是新增路由，删掉路由 + 把 `shared-key` 改回"预留"即可回到今天的状态；桌面端 `consumption` 字段留着不影响直连模式。 |

## 12. 分期

- **P0 — 打通流式响应（D15）**：node:http 适配层的 SSE 流式路径 + `shouldStreamResponse` 纯函数。这是网关的先决条件，单独一个可验证的小改动（起真服务 curl 一个 SSE 路由）。
- **P1 — 企业端网关**：D1–D9 的服务端部分（orgCredential、gatewayPolicy、connectorVisibility、mcpGateway 路由、公共视图两个字段、审计、控制台表单）。产出：企业端可发布一个共享密钥连接器并被网关正确代理（curl 可验）。
- **P2 — 桌面端接线**：D10–D13、D18、D19（`consumption` + `gatewayToken` + `gatewayTokenOwner` 落库、`ensureGatewayToken` 换发与 owner 校验、`resolveMcpTarget`、配置同步改写、探测同源、详情页与卡片、吊销钩子接线）。产出：员工装上就能用，详情页状态真实，换人登录不会串权限。
- **P3 — 端到端验证与文档**：真实/假上游跑通全链路；补 `docs/superpowers/plans/`；更新 2026-09-27 设计的 M2 状态。

## 13. 我替读者做的判断（可否决）

1. **不新增"连接器专用令牌"表**。最初想的是"每个安装发一枚不透明令牌，服务端只存哈希，另加一张表做签发/吊销"。最后选了 **GSJ（无状态 JWT）**，因为：真正需要的吊销路径（成员离职、连接器停用、密钥轮换）三条都已由既有机制覆盖，不值得为此多一套表 + 一套状态机；代价是 GSJ 无法被单独吊销、90 天自然过期（D18 已写明）。如果日后产品要求"单独吊销某个成员对某个连接器的访问"，再换回不透明令牌 + 一张 `mcp_gateway_tokens` 表 —— 那时只需替换 GSJ 的签发与校验两个函数，其余（路由、策略、中继）不动。
2. **GSJ 用独立于企业 JWT 的派生密钥签名**，而不是共用 `JWT_SECRET` + 多一个 claim。共用密钥会让一枚 GSJ 通过 `verifyToken`（它只读 `sub`/`orgId`/`roles`），从而可能被当成企业 JWT 调成员级 API —— 这是实打实的权限混淆，派生密钥从根上避免（D18）。
3. **SSE 不做**（D5）。宁可明确不支持，也不做一个有状态、会漏连接的中继。
4. **组织密钥轮换不通知桌面**。服务端改完即生效，这是 D1 的直接收益；不引入"密钥版本号 + 桌面拉取"机制。
5. **`consumption` 用显式字段而不是从 `authMode` 推断**。多一个字段，换一份不会漂移的契约。
6. **审计只记 `tools/call`**。协议握手不记，否则审计表会被探测流量淹没。
7. **工具策略在网关侧 fail-closed**（D6）。`toolFilterFor` 把"策略未初始化"和"不限制"都压成 `undefined`，所以网关不复用它的返回值，自己按 `ToolEntry[]` 判 —— `tools` 为空则**一个工具都不放行**。代价：一个刚建好、还没探测成功的共享密钥连接器在探测之前不可调用（管理员会看到"策略未初始化"，去工具面板同步一次即可）。这比"策略缺失 = 全开"安全得多。
8. **成员状态检查复用既有实现，不另起一套**（D18(4)）。把 `resolveMemberStatus` 抽到 `auth/memberStatus.ts` 共用，**包括 fail-open 这个既有语义**（DB 抖动不踢人）。代价：被吊销的成员在最多 30 秒内仍能过网关 —— 与 LLM 代理是同一个窗口，不是新增缺口。
9. **GSJ 绑定签发对象，而不是"在登出处记得清"**（D19）。登出路径今天有两条、将来会有第三条，靠"每处都记得清"迟早漏；owner 比较是数据的属性，忘不掉。代价：多存一个非机密的 `gatewayTokenOwner` 字符串，换人后多一次换发与一次重启。
10. **审计只记 HTTP 状态码，不记 JSON-RPC 的 `result.isError`**（D20(2)）。要记 `isError` 就得读完响应体，而那会把 D15 的流式中继毁掉。取舍：审计能回答"谁在什么时候调了哪个工具、网关放行了没有、上游接没接"，不能回答"工具自己报错没有"—— 后者从上游日志里查。
