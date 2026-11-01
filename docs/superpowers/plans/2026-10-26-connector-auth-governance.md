# 连接器鉴权治理 实现计划

> For agentic workers: 本计划按任务顺序执行，每步先写失败测试。规格见
> `docs/superpowers/specs/2026-10-26-connector-auth-governance-design.md`（含第 8 节 R1–R6 裁决）。

**Goal:** 企业端只声明校验方式与治理信息；桌面端持有用户凭据；组织凭据模式诚实标注为暂未开放；工具白名单真正生效。

**Tech Stack:** Hono + Postgres（pglite 测试）/ React 19 控制台 / Electron + React 桌面端 / Vitest。

## 全局约束
- 无数据库迁移；`config_json` 新增字段即可。
- 用户可见文案必须 `t()` + zh/en 两套。
- 不改 OpenClaw 源码；只写 `openclaw.json` 的原生 `toolFilter`。

---

### Task 1 — 服务端：公共视图下发 `toolFilter`
文件：`enterprise_server/src/models/connectorView.ts`、`enterprise_server/tests/routes/mcpMarketplace*.test.ts`（或新增 view 测试）
接口：`ConnectorPublicView.toolFilter?: { include?: string[]; exclude?: string[] }`
- [x] 测试：全启用 → 无 `toolFilter`；部分禁用 → `{include:[启用]}`；全部禁用 → `{exclude:[全部]}`；工具列表为空 → 无。
- [x] 实现 `toolFilterFor(tools)` 纯函数并在 `mapPublicConnector` 使用。
- [x] 跑 `npx vitest run tests/routes/mcpMarketplace*.test.ts`。

### Task 2 — 控制台：表单与校验
文件：`web/src/pages/mcpManage/ConnectorAuthFields.tsx`、`ConnectorDrawer.tsx`、`ConnectorToolPermissions.tsx`、`web/src/i18n.ts`
- [x] `user-oauth`：渲染 callbackUrl/authorizeUrl/tokenUrl/clientId/scopes；无 clientSecret。
- [x] `sso`：无 ssoApp、无 ssoClientSecret。
- [x] `shared-key`/`client-creds`：顶部预留提示（"需企业端代理注入，当前版本桌面端不可用"）。
- [x] `validate()`：`user-oauth` 必填 authorizeUrl/tokenUrl；不再要求任何 secret；`client-creds` 仍要求 clientId+clientSecret（模拟/预留）。
- [x] 工具面板加"在桌面端更新配置后生效"说明。
- [x] i18n zh/en 增删文案。
- [x] 测试：字段在/不在、校验消息。

### Task 3 — 桌面主进程：持久化 + 写入 toolFilter + 安装即派生状态
文件：`src/main/mcp/mcpStore.ts`、`src/main/libs/openclawConfigSync.ts`、（类型）`src/renderer/types/mcp.ts`
- [x] `McpServerRecord`/`McpServerFormData`/`McpConfigJson` 增 `toolFilter?` 与 `enterpriseAuthMode?`。
- [x] `createServer` 用 `deriveAuthStatus` 写 `auth_status`。
- [x] `buildOpenClawMcpServers`：`toolFilter` 非空时写 `entry.toolFilter`。
- [x] 测试：store 往返；配置同步写/不写；空 include 不写。

### Task 4 — 桌面端 UI：组织凭据状态 + 更新配置
文件：`src/renderer/components/mcp/enterpriseAuthMode.ts`、`McpCard.tsx`、`McpManager.tsx`、`McpServerFormModal.tsx`、`src/renderer/services/i18n.ts`、`src/main/auth/enterpriseClient.ts`、`src/renderer/types/mcp.ts`
- [x] 删除 shared-key/client-creds → Bearer 映射；新增 `isOrgManagedAuthMode()` 与 `isOrgManagedInstalled()`（记录持久化值优先，旧记录用 serverKey 比对目录）。
- [x] 企业卡片：组织凭据 → 徽标 + 无安装/授权入口；已安装 → "更新配置"（编辑模式预填目录最新值，保留凭据）。
- [x] `toolFilter` 随安装/更新写入本地记录。
- [x] i18n zh/en。
- [x] 测试：映射、判定、表单预填。

### Task 5 — 桌面端：成员提交表单
文件：`src/renderer/components/mcp/SubmitConnectorForm.tsx`、i18n
- [x] `user-oauth` 收端点 + clientId，不收 secret；移除 `shared-key`/`client-creds` 选项。
- [x] 测试：可选项集合、提交体形状。

### Task 6 — 回归
- [x] 桌面：`npm test`、`npm run compile:electron`、`npx eslint --max-warnings 0 <touched>`
- [x] 服务端/控制台：各自 `npx vitest run`（服务端按文件跑）、`tsc`

## 执行记录（2026-10-26）

