# 企业版 ASR（语音输入）与 Media（图像/视频）后端补全 + 客户端鉴权重构 — 设计

| | |
| --- | --- |
| 状态 | 待评审（含 builder-check 消化） |
| 触发 | 语音输入在企业登录下必然 401；media 生成同病 |
| 决策 | ①ASR 走服务端全代理（ws 中继）②上游做可插拔 adapter，vendor 在企业控制台模型管理配置 ③media 本期不计费 |
| 相关 | `src/main/ipcHandlers/asr/handlers.ts`、`src/main/main.ts`(media 8 处)、`enterprise_server` |

---

## 1. 背景与根因

MixCWork 已彻底断开 youdao，账号只经 MixCWork/Enterprise server 登录。企业 org JWT 存 **sessionStorage**；消费者遗留 `auth_tokens`（electron-store）对企业用户**恒为空**。

桌面端两处功能仍用**消费者鉴权**打 `${ENTERPRISE_SERVER_URL}`：

- **ASR**：`ipcHandlers/asr/handlers.ts` 的 `createRealtimeSession` 先 `getAuthTokens()`，空则**直接 401、请求未发出**；前端把 401 翻成「登录后可使用语音输入」。
- **Media**：`main.ts` **8 处** `fetchWithAuth` → `/api/media/*`（见 §7.3），内部 `getTokens()` 空则抛 "No auth tokens are available"。

**第二层根因**：`enterprise_server` **没有任何 `/api/asr/*` 或 `/api/media/*` 路由**。即便鉴权换成企业 JWT，也只会 401→404。这是 youdao 时代对接已移除消费者后端（`api-overmind`）的孤儿功能：桌面端客户端齐全（realtime 流式、每日配额、上游余额/限流错误码、media 任务+积分 UI），后端没了。对照：模型聊天能用，因为 `/proxy/*` 在服务端**确实实现**了。

**结论**：不是"改个鉴权"的小修，是**在 enterprise server 上把 ASR + Media 后端补出来并让桌面端改用企业鉴权**。

## 2. 目标 / 非目标

### 目标
- 企业登录用户语音输入、图像/视频生成端到端可用。
- 鉴权统一到企业 org JWT，桌面端 ASR/media 不再依赖消费者 `auth_tokens`。
- 上游厂商可插拔，**复用现有「模型管理」的 `provider_keys`+`model_catalog` 配置**，不新增配置表、不新增权限点。
- ASR 每日配额由服务端权威计量。

### 非目标
- media 积分计费/扣减（决策③）；UI 暂按固定值显示。
- 离线/跨端 ASR；更换 enterprise server HTTP 框架（仅加 ws upgrade）。
- 消费者（youdao）兼容路径（已废弃）。

## 3. 总体架构

桌面端 ASR：IPC 建会话(org JWT) → 拿 `wsUrl`(wss 企业域 + ticket) → WebSocket 连企业 → 音频帧经**服务端中继**到上游 ASR → 识别事件经**服务端翻译成 youdao 信封**回桌面。Media：企业 fetch → `/api/media/*` 任务式。全部落 enterprise_server；配置复用 `provider_keys`+`model_catalog`，新增 `asr_daily_usage`/`media_tasks`。

复用：`requireActiveMember`、`providerProxy` 转发思路、`vault/crypto.ts` 密钥加解密、`permissionPoints` + 052 式角色迁移。

## 4. 数据模型（新增迁移 054/055）

### 4.1 复用 `provider_keys` + `model_catalog`（不新增配置表）

上游 ASR/Media 配置**直接放进现有模型配置**：

- `provider_keys` 扩两处：
  - `protocol` 的 CHECK 从 `('openai','anthropic')` 扩为 `('openai','anthropic','realtime-asr','image-gen','video-gen')`——`protocol` 即 **adapter 注册名**（协议而非厂商，可插拔）。
  - 新增 `config JSONB NOT NULL DEFAULT '{}'`：adapter 私有参数（sampleRate、模型映射、厂商细节等）。
- `model_catalog.types` 补 **`video-gen`**（现 8 值无 video），`MODEL_TYPE_VALUES` 同步。ASR 模型 `types=['asr']`、图像 `['image-gen']`、视频 `['video-gen']`。
- 密钥继续用 `vault/crypto.ts` + `providerKeyVault.getDecrypted(id)`，无需新 vault 访问器。
- 模型类型展示/管理走现有 admin models/catalog 路由与 UI；`/api/media/*/models` 的 `modelId/displayName/capabilities/parameterSpec` 从 `model_catalog` + `config.models` 拼出，`modelId` 与桌面 `canonicalizeMediaModelAliases` 对齐。

