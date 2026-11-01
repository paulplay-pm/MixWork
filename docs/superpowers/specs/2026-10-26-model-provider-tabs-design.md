# 企业控制台「模型配置」：模型类型 Tab 化 + 会话 401 自愈

> 本文是对 `docs/superpowers/specs/2026-10-25-model-provider-capability-design.md`（厂商能力分区 + 统一模型清单）的修订。
> 数据模型（`provider_cards` / `provider_keys` / `model_catalog.types` / `model_type_defaults`）**不变**；
> 改的是控制台的信息架构，以及一个在生产里暴露出来的会话 bug。

---

## 1. 背景

2026-10-25 的设计把厂商卡片做成了「能力类型 chips（多选）→ 每种能力一段独立配置（Base URL / API Key / 模型清单）」。
上线后管理员反馈了三个问题：

1. **名不副实**：chips 标的是「能力类型」，但管理员的心智是「这家厂商提供哪几类模型」。
   而模型表格里本来就有一列「类型」（对话 / 视觉理解 / 深度思考 / Embedding / 重排序 / 语音识别 / 语音合成 / 图像生成 / 视频生成），
   同一页出现两个「类型」语义，管理员分不清哪个是哪个。
2. **勾选框只回答了「有没有」，没回答「在哪配」**：勾上 LLM 之后，四个分区从上到下平铺在页面里，
   管理员要自己在长页面里找「刚才勾的那一段」，配置项一多就找不到北。
3. **清单行挤**：服务商清单每一行都挂着 `LLM · 语音 · 图像 · 视频` 一排小标签，把厂商名挤成了省略号。

同时暴露了一个独立的 bug：**控制台会话过期后，所有写操作返回 `http 401 unauthorized`**（§7）。

---

## 2. 目标

- **G1** 卡片顶部用一个「模型类型」Tab 栏表达「这家厂商提供哪几类模型」；每个 Tab 页就是那一类模型的独立配置（Base URL / API Key / 模型清单）。
- **G2** 四个模型类型 Tab 恒定存在，未配置的 Tab 不置灰，点进去就是配置态。
- **G3** 清单行只保留 品牌方块 / 名称 / 模型数 / 启用开关。
- **G4** 控制台会话在管理员工作期间保持有效；会话真的失效时给出可读提示并回到登录页，而不是裸的 `http 401 unauthorized`。

## 3. 非目标

- 不改服务端数据模型、不加迁移、不改 API 的请求/响应结构。
- 唯一的**服务端行为**改动见 §6.1：协议切换不再连带清空模型清单。
- 不做「按模型类型分开的独立凭证分区」：Embedding / 重排序不单开 Tab（§4.5）。
- 不做语音合成（`tts`）分区：服务端没有 TTS adapter。
- 不做桌面端的媒体 / 语音模型选择 UI（沿用 2026-10-25 设计的分期）。
- 不改服务端的 token 有效期与 `/auth/refresh` 语义（§7.3）。

---

## 4. 决策清单

| # | 决策 | 结论 | 依据 | 定的人 |
|---|---|---|---|---|
| D1 | 「能力类型」改名 | **模型类型** | 管理员用语；与模型表格的「类型」列区分见 D2 | 需求方 |
| D2 | 模型表格「类型」列 / 抽屉类型多选的文案 | 改称 **模型能力** | 同页两个「类型」语义会混淆。纯 i18n 文案，API 与 DB 仍叫 `types` | 我（可在评审时推翻） |
| D3 | 勾选框 → Tab | 四个 Tab 恒定显示 | 一眼看得见「缺哪类能力」，且点进去就能配 | 需求方 |
| D4 | 未配置 Tab 的样式 | **不置灰、不加灰字**，点进去直接是配置态 | 需求方明确要求 | 需求方 |
| D5 | Tab 状态信号 | 已配置的 Tab 显示模型数徽章（如 `语音识别 3`）；未配置的不带徽章 | 徽章同时替代了原 chips 的「已勾选」信息 | 我 |
| D6 | 移除分区 | **任何 Tab 都不提供「移除」**：四个模型类型一律只有启用 / 停用 | 需求方两轮确认（先点名语音/图像/视频三个 Tab，再明确 LLM 也去掉） | 需求方 |
| D7 | Embedding / 重排序 | **不单开 Tab**，留在 LLM Tab 内做「模型能力」标签 | 同一 endpoint、同一份密钥；单开 Tab 等于逼管理员再填一次 Base URL / API Key。且当前无消费方（§5.5） | 我（已在对话中说明，需求方未反对） |
| D8 | LLM Tab 的模型清单 | **不加类型筛选**，平铺全部 | 需求方 | 需求方 |
| D9 | 清单行的类型标签 | 删除 | 需求方 | 需求方 |
| D10 | 会话 401 | 控制台主动轮换 token + 会话失效可见反馈；**不改服务端** | §7 | 我（可在评审时推翻） |
| D11 | LLM Tab 的协议切换 | 保持**单选**（OpenAI 兼容 / Anthropic 兼容 二选一）；切换**不清空模型清单**，只把 Base URL 换成新协议的默认地址 | 需求方明确要求：模型清单是人工录入的资产，不能因为换一个协议开关就消失 | 需求方 |
| D12 | 协议切换的确认弹窗 | 删除——切换不再有破坏性后果 | 随 D11 推导 | 我 |