- Task 4 命名偏差：计划里写的 `isOrgManagedInstalled()` 最终实现为
  `isOrgManagedServer(record, catalogAuthModeByServerKey)` —— 同一个判断（记录
  持久化的模式优先，旧记录用 `serverKey` 比对目录），名字说明它接受的是"记录"，
  而不是"已安装"这个事实本身。
- R3 落地：安装/更新时 `McpServerFormData` 直接带 `enterpriseAuthMode` 与
  `toolFilter`，写入 `config_json`，无迁移。
- 新增裁决（计划未覆盖）：企业连接器的"更新配置"必须能**清除**旧的工具白名单。
  目录用"没有 filter"表达"全部工具"，所以 `updateServer` 在企业更新
  （`enterpriseAuthMode` 显式传入）时以目录为准：传空即清除。测试
  `an enterprise update that now allows every tool clears the stored filter`。
- 顺带修复：`src/renderer/types/electron.d.ts` 的 `skills.download/upgrade` 少了
  `catalogVersion` 参数，导致 `tsc`（即 `npm run build`）失败 —— 上一轮技能更新的
  遗留，一行修正。
- 桌面回归：`npm test` 384 文件 / 3796 通过；`npm run compile:electron` 通过；
  `tsc` 通过；改动文件 ESLint 0 warning。
- 服务端回归：`connectorView` 25、`mcpConnectors` 21、`mcpSubmissions` 11（按文件跑，
  整包会触发沙箱 fd 上限）；控制台 79 文件 / 579 通过，`tsc` 通过。

## 追加任务 — 认证方式收敛为 4 项（2026-10-28）

对应规格 D7。

- [x] 新增 `enterprise_server/web/src/pages/mcpManage/connectorAuthModeOptions.ts`：
      `SELECTABLE_AUTH_MODES`（4 项）、`DATA_ONLY_AUTH_MODES`、`isSelectableAuthMode`、
      `normalizeLegacyAuthMode`（sso → user-oauth）、`readOAuthFields`（读 `sso*` 或裸字段）。
- [x] `ConnectorConnConfig.tsx`：下拉只列 4 项；存量 `client-creds` 以禁用项显示当前值。
- [x] `ConnectorAuthFields.tsx`：删除 `sso` 分支（`sso` 现在走 user-oauth 的字段）。
- [x] `ConnectorDrawer.tsx`：打开存量 `sso` 记录时按 `user-oauth` 呈现并复制 `sso*` 字段；
      表单状态与 `buildAuthConfig` 删除 `sso*` 字段。
- [x] `connectorValidation.ts`：`AuthFieldValues` 去掉 `sso*` 字段。
- [x] i18n：新增 `mcp.authMode.retired` / `mcp.authMode.merged`；删除 `mcpDrawer.auth.sso*` 字段文案。
- [x] 测试：`connectorAuthModeOptions.test.ts`（7）、`ConnectorConnConfig.test.tsx`（3），
      更新 `connectorValidation.test.ts` 与 `ConnectorAuthFields.test.tsx`。

裁决：服务端枚举六值不动（必须能读/PATCH 存量记录），退役只发生在"创建入口"——控制台下拉与
成员提交表单，二者都已排除 `client-creds` / `sso`。

## 追加任务 — 运行期字段：超时接线、重试删除（2026-10-28）

对应规格 D8。

- [x] 控制台：新增 `enterprise_server/web/src/pages/mcpManage/connectorRuntimeOptions.ts`
      （`normalizeTimeoutSeconds` / `readTimeoutSeconds` / `timeoutAuthConfigEntry`，
      上下限 5–300 秒）；`ConnectorConnConfig.tsx` 超时可留空、删除「重试次数」；
      `ConnectorDrawer.tsx` 删除 `retryCount` 状态与提交；`buildAuthConfig` 写入
      `timeoutSeconds`（留空时为显式 `null`）。
- [x] 服务端：`connectorView.ts` 公共视图新增 `timeoutSeconds`；`mcpConnectors.ts`
      的 `mergeAuthConfig` 认 `null` = 清除该字段（否则清空超时会被合并成"保留旧值"）。
- [x] 桌面端：`mcpStore.ts` 持久化 `timeoutSeconds`（企业更新以目录为准，目录没有即清除）；
      `mcpRuntime.ts` 透传；`openclawMcpServers.ts` 写 `mcp.servers.<key>.timeout`（仅正数）；
      `McpServerFormModal.tsx` 安装/更新时带上目录的超时；`types/mcp.ts`、
      `types/electron.d.ts` 补齐类型（含此前漏掉的 `toolFilter`/`enterpriseAuthMode`）。
- [x] 测试：`openclawMcpServers.test.ts`（写/不写/垃圾值）、`mcpStore.test.ts`（往返、
      普通更新保留、企业更新清除）、`connectorRuntimeOptions.test.ts`（8）、
      `connectorView.test.ts`（3）、`mcpConnectors.test.ts`（null 清除）。

