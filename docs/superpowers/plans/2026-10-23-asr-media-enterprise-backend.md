# ASR / Media 企业后端补全 + 客户端鉴权重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让语音输入（ASR）和图像/视频生成（Media）在企业登录下端到端可用：在 enterprise server 上补出 `/api/asr/*`（ws 全代理）与 `/api/media/*`（任务式），并把桌面端两处从消费者 `auth_tokens` 切到企业 org JWT。

**Architecture:** 配置复用现有 `provider_keys`（扩 `protocol` 加 `realtime-asr/image-gen/video-gen` + `config` JSONB）+ `model_catalog`（补 `video-gen` 类型）；运行时新增 ASR ws 中继（服务端持有上游 key，音频帧经服务端转发、识别事件翻译成 youdao 信封、服务端权威计量每日秒数）与 Media 任务表 + worker。首个厂商 Minimax。

**Tech Stack:** Hono + Postgres（测试 pglite）+ `ws`（本期唯一新增依赖，仅服务端握手）+ Vitest；桌面端 Electron main/preload。

**Spec:** `docs/superpowers/specs/2026-10-23-asr-media-enterprise-backend-design.md`

## Global Constraints

- 路由挂在根：`POST /api/asr/realtime/sessions`、`WS /api/asr/realtime`、`/api/media/*`。
- **不新增 `service_providers` 表、不新增 `service_provider:*` 权限点**（复用 `provider_keys`+`model_catalog` 与 `model:*/provider:*`）。
- 运行时路由鉴权用 `requireActiveMember`；配置管理沿用现有 `provider:view/edit`、`model:view/edit`。
- 响应信封 `{ code, data }`；**失败码严格用 `shared/asr/constants.ts` 数字**（撤销成员返回数字 `41602`，桌面据此触发撤销，`'not_member'` 字符串不行）。
- 桌面端已解析的线格式是**固定客户端契约**：ASR 事件是 youdao 信封、首帧带 44B WAV 头、结束帧文本 `{"end":"true"}`；Media 信封 `{code,data}`、`data.resultUrls`/`data.errorMessage`（字符串）、终态 `cancelled`（两个 l）。服务端必须对齐，不得"顺手改干净"。
- 服务端测试**按文件跑**（整包 vitest 会撞 fd 上限 EBADF）。
- 每任务 TDD，提交信息 Conventional Commits（英文）。

## Review Focus

1. **被撤销的成员**在 ASR/Media 上必须拿到数字码 `41602` 并触发桌面撤销，而不是看到"请登录"。
2. **首帧 WAV 头**若未剥离，上游会把 44B 头当噪声且配额多算一帧。
3. **Media 终态拼写** `cancelled`（两个 l）——写错桌面端会永远轮询。
4. **多副本/重启**下 media worker 不得重复跑任务、幂等键跨重启有效（不能再用内存 Map）。
5. **nginx 无 WS 升级配置**——否则 ASR 在 nginx 层就断，不在应用层。

---

### Task 1: 迁移 `054_asr_media.sql`（扩 provider_keys + 新表）

**Files:**
- Create: `enterprise_server/src/db/migrations/054_asr_media.sql`
- Test: `enterprise_server/tests/db/migrate.test.ts`（增量）

**Interfaces:**
- Consumes: 现有迁移链；`provider_keys` 的 `protocol` CHECK 来自 031
- Produces:
  - `provider_keys.protocol` 域扩为 `openai|anthropic|realtime-asr|image-gen|video-gen`
  - `provider_keys.config JSONB NOT NULL DEFAULT '{}'`
  - `asr_daily_usage(org_id, user_id, day DATE, used_seconds INTEGER, PRIMARY KEY(org_id,user_id,day))`
  - `media_tasks(id, org_id, user_id, kind CHECK image|video, model, prompt JSONB, status, provider, upstream_task_id, result JSONB, error JSONB, idempotency_key TEXT, created_at, updated_at, UNIQUE(org_id, idempotency_key))` + `INDEX(org_id, status, created_at DESC)`

- [ ] **Step 1: 写失败测试**（`migrate.test.ts`）：`runMigrations()` 后断言 `provider_keys.config` 列存在、`protocol` 接受 `'realtime-asr'`、`asr_daily_usage`/`media_tasks` 存在、`media_tasks(org_id,idempotency_key)` 唯一。
- [ ] **Step 2: 跑测试确认失败**（列/表不存在）
- [ ] **Step 3: 实现迁移**（`IF NOT EXISTS` 幂等；protocol 的 CHECK 用 `DROP CONSTRAINT IF EXISTS` 后重建，因 SQLite/pglite 与 PG 语法差异，参照 031 的写法）
- [ ] **Step 4: 跑测试通过**
- [ ] **Step 5: 提交** `feat(db): add asr/media tables and widen provider protocol`

