# 桌面端连接器指定与提示词引导 — Design Spec

**Date:** 2026-10-28
**Owner:** paul
**Status:** Approved in brainstorm
**Related specs:**
- `2026-09-13-mcp-connector-marketplace-redesign-design.md`（企业市场 / 安装）
- `2026-09-26-mcp-connector-management-design.md`（管理控制台 / 后端 / 桌面消费侧）
- `2026-09-27-mcp-connector-desktop-oauth-design.md`（桌面端 per-user 鉴权流）

---

## 1. Goal

桌面端对话输入框里能选择一个连接器，让模型**优先直接使用它**，而不是绕路去搜网页或凭记忆回答；同时连接器的**启用状态**与**授权状态**在输入框附近可见、可就地操作（启用 / 连接）。

一句话：**把「用户点名服务」这件事从用户打字变成用户点一下。**

---

## 2. 背景：模型侧到底看见什么

这一节是整份设计的依据，所有决策都由它推出。

### 2.1 工具名的构成

OpenClaw 把每个 MCP server 的工具物化成：

```
<safeServerName>__<toolName>
```

- 分隔符是 `__`（`openclaw/src/agents/agent-bundle-mcp-names.ts` 的 `TOOL_NAME_SEPARATOR`）。
- `safeServerName = sanitizeServerName(configKey)`：非 ASCII 字符**全部**替换成 `-`；不以字母开头时补 `mcp-` 前缀；重名时追加 `-2` / `-3` 后缀。
- 工具描述 = **厂商自己写的** `tool.description`（`openclaw/src/agents/agent-bundle-mcp-runtime.ts:687`）。连接器名字**不在描述里**；只有厂商没写描述时才用带 server name 的 fallback。

`configKey` 是 MixWork 写进 `openclaw.json` 的 `mcp.servers` 键，目前是
`safeServerKey(record.name)`（`src/main/libs/openclawMcpServers.ts:120`），也就是**显示名**。

### 2.2 企业连接器的显示名是中文优先

`enterprise_server/src/models/connectorView.ts` 的 `mapPublicConnector`：

```ts
name: row.name_zh ?? row.name_en ?? row.server_key
```

所以一个中文名连接器，在模型眼里长这样：

```
mcp-29c79d44__query_company      描述「查询客户跟进记录」
```

模型**不知道**这是纷享销客CRM，**不知道**这是公司内部系统，也无从判断它是不是权威数据源。

### 2.3 直接用显示名当 config key 会撞名

把 OpenClaw 的 `sanitizeServerName` 原样跑一遍（`safeServerName` 一侧是 MixWork 现有逻辑）：

| 显示名 | 直接当 config key → OpenClaw 产出的 key |
|---|---|
| 纷享销客 | `mcp-----` |
| 腾讯文档 | `mcp------2` |
| 同程程心 | `mcp------3` |
| 百度网盘 | `mcp------4` |
| 金山文档 | `mcp------5` |
| QQ邮箱 | `QQ--` |

三个问题：

1. **不可读** —— 全是连字符。
2. **撞名** —— 5 个 4 字中文名的 base 全是 `mcp-----`，靠数字后缀区分。
3. **后缀依赖注册顺序** —— 新装一个连接器可能挤掉已有连接器的后缀，导致它的工具名变化。

MixWork 现有的 md5 方案（`mcp-29c79d44`）避开了第 2、3 条，但一样不可读。

### 2.4 同类产品的做法

| 产品 | 做法 | 出处 |
|---|---|---|
| **WorkBuddy**（腾讯） | ❌ 无提示词指定。连接器是全局开关（输入框左下角 `+` > 连接器）；引导靠**用户在提示词里点名服务**；官方文档写明第三方数据「仅在您的指令触发时按需读取」；固化办法是做成 Skill | `workbuddy.cn/docs/workbuddy/.../Connector`（2026-10-23 更新） |
| **HugAgentOS**（浙大 ZJU-REAL） | ✅ 有。输入框 `+` 菜单选连接器 → 出现 MCP chip、显式激活、持久成 badge，**并注入一段提示词引导模型优先用它**；无强制调用参数，模型不调用也不中断 | `ZJU-REAL/HugAgentOS` `docs/zh-CN/modules/chat.md` |
| **DB-GPT** | ⚠️ 更激进。ask 区工具栏勾选连接器 → **只把选中的连接器的工具挂给 agent**；文档明确论证理由：保持 prompt 聚焦、省 token、避免选错工具 | `docs.dbgpt.cn/.../mcp_connectors` |
| **ChatGPT Apps** | ❌ 无系统提示词。用 @mention / 对话里点名 app。且有研究指出 Apps SDK `sendFollowUpMessage` 的隐藏参数 `systemPrompt` + `isVisible:false` 构成跨 app 上下文投毒向量 —— 「静默系统级注入」在生态里有安全争议 | `arxiv.org/abs/2606.00485` |

