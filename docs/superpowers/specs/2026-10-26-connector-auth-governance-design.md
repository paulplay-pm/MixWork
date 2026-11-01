# 连接器鉴权治理（Enterprise ↔ 桌面端）设计

日期：2026-10-26
状态：已确认（用户确认四项改动方向）

## 1. 意图

连接器（MCP）的鉴权责任必须只有一处：

- **企业端 = 声明与治理**：定义"怎么校验"（方式、端点、clientId、header 名）、谁能用（组织/部门/人）、治理元数据。
- **桌面端 = 授权与持有**：员工在自己的机器上授权，凭据只落本机。

用户明确：**"组织买一份、全员共用同一个凭据"的场景真实存在，但很少，且目前没有人在等**。因此组织级凭据保留为将来的能力，但不建数据通路，两端都不再假装它可用。

> **2026-10-28 更新：** 这条"不建数据通路"的决定已被 `shared-key` 的企业端网关落地所取代（见 D4 的更新说明）。`client-creds` 仍按本节处理。

## 2. 现状盘点（问题所在）

| 位置 | 现状 | 问题 |
| --- | --- | --- |
| 企业端表单 `ConnectorAuthFields.tsx` | `user-oauth` 的 `clientSecret` 标 `*` 必填 | 桌面端是 PKCE 公共客户端，交换 token 时 `token_endpoint_auth_method=none`（`src/main/mcp/genericOauthFlow.ts:58`），该 secret 永不被使用 |
| 企业端表单 | `sso` 的 `ssoApp`（oidc/飞书/钉钉/企业微信）选择器 | 公共视图不下发 `ssoApp`，端点也不因它改变 —— 纯装饰 |
| 桌面端 `enterpriseAuthMode.ts` | `shared-key`/`client-creds` → `McpAuthMethod.Bearer` | 授权弹框要求用户粘贴一个他不可能有的 token；企业端存的密钥永远不下发 → 永久"待配置" |
| 桌面端 `openclawConfigSync.ts` | MCP 条目只写 url/headers | 管理端的逐工具勾选（`mcp_connectors.tools[].enabled`）不下发、不生效 |
| 公共视图 `connectorView.ts` | `mapPublicConnector` 只给 `toolCount` | 同上 |

已经正确的部分（不改）：企业端密钥加密存储（`vault/connectorSecret.ts`）、公共视图永不下发 `authConfig`/`__enc__*`、按部门/人范围过滤（`scopeMatches` + 子树展开）、四步授权后桌面端探活与 OpenClaw 配置同步。

## 3. 决策

**D1 — 用户级方式不再收集 `clientSecret`。**
`user-oauth` / `sso` 的表单不再渲染 `clientSecret` / `ssoClientSecret` 输入框。服务端校验保持现状（`missingAuthField` 在公共端点齐全时本就不要求 secret），已存的密文原地保留、不迁移、不下发。

**D2 — `user-oauth` 必须有完整的 authorize/token 端点。**
既然不再有 secret 兜底，端点缺失就没有任何可用的授权路径。控制台 `validate()` 为 `user-oauth` 增加 `authorizeUrl`/`tokenUrl` 必填（服务端 `missingAuthField` 已有等价约束）。

**D3 — `sso` 去掉 `ssoApp` 选择器与 `ssoClientSecret`。**
只保留 `ssoAuthorizeUrl` / `ssoTokenUrl` / `ssoClientId`（+ 可选 scopes）。厂商原生 wire format 需要独立的 OAuth 适配器，本轮不做；等真有飞书/钉钉 MCP 时再补。

**D4 — 组织凭据模式改为诚实的"预留"。**

> **2026-10-28 更新：`shared-key` 已可用。** 企业端网关落地后，组织统一密钥由
> 服务端在出站时注入，桌面端只持有一个 90 天的网关服务令牌（`McpGateway`），
> 密钥永不下发。实现见 `docs/superpowers/specs/2026-10-28-mcp-shared-key-auth-design.md`，
> 计划见 `docs/superpowers/plans/2026-10-28-mcp-shared-key-auth.md`。`client-creds`
> 仍为预留（并已从下拉中退役，见 D7）。

`shared-key` / `client-creds` 保留在数据模型与方式下拉里，但：
- 企业端表单顶部出现提示："需要企业端代理注入凭据，当前版本桌面端不可用。"
- 桌面端企业目录卡片显示徽标"组织统一授权 · 暂未开放"，安装按钮禁用并给出原因；
- 不再映射成 Bearer、不再计入"待授权"数量 —— 用户不会看到任何可点的授权入口。
- 删除 `enterpriseAuthMode.ts` 中这两个模式到 `Bearer` 的映射。

**D5 — 工具白名单真正生效。**
- 公共视图新增 `enabledTools?: string[]`（仅 `enabled && !removed` 的工具名，非秘密）。
- 桌面安装时写入本地记录；`buildOpenClawMcpServers` 在非空时写入 `mcp.servers.<key>.toolFilter.include`（OpenClaw 原生字段，`zod-schema.ts:396`；空数组不写，zod 要求 `min(1)`）。
- 控制台工具面板注明"更改在桌面端重新安装该连接器后生效"。

**D6 — 数据模型不动。** 本轮无迁移：`auth_mode` 六值、`auth_config`、`secret_meta`、vault 全部保留，供将来的企业端代理使用。

**D7 — 认证方式收敛为 4 项（2026-10-28 追加）。**
下拉只剩 `none` / `shared-key` / `user-key` / `user-oauth`：
- `client-creds` **退役**：不再可选。它和 `shared-key` 一样是组织凭据，没有代理就永远用不上，留着只是让管理员点一个看不见效果的开关。存量记录仍能打开与保存。
- `sso` **并入 `user-oauth`**：同一套 PKCE 流程、同样三个端点，只是历史上多了一个 `sso*` 字段前缀。存量 sso 记录打开时按 `user-oauth` 呈现（`sso*` 字段自动复制到裸字段），保存写 `user-oauth`；发布时走既有的"认证方式变更"确认弹窗，管理员看得见这次变更。
- 服务端枚举六值保持不动：服务端必须还能读、还能 PATCH 存量记录（控制台每次保存都会带上 `authMode`）。创建连接器的入口只有控制台与成员提交表单，二者都已排除这两个值。
- 桌面对存量 `sso` 记录照旧可用（`sso` → OAuth），对存量 `client-creds` 记录仍显示"组织统一授权 · 暂未开放"徽标。

**D8 — 超时时间真正生效，「重试次数」删除（2026-10-28 追加）。**
控制台连接器表单原先有四个运行期字段，本轮逐个查清它们在代码里的落点，结论是两个留、两个走：
- **超时时间（秒）留，并接线到底。** OpenClaw 原生支持 `mcp.servers.<key>.timeout`（秒，`zod-schema.ts:378`；`getRequestTimeoutMs` 换算成毫秒，默认 60s）。此前该字段只存在控制台的 `auth_config` 里：公共视图不下发、桌面端不接收、OpenClaw 配置里也没有——是一个永远不生效的输入框。现在贯通：控制台写入 `auth_config.timeoutSeconds` → 公共视图下发 `timeoutSeconds` → 桌面端落本地记录 → `buildOpenClawMcpServers` 写 `mcp.servers.<key>.timeout`。留空 = 不写 = 用运行时默认值。
- **重试次数删。** 它没有任何落点：OpenClaw 没有对应的 MCP 字段，桌面端也没有重试逻辑。工具调用该不该重试、退避多少、是否幂等，是 agent 运行时的判断，不是连接器的属性。
- **API Key 请求头名称、工具权限保持原样。** 前者已全链路接通（控制台 → 公共视图 → 桌面预填 → 成员密钥按该头注入），且写错头名成员无法补救；后者已在上一轮通过 `toolFilter` 真正生效。