裁决（计划未覆盖）：
- **清空超时必须能被真正清除。** 服务端的 `mergeAuthConfig` 是"合入"语义：请求里
  不带的键不会删掉存储里的旧值。管理员清空超时若只是"不发这个键"，旧数字会一直留在
  连接器里，桌面端也会一直带着它跑。因此约定：请求里显式给 `null` = 删除该键
  （仅限非秘密字段；秘密字段的空值语义不变，仍然是"保留密文"）。
- **重试次数直接删除，不做"先存着"。** 它没有任何下游落点，留着就是一个改了也没人看
  的输入框。
- **API Key 请求头名称不动。** 它已全链路接通且成员无法补救写错的头名；本轮不引入
  新的清空语义（它仍然是"留空 = 不覆盖"）。

已知行为变化（须知会）：旧控制台把「超时时间」默认写成 30（表单默认值），所以**存量连接器的
`auth_config` 里已经躺着 `timeoutSeconds: 30`**。接线之后这个值会真的生效——桌面端安装/更新该
连接器时写入 `timeout: 30`，比运行时默认的 60 秒更严。控制台现在不再替管理员编造默认值（新连接器
留空 = 运行时默认），存量值原样保留、管理员可在表单里清空（清空 = 发 `null` = 真删除）。

回归：桌面 `npm test` 384 文件 / 3802 通过；`npm run compile:electron` 与 `tsc` 通过；
改动文件 ESLint 0 warning。控制台 82 文件 / 597 通过，`tsc` 通过。服务端按文件跑：
`connectorView` 28、`mcpConnectors` 22、`mcpSubmissions` 11、`mcpMarketplaceScope` 8、
`mcpMarketplaceAdmin` 14 全通过；`tsc -p tsconfig.build.json` 通过。

## 追加任务 — 成员凭据模式下的测试连接与工具权限（2026-10-28）

对应规格 D9。起因是产品方的一句追问："用户密钥和用户 OAuth 情况下，测试连接和工具权限
有意义吗？服务端都没有用户密钥和 OAuth 授权，如何测试连接并获取工具？"

排查结论：服务端只在 `shared-key`（组织的密钥）与 `none`（不需要凭据）下有东西可以带去
握手；成员模式下一个凭据都不带 → 必然 401 → 被记成 `failed`（管理员修不好的假故障），
而工具清单只由成功的探针填充 → 成员模式下清单永远为空 → 工具权限无物可管，策略静默地
等于"上游给什么放什么"。

- [x] 服务端：`mcpConnectors.ts` 新增 `UNAUTHENTICATABLE_MODES`（`user-key` / `user-oauth` /
      `sso` / `client-creds`），`Authorization` 头只留给 `shared-key`；这些模式的 401 记为
      `needs_user_auth`、响应 `status: 'needs-user-auth'` + `needsUserAuth: true`（仍是已决
      结果，不是 HTTP 错误）；`connectorCfgSchema` 增加 `tools`，创建连接器可带声明清单；
      探针合并不再把人工声明的工具标记为 `removed`。
- [x] 服务端：`connectorView.ts` 的 `toolFilterFor` 分两路——清单含"没有 `syncedAt`"的条目
      （人工声明）时是显式白名单（`include` = 清单全部名称，`exclude` = 被关掉的）；纯发现
      清单维持原语义。
- [x] 控制台：新增 `connectorToolManifest.ts`（`parseToolNames` / `declaredToolNames` /
      `mergeToolEntries`）与 `connectorAuthModeOptions.serverCanDiscoverTools`；
      `ConnectorToolPermissions.tsx` 增加声明输入框、"手工"标签与服务端无法发现时的说明；
      `ConnectorDrawer.tsx` 表单状态增加 `toolManifestText`，发布/存草稿的工具清单 =
      发现 ∪ 声明（含逐项开关）；`ConnectorBasicInfo.tsx` 的测试结果分三态，
      `needs-user-auth` 显示为警告。
- [x] 控制台：`api/connectors.ts` 的 `ConnectorInput` 增加 `tools?`，测试接口返回类型收窄为
      `'connected' | 'failed' | 'needs-user-auth'`；i18n 新增 6 组中英文案。
- [x] 测试：服务端 `connectorView`（+4 声明清单形状，既有 4 条补上 `syncedAt` 以坐实
      "发现出来的"语义）、`mcpConnectors`（+2：成员模式的 `needs-user-auth`、声明工具不被
      判死）；控制台 `connectorToolManifest.test.ts`（16）、`ConnectorToolPermissions.test.tsx`
      （6）、`ConnectorBasicInfo.test.tsx`（2）、`connectorAuthModeOptions.test.ts`（+2）。

裁决（计划未覆盖）：
- **成员模式的 401 不是失败，是"端点可达"。** 端点应答了，这已是服务端能学到的全部；记成
  `failed` 只会让管理员去改一个企业端根本改不了的东西。`none` / `shared-key` 的 401 仍然是
  真失败——那说明模式与上游的要求对不上。