**结论：WorkBuddy 那条路（「用户自己点名」）今天在 MixWork 走不通** —— 用户写「纷享销客」，模型看见 `mcp-29c79d44__`，两边对不上。所以 MixWork 要么把名字改成模型看得懂的（→ 提示词注入），要么收窄工具集（→ 能力边界变窄）。

本设计取前者：**改 config key 让工具名可读 + 用提示词把「显示名 ↔ 工具前缀」的映射交给模型。**

---

## 3. 范围

### 3.1 本期做

1. **config key 规则**：企业连接器用 `serverKey`，本地连接器保持现状。（§5.1）
2. **AGENTS.md 托管段新增「已连接的数据源」章节**：常驻声明「显示名 ↔ 工具前缀」映射 + 使用规则。（§5.2）
3. **输入框连接器选择器**：输入框 `+` 菜单里新增「连接器」，弹出列已安装连接器的浮层，可就地启用 / 连接 / 看状态，底部有「管理连接器」入口。（§5.3）
4. **授权失效卡片**：已启用连接器探测到授权失效时，输入框上方出现「连接器需要重新连接」卡片，可就地重新连接。（§5.4）

### 3.2 不做（及原因）

| 不做 | 原因 |
|---|---|
| 每轮 prompt 注入连接器映射 | 「启用 = 指定」意味着每轮内容完全一样，常驻章节更合适（不重复烧 token、不受多轮漂移、启用状态自动最新）。§4-D3 |
| 内部 / 外部连接器分级 | 组织信任级别是 server 端字段，本期不引入。规则只区分「连接器覆盖的数据」与「网页 / 记忆」。 |
| 工具收窄（只暴露选中连接器的工具） | `mcp.servers` 是全局的，收窄要么重启网关、要么等 OpenClaw 侧的 per-agent 工具白名单落地。收益（省 token、避免选错工具）留待后续评估。 |
| 自动重试失败的那一步 | WorkBuddy 有这个能力，但 MixWork 的工具执行由 OpenClaw 掌控，桌面端无法重放某个 tool call。卡片在重连成功后改为提示用户可重试，不代替用户操作。 |
| 连接器管理页的功能变更 | 管理页（`McpManager.tsx`）不在本期范围，选择器复用它的既有能力与 IPC。 |
| Kit 与连接器的合并 | Kit 的 `mcpServers` / `connectors` 目前**只是元数据**，安装 Kit 不创建本地 `mcp_servers` 行（`src/main/ipcHandlers/kits/handlers.ts` 只把两者 normalize 后存进 installed kit 记录）。Kit 的连接器与真实可调的连接器是两套东西，本期不合并。 |

---

## 4. 决策

### D1 — config key：企业连接器用 `serverKey`，其余保持现状

```
key = safeServerKey(record.serverKey || record.name)
```

- 企业连接器：`serverKey` 由 server 端保证 `^[a-z0-9-]+$`、组织内唯一稳定（`server_key` 列），且桌面端本地记录已经存着它（`src/renderer/components/mcp/McpServerFormModal.tsx:361`：`data.serverKey = enterpriseServer.serverKey`）。
- 本地 / 自定义连接器：没有 `serverKey`。ASCII 名原样（OpenClaw 只把空格换成 `-`，`My Server` → `My-Server`，可读）；中文名继续走 md5 兜底（`mcp-29c79d44`），避免 §2.3 的撞名与顺序依赖。

**影响与已核对项：**