**D9 — 成员凭据模式下的「测试连接」与「工具权限」（2026-10-28 追加）。**
`user-key` / `user-oauth`（以及已退役的 `sso` / `client-creds`）的凭据属于成员：密钥在成员自己的桌面上填写，OAuth token 在成员自己的桌面上通过 PKCE 取得。企业端手里**没有任何凭据**可以拿去握手，于是两件事同时失真：
- **测试连接**：服务端的探针（`initialize` + `tools/list`）只对 `shared-key`（组织的密钥）与 `none`（不需要凭据）有东西可带。成员模式下一个凭据都不带 → 必然 401 → 被记成 `failed`。这是管理员在企业端**修不好**的"缺陷"，假故障。
- **工具权限**：工具清单只由一次成功的探针填充，成员模式下永远是空的 → 工具权限面板无物可管，而连接器的工具策略静默地等于"上游给什么就放行什么"。

决策：
1. **测试连接降级为可达性检查。** 成员凭据模式下的 401 不再是失败：端点应答了，这已是服务端能学到的全部。记为 `last_test_status='needs_user_auth'`，控制台显示**警告**（不是红色报错）："接口可达，但服务端没有该连接器的凭据：成员在桌面端自行授权。"它依旧是一个已决结果（resolved result），不是 HTTP 错误，与其他探针结果同形。`none` / `shared-key` 的 401 仍是真失败——那说明模式与上游要求对不上。
2. **工具清单改为人工声明。** 控制台工具面板增加"手工声明工具清单"输入框（每行一个名称；也可直接粘贴 JSON 数组或上游的 `tools/list` 结果）。声明出来的工具存进连接器的工具清单，但**不带 `syncedAt`**——服务端给"自己列出来的"工具盖这个戳，没有戳的就是人工声明的。
3. **声明即白名单。** 服务端把含人工声明的清单翻译成显式的 OpenClaw 过滤器：`include` = 声明出来的全部名称，`exclude` = 管理员关掉的那几个。于是上游那些管理员没写下来的工具永远到不了 agent。全部关掉时 include 与 exclude 同时给出（OpenClaw 的 `include` 要求 `min(1)`，空数组无法表达"一个都不给"）。纯发现出来的清单保持原语义（全部启用就不写过滤器）。
4. **人工声明的工具不会被探针判死。** 服务端从没列过它，谈不上"已下线"；探针合并时不再给它打 `removed`。否则管理员的声明会被一次成功的探针静默抹掉。

**D10 — 「OAuth 回调地址」必须就是桌面端真正发出的那个（2026-10-28 追加）。**
`user-oauth` 的五个字段分两类：
- **OAuth 客户端档案**：`authorizeUrl`（用户去哪里登录/授权）、`tokenUrl`（桌面端拿 code 去换 token 的地址）、`clientId`（桌面端在 IdP 处的公开身份）、`scopes`（申请的权限范围）。这四个都是**公开元数据**——桌面端是 PKCE 公共客户端（`token_endpoint_auth_method=none`，没有 secret），所以它们不保密，企业端可以统一持有并下发。
- **`callbackUrl`（redirect_uri）**：IdP 把授权 code 送回来的地址。它必须**在上游 IdP 处登记**，也必须**与桌面端实际发出的完全一致**。

本轮查出的失真：控制台显示的回调地址是 `https://oauth.mixcwork.cn/mcp/callback`（"回调落企业端"的机密客户端网关设计，见 §7 的待办），而桌面端实际发的是 `http://localhost:<随机端口>/callback`。三者对不上：
1. 这个值**根本没下发**——`pickPublicOauth` 只下发 `authorizeUrl`/`tokenUrl`/`clientId`/`scopes`，服务端自己也不读它；
2. 桌面端的**随机端口无法在上游登记**——Okta、Azure AD 这类严格匹配 redirect_uri 的 IdP 会直接 `redirect_uri_mismatch`；
3. 桌面端绑定的是 `127.0.0.1`，发出去的却是 `localhost`——浏览器把 `localhost` 解析成 `::1` 时，code 会送到没人监听的套接字上。

决策：
1. **企业服务端是回调地址的唯一出处。** 新增 `models/connectorOauthRedirect.ts`：`http://127.0.0.1:<port>/callback`，端口由 `MCP_OAUTH_REDIRECT_PORT` 决定（默认 53232）。**固定端口**而不是临时端口——严格匹配 redirect_uri 的 IdP 永远登记不了临时端口；本仓库对 SSO（53231）与 xAI（56121）已经是这个做法。
2. **控制台只展示、不存储。** 回调地址从组织设置接口取（`GET /admin/mcp-connectors/settings` 增加 `oauthRedirectUri`），仍���只读 + 可复制，它的用途就是"把这个地址登记到上游 IdP"。表单不再把它写进 `auth_config`——存一份没人读的值就是漂移的来源。
3. **桌面端按服务端给的值绑端口、发 redirect_uri。** 只接受 `http` + 回环地址 + 显式端口；企业端那种 `https` 的服务端回调它绑不了，直接拒绝并回落到自带默认端口（服务端没下发时的兜底）。
4. **换 token 时带上 `redirect_uri`**（RFC 6749 §4.1.3：授权请求里带了，换 token 时就要带且必须一致）。
5. **主机名统一用回环字面量 `127.0.0.1`**，不再用 `localhost`。
6. `sso` 的公共视图**不带**这个字段——组织 SSO 走的是服务端自己的 `/auth/sso/callback`，与连接器回调无关。


**D11 — 连接器 OAuth 由桌面端自行发现与注册（2026-10-28 追加）。**
D10 解决的是"回调地址两端一致"，但它默认管理员知道上游 IdP 的 `authorizeUrl` / `tokenUrl` / `clientId`。MCP 生态里越来越多的服务（例如纷享销客的 MCP 服务）只给一个 MCP URL，客户端按 MCP 的 OAuth 规范自行发现授权服务器并动态注册客户端（RFC 8414 / 9728 / 7591）。旧实现下这类连接器在桌面端**永远授权不了**：`buildSaveCredentialPayload` 在缺端点时直接返回 null，弹窗只显示"该连接器的 OAuth 登录方式尚未在管理端配置"。