- **人工声明 = 白名单，不是补充。** 服务端枚举不出上游有哪些工具，管理员写下的清单就是
  桌面端可见的范围。因此声明清单翻译成显式的 `include`，上游没写下来的工具到不了 agent。
  全部关掉时 `include` 与 `exclude` 同时给出（OpenClaw 的 `include` 要求 `min(1)`，空数组
  表达不了"一个都不给"）；只用 `exclude` 会把没声明的上游工具放行，与意图相反。
- **"发现出来的"与"人工声明的"用 `syncedAt` 区分。** 服务端给"自己列出来的"工具盖戳，
  没戳的就是人工声明的。无需新字段、无需迁移。
- **人工声明的工具不会被探针判死。** 服务端从没列过它，谈不上"已下线"；否则一次成功的
  探针会把管理员的声明静默抹掉。
- **桌面端不上报工具清单（本轮明确不做）。** 真正握着成员凭据的是桌面端（OpenClaw 才是
  MCP 客户端），工具清单本来可以由桌面端授权后回传——但那是一条跨机通路（上报接口 +
  桌面端推 `tools/list`）。在那之前成员模式的清单以人工声明为准；已记入规格的"已知缺口"。

回归：桌面 `npm test` 384 文件 / 3802 通过（2 skipped）——本轮未改桌面文件。控制台 85 文件 /
623 通过，`tsc --noEmit` 通过。服务端按文件跑：`connectorView` 32、`mcpConnectors` 26、
`mcpMarketplaceScope` 8、`mcpMarketplaceAdmin` 14 通过；全量 182 个测试文件逐个跑，无失败；
`tsc -p tsconfig.build.json` 通过。

## 追加任务 — OAuth 回调地址对齐桌面端（2026-10-28）

对应规格 D10。起因是产品方的追问："用户 OAuth 模式下，为什么要有 OAuth 回调地址/授权地址/
Token URL/Client ID/scope 每个字段分别是什么用途？在 Enterprise server 端设置这些字段有
什么必要？"

逐字段查清之后的结论：**授权地址 / Token URL / Client ID / scope 是 OAuth 客户端档案**
（公开元数据，桌面端是 PKCE 公共客户端，没有 secret，企业端可以统一持有并下发）；**回调地址
是 redirect_uri**，必须在上游 IdP 登记，且必须与桌面端实际发出的完全一致。

查出的失真：控制台显示 `https://oauth.mixcwork.cn/mcp/callback`（"回调落企业端"的网关设计），
桌面端实际发 `http://localhost:<随机端口>/callback`。三者对不上——这个值服务端不读、也不
下发；随机端口在上游登记不了（Okta / Azure AD 严格匹配 redirect_uri）；桌面端绑 `127.0.0.1`
却发 `localhost`（浏览器解析成 `::1` 时 code 送不到）。

- [x] 服务端：新增 `models/connectorOauthRedirect.ts`——回调地址的唯一出处
      （`MCP_OAUTH_REDIRECT_PORT`，默认 53232 → `http://127.0.0.1:<port>/callback`；非法
      端口回落到默认值）；公共视图的 `oauth` 增加 `redirectUri`（仅 `user-oauth`）；
      `GET /admin/mcp-connectors/settings` 增加 `oauthRedirectUri`。
- [x] 控制台：表单状态去掉 `callbackUrl`、不再写进 `auth_config`；回调地址改为只读展示服务端
      下发的值（复制按钮保留）；`MCPManagePage` 把设置接口的值传给抽屉；i18n 标签与说明改为
      "在上游 OAuth 服务商处登记该地址"（中英）。
- [x] 桌面端：`genericOauthFlow.ts` 增加 `MCP_OAUTH_REDIRECT_PORT_DEFAULT` 与
      `resolveRedirect(configured)`（只接受 `http` + 回环 + 显式端口，主机名归一为
      `127.0.0.1`），回调服务器改绑固定端口并发出 `http://127.0.0.1:<port>/callback`，
      `buildTokenExchangeBody` 带 `redirect_uri`；`McpOAuthEndpoint` 增加 `redirectUri?`，
      `mcpAuthModalHelpers` 改用共享类型（此前内联复制了一份 OAuth 配置类型）。
- [x] 测试：服务端 `connectorOauthRedirect.test.ts`（4）、`connectorView`（+1：`redirectUri`
      只对 `user-oauth` 生效，存量记录里的 `callbackUrl` 不作数）、`mcpConnectors`（设置接口）；
      控制台 `ConnectorAuthFields`（+3：显示服务端的值、只读、无值时为空、其它方式不出现）；
      桌面端 `genericOauthFlow.test.ts`（+6：回环解析、拒收服务端回调、拒收无端口地址、
      `localhost` 归一、token 请求带 `redirect_uri`）。

裁决（计划未覆盖）：
- **回调地址是桌面端的回环地址，企业端只"生成"不"接收"。** "回调落企业端、由企业端代换
  token"是网关项目的一部分（规格 §7）；本轮控制台不再展示那种地址，正是为了不让管理员去
  登记一个用不上的 URL。