- ✅ **不破坏组织的工具策略**：`shouldExposeMcpTool(selection, tool.name.trim())` 匹配的是**原始工具名**，不是带前缀的全名（`openclaw/src/agents/agent-bundle-mcp-runtime.ts:337-345`）。org 的 `toolFilter.include: ["query_company"]` 照常生效。
- ⚠️ **工具名会变**：老用户的 `mcp-29c79d44__x` 变成 `fxiaoke__x`。历史对话里显示的仍是旧名（纯展示层）；`agents.<id>.tools.allow/deny` 里若有人写过 `mcp-29c79d44__*` 形式的模式会失效 —— MixWork 自己不写这种模式（`MANAGED_TOOL_DENY = ['web_search']`），但用户自定义的系统提示词里可能有，发布说明要提一句。
- ⚠️ **极小概率重名**：`serverKey` 是小写，`name` 可能是大写（`GitHub`）。OpenClaw 的重名消解按小写比较，理论上 `serverKey=github` 与本地名 `GitHub` 会撞，后者在 OpenClaw 侧变成 `github-2`。实现时要保证同一份 `mcp.servers` 里 key 唯一。

### D2 — 「启用」就是「指定」

选择器里的开关只有一层含义：连接器启用 → 进 `mcp.servers` → 模型拿到工具，同时它出现在 AGENTS.md 的连接器清单里。不引入第二个「指定」状态。

代价（已知并接受）：无法表达「两个都要，但 CRM 优先」。要优先就是只开 CRM。

### D3 — 映射与规则常驻 AGENTS.md 托管段，不每轮注入

理由：§2.4 的对照 + 「启用=指定」意味着每轮内容一样。

`src/main/libs/openclawConfigSync.ts` 的 `syncAgentsMd`（第 3101 行）已经在维护 8 个 `MANAGED_*_POLICY_PROMPT` 章节（第 3118-3126 行），每次 config sync 都重写 main 与每个 agent 的 `AGENTS.md`。连接器清单天然属于这里：

- 常驻，不重复烧 token。
- 不受多轮对话漂移影响。
- **启用状态自动最新** —— `syncAgentsMd` 在 config sync 内被调用，而 MCP 解析缓存在 sync 之前刷新（`src/main/main.ts:2482` → `refreshResolvedServersCache()`，紧接 `configSync.sync()`）。
- App 拥有，用户改不了（托管段 marker 之前是用户内容，之后每次重写）。

### D4 — 选择器只列已安装的连接器，可就地启用 / 连接

- 候选 = 本地 `mcp_servers` 记录（已安装），不含企业市场目录里没装的。
- 安装但未启用 → 行内开关，直接启用。
- 已启用但未连接 / 授权过期 → 行内「连接」动作，走既有 `mcp:startAuth` 流程。
- 底部「管理连接器」→ 打开 MCP 管理页。

### D5 — 授权失效用输入框上方的卡片提示，可就地重连

抄 WorkBuddy 的形态：**输入框上方**（不是浮层里）出现「连接器需要重新连接」卡片，点「重新连接」走既有鉴权流，成功后卡片消失。**不做自动重试失败的那一步**（§3.2）。

---

## 5. 实现要点

### 5.1 config key

**改动点**：`src/main/libs/openclawMcpServers.ts`

- `ResolvedMcpServer`（第 14 行）需要能携带 `serverKey`（或直接携带算好的 key）。
- `buildOpenClawMcpServers`（第 74 行）里第 120 行的 `result[safeServerKey(server.name)]` 改为按 D1 取 key。
- **关键**：§5.2 的 AGENTS.md 章节要写同样的映射，所以**取 key 的逻辑必须抽成一个导出函数**，两边共用，不能各写一份。

**已实现形态**（`src/main/libs/openclawMcpServers.ts`，main 进程内即可满足两个消费者；renderer 不需要算 key）：

```ts
export function resolveMcpServerKey(input: { serverKey?: string | null; name: string }): string
```

- 有 `serverKey` → 用它；无 → 用 `name`。
- 候选含非 ASCII → `mcp-<md5 前 8 位>`（避免中文名塌成连字符后撞名）。
- 其余 → `toOpenClawServerKey()`，逐条镜像 OpenClaw 的 `sanitizeToolFragment`：非法字符换 `-`、不以字母开头补 `mcp-`、截至 30 字符。**因此产出的 key 一定是 OpenClaw 的固定点**，config key 与工具名前缀逐字相同。
- `isOpenClawSafeKey()` 把这条契约暴露出来，测试直接断言它。