决策：
1. **管理端三项都变成可选覆盖。** `authorizeUrl` / `tokenUrl` / `clientId` 不再是 `user-oauth` 的必填（服务端 `missingAuthField`、控制台 `connectorValidation`、成员提交表单三处同步放开）。填了就以填的为准——**逐字段覆盖**，不是整组替换。
2. **发现顺序：RFC 9728 → RFC 8414 / OIDC → 401 挑战。** 新增 `src/main/mcp/oauthDiscovery.ts`：先取 `<MCP URL>/.well-known/oauth-protected-resource`（路径后缀式在前、源站式兜底）读 `authorization_servers`；再取授权服务器的 `/.well-known/oauth-authorization-server`（RFC 8414 §3.1：well-known 段插在 issuer 路径**之前**）与 OIDC 的各变体；都拿不到时用 `WWW-Authenticate: Bearer resource_metadata="…"` 指向的文档；最后以 MCP 源站自身作为 issuer 兜底。
3. **只信任 https（回环 http 例外）。** 发现与注册用到的每个 URL——包括元数据里给出的端点——都必须是 https，或回环上的 http；否则跳过并在错误里说明。整条链路不发送任何凭据。
4. **只支持 S256。** 元数据声明了 `code_challenge_methods_supported` 但不含 S256 时明确报错，而不是开一个注定失败的授权窗。
5. **没有 clientId 时动态注册（RFC 7591）。** 新增 `src/main/mcp/oauthRegistration.ts`，请求体固定为公开客户端：`token_endpoint_auth_method: 'none'`、`redirect_uris: [<回环回调>]`、`grant_types: ['authorization_code']`、`response_types: ['code']`。若上游发回的是机密客户端（`token_endpoint_auth_method` 非 `none`），拒绝——桌面端没有 secret 可发。
6. **注册结果必须复用，发现结果不复用。** `client_id` 是有状态的（AS 把 redirect_uri 绑在它上面），授权前写回本地记录的 `oauthConfig.clientId`，重新授权时不再注册；发现到的端点每次重新读取、不落盘——上游可以搬家。
7. **管理端给了 clientId 就绝不注册。** 那可能是管理员在上游登记过、带额外策略的应用；替它再注册一个等于绕过它。
8. **走 Chromium 网络栈。** 发现/注册请求用 Electron `net.fetch` 而不是 Node 的 `fetch`：企业桌面通常经系统代理出网，证书也走 OS 信任链，Node 的 fetch 两者都不认。
9. **失败要说清楚。** 认证弹窗从"未配置"死胡同改成"将自动发现并注册，点击后打开授权页"，OAuth 模式下按钮文案为「去授权」；失败时的错误带上试过的 URL（`OAuthDiscoveryError.tried`）。

**D12 — 连接器 OAuth 窗口不再套用 SSO 的第三方请求封锁（2026-10-28 追加）。**
D11 让桌面端能自己发现并注册，第一个真实连接器（纷享销客）就一路走到了授权页。但点「前往登录」之后是**空白页**：主进程日志里是连成串的

```
[OAuthFlow] blocked non-IdP request to a9.fspage.com in MCP OAuth Authorization (etld1="fxiaoke.com")
```

`openOauthFlow` 把 SSO 的"身份面"过滤策略用在了所有 OAuth 窗口上：只放行 IdP 的 eTLD+1（加一张内置的 CDN 表：feishucdn / alicdn / mscnd…）和回环。SSO 可以这样做，因为它的 IdP 是**已知且内置**的，CDN 能提前写进表里。连接器的授权服务器是**运行期发现**的，登录页把 JS/CSS 放在哪个 CDN 上无法预知——`a9.fspage.com` 不在任何表里，于是所有资源请求被取消，页面渲染成一片白。这不是降级，是硬失败：用户没有任何出路，也看不懂发生了什么。

决策：
1. **过滤策略变成窗口的一个选项**（`OAuthNetworkPolicy`：`idp` / `open`），默认仍是 `idp`，SSO 四条调用路径行为不变。
2. **连接器窗口用 `open`**：https 任意主机放行，回环永远放行；**不在允许清单里的明文 `http` 一律拒绝**（凭据只能走加密通道），非 http(s) 协议照旧放行。
3. **允许清单在策略之前判断**，所以管理员手工钉了一个 `http` IdP 仍然可用；`open` 只是不再拦"清单之外但走 https"的主机。
4. **`open` 下不安装 `onBeforeRedirect` 的增长逻辑**：没有清单要长，少一个每请求都跑的监听。
5. **判定抽成纯函数 `decideOauthRequest(url, policy, state)`**，返回 `{ kind: 'allow' } | { kind: 'deny', reason: 'malformed' | 'insecure-http' | 'third-party' }`，不需要构造 BrowserWindow 就能测；阻塞日志按 reason 分开，排查时一眼能看出是"明文"还是"第三方"。
6. **安全性由窗口沙箱兜底**，不是这份清单：窗口是 `sandbox: true`、无 preload、无 node，加载任意网页的权限不高于一个浏览器标签页；清单原本要挡的"隐私"（统计、广告）在登录页面前不值一次授权失败。

**D13 — 授权码只能兑换一次（2026-10-28 追加）。**
D12 之后纷享销客的登录页正常了：用户输完账号密码，窗口自动关闭，回到桌面端，然后弹出一个红条
**"探测失败：缺少认证字段"**。日志里是同一个错误刷了一屏：

```
[OAuthFlow] probe failed … oauth token exchange failed: token已下发，请勿重复下发！
```

根因在 `openOauthFlow` 的探针契约上：它在每次 `did-finish-load` 和每个轮询周期（2s）都调用一次
`probe`，而 `cb.wait()` 是 resolve-once 的——code 一到，**所有挂起的轮询同时拿到同一个 code**，
于是每个都 POST 一次换 token。授权码是一次性的（RFC 6749 §4.1.2），第二次就被告知"已下发"。
更糟的是这些失败请求和真正成功的那次并发：失败者调用 `win.close()`，`closed` 处理器先把流程
以错误结掉，赢家的 token 连返回的机会都没有——IdP 那边码已经烧掉，用户这边一无所获。

决策：
1. **换 token 单飞。** 新增 `createTokenExchangeProbe(deps)`：把 `waitForCode` / `exchange` /
   `closeWindow` / `onError` 注入进去，内部对 `exchange` 记忆化——无论被轮询多少次，POST 只有
   一次；后续轮询拿到的是同一个 Promise（成功即同一个 token，失败即同一个错误）。
2. **失败只关一次窗。** 每个轮询都会看到失败，但 `closeWindow` 只调用一次；`onError` 每次都
   上报，让 `runGenericOauthFlow` 能把这个具体错误原样抛给用户。
3. **HTTP 失败带上 IdP 的理由。** 原来是裸的 `HTTP 400`；现在尽力解析响应体，拼成
   `HTTP 400 (invalid_grant …)`——状态码本身无法区分"端点配错"和"授权码问题"。
4. **`missing-save` 有自己的文案（`mcpAuthFailedSave`：授权未完成）。** 它代表"根本没拿到
   凭据"，不是"某个字段你没填"；复用一个"缺少认证字段"的标签，会把 IdP 的拒绝伪装成用户的
   输入问题——这一次就是这么被误导读的。
5. **失败一律显示底层消息。** 原来 `unauthorized` / `missing-credential` / `missing-save`
   三种恰好把 `message` 藏起来了，而这三种才是最需要原因的地方。现在除成功外都拼在红条后面。

**D14 — 详情页的连接状态与工具清单（2026-10-28 追加）。**
详情弹窗原来只有「状态（启用/停用）」「传输」「来源」三行。启用不等于连得上：凭据可能已经过期，
上游可能连不上，而用户看到的永远是"已启用"。同时这个 MCP 到底暴露了哪些工具也看不到——
D9 里的工具清单只活在管理端的人工声明里，桌面端一次都没问过服务器本人。