---

## 5. 界面设计

### 5.1 卡片结构

```
┌────────────────────────────────────────────────────────────────────────────┐
│ 面包屑 / 模型配置 / MiniMax                     [测试连接] [保存]  ( ●── ) │
├────────────────────────────────────────────────────────────────────────────┤
│ 服务商名称  [ MiniMax                                                   ] │
│ (新卡片时下方还有 厂商 id 输入框)                                          │
│                                                                            │
│ 模型类型   ┌ LLM (VLM) ┐  语音识别   图像生成   视频生成                    │
│            └───────────┘  ────────    ────────   ───────                   │
│              ↑ 当前 Tab（蓝色下划线）                                        │
│                                                                            │
│ ┌ 当前 Tab 的内容 ──────────────────────────────────────────────────────┐  │
│ │ 协议  (●) OpenAI 兼容  ( ) Anthropic 兼容                    [启用 ○─]      │  │
│ │ Base URL  [ https://api.minimaxi.com/v1                            ]  │  │
│ │ API Key   [ sk-·············                                     ]  │  │
│ │ 当前密钥 sk-abc••••wxyz                                              │  │
│ │                                                                          │  │
│ │ 模型清单 (3)                              [获取模型]  [+ 添加模型]        │  │
│ │ ┌──────────────┬──────────┬────────────┬────────┬────────┐            │  │
│ │ │ 模型         │ 模型能力 │ 上下文窗口  │ 已启用 │ 操作   │            │  │
│ │ ├──────────────┼──────────┼────────────┼────────┼────────┤            │  │
│ │ │ abab-6.5     │ 对话     │ 200K       │  ✓     │ 编辑   │            │  │
│ │ └──────────────┴──────────┴────────────┴────────┴────────┘            │  │
│ └──────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────┘
```

- Tab 栏取代原来的「能力类型」fieldset（`ProviderCard.tsx`）。
- Tab 内容区顶部一行：协议单选（只有 LLM Tab 有）+ 右侧的 启用/停用 开关（分区唯一的操作，见 D6）。
- 分区标题不再重复 Tab 名（Tab 已经是标题了）。

### 5.2 Tab 状态

| 状态 | 表现 |
|---|---|
| 当前 Tab | 蓝色下划线 + 文字加粗 |
| 已配置 | 标签右侧带模型数徽章（`语音识别 3`） |
| 未配置 | 无徽章，**不置灰**；点进去是空表单（Base URL 有该厂商该协议的默认值、API Key 空、模型清单空态） |
| 已配置但被停用 | 保留徽章，标签用次要色（`--text-tertiary`），分区内容顶部提示「该模型类型已停用」 |

### 5.3 分区操作

| 操作 | 适用 | 行为 |
|---|---|---|
| 启用 / 停用 | 全部 Tab（唯一的分区操作） | `POST /admin/provider-keys/:id/enable|disable`（`providersApi.setEnabled` 已有）。停用保留模型清单，只是不再路由 |
| 移除 | **不提供** | 四个模型类型都没有删除入口。分区只能停用，不能删 |