**Bug 顺手修复**：`buildOpenClawMcpServers` 原来在 key 重复时直接覆盖 —— 两个连接器会静默丢一个。现在 `uniqueServerKey()` 用与 OpenClaw 相同的 `-2`/`-3` 后缀算法消解，且顺序一致。

### 5.2 AGENTS.md 托管段

**新增章节**（英文，与既有 `MANAGED_*_POLICY_PROMPT` 一致；模型读英文没有歧义）：

```markdown
## Connected Data Sources

These connectors are installed and enabled on this desktop. The tools of each
connector are named with the prefix shown below.

- 纷享销客 — tools are named `fxiaoke__*`
- 腾讯文档 — tools are named `txdoc__*`

When the request is about data a connector covers, call that connector's tools
directly instead of searching the web or answering from memory.

If a connector listed here has no tools in your available tool list, say so
instead of guessing.
```

**最后一段是关键**：它让「连接器授权过期被跳过」这件事**不需要提示词知道实时状态** —— 模型发现工具不在，照实说，UI 那头再弹卡片（§5.4）。

**实现要点：**

- 新模块，建议 `src/main/libs/mcpAgentPolicyPrompt.ts`，导出 `buildConnectedSourcesPrompt(servers: ResolvedMcpServer[]): string | undefined`。
  - 无连接器 → 返回 `undefined` → 不 push 章节。
  - key 用 §5.1 的共用函数算，保证和 `mcp.servers` 里的键**逐字一致**。
- 在 `syncAgentsMd` 第 3126 行之后 push：`sections.push(connectedSourcesPrompt)`（`undefined` 时跳过）。
- 数据来源：`this.getResolvedMcpServers?.()`（依赖注入见 `src/main/main.ts:2230`）。这批是**真正进了配置**的连接器 —— 被跳过的（gateway token 不可用）不在其中，正好符合「不列出不可用的」。
- ⚠️ **长度预算**：`openclaw/src/agents/bootstrap-budget.ts` 对 AGENTS.md 有截断预算，超了会变成「AGENTS.md was truncated; read the full AGENTS.md before relying on scoped policy.」。每连接器一行足够短，但需要给数量设上限（建议 30 条，超出写「and N more」）。
- ⚠️ **只列已启用的**：`getResolvedMcpServers` 返回的正是 enabled 的那批，符合 D2。

### 5.3 输入框连接器选择器

**两个入口，一个列表**（用户确认）：

1. **`+` 菜单里的「连接器」项** —— 悬停即展开子浮层，与「使用技能」项同款交互；浮层开在菜单右侧（`asSubmenu`）。
2. **工具栏独立按钮**，紧跟在套件图标（`KitsButton`）后面 —— 点击直接打开同一个列表，浮层向上展开。任务明确时不必先开菜单。

`ConnectorPickerPopover` 用 `asSubmenu` 区分两套定位与高度计算（右侧展开 / 向上展开）；`ConnectorButton`（`src/renderer/components/mcp/ConnectorButton.tsx`）承载工具栏入口，结构镜像 `KitsButton`。

**浮层内容**（对照用户原型图）：

| 行状态 | 右侧控件 |
|---|---|
| 已启用 + 正常 | 开关（开） |
| 已启用 + 授权过期 | 开关（开）+ 行内红字「授权已过期」 |
| 已安装 + 未启用 | 开关（关） |
| 已安装 + 缺凭证 | 「连接」动作 |

- 行首：连接器图标 + 名称。
- 底部固定：「管理连接器」→ 打开 MCP 管理页。
- 连接器数 ≥ 3 时显示搜索框（复用 `KitsPopover` 的 `MIN_SEARCHABLE_KIT_COUNT` 惯例）。
- 浮层打开时对已启用连接器做一次实时探测（`mcp:listTools`），拿「已连接 / 授权失效 / 未连接」状态 —— 与 `McpManager` 详情弹窗的口径一致（`src/renderer/components/mcp/mcpConnectionStatus.ts` 的 `connectionLabelKey`）。

**数据与状态：**

- `mcpSlice.servers`（`src/renderer/store/slices/mcpSlice.ts`）**目前只有 `McpManager.tsx` 会写入**。选择器不能假设它有数据：打开时自己 `mcpService.loadServers()` 并 dispatch `setMcpServers`。
- 订阅 `mcp:onChanged`（`src/main/preload.ts:191`）保持新鲜。
- 启用走 `mcp:setEnabled`，连接走 `mcp:startAuth`（`src/main/preload.ts:178-185`）。