决策：
1. **连接状态是现场问出来的，不是读 `auth_status`。** 详情打开时对这台服务器做一次
   `initialize` → `tools/list`（带上已保存的凭据）：它此刻答了话 = 已连接；401/403 = 授权失效；
   其它失败 = 未连接。存下来的 `auth_status` 只记录"上一次探测是什么时候"，可能已经是几小时前的事。
2. **桌面端自己说 MCP，不经过 OpenClaw。** 详情页必须对"运行时有没有加载它"无感，答案必须是
   "这个端点上现在挂着什么"。OpenClaw 仍然是真正执行工具的一方，这里只是一次只读检视。
3. **缺凭据时不发请求。** 复用鉴权探测的 `checkMissingCredential`（本次导出），把"OAuth token
   missing"之类的真实原因直接显示出来，而不是先打一个必定 401 的请求。
4. **工具清单只在成功时展示，失败有失败的样子。** 加载中 / 失败（附原因）/ 空清单 / 有工具，
   四种状态各自成文；失败绝不能退化成"该 MCP 未返回任何工具"——所以渲染分支看的是
   `outcome.ok`，不是错误消息是否为空。工具名等宽显示，描述截到 200 字符、界面 `line-clamp-2`：
   一个返回三百个工具的服务端不该把弹窗撑爆。
5. **分页跟随 `nextCursor`，最多 5 页。** 永不停止分页的服务端不能把弹窗挂死。响应体既可能是
   普通 JSON 也可能是 SSE `data:` 帧（streamable HTTP 两种都合法），两种都接受。
6. **停用的服务器不探测**，直接显示「已停用」。读取走只读 IPC `mcp:listTools`：不写
   `auth_status`、不触发 OpenClaw 配置同步。看一眼工具列表不该改变任何状态。
7. **「来源」先看 `serverKey`，再看内置标记。** 企业市场的安装走的是同一套内置安装器，记录上
   `isBuiltIn` 同样是 true——先看它会把每个企业连接器都显示成「内置市场」。企业安装的独有标记是
   `serverKey`（手填表单没有这个字段），所以判定顺序是：有 `serverKey` → 企业市场；否则
   `isBuiltIn`/`registryId` → 内置市场；否则 → 自定义。

**D15 — OAuth scope 不再提供硬编码的厂商预设（2026-10-28 追加）。**
控制台的 scope 选择器挂着七组写死的预设：OIDC 四项、Gmail/Drive 四项、Microsoft Graph 四项、
Salesforce、GitHub、Slack、Jira。它们是原型时期的样例，与管理员自己的连接器毫无关系——纷享销客
要求的 scope 一个都不在里面——排成一列只会让人以为"必须从这里选一个"。同一处的说明还承诺
"生产环境将根据服务商 OAuth discovery 文档自动拉取 scope 列表"，而这件事从未实现：发现发生在
桌面端，且只取端点，不取 `scopes_supported`。

决策：
1. **字段保留，预设删除。** scope 是真实参数：留空时授权请求不带 `scope`，由服务商按默认范围
   授权（多数 MCP 服务端如此）；需要时必须能填，典型例子是 `offline_access`——不申请就拿不到
   refresh_token。删掉整个字段等于删掉这个能力。
2. **改成自由输入 + 已选标签。** 输入框回车或失焦即加入，点 × 移除。不再有搜索框和分组列表：
   分组只剩一个时，那套交互（搜索、弹层、滚动）只是噪声。
3. **说明文案改成事实。** 不再承诺自动拉取；写明"留空 = 不发送 scope，服务商用默认范围"，
   并给出唯一真正常见的例子（`offline_access`）。
4. **空输入不报错。** 输入框同时是 blur 处理器，点进点出不该弹"请输入 scope 名称"。

## 4. 变更清单

### 服务端 `enterprise_server/src`
- `models/connectorView.ts`：`ConnectorPublicView` 增加 `enabledTools?: string[]`；`mapPublicConnector` 填值（`tools.filter(t => t.enabled && !t.removed).map(t => t.name)`，空数组 → 省略）。
- `models/connectorView.ts`（D8）：`ConnectorPublicView` 增加 `timeoutSeconds?: number`，取自 `auth_config.timeoutSeconds`（非正数 → 省略）。
- `routes/mcpConnectors.ts`（D8）：`mergeAuthConfig` 认 `null` = 清除该字段（管理员清空超时 → 存储里真的没有这个键，而不是保留旧值）。
- `routes/mcpConnectors.ts`：不改校验逻辑；确认 `missingAuthField` 注释里"confidential client 用于服务端网关"的措辞与 D4 一致。
- 测试：`tests/analytics`-风格的路由测试补齐 `enabledTools` 的三种情形（无工具 / 全启用 / 部分禁用）。
- `models/connectorView.ts`（D9）：`toolFilterFor` 分两路——清单里只要有**没有 `syncedAt`** 的条目（人工声明），过滤器就是显式白名单（`include` = 清单全部名称，`exclude` = 被关掉的）；纯发现清单维持原语义。
- `routes/mcpConnectors.ts`（D9）：`UNAUTHENTICATABLE_MODES`（`user-key` / `user-oauth` / `sso` / `client-creds`）= 服务端没有凭据可带的模式；这些模式的 401 记为 `needs_user_auth`（响应 `status: 'needs-user-auth'`），并把 `Authorization` 头只留给 `shared-key`。
- `routes/mcpConnectors.ts`（D9）：探针合并时不再把人工声明的工具标记为 `removed`；`connectorCfgSchema` 增加 `tools`，创建连接器时可带声明清单。
- 测试：`tests/models/connectorView.test.ts` 覆盖声明清单的三种过滤器形状；`tests/routes/mcpConnectors.test.ts` 覆盖 `needs-user-auth` 与"声明工具不被判死"。
- `models/connectorOauthRedirect.ts`（D10，新建）：企业端 OAuth 回调地址的唯一出处——`MCP_OAUTH_REDIRECT_PORT`（默认 53232）→ `http://127.0.0.1:<port>/callback`；非法端口回落到默认值。
- `models/connectorView.ts`（D10）：公共视图的 `oauth` 增加 `redirectUri`（仅 `user-oauth`；`sso` 不带）。
- `routes/mcpConnectors.ts`（D10）：`GET /admin/mcp-connectors/settings` 的响应增加 `oauthRedirectUri`，供控制台展示。
- 测试：`tests/models/connectorOauthRedirect.test.ts`（新建）、`tests/models/connectorView.test.ts`（`redirectUri` 只对 `user-oauth` 生效）、`tests/routes/mcpConnectors.test.ts`（设置接口返回回调地址）。
- `models/connectorView.ts`（D11）：`oauth` 的 `authorizeUrl`/`tokenUrl`/`clientId` 改为可选；`user-oauth` 即使什么都没配也下发对象（至少带 `redirectUri`），`sso` 维持"端点齐备才下发"。
- `routes/mcpConnectors.ts`（D11）：`missingAuthField` 对 `user-oauth` 不再要求任何字段（`client-creds` 的机密客户端规则不变）。
- 测试：`tests/models/connectorView.test.ts`（空配置仍给 `oauth`）、`tests/routes/mcpConnectors.test.ts`（三项全空也能创建）。