内置分区与自定义分区在这里没有区别：都只有启用 / 停用。

### 5.4 删除入口

分区（模型类型）没有删除入口，只有启用 / 停用。整张厂商卡片的删除仍然保留在清单行（垃圾桶图标，仍然只对「全部分区都是自定义」的卡片开放），
所以「建错了」的自定义卡片可以整张删掉。

服务端 `DELETE /admin/provider-keys/:id` 路由保留（控制台不再调用它）。

### 5.5 Embedding / 重排序为什么不单开 Tab

- **同一份密钥**：Embedding / 重排序模型和对话模型走同一个 OpenAI 兼容 endpoint。独立 Tab = 独立分区 = 独立 Base URL + 独立 API Key，
  等于让管理员为同一家厂商填两遍同样的信息。
- **当前没有消费方**：服务端的会话模型列表只放行 `chat / vision / reasoning`（`SESSION_MODEL_TYPES`），
  桌面端的 embedding 走自己的 `cowork_config.embeddingProvider`，不吃企业目录。独立 Tab 会造出一段没人用的配置。
- **真正该做的**：等桌面端 embedding 改吃企业目录时，用 `model_type_defaults`（已支持按类型指默认模型），
  那时新增的是「一个模型类型 + 一个默认模型指针」，不是「一个凭证分区」。

### 5.6 服务商清单行

```
┌────┐
│ M  │  MiniMax                                  (17)      ( ●── )
└────┘
```

删除 `LLM / 语音 / 图像 / 视频` 小标签（`ProviderRail.tsx` 的 `capabilityTags()`）；模型数徽章与启用开关保留。

### 5.7 协议切换（仅 LLM Tab）

LLM Tab 顶部的协议单选保持**单选**（OpenAI 兼容 / Anthropic 兼容，二选一）。切换时：

- **模型清单保留**：下面的模型表、模型能力标签、默认模型指针都不动。
- **Base URL 换成新协议的默认地址**（`openai` → 该厂商的 OpenAI 兼容地址，`anthropic` → 该厂商的 Anthropic 兼容地址）。
  管理员手填过的 Base URL 会被新默认值覆盖（之后可以再改回来）。
- **不再有确认弹窗**：切换没有破坏性后果，不需要二次确认。
- 协议与 Base URL **一次 PATCH 同时提交**（`{ protocol, baseUrl }`），避免出现「新协议 + 旧地址」的中间态。
  新协议不是 `openai` 时同时带 `codingPlan: false`：Coding Plan 是 OpenAI 协议的专属开关，
  跨协议留着它，切回来时开关会显示成「开」而地址并不是 coding 地址。
- 切换请求在途期间，协议单选置灰（避免连点两次发出两次切换）。

两个协议都是对话协议，模型 id 与模型能力标签（对话 / 视觉理解 / 深度思考 / Embedding / 重排序）含义相同，
所以切换之后不需要重新给模型打标签。

---

## 6. 数据模型与 API

**数据模型零改动**（无迁移、无字段变化、API 的请求/响应结构不变）。Tab 与「分区」（`provider_keys` 行）一一对应的关系不变：

```
Tab (模型类型)          provider_keys 行
─────────────────────────────────────────────
LLM (VLM)        →     protocol ∈ {openai, anthropic}   （单选）
语音识别          →     protocol = realtime-asr
图像生成          →     protocol = image-gen
视频生成          →     protocol = video-gen
```

保存语义（卡片右上角的「保存」提交全部 Tab）：

| 分区状态 | 请求 |
|---|---|
| 已存在 | `PATCH /admin/provider-keys/:id`（baseUrl / codingPlan / apiKey） |
| 待创建（本次新填的） | `POST /admin/provider-keys`（`cardId` + `provider` + `protocol` + `endpoint` + `codingPlan` + `apiKey`） |
| 卡片名 | `PATCH /admin/provider-cards/:id`（label） |

现状：`ProvidersModelsPage.tsx` 的 `saveCardMut` 只 PATCH 已存在的分区，`createCardMut` 只在整张卡还是草稿时建分区。
本次要扩展为「保存时把待创建的分区一并建出来」——草稿卡和已有卡共用同一条保存路径。