**⚠️ 启用 = 重启网关。** 启用会改 `mcp.servers` → `openclawConfigSync` 判定 `restartImpact: Restart`（`src/main/libs/openclawConfigSync.ts:2646`）。若此刻有 turn 正在流式输出，重启会被推迟到会话空闲（`src/main/main.ts:2417` 的 `scheduleDeferredGatewayRestart`，3 秒轮询；`activeTurns` 只在正在输出时非空）。

→ **UI 必须让用户看见这件事**：启用后给出「正在重启以加载工具」的提示，否则用户会以为是自己消息写错了。

### 5.4 授权失效重连卡片

**位置**：输入框**上方**（WorkBuddy 的位置），不是浮层里。

**触发条件**：某个**已启用**的连接器，最近一次探测结果是 unauthorized。

**探测时机（实现定案）**：**没有定时器，也没有后台轮询**。横幅在服务器列表每次刷新后重探已启用连接器（`setMcpServers` 之后，即挂载、启用/停用、以及授权成功后）。这个时机天然覆盖"刚授权完要自己消失"，也避免把 `listTools`（一次真实往返，会铸/轮换 gateway token，成员资格被撤销时还会触发登出）变成聊天页的周期性开销。用既有的 `mcp:listTools` IPC（`src/main/mcp/mcpToolCatalog.ts`），`status === 'unauthorized'` 即命中。注意**横幅必须自己加载服务器列表**：`mcpSlice.servers` 只有管理页和选择器打开时才写入，冷启动时是空的，等它们来填横幅就永远不出现。

**卡片内容**（已实现为输入框上方的横幅，每个失效连接器一条）：

```
⚠  连接器需要重新连接
   纷享销客CRM — 授权已过期
   [重新连接]  [×]
```

- 「重新连接」→ 既有鉴权流（`mcp:startAuth` + `mcp:onAuthFlowRequested` → `McpAuthModal`）。
- 重连成功 → 重新探测 → 成功则卡片消失。
- 不自动重试失败的那一步（§3.2）。

**文案复用**：既有 i18n 键已覆盖大部分词汇 —— `mcpDetailConnection`（连接）、`mcpAuthConnect`（连接）、`mcpDetailConnectionUnauthorized`（授权失效）、`mcpDetailConnectionFailed`（未连接）、`mcpDetailConnectionDisabled`（已停用）。新文案只需补「连接器需要重新连接」「重新连接」「×」几个键。

### 5.5 i18n

- 渲染进程：`src/renderer/services/i18n.ts`，**zh 与 en 都要加**。
- 新键建议：`coworkConnectors`（连接器）、`mcpManageConnectors`（管理连接器）、`mcpConnectorAuthExpired`（授权已过期）、`mcpConnectorReconnect`（连接器需要重新连接）、`mcpConnectorReconnectAction`（重新连接）。
- 用户原型图用「授权已过期」，既有键是「授权失效」——**沿用既有键的文案**，保持全应用一致。

---

## 6. 测试

按 `AGENTS.md` 的 Vitest 约定（`.test.ts` 与源码同目录，`npm test`）。

**纯逻辑（必测）：**

- `resolveMcpServerKey`：`serverKey` 优先；无 `serverKey` 时回退 `name`；ASCII 名原样；中文名 → md5 形式稳定。
- `buildConnectedSourcesPrompt`：无连接器 → `undefined`；有连接器 → 章节里出现的 key 与 `buildOpenClawMcpServers` 产出的键**逐字一致**（这一条是整个映射正确性的护栏）。
- 选择器状态映射：enabled × authStatus → 行的右侧控件。

**组件（渲染进程）：**

- 选择器浮层：列出已安装连接器；未启用行的开关触发 `setEnabled`；缺凭证行触发 `startAuth`；底部入口跳转管理页。
- 授权失效卡片：探测返回 unauthorized 时出现；重连成功后消失。

**改动文件的 lint：**

```bash
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <files>
```

---

## 7. 留给实现者的