- **固定端口而不是临时端口。** 严格匹配 redirect_uri 的 IdP 永远登记不了临时端口；本仓库
  对 SSO（53231）与 xAI（56121）已经是固定端口，本轮沿用同一做法，端口可由
  `MCP_OAUTH_REDIRECT_PORT` 调整。
- **主机名用回环字面量 `127.0.0.1`。** 桌面端绑的是 IPv4 回环，`localhost` 在 IPv6 优先的
  机器上会被解析到 `::1`，code 就送到了没人监听的套接字上。
- **企业端只生成、不存储。** 控制台曾把这个值写进 `auth_config`，而没有任何代码读它——存
  一份没人读的值就是漂移的来源；现在只有服务端的一个常量说了算。
- **换 token 时带上 `redirect_uri`（RFC 6749 §4.1.3）。** 授权请求里带了，换 token 时就要
  带且必须一致；缺了会被严格匹配的 IdP 判 `invalid_grant`。
- **`sso` 的公共视图不带这个字段。** 组织 SSO 走的是服务端自己的 `/auth/sso/callback`，
  与连接器回调无关。
- **`user-oauth` 不再写 `clientSecret`。** 桌面端是公共客户端，永远用不上 secret；控制台
  的 `user-oauth` 分支本来就没有 secret 输入框，那行写入是死代码，顺手删掉。

回归：桌面 `npm test` 384 文件 / 3808 通过（2 skipped）；`tsc`、`tsc -p electron-tsconfig.json`
通过；改动文件 ESLint 0 warning。控制台 85 文件 / 626 通过，`tsc --noEmit` 通过。服务端
全量 182 个测试文件逐个跑，无失败；`tsc -p tsconfig.build.json` 通过。

## 追加任务 — OAuth 发现与动态客户端注册（2026-10-28）

对应规格 D11。起因是一个真实的 MCP 配置：

```json
{"mcpServers":{"crm-mcp":{"type":"http","url":"https://open.fxiaoke.com/mcp/nuobo2026/ai"}}}
```

管理员手上只有这一个 URL。D10 之后回调地址对上了，但 `user-oauth` 仍要求管理员自己填
`authorizeUrl` / `tokenUrl` / `clientId`——三个桌面端根本不需要人类知道的值。MCP 生态里越来
越多的服务按规范让客户端自己发现授权服务器（RFC 9728 / 8414）并动态注册客户端（RFC 7591）；
旧实现下这类连接器在桌面端**永远授权不了**：`buildSaveCredentialPayload` 在缺端点时返回
null，弹窗只有一句"尚未在管理端配置"。

- [x] 桌面端：新增 `src/main/mcp/oauthDiscovery.ts`——先看 `/.well-known/oauth-protected-resource`
      （路径后缀式在前、源站式兜底）读 `authorization_servers`，再按 RFC 8414 §3.1 取授权服务器
      元数据（well-known 段插在 issuer 路径之前）与 OIDC 各变体，兜底用 401 的
      `WWW-Authenticate: Bearer resource_metadata="…"`，最后以 MCP 源站自身当 issuer；
      只接受 https（回环 http 例外）；元数据只声明 plain 却声明了 `code_challenge_methods_supported`
      的明确拒收；失败时用 `OAuthDiscoveryError.tried` 列出试过的地址。
- [x] 桌面端：新增 `src/main/mcp/oauthRegistration.ts`——RFC 7591 公开客户端注册（
      `token_endpoint_auth_method: 'none'`、`redirect_uris: [<回环回调>]`），200/201 收，
      上游错误码透出，没 `client_id` 或发回机密客户端都拒收。
- [x] 桌面端：`genericOauthFlow.ts` 的 `GenericOauthConfig` 三项改可选并加 `resourceUrl`；
      新增 `resolveOauthEndpoints`（管理端值逐字段优先、缺的由发现补齐、缺 URL 缺注册端点都有
      明确报错）；`runGenericOauthFlow` 改成**先解析再绑回调端口**，并通过 `onResolved` 把
      结果交给调用方。
- [x] 桌面端：`mcpAuthFlows.ts` 把连接器自己的 `record.url` 作为发现锚点（渲染进程那份是
      组织档案，不带 URL）；注册出的 `clientId` 写回记录，发现到的端点**不写**；发现/注册走
      Electron `net.fetch`（企业桌面经系统代理出网、走 OS 证书链，Node 的 fetch 两者都不认）。
- [x] 桌面端 UI：`mcpAuthModalHelpers` 不再因缺端点拒绝提交（护栏保留：企业连接器永不落到
      企查查）；新增 `oauthUsesDiscovery`；`McpAuthModal` 在会走发现时显示提示，按钮文案改
      「去授权」；`submitConnectorDraft` 的 `user-oauth` 必填清空且空值不写入。