> 结论：不引入 `service_providers` 表、不引入 `service_provider:*` 权限点——ASR/media 就是模型配置里的一种类型。

### 4.2 `asr_daily_usage`
`(org_id, user_id, day)` → `used_seconds`。`day` 用**既有** `timezone.quotaWindowDate(userId, ts)`（用户时区优先、回落组织）以与产品其余处一致——不是本文早前写的"组织时区"。写入策略见 §6.3。

### 4.3 `media_tasks`
`id, org_id, user_id, kind, model, prompt, status, provider, upstream_task_id, result, error, idempotency_key, created_at, updated_at`。`status ∈ {queued,running,succeeded,failed,cancelled}`（**cancelled 两个 l**，对齐桌面端终态判定）。`UNIQUE(org_id, idempotency_key)`（桌面 generate 带 `Idempotency-Key` 头，做 DB 级幂等，跨副本/重启有效，取代内存 Map）。全部按 `org_id` 收窄。

## 5. API 契约（严格对齐桌面端已解析的线格式）

> 关键：桌面端是**已存在的固定客户端**，服务端响应必须匹配它实际读取的字段，否则 UI 静默为空。以下字段全部来自对桌面解析代码的核对。

统一响应信封：`{ code: 0, data: {...} }`，失败 `{ code: <数字>, message }`。鉴权 `requireActiveMember`。

### 5.1 ASR

**建会话** `POST /api/asr/realtime/sessions`
- 请求：`Content-Type: application/x-www-form-urlencoded`，body `langType=zh-CHS`（**对齐桌面现状**，路由用 `c.req.parseBody`，非 `c.req.json()`）。
- 响应 `data`（`AsrRealtimeSessionData`）：
```json
{ "requestId":"…", "wsUrl":"wss://<public-host>/api/asr/realtime?ticket=<signed>",
  "expiresInSeconds":120, "chunkIntervalMillis":200, "maxSessionSeconds":60,
  "maxConcurrentSessions":1, "usedSecondsToday":30, "remainingSecondsToday":570, "limitSecondsToday":600 }
```
- 失败码（复用 `shared/asr/constants.ts` 数值）：无 provider→`ConfigInvalid(41400)`；配额耗尽→`DailyLimitExceeded(41404)`；成员撤销→**数字码 `41602`(NotMember)**（桌面撤销机制按数字码识别，见 §7.1）。

**实时中继** `WS /api/asr/realtime?ticket=<signed>`
- **ticket**：短时（≈60s）、**单次使用**、绑定 org+user+session。ws 握手重校验成员有效（复用 `requireActiveMember` 的 `users.status` 缓存读），撤销成员拿不到会话。
- **帧协议**（服务端中继，桌面已固定）：
  - 客户端→上游：**二进制**=音频帧；**文本**=控制帧（如 `{"end":"true"}` 结束流）。中继按帧类型区分原样透传。
  - **首帧剥离 44 字节 WAV 头**（桌面 `buildPcm16WavHeader` 只加在第一帧），上游按裸 PCM16 收。
  - **事件翻译**：上游厂商事件 → **youdao 信封**（桌面 `RealtimeRecognitionBuffer` 读 `result[].seg_id`、`result[].st.sentence`、`result[].st.partial===false` 判终态）。翻译在 **adapter 内**做（vendor↔youdao 是厂商知识），中继只搬运已翻译好的事件。
  - **结束**：桌面发 `{"end":"true"}` 后等 4s 收尾事件。adapter 接口需 `finish()` 表达（见 §6.1）。
- **计量**：见 §6.3。
- 依赖：上游侧 Node24 自带可带 header 的 `WebSocket`，**无需新依赖**；**服务端**握手需引入 `ws`（本期唯一新依赖）。

### 5.2 Media（严格对齐桌面解析）

- **列模型** `GET /api/media/{images|videos}/models` → `data: [{ modelId, displayName, capabilities, parameterSpec }]`。`modelId` 必须与桌面 `canonicalizeMediaModelAliases`（`canvas-20→gpt-image-2` 等）对齐，否则别名成死代码。映射来源：`provider_keys.config.models`（或 `model_catalog` 能力列）。
- **建任务** `POST /api/media/{images|videos}/generate`，请求 `{ model, type, prompt, params }`，`type ∈ {image,video,t2v,i2v,r2v}`，带 `Idempotency-Key` 头。响应 `data: { taskId, upstreamTaskId, status, model, upstreamModel, modelSelectionReason, quotaRemaining, metadata:{ execution_expires_after } }`。
- **状态** `GET /api/media/{images|videos}/tasks/{id}` → `data: { status, resultUrls: string[], errorMessage: string }`（`errorMessage` 是**字符串**，成功时 `resultUrls` 有值）。org 收窄。
- **取消** `POST /api/media/videos/tasks/{id}/cancel` → `queued|running` 可取消。