- **`serverKey` 落到 config key 之后，老连接器的工具名会变。** 发布说明要提一句；`agents.<id>.tools.allow/deny` 里写过旧 `mcp-<hash>__*` 模式的用户需要自己改（MixWork 自己不写这种模式）。
- **连接器清单的显示名用记录上的 `name`**（企业连接器是中文优先）。不要在章节里改写显示名 —— 用户在管理页看到的名字必须和这里一致。
- **AGENTS.md 章节是英文**，与既有 `MANAGED_*_POLICY_PROMPT` 保持一致；连接器显示名保持原样（中文没问题）。
- **章节里不写「内部 / 外部」分级**，只写「连接器覆盖的数据」与「网页 / 记忆」的对立。
- **选择器的启用动作要提示「正在重启以加载工具」**（§5.3 末尾）。
- **卡片不做自动重试**（§5.4）。
- **`mcpSlice` 可能没有数据**，选择器要自己加载（§5.3）。
- 现有企业市场 / 管理台 / 桌面 OAuth 的行为**一律不动**（相关 spec 见文首）。

---

## 8. Builder-check 结论（实现后回填）

一份独立评审在动工前读了这份文档，提出七个问题。三个由实现本身回答，四个在实现中定案：

| # | 问题 | 结论 |
|---|---|---|
| 1 | AGENTS.md 该写 config key 还是 OpenClaw 的工具前缀？两者不等（`My Server` → `My-Server`，`12306` → `mcp-12306`） | **改 key 本身**，让两者恒等（§5.1 的 `toOpenClawServerKey` 镜像 + `isOpenClawSafeKey` 契约测试）。评审指出的失败模式（模型去找 `My Server__query` 找不到，静默退回网页搜索）正是本设计要消灭的那个 |
| 2 | key 撞名怎么办？现状是静默覆盖、丢连接器 | **加后缀**，用与 OpenClaw 相同的 `-2`/`-3` 算法与顺序（`uniqueServerKey`）。已修 |
| 3 | 鉴权弹窗只在管理页里，聊天侧开不出来 | **抽出共享宿主**：`mcpAuthSlice` + `McpAuthHost`，`App.tsx` 挂一次；`McpManager` 净减约 25 行 |
| 4 | 选择器挂在哪些输入框？ | **两个都挂**。`CoworkPromptInput` 是同一个组件，首页与会话页共用；`remoteManaged` 下仍然隐藏 |
| 5 | 每次挂载都探测每个已启用连接器，代价能不能接受？`listTools` 会铸/轮换 gateway token，成员资格被撤销时还会触发登出 | **不做定时/后台探测**。选择器打开时探测已启用项；失效横幅在**服务器列表每次刷新时**重探（`setMcpServers` 之后），这时机天然覆盖"刚授权完"和"刚启用"，不需要额外节流 |
| 6 | "正在重启以加载工具"具体给用户什么？没有 renderer 推送（`syncMcpConfig` 是 fire-and-forget） | **行内提示**，启用后在该行显示 6 秒。不追踪重启完成，也不阻塞发送 |
| 7 | renderer 要不要自己算 key（`createHash` 在沙箱里不可用）？ | **不需要**。两个消费者（config builder、AGENTS.md 章节）都在 main 进程，函数留在 `src/main/libs/` |

评审另外核实了文档里其余的可核对断言（`shouldExposeMcpTool` 匹配原始工具名、`server_key` 的格式与唯一性、`name_zh ?? name_en`、`syncAgentsMd` 覆盖 main 与每个 agent workspace、`refreshResolvedServersCache` 在 `sync()` 之前、既有 i18n 键、`mcpSlice` 只由 `McpManager` 写入、`SkillsPopover asSubmenu` 模式），均属实。AGENTS.md 的 20,000 字符预算充裕，30 条上限不需要调 `bootstrapMaxChars`。

### 实现中额外发现并处理的

- **两个入口**：先是只做了 `+` 的子浮层；用户后续要求加一个工具栏图标（紧跟套件图标）直接打开同一个选择器，并让 `+` 里的「连接器」项悬停即展开。已按此实现。
- **`McpManager` 里两个函数（`getPromptContextAnalyticsParams` / `getPromptInputSource`）在遥测移除后已无读者**，只在一个错误的依赖数组里出现过。文件被本次改动触碰，按门禁要求随改动一并删除。
- **`mcpConnectorAuthExpired` 用「授权已过期」而非既有的「授权失效」**，与用户给的原型图一致；管理页仍用既有键。