---

### Task 2: 扩 `MODEL_TYPE_VALUES` + `ProviderKeyView.protocol`

**Files:**
- Modify: `enterprise_server/src/models/modelCatalog.ts`（`ModelTypes` 加 `VideoGen:'video-gen'`）
- Modify: `enterprise_server/src/vault/providerKeyVault.ts`（`ProviderKeyView.protocol` 类型加宽）
- Test: `enterprise_server/tests/models/modelCatalog.test.ts`（若有）或新 `tests/models/modelCatalogTypes.test.ts`

**Interfaces:**
- Produces: `ModelTypes.VideoGen = 'video-gen'`；`ProviderKeyView.protocol: 'openai'|'anthropic'|'realtime-asr'|'image-gen'|'video-gen'`

- [ ] **Step 1: 写失败测试**：`MODEL_TYPE_VALUES` 含 `'video-gen'`；admin models 校验能接受 `types:['video-gen']`
- [ ] **Step 2: 跑测试失败**
- [ ] **Step 3: 实现**（两个文件各加一字/类型加宽）
- [ ] **Step 4: 跑测试通过**
- [ ] **Step 5: 提交** `feat(models): add video-gen model type and widen provider protocol`

---

### Task 3: ASR adapter 接口 + 注册表 + Minimax 骨架

**Files:**
- Create: `enterprise_server/src/asr/types.ts`（`ResolvedAsrConfig`、`AsrStream` 接口，见 spec §6.1）
- Create: `enterprise_server/src/asr/registry.ts`（`asrAdapterRegistry`，按 `protocol` 查实现）
- Create: `enterprise_server/src/asr/providers/minimax.ts`（首期骨架：能 `openStream` 但厂商协议以 Minimax 官方文档为准，先放可测试的桩）
- Test: `enterprise_server/tests/asr/registry.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface AsrStream { send(pcmRaw: Buffer): void; finish(): void; close(): void;
    on(ev:'recognition'|'closed'|'error', cb:(...a:unknown[])=>void): void; }
  interface AsrProvider { openStream(cfg: ResolvedAsrConfig, p:{langType:string}): Promise<AsrStream>; }
  // registry: get(protocol) => AsrProvider | undefined
  ```

- [ ] **Step 1: 写失败测试**：未知 protocol → `undefined`；注册 Minimax 后 `get('realtime-asr')` 命中（若 Minimax 的 protocol 名就是 `realtime-asr`）
- [ ] **Step 2: 跑测试失败**
- [ ] **Step 3: 实现** 接口+注册表+桩
- [ ] **Step 4: 跑测试通过**
- [ ] **Step 5: 提交** `feat(asr): add provider adapter registry with minimax skeleton`

---

### Task 4: ASR 建会话路由（不含 ws）

**Files:**
- Create: `enterprise_server/src/routes/asr.ts`（`POST /api/asr/realtime/sessions`）
- Modify: `enterprise_server/src/server.ts`（注册）
- Test: `enterprise_server/tests/routes/asr.test.ts`

**Interfaces:**
- Consumes: `requireActiveMember`、`providerKeyVault.getDecrypted`、Task3 registry、Task5 quota
- Produces: `asrRoutes: Hono`；`POST /api/asr/realtime/sessions`（form-urlencoded `langType`）
  - 成功：`{ code:0, data: AsrRealtimeSessionData }`（`wsUrl` 先放占位/相对，Task6 补真 wss）
  - 失败：无 provider→`41400`；配额耗尽→`41404`；非成员→数字 `41602`

- [ ] **Step 1: 写失败测试**：无 JWT 401；被撤销成员 401 + 数字 `41602`；form-urlencoded `langType=zh-CHS` 被接受；`c.req.json()` 不用于此路由；无 provider 时 `code 41400`
- [ ] **Step 2: 跑测试失败**
- [ ] **Step 3: 实现**：`c.req.parseBody()`；按 `model_catalog.types` 找 asr 模型→`provider_key`→解 key→registry；写会话数据
- [ ] **Step 4: 跑测试通过**
- [ ] **Step 5: 提交** `feat(asr): add realtime session creation endpoint`

---

### Task 5: ASR 配额访问器

**Files:**
- Create: `enterprise_server/src/asr/quota.ts`
- Test: `enterprise_server/tests/asr/quota.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface AsrQuota { usedSecondsToday:number; remainingSecondsToday:number; limitSecondsToday:number; }
  getAsrQuota(orgId,userId,limit): Promise<AsrQuota>
  addAsrSeconds(orgId,userId,seconds): Promise<void>   // 日界用 timezone.quotaWindowDate
  ```