### 控制台 `enterprise_server/web`
- `pages/mcpManage/connectorRuntimeOptions.ts`（D8，新建）：超时时间的归一化/读回，以及 `timeoutAuthConfigEntry`（清空时给出显式 `null`）。
- `pages/mcpManage/ConnectorConnConfig.tsx`（D8）：超时时间可留空（留空 = 运行时默认）；删除「重试次数」。
- `pages/mcpManage/ConnectorAuthFields.tsx`：删除 `user-oauth` 的 `clientSecret` 块、`sso` 的 `ssoApp` 与 `ssoClientSecret` 块；`shared-key`/`client-creds` 顶部加预留提示。
- `pages/mcpManage/ConnectorDrawer.tsx`：`validate()` 按 D2/D3 调整；表单状态里这两个字段保留解析（兼容历史草稿），但不再提交新值。
- `pages/mcpManage/ConnectorToolPermissions.tsx`：加"重新安装后生效"说明。
- `i18n.ts`：新增/删除对应中英文案（`mcpDrawer.auth.*`、`mcpDrawer.tools.*`）。
- 测试：`tests/pages/mcpManage/*` 覆盖新表单形状与校验。
- `pages/mcpManage/connectorToolManifest.ts`（D9，新建）：`parseToolNames`（逐行 / 逗号 / JSON 数组解析）、`declaredToolNames`（没有 `syncedAt` 的即人工声明）、`mergeToolEntries`（发现 + 声明 + 逐项开关）。
- `pages/mcpManage/connectorAuthModeOptions.ts`（D9）：`serverCanDiscoverTools(mode)` —— 服务端能自己列工具的模式只有 `none` 与 `shared-key`。
- `pages/mcpManage/ConnectorToolPermissions.tsx`（D9）：声明输入框、手工标签、服务端无法发现时的说明。
- `pages/mcpManage/ConnectorDrawer.tsx`（D9）：表单状态增加 `toolManifestText`；发布/存草稿的工具清单 = 发现 ∪ 声明（含开关）。
- `pages/mcpManage/ConnectorBasicInfo.tsx`（D9）：测试结果分三态（成功 / 警告 / 失败），`needs-user-auth` 走警告样式。
- `api/connectors.ts`（D9）：`ConnectorInput.tools?`；测试接口返回类型收窄为 `'connected' | 'failed' | 'needs-user-auth'`。
- 测试：`tests/pages/mcpManage/connectorToolManifest.test.ts`（新建）、`ConnectorToolPermissions.test.tsx`（新建）、`ConnectorBasicInfo.test.tsx`（新建）。
- `pages/mcpManage/ConnectorDrawer.tsx`（D10）：表单状态去掉 `callbackUrl`，不再把它写进 `auth_config`；新增 `oauthRedirectUri` 属性（由页面从组织设置传入）。
- `pages/mcpManage/ConnectorConnConfig.tsx` / `ConnectorAuthFields.tsx`（D10）：回调地址改为只读展示服务端下发的值（复制按钮保留：管理员要把它登记到上游 IdP）。
- `pages/MCPManagePage.tsx`（D10）：把设置接口的 `oauthRedirectUri` 传给抽屉。
- `api/connectors.ts`（D10）：`getSettings` 返回类型增加 `oauthRedirectUri`。
- `i18n.ts`（D10）：回调地址标签与说明改为"在上游 OAuth 服务商处登记该地址"（中英）。
- `pages/mcpManage/connectorValidation.ts`（D11）：`user-oauth` 的必填规则清空（三项都是可选覆盖）。
- `pages/mcpManage/ConnectorAuthFields.tsx`（D11）：去掉三项的必填星号，顶部加"留空即由桌面端自动发现并注册"的说明。
- `i18n.ts`（D11）：新增该说明；回调地址说明补上"也是桌面端自行注册客户端时登记的 redirect_uri"；`mcp.authHint.userOAuth` 说明可留空。
- `pages/mcpManage/ConnectorAuthFields.tsx`（D15）：删除七组硬编码 scope 预设、搜索框与弹层；改成自由输入 + 已选标签（回车/失焦加入，× 移除），空输入失焦静默。
- `i18n.ts`（D15）：删除 `mcpDrawer.auth.scopeGroup.*` / `scopeDesc.*` / `scope.search` / `scope.add` / `scope.required`（中英共 62 行，已无引用）；`mcpDrawer.auth.scopes.hint` 改写为"留空 = 服务商默认"，不再承诺自动拉取。