- [x] 服务端/控制台：`missingAuthField`、`connectorValidation` 对 `user-oauth` 不再要求任何
      字段；`pickPublicOauth` 在 `user-oauth` 下即使空配置也下发对象（至少带 `redirectUri`）；
      抽屉顶部加"留空即由桌面端自动发现并注册"，三项去掉必填星号；中英文案同步。
- [x] 测试：桌面端 `oauthDiscovery.test.ts`（14）、`oauthRegistration.test.ts`（6）、
      `genericOauthFlow.test.ts`（+7：逐字段覆盖、缺 URL、缺注册端点、已有 clientId 不注册、
      注册结果上报）、`mcpAuthFlows.test.ts`（+4：发现锚点取自记录、注册写回、发现不落盘）、
      `mcpAuthModalHelpers.test.ts`（+3）；服务端 `connectorView`（空配置仍给 `oauth`）、
      `mcpConnectors`（三项全空可创建）；控制台 `connectorValidation`、`ConnectorAuthFields`。

裁决（计划未覆盖）：
- **管理端三项降级为"可选覆盖"，而不是删掉。** 上游不提供元数据的老服务、或管理员要求固定
  某一个应用（上游做过白名单登记）时，这三个字段仍是唯一出路；删掉等于把已经能用的配置打断。
- **逐字段覆盖，不是整组替换。** 只填了 token URL 的企业，其余两项应当由发现补齐；按组判断
  会逼它把三项填满。
- **注册结果必须持久化，发现结果必须不持久化。** `client_id` 被 AS 绑了 redirect_uri，重授权
  时换一个会被判 `invalid_client`；端点则相反，上游搬家以后缓存就变成了新的故障源。
- **管理端给了 `clientId` 就绝不注册。** 那可能是管理员在上游登记过、带额外策略的应用。
- **注册只发公开客户端。** 桌面端没有 secret 可发；上游回一个 confidential client 说明它
  根本不支持这个模式，继续走只会在换 token 时失败。
- **不做 RFC 7592（动态注册的更新/删除）。** 每次授权复用同一个 id 已经够用，新增状态管理
  换不来收益；真要换，删掉本地记录即可重新注册。
- **只支持 S256。** 桌面端本来就只有 S256 的实现，接受 plain 等于开一个注定失败的窗口。
- **发现与注册也走 `net.fetch`。** 与 `openOauthFlow` 加载页面用的是同一个网络栈，避免"页面
  能打开、元数据拿不到"这种企业代理下的半残状态。
- **失败信息带试过的地址。** 这类问题几乎只能靠管理员拿 URL 自己去试，报一句"发现失败"没用。

回归：桌面 `npm test` 386 文件 / 3843 通过（2 skipped）；`tsc -p tsconfig.json`、
`tsc --noEmit -p electron-tsconfig.json` 通过；改动文件 ESLint 0 warning。控制台 85 文件 /
627 通过，`tsc --noEmit` 通过。服务端 `connectorView`（33）、`mcpConnectors`（26）逐个跑通过，
`tsc -p tsconfig.build.json` 通过。

## 追加任务 — 连接器授权窗口放行第三方资源（2026-10-28）

对应规格 D12。真机反馈：纷享销客连接器在桌面端点「去授权」→ 授权页（环境选择）正常 →
点「前往登录」→ **空白页**。主进程日志给出根因：

```
[OAuthFlow] blocked non-IdP request to a9.fspage.com in MCP OAuth Authorization (etld1="fxiaoke.com")
```

`openOauthFlow` 给所有 OAuth 窗口装了 SSO 的第三方封锁。SSO 的 IdP 是内置已知的，CDN 可以
写表；连接器的授权服务器是发现来的，登录页把资源放在哪个 CDN 无法预知——`a9.fspage.com`
不在表里，资源请求全被取消，页面渲染成白纸。

- [x] 桌面端：`oauthBrowserFlow.ts` 新增 `OAuthNetworkPolicy`（`idp` / `open`）与纯函数
      `decideOauthRequest(url, policy, state)`；`openOauthFlow` 增加 `networkPolicy` 选项，
      默认 `idp`（SSO 四条调用路径不变）；`open` 策略下放行任意 https、永远放行回环、拒绝
      允许清单之外的明文 http、不安装 `onBeforeRedirect`；阻塞日志按 reason 区分。
- [x] 桌面端：`genericOauthFlow.ts` 的连接器授权窗口传 `networkPolicy: Open`。
- [x] 测试：`oauthBrowserFlow.test.ts` 新增 `decideOauthRequest` 八例（两种策略对照
      `a9.fspage.com`、明文 http 拦截、钉死 http 的 IdP 仍放行、回环、非 http 协议、畸形
      URL）与两个窗口级用例（`open` 放行且不装 redirect 监听；默认策略仍拦截）。

裁决（计划未覆盖）：
- **只改连接器窗口，不动 SSO 窗口。** SSO 的封锁是有意义的（IdP 已知、清单可维护），而且
  四条 SSO 调用路径都在用；一起去掉等于用一个真机故障换来另一个可维护性倒退。