### 6.1 服务端唯一的行为改动：协议切换不再清空模型清单

现状（`src/routes/admin/providerKeys.ts` 的 PATCH 路由）：只要 `protocol` 变了，就调用
`modelCatalog.deleteByProviderKey(orgId, id)`，把该分区的模型行连同 `model_type_defaults` 里的默认指针一起删掉，
并在响应里回 `clearedModels`。

D11 要求 `openai ↔ anthropic` 的切换保留模型清单，所以这条规则要收窄：

| 从 → 到 | 模型清单 |
|---|---|
| `openai` → `anthropic`（或反向） | **保留**：两个都是对话协议，模型 id 与能力标签含义相同 |
| 对话协议 ↔ 非对话协议（`realtime-asr` / `image-gen` / `video-gen`） | **清空**：一个对话模型 id 对 ASR / 图像适配器没有意义，留着会继续把桌面端路由到该分区服务不了的模型 |

控制台只会在 LLM Tab 里切换协议（单选只有 openai / anthropic 两项），所以控制台永远走「保留」这一支；
保留跨族清空这一支，是不给直接调 API 的客户端留下「图像模型被路由到视频适配器」的坑。

- 响应字段 `clearedModels` **保留**（`0` = 本次没有清空），控制台不读它，只有服务端测试断言它。
- `duplicate_section` 检查（同卡片同协议唯一）不变：切到同卡片已有的协议仍然 409 拒绝，且拒绝时模型清单原封不动。

---

## 7. Bug：控制台会话过期后所有写操作 401

### 7.1 现象

在 DeepSeek 等厂商卡片里填入正确的 API Key 后，点「启用」「测试连接」「保存」三个动作全部弹红色 toast：
`http 401 unauthorized`。页面本身看起来是好的（卡片、模型清单都在）。

### 7.2 根因链

1. 服务端签发的 JWT 有效期 **1 小时**：`enterprise_server/src/auth/jwt.ts` → `signToken(...).setExpirationTime('1h')`。
2. 控制台的 API 客户端**只在收到 401 之后**才去刷新（`web/src/api/client.ts:142`）。
3. 但 `POST /auth/refresh` 会用**同一个** token 重新验签（`enterprise_server/src/routes/auth.ts:175` → `verifyToken`）。
   token 一旦过期，`jwtVerify` 必然抛错 → refresh 自己也返回 401。
4. 客户端捕获 refresh 的失败，把**原始的** 401 抛给调用方；`ApiError` 的消息模板是 `http ${status} ${body.error}`，
   服务端返回体是 `{"error":"unauthorized"}` → toast 显示 `http 401 unauthorized`。
5. 页面看起来完好：react-query 保留上一次成功的数据，**读**请求虽然也 401，但界面不空；只有**写**请求会弹 toast。

**结论：控制台的「401 自动刷新」链路对唯一需要它的场景（token 过期）是无效的。**

桌面端早就绕开了这个坑，并在代码里写明了原因：
`src/main/libs/enterpriseJwtRefresh.ts` —— “the /auth/refresh endpoint requires the current (still-valid) token to verify. So we must rotate it proactively while it is still valid.”
控制台没有对应实现。

### 7.3 为什么不是别的 401

| 候选 | 排除依据 |
|---|---|
| 上游厂商返回 401 | `/admin/provider-keys/:id/test` 把上游失败包成 **200** `{status:'failed'}`，前端显示「测试失败」而不是 401；且上游失败不影响「保存」 |
| 权限不足 | `requirePermission` 拒绝时返回 **403** `forbidden` |
| 跨组织 | `org_mismatch` → 400 |
| 鉴权中间件 | **唯一**会返回 401 + `{"error":"unauthorized"}` 的地方（`src/auth/middleware.ts`）：token 缺失 / 无效 / 过期 |

### 7.4 修复