### 桌面端
- `src/main/mcp/mcpStore.ts`（D8）：`McpServerRecord`/`McpServerFormData`/`McpConfigJson` 增加 `timeoutSeconds?`；企业更新时以目录为准（目录没有 = 清除旧值，与 toolFilter 同规则）。
- `src/main/libs/openclawMcpServers.ts`（D8）：`ResolvedMcpServer.timeoutSeconds?` → 写 `mcp.servers.<key>.timeout`（仅正数）。
- `src/renderer/types/mcp.ts` + `src/main/auth/enterpriseClient.ts`：公共视图类型加 `enabledTools`。
- `src/renderer/components/mcp/enterpriseAuthMode.ts`：删除 shared-key/client-creds 的 Bearer 映射；新增 `isOrgManagedAuthMode(mode)` 供卡片/安装门禁用。
- `src/renderer/components/mcp/McpCard.tsx` / `McpManager.tsx`：组织凭据卡片显示徽标、禁用安装；待授权计数排除它们。
- `src/main/mcp/mcpStore.ts`：`McpServerRecord`/`McpServerFormData`/`McpConfigJson` 增加 `enabledTools?: string[]`。
- `src/main/libs/openclawConfigSync.ts`：`buildOpenClawMcpServers` 在 `enabledTools?.length` 时写 `toolFilter.include`。
- `src/renderer/services/i18n.ts`：新增徽标/提示文案（中英）。
- 测试：`enterpriseAuthMode.test.ts`、`openclawConfigSync` 的 MCP 段测试、`mcpStore` 往返测试。
- `src/main/mcp/genericOauthFlow.ts`（D10）：`MCP_OAUTH_REDIRECT_PORT_DEFAULT`、`resolveRedirect(configured)`（只接受回环 + 显式端口，主机名归一为 `127.0.0.1`）；回调服务器改为绑定固定端口并发出 `http://127.0.0.1:<port>/callback`；`buildTokenExchangeBody` 带 `redirect_uri`。
- `src/renderer/types/mcp.ts`（D10）：`McpOAuthEndpoint` 增加 `redirectUri?`。
- `src/renderer/components/mcp/mcpAuthModalHelpers.ts`（D10）：OAuth 载荷/表单类型改用共享的 `McpOAuthEndpoint`（此前内联复制了一份，字段会漂移）。
- 测试：`src/main/mcp/genericOauthFlow.test.ts`（回环解析、拒收服务端回调、token 请求带 `redirect_uri`）。
- `src/main/mcp/oauthDiscovery.ts`（D11，新建）：RFC 9728 / 8414 / OIDC 的发现链、`WWW-Authenticate` 兜底、S256 与 https 的信任规则、`OAuthDiscoveryError.tried`。
- `src/main/mcp/oauthRegistration.ts`（D11，新建）：RFC 7591 公开客户端注册、上游错误码透出、机密客户端拒收。
- `src/main/mcp/genericOauthFlow.ts`（D11）：`GenericOauthConfig` 三项改可选并加 `resourceUrl`；`resolveOauthEndpoints`（逐字段覆盖 + 按需注册）；`runGenericOauthFlow` 先解析再绑回调端口，并通过 `onResolved` 把注册结果交给调用方。
- `src/main/mcp/mcpAuthFlows.ts`（D11）：把连接器 URL 作为发现锚点；注册出的 `clientId` 写回记录（发现到的端点不写）；发现/注册走 `net.fetch`。
- `src/renderer/components/mcp/mcpAuthModalHelpers.ts`（D11）：企业连接器不再因缺端点拒绝提交（护栏改为"永不落到企查查"）；新增 `oauthUsesDiscovery`。
- `src/renderer/components/mcp/McpAuthModal.tsx`（D11）：OAuth 模式下显示发现提示，按钮文案「去授权」；`i18n` 新增两条中英文案。
- `src/renderer/components/mcp/submitConnectorDraft.ts`（D11）：成员提交同样不再必填，空值不写入 `auth_config`。
- 类型（D11）：`McpOAuthEndpoint` 在 `renderer/types/mcp.ts`、`main/mcp/mcpStore.ts`、`main/preload.ts`、`main/auth/enterpriseClient.ts`、`renderer/types/electron.d.ts` 五处三项改可选。
- 测试：`oauthDiscovery.test.ts`、`oauthRegistration.test.ts`、`genericOauthFlow.test.ts`（解析/注册分支）、`mcpAuthFlows.test.ts`（发现锚点、注册写回、发现不落盘）、`mcpAuthModalHelpers.test.ts`（不再拒绝提交、`oauthUsesDiscovery`）。
- `src/main/mcp/oauthBrowserFlow.ts`（D12）：新增 `OAuthNetworkPolicy`（`idp` / `open`）与纯函数 `decideOauthRequest`；`openOauthFlow` 增加 `networkPolicy` 选项（默认 `idp`）；`open` 下不安装 `onBeforeRedirect`；阻塞日志按 reason 区分（malformed / insecure-http / third-party）。
- `src/main/mcp/genericOauthFlow.ts`（D12）：连接器授权窗口传 `networkPolicy: OAuthNetworkPolicy.Open`。
- 测试（D12）：`oauthBrowserFlow.test.ts`（+10：`decideOauthRequest` 的两种策略对照、明文 http 拦截、回环与非 http 协议、畸形 URL；`open` 窗口放行 `a9.fspage.com` 且不装 redirect 监听、默认窗口仍拦截同一请求）。
- `src/main/mcp/genericOauthFlow.ts`（D13）：新增 `createTokenExchangeProbe`（换 token 单飞、失败只关一次窗、错误原样上抛）；`runGenericOauthFlow` 改用它；HTTP 非 2xx 时带上响应体里的 `error` / `error_description`。
- `src/renderer/components/mcp/mcpAuthModalHelpers.ts`（D13）：新增 `probeLabelKey`（`missing-save` → `mcpAuthFailedSave`）与 `showsProbeDetail`（失败一律展示底层消息）。
- `src/renderer/components/mcp/McpAuthModal.tsx`（D13）：红条改用上面两个助手，不再隐藏失败原因。
- `src/renderer/services/i18n.ts`（D13）：`mcpAuthFailedSave`（授权未完成 / Authorization not completed，中英）。
- 测试（D13）：`genericOauthFlow.test.ts`（+4：并发轮询只 POST 一次、码到之前不兑换、窗口先关返回 null、失败不重试且只关一次窗）；`mcpAuthModalHelpers.test.ts`（+3：`missing-save` 不再复用"缺少认证字段"、五种结果的标签、成功不显示明细）。
- `src/main/mcp/mcpToolCatalog.ts`（D14，新增）：`listServerTools` 直接对目标服务器说 MCP（`initialize` → `notifications/initialized` → `tools/list`，跟随 `nextCursor` 至多 5 页，10s/8s 超时）；`parseJsonRpcMessages` 接受普通 JSON、批量数组与 SSE `data:` 帧；`extractToolSummaries` 丢无名条目并截断描述；`McpToolListStatus` = `ok` / `unauthorized` / `connect-error` / `missing-credential`；永不抛异常。
- `src/main/mcp/mcpAuthProbe.ts`（D14）：`checkMissingCredential` 改为导出（工具清单读取套用同一条缺凭据规则）。
- `src/shared/mcp/constants.ts`（D14）：`McpIpcChannel.ListTools`（`mcp:listTools`）。
- `src/main/ipcHandlers/mcp/handlers.ts`（D14）：只读 handler——取记录、调 `listServerTools`、原样返回；不写 `auth_status`、不同步 OpenClaw。
- `src/main/preload.ts` / `src/renderer/types/electron.d.ts` / `src/renderer/types/mcp.ts` / `src/renderer/services/mcp.ts`（D14）：`listTools(id)` 透出，失败统一归一为 `connect-error`。
- `src/renderer/components/mcp/mcpConnectionStatus.ts`（D14，新增）：`connectionLabelKey`（停用 / 检测中 / 已连接 / 授权失效 / 未连接 / 未检测）与 `connectedTools`（只有成功才给清单）。
- `src/renderer/components/mcp/mcpSource.ts`（D14，新增）：`sourceLabelKey` 判定来源——`serverKey` → 企业市场，`isBuiltIn`/`registryId` → 内置市场，否则自定义。
- `src/renderer/components/mcp/McpDetailModal.tsx`（D14）：新增 `children` 插槽（信息行之下、管理条之上的单一滚动列）。
- `src/renderer/components/mcp/McpManager.tsx`（D14）：详情打开即对启用的服务器做一次 `listTools`（依赖 id + enabled，避免每次记录对象换身份就重发请求）；信息行新增「连接」；成功时渲染工具清单区块。
- `src/renderer/services/i18n.ts`（D14）：`mcpSourceEnterprise`（企业市场 / Enterprise marketplace）；`mcpDetailConnection*`（连接 / 检测中 / 已连接 / 授权失效 / 未连接 / 已停用 / —）与 `mcpDetailTools*`（工具清单 / 正在读取工具清单… / 该 MCP 未返回任何工具 / 读取工具清单失败），中英。
- 测试（D14）：`mcpToolCatalog.test.ts`（12：JSON/批量/SSE/多行 data 帧/空响应体；无名条目丢弃、`nextCursor`、描述截断；三请求序列 + `mcp-session-id` 透传 + 凭据透传且不出现在结果里；无会话服务器；SSE 编码的 `tools/list`；401 → `unauthorized`；上游错误原样透出；分页；缺凭据不发请求）；`mcpConnectionStatus.test.ts`（4：停用优先、四种状态标签、加载中不给清单、成功给清单且失败为 null）；`handlers.test.ts` +4（`mcp:listTools` 确实注册、未知 id 不打网络、记录原样透传、抛错转成失败应答）；`mcpSource.test.ts`（3：企业安装即便带 `isBuiltIn` 也报企业市场、内置目录条目报内置市场、手填服务器报自定义）。

## 5. 行为规格（可验收）