- [ ] **Step 1: 写失败测试**：跨日重置、累计、`remaining = limit - used`
- [ ] **Step 2: 跑测试失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑测试通过**
- [ ] **Step 5: 提交** `feat(asr): add daily usage accounting`

---

### Task 6: server.ts 加 ws upgrade 支持

**Files:**
- Modify: `enterprise_server/src/server.ts`（`createServer` 的 `server.on('upgrade', …)`）
- Modify: `enterprise_server/package.json`（加 `ws`）
- Test: `enterprise_server/tests/asr/wsUpgrade.test.ts`

**Interfaces:**
- Produces: `upgrade` 处理：`/api/asr/realtime` 路径 → ws 握手，其余 404；为 Task7 提供已握手 socket

- [ ] **Step 1: 写失败测试**：发 upgrade 到 `/api/asr/realtime` 得到 101；其它路径不升级
- [ ] **Step 2: 跑测试失败**
- [ ] **Step 3: 实现**（`WebSocketServer({ noServer:true })` + `handleUpgrade`）
- [ ] **Step 4: 跑测试通过**
- [ ] **Step 5: 提交** `feat(server): add websocket upgrade for asr relay`

---

### Task 7: ASR ws 中继（剥 WAV 头、事件翻译、计量、错误码）

**Files:**
- Create: `enterprise_server/src/asr/realtimeRelay.ts`
- Test: `enterprise_server/tests/asr/realtimeRelay.test.ts`（假上游）

**Interfaces:**
- Consumes: Task3 registry、Task5 quota、`ticket` 签发/校验（新 `src/asr/ticket.ts`）
- Produces: `handleAsrSocket(ws, ticket): Promise<void>`
  - 校验 ticket（单次、绑定 org/user/session、TTL≈60s）→ 重验成员有效
  - 二进制帧：剥首帧 44B WAV 头 → `adapterStream.send(pcmRaw)`
  - 文本帧：`{"end":"true"}` → `adapterStream.finish()`
  - `recognition` 事件：上游已翻译成 youdao 信封，透传
  - `error` 事件：带 `code` 下发后关流；`closed` 透传
  - 计量：转发字节 / (sampleRate*2)，每 5s 刷 + 关闭刷；达上限回 `DailyLimitExceeded`

- [ ] **Step 1: 写失败测试**：帧透传、首帧剥头、结束信号、事件透传、错误码下发、秒数计量、超限关流（用假 AsrProvider）
- [ ] **Step 2: 跑测试失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑测试通过**
- [ ] **Step 5: 提交** `feat(asr): relay realtime audio through the server`

---

### Task 8: 服务端 asr 常量镜像 + parity

**Files:**
- Create: `enterprise_server/src/shared/asr/constants.ts`（镜像桌面 `src/shared/asr/constants.ts` 的 `AsrApiCode`/`AsrRealtimeSessionData`/事件类型）
- Test: `enterprise_server/tests/shared/asrParity.test.ts`

**Interfaces:**
- Produces: 服务端 `AsrApiCode` 数字与桌面一致

- [ ] **Step 1: 写失败测试**：parity 测试 import 桌面 `src/shared/asr/constants.ts` 与服务端副本，断言 `AsrApiCode` 逐键相等
- [ ] **Step 2: 跑测试失败**
- [ ] **Step 3: 实现**镜像
- [ ] **Step 4: 跑测试通过**
- [ ] **Step 5: 提交** `chore(asr): mirror asr constants into the server with parity test`

---

### Task 9: 桌面端 ASR 鉴权切换（核心修复）

**Files:**
- Modify: `src/main/ipcHandlers/asr/handlers.ts`（`getAuthTokens`→企业 JWT；`fetchWithAuth`→企业版）
- Modify: `src/main/main.ts`（为 ASR 提供企业 token/fetch；补数字 `41602` 撤销钩子）
- Test: `src/main/ipcHandlers/asr/handlers.test.ts`（或就近新增）

**Interfaces:**
- Consumes: `sessionStorage.load()?.jwt`；`enterpriseFetchWithAuth` 加撤销钩子
- Produces: ASR 会话请求带 `Authorization: Bearer <orgJwt>`；无 JWT → 未登录；`41602` → 撤销

- [ ] **Step 1: 写失败测试**：只有企业 JWT（无 `auth_tokens`）时能发起会话；无 JWT 时报未登录；服务端回 `41602` 时触发撤销
- [ ] **Step 2: 跑测试失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑测试通过**
- [ ] **Step 5: 提交** `fix(asr): authenticate realtime sessions with the enterprise JWT`

---

### Task 10: 桌面端 ASR 客户端错误码覆盖

**Files:**
- Modify: `src/renderer/services/voiceInput/realtimeAsrClient.ts`（覆盖新服务端错误码分类）
- Test: 就近 `*.test.ts`