| # | 改动 | 位置 |
|---|---|---|
| F1 | **主动轮换 token**：新模块镜像桌面端 `enterpriseJwtRefresh.ts` —— 到期前 10 分钟轮换、单飞（并发只发一次）、启动即检查、窗口切回前台时检查 | 新增 `web/src/auth/sessionRefresh.ts` + `web/src/main.tsx` 接线 |
| F2 | **会话失效可见**：一次请求 401 且刷新也失败时，客户端抛专用的 `SessionExpiredError`（文案走 i18n），并触发「清空会话 → 跳 /login → 登录页提示『登录会话已过期，请重新登录』」，不再显示裸的 `http 401 unauthorized` | `web/src/api/client.ts`、`web/src/auth/store.ts`、`web/src/pages/LoginPage.tsx` |
| F3 | **不改服务端**：`POST /auth/refresh` 继续要求「未过期的 token」 | 服务端此路径零改动（§6.1 的改动与本条无关） |

**F3 的理由与代价**：让 refresh 接受过期 token 会把 1 小时有效期变成滑动有效期，削弱企业控制台里 JWT 的可撤销性
（当前 JWT 本就不可撤销，过期是唯一的 kill switch），而且桌面端依赖「过期即必须重新登录」的语义。
**代价**：离开控制台超过 1 小时再回来，需要重新登录一次（此时页面已重新加载，未保存的输入本来也已经没了）。
F1 保证的是「一直在用的标签页不会掉线」——正是本 bug 的场景。

---

## 8. i18n 文案

| key | 中文 | English | 备注 |
|---|---|---|---|
| `providersModels.card.capabilities` | 模型类型 | Model types | 原「能力类型 / Capability types」；**改值不改 key**（key 改名会波及测试与调用点，收益不抵） |
| `providersModels.model.colType` | 模型能力 | Model capability | 原「类型 / Type」 |
| `providersModels.drawer.types` | 模型能力 | Model capabilities | 原「类型 / Types」 |
| `providersModels.model.typeChat` 等 | 对话 / 视觉理解 / 深度思考 / Embedding / 重排序 / 语音识别 / 语音合成 / 图像生成 / 视频生成 | Chat / Vision / Deep thinking / Embedding / Rerank / ASR / TTS / Image Gen / Video Gen | 不变 |
| `providersModels.card.modelTypeTabs`（新） | 模型类型 | Model types | Tab 栏的 aria-label |
| `providersModels.card.sectionNotConfigured`（新） | 该模型类型尚未配置 | This model type is not configured yet | 未配置 Tab 的空态提示 |
| `providersModels.card.sectionDisabled`（新） | 该模型类型已停用 | This model type is disabled | 停用提示 |
| `auth.session.expired`（新） | 登录会话已过期，请重新登录 | Your session has expired. Please sign in again. | F2（会话失效时的错误文案） |
| `auth.session.expiredHint`（新） | 登录状态已失效，请重新登录后继续 | Your session is no longer valid. Please sign in again to continue. | F2（登录页提示） |

`en` / `zh` 两份字典必须**键集合完全一致**（今天是靠人工核对，2026 10 月核对时各 1422 条）。
本次顺手补一条 parity 测试锁住它（`web/src/i18n.ts` 需要导出一个 `i18nDicts = { en, zh }`），
免得以后改文案时漏掉一边。

随 D6 一并删掉的旧 key（`en` / `zh` 各删同一条，保持等长）：
`providersModels.card.removeTitle`、`providersModels.card.removeMessage`、`providersModels.card.builtinLocked`
—— 分区删除入口与「内置能力不可移除」提示一起消失。

随 D12 一并删掉的旧 key：
`providersModels.card.switchProtocolTitle`、`providersModels.card.switchProtocolMessage`
—— 「切换协议会清空 N 个模型」的确认弹窗没有存在意义了。

---

## 9. 测试计划

### 9.1 新增

| 文件 | 覆盖 |
|---|---|
| `web/tests/auth/sessionRefresh.test.ts` | 主动轮换：临近到期才轮换 / 未到期不轮换 / 已过期返回 `jwt-expired` 不发请求 / 并发调用只发一次请求 / 轮换成功后写入新 token |
| `web/tests/api/clientSessionExpired.test.ts` | 401 → 刷新成功 → 重试并成功；401 → 刷新失败 → 抛 `SessionExpiredError`（不是 `http 401 unauthorized`）且触发会话失效回调 |
| `web/tests/shared/i18n.parity.test.ts`（新） | `en` / `zh` 键集合完全一致 |

### 9.2 改写