1. 控制台创建 `user-oauth` 连接器：只见 callbackUrl / authorizeUrl / tokenUrl / clientId / scopes；三项可全部留空（留空 = 桌面端自动发现并注册）；提交成功且公共视图给出 `oauth`。
2. 控制台创建 `sso` 连接器：无 `ssoApp` 下拉、无 secret 输入；缺 clientId 或端点报错。
3. 控制台选择 `shared-key` 或 `client-creds`：显示"需企业端代理注入，当前版本桌面端不可用"，字段仍可填写并保存（预留给将来）。
4. 桌面端企业目录：`shared-key`/`client-creds` 卡片带"组织统一授权 · 暂未开放"徽标，无安装入口，不计入待授权。
5. 桌面端安装 `user-oauth` 连接器 → 本地为 OAuth、待授权；授权走 PKCE，成功后连接可用（回归现有行为）。
6. 管理端关掉某工具后，桌面端**重新安装**该连接器 → `openclaw.json` 的该条目出现 `toolFilter.include`，且只含启用工具；全部启用时不写 `toolFilter`。
7. 用户自建的本地 MCP 不受影响：不写 `toolFilter`。
8. 管理端把超时时间设为 90 秒并发布 → 桌面端安装/更新该连接器后，`openclaw.json` 的该条目出现 `timeout: 90`；管理端清空该字段后再次更新 → 该条目不再有 `timeout`（回到运行时默认 60s）。
9. 管理端对 `user-key` / `user-oauth` 连接器点「测试连接」→ 服务端 401 → 控制台显示**警告**"接口可达，但服务端没有该连接器的凭据……"，不是红色报错；连接器的 `last_test_status` 为 `needs_user_auth`；`none` / `shared-key` 的 401 仍显示为失败。
10. 管理端在 `user-key` 连接器的手工声明框里写 `query_customer` 并发布 → 公共视图下发的 `toolFilter.include` 含 `query_customer`；上游那些没写下来的工具不会出现在桌面的工具列表里。
11. 声明框里写两个名称、关掉其中一个 → `toolFilter` 同时给出 `include`（两个）与 `exclude`（被关掉的那个）；两个全关掉 → `include` 与 `exclude` 同为两个（一个工具都不暴露）。
12. 管理端删掉声明框里的某个名称再发布 → 该名称从 `toolFilter` 中消失；纯服务端发现的清单（`none` / `shared-key`）不受影响，全部启用时仍不下发过滤器。
13. 管理端打开 `user-oauth` 连接器 → 回调地址框显示服务端下发的 `http://127.0.0.1:53232/callback`，只读、带复制按钮；表单保存后 `auth_config` 里**没有** `callbackUrl`。
14. 桌面端安装该连接器 → 授权时浏览器收到的 `redirect_uri` 是 `http://127.0.0.1:53232/callback`（与管理端登记的完全一致），桌面端在该端口接住 code。
15. 桌面端换 token 时请求体带 `redirect_uri`，与授权请求里的值相同；不带 client_secret。
16. 服务端把 `MCP_OAUTH_REDIRECT_PORT` 改成别的端口 → 控制台显示的回调地址与桌面端发出的都跟着变。
17. 管理端把 `user-oauth` 三项全留空并发布 → 桌面端企业目录里该连接器可安装，公共视图的 `oauth` 至少带 `redirectUri`。
18. 桌面端点「连接」→ 弹窗说明"授权地址与客户端将自动发现并注册"，按钮显示「去授权」→ 点击后主进程按 RFC 9728/8414 发现端点；上游提供注册端点且管理端未给 clientId 时先注册（RFC 7591），再打开授权页；`redirect_uri` 仍是管理端展示的那个回环地址。
19. 注册过一次之后再次「重新认证」→ 不再发起注册（记录里已有 `clientId`）；上游把端点搬家 → 下一次授权按新端点走（发现结果不落盘）。
20. 管理端只填其中一项（例如只填 token URL）→ 该项以管理端为准，其余由发现补齐。
21. 发现失败（上游没有任何元数据）→ 弹窗给出失败原因与试过的地址，且**不会**落到企查查登录窗。
22. 授权页上的「前往登录」跳到 IdP 自己的登录页 → 页面正常渲染（登录页的静态资源即使来自另一个 eTLD+1 的 CDN 也能加载）；SSO 窗口的封锁行为不变。
23. 连接器授权窗口里，明文 `http` 请求（非回环、非允许清单内）被拒绝并留下日志；回环回调照常。
24. 完成 IdP 登录后，token 端点只收到**一次**授权码兑换请求；即使轮询探针在页面加载与 2 秒间隔里反复触发，也不会出现第二次 POST，更不会出现"码已下发"的错误。
25. 兑换失败时，红条显示"授权未完成"并附上 IdP 的真实原因（如 `token已下发，请勿重复下发！`），而不是"缺少认证字段"。
26. 桌面端打开一个已授权的 `user-oauth` 连接器详情 → 「连接」行先显示「检测中」，随后显示「已连接」，并在下方列出该 MCP 当前的工具清单（名称 + 一行描述）与数量。
27. 上游把 token 作废后再次打开详情 → 「连接」显示「授权失效」，工具区块显示「读取工具清单失败 · HTTP 401」，而不是空清单。
28. 停用的服务器打开详情 → 「连接」显示「已停用」，不发任何网络请求、不显示工具区块。
29. 从企业市场安装的连接器打开详情 → 「来源」显示「企业市场」（不是「内置市场」）；从内置目录安装的仍显示「内置市场」，手填的显示「自定义」。
30. 控制台的 `user-oauth` 表单里，scope 只有一个自由输入框（没有 Google/Slack/Jira 之类的预设列表）；输入 `offline_access` 回车即成为标签并可点 × 移除；留空提交时 `auth_config` 不含 `scopes`，桌面端的授权 URL 也不带 `scope` 参数。

## 6. 测试计划