- **`open` 不是"完全不设限"：明文 http 仍拒绝。** 授权窗口里唯一会外泄的就是凭据，明文是
  唯一必须守的线；https 的第三方资源没有同样的风险等级。
- **允许清单先于策略判断。** 否则管理员把 IdP 钉成 `http://` 的内部地址时，`open` 反而把它
  自己拦了——这是老行为里能用的配置，不能因为新策略坏掉。
- **判定抽成纯函数。** 过滤器跑在 Electron 的 webRequest 回调里，只有把它拿出来才能不建窗口
  地测两种策略的差别；顺带让日志能按 reason 分类。
- **不把 `fspage.com` 写进内置 CDN 表。** 那是给已知 IdP 用的；连接器的 IdP 是开放集合，
  补一个表项只能治一个上游，下个连接器还会白屏。

回归：桌面 `npm test` 386 文件 / 3853 通过（2 skipped，新增 10）；`tsc -p tsconfig.json`、
`tsc --noEmit -p electron-tsconfig.json` 通过；改动文件 ESLint 0 warning。

## 追加任务 — 授权码只兑换一次（2026-10-28）

对应规格 D13。D12 之后纷享销客能登录了，但回到桌面端弹"探测失败：缺少认证字段"。日志：

```
[OAuthFlow] probe failed … oauth token exchange failed: token已下发，请勿重复下发！   （一秒钟几十条）
```

`openOauthFlow` 在每次 `did-finish-load` 和每个 2 秒轮询都调一次探针，而 `cb.wait()` 是
resolve-once 的：code 一到，所有挂起的轮询同时拿到同一个 code，各自 POST 一次换 token。授权码
一次性，重复的那批全被拒；更糟的是它们和真正成功的那次并发，失败者关窗把流程以错误结掉，
赢家拿到的 token 被丢弃——IdP 那边码已经烧掉。

- [x] 桌面端：`genericOauthFlow.ts` 新增 `createTokenExchangeProbe(deps)`——对 `exchange`
      记忆化（无论轮询多少次只 POST 一次），失败每次上报 `onError` 但只关一次窗；
      `runGenericOauthFlow` 改用它；HTTP 非 2xx 时把响应体的 `error` / `error_description`
      拼进错误，不再只有裸状态码。
- [x] 桌面端 UI：`mcpAuthModalHelpers` 新增 `probeLabelKey`（`missing-save` → 新增的
      `mcpAuthFailedSave`「授权未完成」）与 `showsProbeDetail`（失败一律展示底层消息）；
      `McpAuthModal` 红条改用它们，中英文案同步。
- [x] 测试：`genericOauthFlow.test.ts` +4、`mcpAuthModalHelpers.test.ts` +3。

裁决（计划未覆盖）：
- **单飞放在探针里，不改 `openOauthFlow` 的轮询契约。** SSO 的四个调用方依赖"每次加载都探一次"
  来找 token 回传点；换掉这个契约的收益为零、风险不小。换 token 的一次性约束只属于连接器这条路径。
- **失败仍然关窗。** 授权窗停在原地对用户没有意义；关窗的副作用是 `openOauthFlow` 会以错误
  结算，正好把 `exchangeError` 原样交给上层。
- **`missing-save` 换标签而不是加分支。** 它和"缺字段"是两件不同的事；换一个标签比在 UI 上
  再堆一层特判更干净，也让 i18n 能各自表述。
- **失败明细一律显示。** 之前恰好把最需要原因的三种情况藏了起来；主进程给的消息本身是安全的
  （不含凭据值），没有理由不显示。

回归：桌面 `npm test` 386 文件 / 3860 通过（2 skipped）；两个 tsconfig 通过；改动文件 ESLint 0 warning。

---

## 追加任务 — 详情页的连接状态与工具清单（2026-10-28）

对应规格 D14。详情弹窗只有「状态（启用/停用）/ 传输 / 来源」。「启用」说的是本地开关，不是
「连得上」：token 可能早被作废、上游可能连不上，界面上看不出来。同时这个 MCP 到底挂了哪些
工具也看不到——D9 的工具清单只存在于管理端的人工声明里，桌面端一次都没问过服务器本人。

- [x] 主进程：新增 `src/main/mcp/mcpToolCatalog.ts`——`listServerTools(record)` 直接对目标
      服务器说 MCP：`initialize`（带协议版本与 clientInfo）→ 记下 `mcp-session-id` →
      `notifications/initialized` → `tools/list`（跟随 `nextCursor`，至多 5 页）。响应体既可能是
      普通 JSON 也可能是 SSE `data:` 帧，`parseJsonRpcMessages` 两种都认。401/403 →
      `unauthorized`，其余失败 → `connect-error`，缺凭据 → `missing-credential`；永不抛异常。
      stdio 传输另走一条 spawn 路径（8s 超时）。