| 文件 | 改动 |
|---|---|
| `web/tests/pages/providersModels/capabilities.test.ts` → `modelTypeTabs.test.ts` | 随模块改名；断言协议→Tab 映射、LLM 的双协议、媒体/语音不可拉取模型、各 Tab 允许的模型能力集合 |
| `web/tests/pages/providersModels/ProviderCard.test.tsx` | 「renders one chip per capability」→「四个模型类型 Tab 恒定存在」；勾选/取消勾选 → 点击未配置 Tab 进入配置态 |
| `web/tests/pages/providersModels/CapabilitySection.test.tsx` → `ModelTypeSection.test.tsx` | 随模块改名；新增 启用/停用 开关、停用态提示；断言分区内容里没有移除按钮 |
| `web/tests/pages/providersModels/ProviderRail.test.tsx` | 清单行不再出现类型标签 |
| `web/tests/pages/ProvidersModelsPage.test.tsx` | Tab 切换、未配置 Tab 的保存会新建分区、已存在分区保存仍是 PATCH；「切换协议前先确认」改为「切换协议直接提交」：断言直接 PATCH `{ protocol, baseUrl }`、不出现确认弹窗 |
| `web/tests/visual/providers.spec.ts` | 断言从 checkbox 改为 tab；基线截图需在有种子后端时本地重生成（`npm run test:visual:update`），基线不入库 |
| `enterprise_server/tests/routes/providerKeysV2.test.ts` | 「切换协议会清空该分区的模型」反向为「切换协议保留该分区的模型」：模型行数不变、`model_type_defaults` 的 chat 指针仍在、`clearedModels === 0`；「切换协议不影响别的分区的模型」去掉 `clearedModels > 0` 的断言；**新增**一条：跨协议族切换（`openai` → `image-gen`）仍然清空该分区的模型清单 |

`enterprise_server/tests/routes/providerKeysExtended.test.ts` **不用改**：它断言的是**空 body** 的 PATCH
返回 `{ ok: true, clearedModels: 0 }`，`clearedModels` 字段保留，值仍然是 0。

### 9.3 手工验证

有种子后端时：新建厂商 → 四个 Tab 各填一段 → 保存 → 卡片上四个 Tab 各自带模型数徽章；
停用某个 Tab → 该 Tab 变次要色且不再路由；会话过期后操作 → 提示「登录会话已过期」并跳登录页。

---

## 10. 实施顺序

1. **P0 会话 401 自愈**（F1 + F2）—— 独立于 UI 改造，先修，因为它让管理员无法保存任何配置。
2. **P0.5 协议切换保留模型清单**（D11 + D12 + §6.1）—— 服务端收窄清空规则 → 反向三个服务端测试 → 控制台去掉确认弹窗、协议与 Base URL 一次 PATCH。
3. **P1 模型类型 Tab**（D1–D6）：模块改名 → Tab 栏 → 分区操作 → 保存语义。
4. **P2 清单行清理**（D9）+ 文案改名（D2）。
5. **P3 视觉基线**（需要种子后端）。

---

## 11. 风险

| 风险 | 缓解 |
|---|---|
| 改名波及面大（`capabilities.ts` 被 4 个源文件 + 2 个测试文件引用） | 纯机械改名，单独一个提交，`tsc` + vitest 兜底 |
| 未配置 Tab 的「保存」新建分区，管理员可能误建空分区 | 只有填过内容（Base URL 被改过或填了 Key）的 Tab 才随保存创建；空 Tab 不动 |
| F3 决定让「长时间离开」必须重新登录 | 已在 §7.4 记录代价；如需改成滑动会话，是一次服务端改动 + 安全评审 |
| 停用的分区与总开关的交互 | 沿用服务端 `enabled_before_master` 快照语义（2026-10-25 设计 D4/§迁移 060），不做新语义 |
| 协议切换保留清单后，可能把对话模型留在非对话协议上 | 控制台只暴露 `openai ↔ anthropic`（保留清单），跨族切换仍然清空（§6.1）；将来开放更多协议对时这条规则要重新审 |
| 协议与 Base URL 分两次提交会留下「新协议 + 旧地址」的中间态 | 一次 PATCH 同时提交 `{ protocol, baseUrl }`（§5.7） |