- 服务端：`enabledTools` 三种情形；`mapPublicConnector` 不泄漏秘密（既有断言保留）。
- 控制台：`ConnectorAuthFields` 渲染快照级断言（哪些字段在/不在）、`ConnectorDrawer.validate` 的新必填规则。
- 桌面端：`enterpriseAuthMode`（不再 Bearer 映射、org-managed 判定）、`buildOpenClawMcpServers`（写/不写 toolFilter、空数组不写）、`mcpStore` 持久化往返。
- 三端各自跑既有套件回归。
- 服务端（D9）：`toolFilterFor` 的声明清单三种形状（全部启用 / 部分关闭 / 全部关闭）、探针不判死人工声明的工具、成员模式的 401 → `needs-user-auth`。
- 控制台（D9）：`parseToolNames` / `declaredToolNames` / `mergeToolEntries`；声明框的渲染与"手工"标签；`needs-user-auth` 显示为警告而非报错。
- 服务端（D10）：回调地址的生成（默认端口 / 环境变量覆盖 / 非法值回落）；公共视图的 `redirectUri` 只出现在 `user-oauth`；设置接口返回该地址。
- 控制台（D10）：回调地址框显示服务端下发的值、只读、其它方式下不出现。
- 桌面端（D10）：`resolveRedirect` 接受回环端口、拒收 `https` 服务端回调与无端口地址、把 `localhost` 归一为 `127.0.0.1`；`buildTokenExchangeBody` 带 `redirect_uri`。
- 桌面端（D11）：`oauthDiscovery`（路径后缀/源站兜底、issuer 路径插入、OIDC 兜底、`WWW-Authenticate` 挑战、只声明 plain 时拒收、https 约束、失败时上报 `tried`）；`oauthRegistration`（请求体形状、200/201、上游错误码透出、缺 `client_id`、机密客户端拒收）；`resolveOauthEndpoints`（逐字段覆盖、缺连接器 URL 报错、无注册端点报错、已有 clientId 不注册）；`saveCredential`（发现锚点取自记录、注册结果写回、发现结果不落盘）。
- 服务端（D11）：`user-oauth` 三项全空也能创建；空配置的公共视图仍带 `oauth: { redirectUri }`。
- 控制台（D11）：`missingAuthField('user-oauth')` 恒为 null；抽屉显示发现说明。
- 控制台（D15）：`ConnectorAuthFields` 的 scope 区块只渲染自由输入与已选标签（`ConnectorAuthFields.test.tsx`）。
- 桌面端（D12）：`decideOauthRequest`（`idp` 拦 `a9.fspage.com` / `open` 放行、明文 http 拦截、允许清单里的 http IdP 仍放行、回环与非 http 协议、畸形 URL）；`openOauthFlow` 两种策略下的监听器行为（`open` 放行且不装 redirect 监听）。
- 桌面端（D13）：`createTokenExchangeProbe`（三次并发调用只兑换一次、码到之前不兑换、窗口先关返回 null、失败不重试但每次上报、窗口只关一次）；`probeLabelKey` / `showsProbeDetail`。
- 桌面端（D14）：`mcpToolCatalog`（JSON / 批量 / SSE 帧解析、三请求握手与会话头、401 → `unauthorized`、上游错误透出、分页、描述截断、缺凭据不发请求）；`mcpConnectionStatus`（停用优先、四种状态标签、失败不给清单）。

## 7. 已知缺口（明确不做）

- **企业端 MCP 网关**：数据模型与凭据存储已就位；将来需要 `POST /proxy/mcp/:serverKey`（组织身份校验 → 解密注入 → 流式透传 → 计量审计）。届时须解决组织 JWT 只有 1 小时（`enterprise_server/src/auth/jwt.ts`）的问题——或发设备级长票，或在刷新时重同步 MCP header。
- **已安装连接器的治理变更自动下发**：本轮不做，重新安装才生效（UI 明说）。
- **机密客户端（client_secret）服务端代换 code→token**：需要回调落企业端，属网关项目的一部分。
- **连接器回调落企业端（D10 相关）**：本轮连接器的回调是企业端**生成**、桌面端**接收**的回环地址（`http://127.0.0.1:<port>/callback`），企业端不参与 code 的接收。"回调落企业端、由企业端代换 token"仍然是网关项目的一部分（D10 让控制台不再展示那种地址，正是为了不让管理员去登记一个用不上的 URL）。
- **SSO 窗口的第三方封锁仍是白名单制（D12 相关）**：连接器窗口已改用 `open` 策略，但组织 SSO 窗口仍是 `idp` 策略——IdP 换了新的资源 CDN 而内置表没跟上时，登录页同样会白屏。发现帮不上忙（SSO 不走发现），需要时就事补 `deriveIdpAllowlist` 的 `resourceEtld1s`。
- **`sse` 传输按 streamable-HTTP 探测（D14 相关）**：工具清单读取对 `http` 与 `sse` 走同一条 POST 路径。真正的旧版 SSE 握手（`GET` 建流 → `endpoint` 事件 → POST 到该端点）没有实现；上游若只支持旧版 SSE，详情页会显示「未连接」，而 OpenClaw 侧仍可能正常加载。需要时再补。
- **工具清单不回传企业端（D14 相关）**：详情页的连接状态与工具清单只是本地的一次检视，既不上报也不落盘，管理端看不到"成员实际拿到了哪些工具"。
- **飞书/钉钉/企业微信的 MCP 原生 OAuth 流程**。
- **桌面端不上报工具清单（D9 相关）**：真正握着成员凭据的是桌面端（OpenClaw 才是 MCP 客户端），所以工具清单本来可以由桌面端连上后回传。本轮不做——那是一条跨机通路（新的上报接口 + 桌面端在授权成功后推 `tools/list` 结果）。在那之前，成员凭据模式下的工具清单以**管理端的人工声明**为准。

## 8. Builder check 决议（2026-10-26）

独立审阅者提出 6 个会让实现走偏的点，逐条裁决如下（均为实现细节，不改变已确认的方向）：

**R1 — 工具白名单的线上形状改成 `toolFilter`（不再用 `enabledTools`）。**
审阅者指出 `include` 的 zod 约束是 `min(1)`，若"全部禁用"下发空数组就只能"不写" → 等于放开全部，与策略相反。因此公共视图直接下发 OpenClaw 的形状：`toolFilter?: { include?: string[]; exclude?: string[] }`，服务端算好：
- 全部启用（或没有工具）→ 不出现。
- 部分禁用 → `{ include: [启用的…] }`（即白名单）。
- 全部禁用 → `{ exclude: [全部…] }`（合法且达意：一个工具都不暴露）。
桌面端只负责把它原样写进 `openclaw.json`，不再自行判断"空数组"。

**R2 — 成员提交表单同步收敛，且不再允许提交组织凭据模式。**
`SubmitConnectorForm.tsx` 目前仍要求 `user-oauth` 填 `clientSecret`、不收端点，而 `missingAuthField` 会放行这种提交——审阅者说得对：它会制造"审核通过但桌面端永远不可用"的连接器。本轮：成员表单的 `user-oauth` 改为收集 `authorizeUrl`/`tokenUrl`/`clientId`（不收集 secret），并从成员可选方式里移除 `shared-key`/`client-creds`（组织凭据只能由管理员创建，且当前版本桌面端不可用）。

**R3 — 已安装的组织凭据连接器：保留记录，界面按"组织统一授权"呈现。**
新安装会在本地记录里持久化 `enterpriseAuthMode`；历史记录（只有 `authMethod`）用 `serverKey` 与已加载的市场目录比对来识别。两者都走同一个判定函数，结果一致：不显示 Connect/重新授权入口，启用时也不触发鉴权 IPC。不做数据迁移。

**R4 — 安装即派生鉴权状态。**
`McpStore.createServer` 目前不写 `auth_status`，表默认 `authenticated`，所以新装的 OAuth 连接器一装就是"已认证"。本轮在创建时调用既有的 `deriveAuthStatus`（非 None 且无凭据 → `needs-auth`）。这同时修正了所有本地 MCP 的同类误报。

**R5 — "重新安装"的含义与"更新配置"入口。**
已安装的企业连接器卡片增加"更新配置"：以编辑模式打开安装表单并用目录最新值预填（url / authMode / oauth 端点 / toolFilter），保留已有凭据。这同时成为 R1/D5 策略变更的生效路径，不必删了重装丢 token。控制台文案相应改为"在桌面端更新配置后生效"。

**R6 — 桌面端没有"待授权计数"，删掉该说法。**
D4/规格 4 的本意只是"不产生可点的授权入口"，不引入新计数器。规格 4 以"卡片无 Connect、无待授权状态、启用不触发鉴权"为准。