### 5.3 服务商配置（企业控制台）
**不新增 admin 路由**。ASR/Media 上游配置走现有 `/admin/provider-keys`（扩 `protocol`/`config`）与 `/admin/models`（扩 `types` 含 `video-gen`）。鉴权沿用 `provider:view/edit`、`model:view/edit`。

## 6. 上游 Adapter 与运行时

### 6.1 Adapter 接口
```ts
interface ResolvedProviderCfg {           // 由 provider_keys 行 + providerKeyVault 产出
  id; protocol: 'realtime-asr'|'image-gen'|'video-gen'; provider; endpoint; apiKey; config: Record<string,unknown>;
}
// sampleRate 等放 provider_keys.config，adapter 自行读取。
interface AsrProvider {
  openStream(cfg, p:{langType}): Promise<AsrStream>;   // 内部负责 vendor↔youdao 事件翻译
}
interface AsrStream {
  send(pcmRaw: Buffer): void;            // 已剥离 WAV 头的裸 PCM16
  finish(): void;                        // 桌面 {end:'true'} → vendor 的结束信号
  close(): void;
  on(ev:'recognition'|'closed'|'error', cb): void;     // recognition 已是 youdao 信封；error 带 AsrApiCode
}
interface MediaProvider {
  synchronous: boolean;                  // 能力位：true=同步返回（无 task）；见 §6.4
  listModels(cfg): Promise<MediaModel[]>;
  submit(cfg,p): Promise<{ upstreamTaskId: string; immediateResult?: MediaResult }>;
  poll(cfg,upstreamTaskId): Promise<{ status; result?; errorMessage? }>;
  cancel(cfg,upstreamTaskId): Promise<void>;
}
```
注册表按 `provider_keys.protocol` 名查实现；未知 protocol → `ConfigInvalid`。首期落 Minimax 三个 adapter（realtime ASR / image / video，形态以 Minimax 官方文档为准）。

### 6.2 错误映射
上游失败经 adapter → `AsrApiCode`（`UpstreamAuthFailed 41405`、`UpstreamRateLimited 41406`、`UpstreamBalanceInsufficient 50203`、`UpstreamInvalidParams 50204` 等），经 ws `error` 事件 `code` 下发（桌面 `getFallbackAsrErrorMessage` 按这些码取文案）；建会话失败按 §5.1 数字码。**关键错误码先发 `error` 事件再关 socket**，避免一律退化成通用"服务不可用"。

### 6.3 配额计量
- **采样率**：桌面发 PCM16@16kHz（`VOICE_INPUT_TARGET_SAMPLE_RATE`）。`sampleRate` 从 `provider_keys.config` 取并传给 adapter/计量。
- **计哪些字节**：计**实际转发上游**的音频字节（剥离 WAV 头后），`seconds = bytes / (sampleRate*2)`。丢包/背压导致的未转发字节不计。
- **写回节奏**：会话内内存计数 + **每 5s 刷一次 + 关闭时刷一次**；达 `limitSecondsToday` 立即下发 `DailyLimitExceeded` 并关流。崩溃最多丢一个刷新窗口（≤5s）。
- **日界**：`timezone.quotaWindowDate(userId, ts)`。

### 6.4 Media 同步/异步归一
图像 API 常见同步返回 URL（无 task）。`MediaProvider.synchronous=true` 时：服务端仍落一条 `media_tasks`，但直接置 `succeeded` 并填 `resultUrls`，**不经 worker**。异步（视频）走 worker（§6.5）。

### 6.5 Media worker
- **多实例安全**：`SELECT … FOR UPDATE SKIP LOCKED` 领取 `queued` 任务（不依赖进程内定时器，避免 N 副本重复跑）。
- **幂等终态写**：`UPDATE … SET status=? WHERE id=? AND status='running'`——迟到的轮询结果不得覆盖 cancel 造成的终态。
- **过期**：服务端给任务设过期并暴露 `metadata.execution_expires_after`，与桌面自带超时对齐（图像 30min / 视频 10h）。

## 7. 桌面端改造

### 7.1 鉴权切换（核心修复）
- ASR `createRealtimeSession`：`getAuthTokens()+fetchWithAuth` → **企业 org JWT**（`sessionStorage.load()?.jwt`，同 `enterpriseFetchWithAuth`）。无 JWT → 未登录。
- Media **8 处** `fetchWithAuth` → 企业版（`main.ts:5529,5588,5712,5734,6244,7161,7205,9121`；6244 是后台状态轮询，漏改会静默失效）。
- **撤销感知**：现 `fetchWithAuth` 有"读到数字码 41602 → `handleEnterpriseMembershipRevocation`"钩子，`enterpriseFetchWithAuth` **没有**。ASR/media 改走企业 fetch 后需**补上同样的数字码撤销钩子**，否则被撤销的成员仍能开会话、且只看到"请登录"。