- [ ] **Step 1: 写失败测试**：服务端 `error` 事件带 `UpstreamAuthFailed(41405)` 等码时，`getFallbackAsrErrorMessage` 取对文案
- [ ] **Step 2-5: 常规 TDD 流程 + 提交** `fix(voice): surface asr upstream error codes`

---

### Task 11: Media adapter 接口 + Minimax 骨架

**Files:**
- Create: `enterprise_server/src/media/types.ts`（`MediaProvider`、`synchronous` 能力位、`ResolvedMediaConfig`）
- Create: `enterprise_server/src/media/registry.ts`
- Create: `enterprise_server/src/media/providers/minimaxImage.ts`、`minimaxVideo.ts`
- Test: `enterprise_server/tests/media/registry.test.ts`

**Interfaces:**
- Produces: `MediaProvider`（`listModels/submit/poll/cancel`）、`synchronous: boolean`

- [ ] **Step 1: 写失败测试**：registry 未知 protocol → undefined；`synchronous` 位可读
- [ ] **Step 2-5: TDD + 提交** `feat(media): add provider adapter registry with minimax skeleton`

---

### Task 12: Media 路由（严格对齐桌面线格式）

**Files:**
- Create: `enterprise_server/src/routes/media.ts`（4 接口）
- Modify: `enterprise_server/src/server.ts`（注册）
- Test: `enterprise_server/tests/routes/media.test.ts`

**Interfaces:**
- Consumes: Task11 registry、`requireActiveMember`、Task1 `media_tasks`
- Produces: `mediaRoutes: Hono`；`GET /api/media/{images|videos}/models`、`POST /api/media/{images|videos}/generate`、`GET /api/media/{images|videos}/tasks/{id}`、`POST /api/media/videos/tasks/{id}/cancel`
- **线格式**（spec §5.2）：`data.resultUrls`、`data.errorMessage`（字符串）、`status cancelled`（两个 l）、generate 带 `Idempotency-Key` 幂等

- [ ] **Step 1: 写失败测试**：信封 `{code,data}`；generate 返回 `data.taskId`；status 返回 `data.resultUrls`/`data.errorMessage`；终态 `cancelled`（两 l）；组织隔离（A 读不到 B 的 task）；幂等键去重
- [ ] **Step 2: 跑测试失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑测试通过**
- [ ] **Step 5: 提交** `feat(media): add generation endpoints matching the desktop wire format`

---

### Task 13: Media worker（SKIP LOCKED + 幂等终态 + 过期）

**Files:**
- Create: `enterprise_server/src/media/worker.ts`
- Test: `enterprise_server/tests/media/worker.test.ts`

**Interfaces:**
- Produces: `runMediaWorkerOnce()`：`FOR UPDATE SKIP LOCKED` 领 `queued`，`synchronous` 直接置终态，异步 `poll`；终态写 `WHERE status='running'`；过期任务置 `failed`

- [ ] **Step 1: 写失败测试**：并发领任务不重复；迟到结果不覆盖 `cancelled`；过期任务落 `failed` 并返回 `execution_expires_after`
- [ ] **Step 2-5: TDD + 提交** `feat(media): add idempotent task worker`

---

### Task 14: 桌面端 Media 8 处鉴权切换

**Files:**
- Modify: `src/main/main.ts`（8 处 `fetchWithAuth`→企业版，行 5529/5588/5712/5734/6244/7161/7205/9121）
- Test: 就近新增/增量

- [ ] **Step 1: 写失败测试**：企业登录下 media 列表/建任务带 org JWT；无 JWT 报未登录
- [ ] **Step 2-5: TDD + 提交** `fix(media): authenticate generation calls with the enterprise JWT`

---

### Task 15: 全量验证

- [ ] **Step 1: 服务端** `tsc -p tsconfig.build.json --noEmit` + `eslint --ext ts --report-unused-disable-directives --max-warnings 0 <改动文件>`
- [ ] **Step 2: 服务端测试按文件跑**（新 asr/media 相关 + 受影响 models/catalog/routes）
- [ ] **Step 3: 桌面端** 受影响文件 tsc/lint/test
- [ ] **Step 4: 手工**：起 enterprise server + 桌面端，语音输入录一句（观察中继日志、识别文字、配额递减）；media 生成一张图/一段视频（观察任务终态）
- [ ] **Step 5: nginx** 确认 `Upgrade`/`Connection`/`proxy_read_timeout` 已配（否则 ASR 在 nginx 层断）

## Review Focus → 归属任务
1. 撤销成员 41602 → Task4/Task9
2. WAV 头剥离 → Task7
3. `cancelled` 两 l → Task12
4. worker 幂等/跨重启 → Task13
5. nginx WS → Task15 Step5