- [x] 主进程：`mcpAuthProbe.ts` 导出 `checkMissingCredential`（工具读取套用同一条规则），
      新增只读 IPC `mcp:listTools`（`McpIpcChannel.ListTools`）：取记录 → 读清单 → 原样返回，
      不写 `auth_status`、不同步 OpenClaw。preload / `electron.d.ts` / `mcpService.listTools` 打通。
- [x] 渲染层：新增 `mcpConnectionStatus.ts`——`connectionLabelKey(enabled, state)` 给出
      已停用 / 检测中 / 已连接 / 授权失效 / 未连接 / 未检测；`connectedTools(state)` 只在成功时
      给出清单。`McpDetailModal` 加 `children` 插槽；`McpManager` 在详情打开时对启用的服务器
      做一次 `listTools`，信息行新增「连接」，成功时渲染工具清单区块。
- [x] i18n：`mcpDetailConnection*` / `mcpDetailTools*` / `mcpSourceEnterprise` 中英各一套。
- [x] 修正「来源」：企业市场安装走同一套内置安装器（`isBuiltIn` 也是 true），先看内置标记会把
      企业连接器全显示成「内置市场」。新增 `mcpSource.ts` 的 `sourceLabelKey`：`serverKey` →
      企业市场，`isBuiltIn`/`registryId` → 内置市场，否则自定义。
- [x] 测试：`mcpToolCatalog.test.ts` 12 条、`mcpConnectionStatus.test.ts` 4 条、`mcpSource.test.ts` 3 条、`handlers.test.ts` +4
      （含一条通道确实被注册的回归——详情页曾因此报 `No handler registered for 'mcp:listTools'`）。

裁决（计划未覆盖）：
- **状态是现场问出来的，不读 `auth_status`。** 存下来的值只代表上次探测那一刻；详情页要回答的
  是"现在能不能用"。代价：每次打开详情多一个网络往返（停用的服务器不探测）。
- **桌面端自己说 MCP，不经过 OpenClaw。** 详情页不能依赖运行时是否已加载该服务器；OpenClaw
  仍是执行工具的一方，这里只是只读检视。
- **只读通道，不改任何状态。** 探测不写 `auth_status`、不触发配置同步——看一眼工具列表不该有
  副作用。代价：详情页的「已连接」可能和卡片上的授权点不一致（前者是此刻，后者是历史），
  这是刻意的：两者本来就是不同的问题。
- **失败分支看 `outcome.ok`，不看消息是否为空。** 之前那种"没消息就当空清单"的写法会把
  401 伪装成"该 MCP 未返回任何工具"，正好把用户最需要的信息藏掉。
- **`sse` 传输暂时复用 streamable-POST 路径。** 旧版 SSE 握手没有实现；上游只支持旧版时详情页
  显示「未连接」，已记入规格 §7 已知缺口。

回归：桌面 `npm test` 389 文件 / 3883 通过（2 skipped）；`tsc -p tsconfig.json` 与
`tsc -p electron-tsconfig.json` 均通过；改动文件 ESLint 0 warning。

---

## 追加任务 — 去掉 OAuth scope 的硬编码厂商预设（2026-10-28）

对应规格 D15。控制台的 scope 选择器挂着七组写死的预设（OIDC / Gmail / Graph / Salesforce /
GitHub / Slack / Jira），全是原型样例，和实际连接器无关；说明文案还承诺"自动拉取 scope 列表"，
而这从未实现。

- [x] 控制台：`ConnectorAuthFields.tsx` 删除 `scopeGroups()` 预设、搜索框与弹层，改成自由输入
      （回车/失焦加入）+ 已选标签（× 移除）；空输入失焦静默，不再弹"请输入 scope 名称"。
- [x] i18n：删除 62 行已无引用的 `scopeGroup.*` / `scopeDesc.*` / `scope.search` / `scope.add` /
      `scope.required`；`scopes.hint` 改为"留空 = 服务商默认"。
- [x] 测试：`ConnectorAuthFields.test.tsx` +2（不再出现 Gmail/Slack 等预设、输入 `offline_access`
      回车即提交、空输入失焦不提交）。

裁决（计划未覆盖）：
- **字段保留。** 留空时授权请求不带 `scope`，服务商按默认范围授权——这是多数情况；但
  `offline_access` 这类必须显式申请的 scope 没有别的入口，删掉字段就删掉了能力。
- **只删预设，不动提交链路。** 表单状态到 `auth_config.scopes` 再到桌面端授权 URL 的路径不变，
  已有连接器里存的 scope 继续生效。
- **不实现"自动拉取 scope"。** 服务商元数据里的 `scopes_supported` 通常把 admin/full 一起列出来，
  照单全收等于请求过宽；控制台也没有 discovery 通道（发现发生在桌面端）。文案改成事实，比加一个
  半成品功能更诚实。

回归：控制台 `vitest run` 85 文件 / 629 通过；`tsc -p tsconfig.json` 通过。