### 7.2 ASR 客户端
流式协议不变（仍连 `session.data.wsUrl`），故音频/事件逻辑基本不动；仅错误分类覆盖服务端新错误码。首帧 WAV 头、结束帧逻辑与服务端约定对齐（§5.1）。

### 7.3 Media 客户端
调用点换企业 fetch；本期不计费，积分展示维持固定值/隐藏。

### 7.4 权限（复用，不新增）
ASR/Media 的 provider/model 管理沿用现有 `provider:view/edit`、`model:view/edit`；运行时调用端（`/api/asr`、`/api/media`）用 `requireActiveMember`（同 `/proxy/*`）。**无新增权限点、无 SPA 镜像改动。**

## 8. 部署（非代码）
- **nginx 需开 WS**：`proxy_http_version 1.1` + `Upgrade`/`Connection` 头 + `proxy_read_timeout` > `maxSessionSeconds`+4s 收尾。当前 `nginx.conf.example` 缺这些，ASR 会在 nginx 而非应用层失败。Caddy 自动支持。
- **公开 wss 源**：服务端无公开地址配置且 `server.ts` 硬编码 `http://${host}`。取 `X-Forwarded-Proto`/`X-Forwarded-Host`（nginx/caddy 示例均设置），回落 `Host`，并提供可选 `PUBLIC_BASE_URL` 覆盖——避免在 TLS 终止后把 `wsUrl` 拼成 `http://`。保持 `wsUrl` 绝对（不改共享契约）。

## 9. 服务端常量归属
`AsrApiCode`/会话数据契约现定义在**桌面仓** `src/shared/asr/constants.ts`；enterprise server 是独立 npm 工程、Dockerfile 只拷 `enterprise_server/src`，**无法 import 桌面 shared**。服务端建**手工镜像** `enterprise_server/src/shared/asr/constants.ts`，并加**一致性测试**（沿用仓内既有 mirror+parity 模式，如 `web/tests/shared/*.parity.test.ts`）。

## 10. 测试策略
**服务端**：迁移（新表/约束）；ASR 会话（无 JWT 401、撤销 `41602`、provider 缺失、配额耗尽码）；ws 中继（假上游：音频帧透传+剥 WAV 头、结束帧、事件翻译成 youdao、秒数计量落库、超限关流）；Media（任务生命周期、组织隔离 A 读不到 B、幂等、取消、同步 adapter 直落终态、worker SKIP LOCKED/幂等终态写）；权限门禁；常量 parity。
**桌面端**：ASR/media 走企业鉴权分支（无 JWT 报未登录而非"已登录却 401"）、撤销钩子触发；补 media 8 处回归。

## 11. 分期
1. **P0 骨架**：扩 `provider_keys`(protocol/config) + `model_catalog`(video-gen) + 迁移 + Minimax ASR adapter + 建会话/配额（不含 ws）。
2. **P1 ASR 全代理**：`server.ts` 加 ws upgrade、中继+WAV 剥头+事件翻译+计量+错误码；桌面端 ASR 切企业鉴权，端到端打通。
3. **P2 Media**：任务表+worker+四接口（对齐 §5.2 线格式）；桌面端 media 8 处切企业鉴权。
4. **P3**：更多 adapter、配额可配、（日后）积分计费。

## 12. 风险
| 风险 | 对策 |
|---|---|
| ws 依赖 + `upgrade` 改造是新增基建（服务端无 ws） | P1 核心风险，先 spike 验握手/中继/背压 |
| 事件翻译 vendor↔youdao 是厂商知识 | 收在 adapter 内；契约（youdao 信封）由 §5.1 固定，先落一个参考 adapter |
| nginx 不支持 WS / read_timeout 过短 | §8 部署项，实施前改配置 |
| 多副本并发/幂等 | worker SKIP LOCKED + 终态条件写 + DB 幂等键 |
| media 不计费被误用 | UI/文档标注"不计费" |
| 桌面端鉴权面收窄影响其它功能 | 只改 ASR/media 两处为企业 fetch，逐个回归 |

## 13. 待确认（实施前敲定，不阻塞）
- 首个 ASR adapter 目标厂商/协议：已定 **Minimax**，具体端点/协议形态待对照其官方文档。
- media 图像/视频首批厂商：已定 **Minimax**。