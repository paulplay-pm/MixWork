# 企业控制台「模型配置」：厂商能力分区 + 统一模型清单

日期：2026-10-25
状态：待评审
关联文档：`docs/superpowers/specs/2026-10-23-asr-media-enterprise-backend-design.md`（ASR/媒体后端既有设计，本设计是它的补完，不是推翻）

---

## 1. 背景：今天的三处错位

### 1.1 左侧栏列的是「凭证行」，不是「厂商」

`provider_keys` 一行 = 一份凭证 = 一种上游协议。控制台左侧栏直接列 `provider_keys` 行，于是同一个厂商在栏里出现多次。当前线上数据：

| provider_keys.id | provider | protocol | label |
|---|---|---|---|
| `builtin:org-e6da8a5a:minimax` | minimax | openai | minimax |
| `25cb9722-…` | minimax | realtime-asr | MiniMax 语音识别 |
| `251839dd-…` | minimax | image-gen | MiniMax 图像生成 |
| `10aa2e9e-…` | minimax | video-gen | MiniMax 视频生成 |

用户要在 4 个入口之间来回切，才知道「这是同一家 MiniMax」。这正是本次要解决的第一件事。

### 1.2 「API 协议」被当成厂商的属性

`provider_keys.protocol` 是**上游线路 / 适配器**（请求怎么发、用哪个 adapter、Base URL 填哪个），不是厂商的属性。现在它和厂商名绑在同一张表单卡上，用 radio 单选，于是「一家厂商同时提供 OpenAI 兼容和图像生成」这种再正常不过的情况，只能靠拆成多个侧栏条目来表达。

### 1.3 模型清单有两套数据源

| | 存放位置 | 字段 | 表格能力 |
|---|---|---|---|
| 对话模型 | `model_catalog` | 类型 / 上下文窗口 / 参数 / 启用开关 | 完整 |
| 图像 / 视频 / 语音识别模型 | `provider_keys.config.models[]` | 只有 `modelId` + `displayName` | 无类型列、无启用开关、无默认模型 |

结果是媒体模型在控制台里只能以「一行一个 ID」的纯文本形式存在，**进不了 `model_catalog`**，也拿不到「类型 / 上下文窗口 / 已启用 / 操作」这套表格。

### 1.4 由此产生的服务端路由缺陷（本次必须一起修）

- `GET /api/media/{kind}/models` 用 `findMediaProvider(orgId, protocol)` 取
  `WHERE org_id=$1 AND enabled AND protocol=$2 ORDER BY created_at ASC LIMIT 1` ——
  **只返回最早创建的那一家厂商的模型**，别家的模型根本不出现在列表里。
- `POST /api/media/{kind}/generate` **完全忽略 `body.model` 来选上游** ——
  请求发给谁由 `created_at` 决定，跟 LLM 指定的模型无关。**两个厂商都开了图像生成时，请求会静默走错厂商。**
- `POST /api/asr/realtime/sessions` 同理取第一行；ASR 的模型名藏在 `provider_keys.config.model`（默认 `asr-1.0`）里，不进 `model_catalog`、不暴露给客户端。

所以「将来除了 MiniMax，也配了别家（比如 kimi）的图像/视频模型，同时启用时桌面端怎么选」这个问题，今天在服务端**没有可用的选择机制**——不是界面没做，是数据模型缺了「模型 → 厂商」这一层。

---

## 2. 目标 / 非目标 / 反目标

### 目标

- **G1 厂商卡片**：厂商名下多选能力类型（LLM(VLM) / 语音识别 / 图像生成 / 视频生成），每个类型一段独立配置（Base URL / API Key / 模型清单）。
- **G2 模型清单统一**：所有类型的模型都进 `model_catalog`，用同一套表格格式（模型 / 类型 / 上下文窗口 / 已启用 / 操作）+ 获取模型 + 添加模型。
- **G3 路由确定**：请求里指定的模型唯一决定上游厂商；不再由 `created_at` 决定。
- **G4 默认模型**：每种类型可设一个默认模型，标记打在 `model_catalog` 行上；未指定模型时按确定顺序回退。
- **G5 消歧**：两个厂商提供同名模型时（如都有 `image-01`），客户端能区分、路由能选对。

### 非目标

- 不做桌面端的媒体 / 语音模型选择 UI。桌面端维持「LLM 挑模型」的现状，本期只把**服务端的选择能力**补齐。
- 不做计费 / 积分。
- 不做语音合成（`tts`）的上游线路——目前没有 adapter，模型类型词汇表里保留 `tts` 但不开放配置入口。
- 不做嵌入 / 重排的独立能力分区（它们走 LLM 那条线路，见 §3.2 映射表）。
- 不重做 `/proxy/*` 的对话代理链路（它已经按 `model_catalog.id` 路由，无重名问题）。

### 反目标（做到即失败）

- **不能把厂商卡片做成「一个厂商只能有一份凭证」。** 同厂商多凭证（含内置 + 自定义同 slug）是产品既有能力——migration 039 整篇就是在为这件事让路。
- **不能让媒体 / 语音模型出现在桌面的对话模型选择器里。**（今天 `/admin/catalog` 和 `listEnabledForOrg` 都不过滤类型，媒体模型一旦进 `model_catalog` 就会泄漏。见 §9。）
- **不能让桌面端直接调用厂商 API。** 桌面端永远只走 Enterprise server（现状如此，本设计保持）。

---

## 3. 核心概念：两条正交轴

|  | 存哪 | 取值 | 回答什么问题 |
|---|---|---|---|
| **API 协议** protocol | `provider_keys.protocol` | `openai` / `anthropic` / `realtime-asr` / `image-gen` / `video-gen` | **跟谁说话、怎么说** —— 上游线路、适配器、Base URL |
| **模型类型** types | `model_catalog.types` | `chat` / `vision` / `reasoning` / `image-gen` / `embedding` / `rerank` / `asr` / `tts` / `video-gen` | **能做什么** —— 模型能力 |

判据一句话：**协议是连接方式，类型是能力。** 一条凭证只有一种协议；一个模型可以有多个类型（`chat`+`vision`+`reasoning`）。

界面上把协议藏进「能力分区」里：分区是用户能操作的概念，协议是分区内部的实现细节。

### 3.1 能力分区与协议、类型的映射

| 能力分区（UI） | 协议（`provider_keys.protocol`） | 该分区下允许的模型类型 |
|---|---|---|
| LLM(VLM) | `openai` **或** `anthropic`（二选一） | `chat` / `vision` / `reasoning` / `embedding` / `rerank` |
| 语音识别 | `realtime-asr` | `asr` |
| 图像生成 | `image-gen` | `image-gen` |
| 视频生成 | `video-gen` | `video-gen` |

`embedding` / `rerank` 归入 LLM(VLM) 分区：它们走的是同一条 OpenAI 兼容线路（`/v1/embeddings`），不需要独立的上游协议。

### 3.2 命名约定

- **厂商卡片**（card）：一个 `provider_cards` 行，代表「一家厂商」。
- **能力分区**（section）：卡片下的一段能力，对应**一行 `provider_keys`**。
- **模型清单**：分区下的模型，全部是 `model_catalog` 行。

---

## 4. 界面方案

### 4.1 卡片结构

```
┌ MiniMax ────────────────────────────────────────────────────┐
│  [测试]  [保存]                                  启用  [ ● ]  │
│                                                            │
│  能力类型                                                     │
│   ▣ LLM(VLM)    ▣ 语音识别    ▣ 图像生成    ▣ 视频生成        │
│                                                            │
│  ┌─ LLM(VLM) ────────────────────────────────────────┐       │
│  │ 协议   ( ● OpenAI 兼容   ○ Anthropic 兼容 )        │       │
│  │ Base URL   [ https://api.minimaxi.com/v1       ]   │       │
│  │ Coding Plan [ ○ ]                                │       │
│  │ API Key    [ •••••••••••• ]  (留空 = 不修改)       │       │
│  │ ── 模型清单 (9) ────────────────────────────────── │       │
│  │ 模型              类型        上下文窗口  已启用  操作│      │
│  │ MiniMax-M3       对话        200K       ●     ✎ 🗑 │      │
│  │ MiniMax-M2.7     对话        200K       ○     ✎ 🗑 │      │
│  │ MiniMax-VL       对话·视觉   200K       ●     ✎ 🗑 │      │
│  │ [获取模型]   [添加模型]                            │      │
│  └───────────────────────────────────────────────────┘       │
│                                                            │
│  ┌─ 图像生成 ──────────────────────────────────────┐         │
│  │ Base URL   [ https://api.minimaxi.com         ]  │         │
│  │ API Key    [ •••••••••••• ]                     │         │
│  │ ── 模型清单 (2) ───────────────────────────────── │         │
│  │ image-01        图像生成   —        ●     ✎ 🗑   │         │
│  │ image-01-live   图像生成   —        ●     ✎ 🗑   │         │
│  │ [获取模型(不可用)]   [添加模型]                   │         │
│  └───────────────────────────────────────────────────┘         │
└────────────────────────────────────────────────────────────┘
```

### 4.2 交互规则

1. **能力类型 chips = 哪些分区存在。**
   - 勾选一个未配置的类型 → 新建该分区（`POST /admin/provider-keys { cardId, protocol }`），展开其表单。
   - 取消勾选 → **删除该分区**（内置分区除外，见下）。删除会连带删除该分区下的 `model_catalog` 行，弹确认框并列出将被删除的模型数。
   - **内置分区不可取消勾选。** 内置凭证行（`is_builtin`）不可删除——今天控制台也是这个规则（rail 里内置行没有删除按钮）。取消勾选内置分区 = 提示「内置能力不可移除」，改为停用该分区（`enabled=false`）。
2. **卡片头部「启用」开关 = 厂商总开关。** 关闭 → 卡片下所有分区 `enabled=false`；打开 → 恢复为各分区自身的状态。
3. **协议单选（LLM(VLM) 分区）**：`openai` ↔ `anthropic` 切换 = 就地改这一行的 `protocol`。
   - 切换会作废该分区现有的模型清单（模型的类型标签与新协议不再匹配），因此**弹确认框**「切换协议将清空该分区的 N 个模型，需要重新获取模型」。
   - `Coding Plan` 开关只在 `openai` 协议下显示（现状如此）。
4. **模型清单表格复用现有组件**（`ModelList` / `ModelTableRow`），列不变：**模型 / 类型 / 上下文窗口 / 已启用 / 操作**。
   - **新增「默认」标记**：打在**类型 chip 上**（见 §7），不新增列。
   - 媒体/语音分区的「上下文窗口」显示 `—`（`contextLabel(null)` 已有此行为）。
5. **「获取模型」只对 LLM(VLM) 分区可用**（只有 chat 协议有 `/v1/models`）。媒体 / 视频 / 语音分区按钮置灰，tooltip 说明「该协议不支持自动获取模型，请手动添加」。
   - 现状：服务端对非 chat 协议已经返回 `not_a_chat_provider` / `unsupported_provider`，前端 `ModelList` 已有 `canRefresh` 开关 —— 沿用即可。
6. **「添加模型」打开现有 `ModelDrawer`**，但类型 chip 按分区锁定（见 §5.3）。

### 4.3 左侧栏

从「列 `provider_keys` 行」改为「列厂商卡片」：

- 一行 = 一张卡片，显示：品牌方块 + 卡片显示名 + 能力标签（如 `LLM · 图像 · 视频`）+ 模型总数徽章 + 启用开关。
- 内置 / 自定义两段保留。卡片是内置的 = 其分区里含内置凭证行。
- 卡片行上的启用开关 = 卡片总开关（同 4.2.2）。删除按钮只对「整卡都是自定义行」的卡片显示。

---

## 5. 数据模型

### 5.1 新增 `provider_cards`（migration 058）

```sql
CREATE TABLE IF NOT EXISTS provider_cards (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL,          -- 厂商 slug ('minimax')
  label      TEXT,                   -- 卡片显示名；NULL → 用 providerDisplayName(slug)
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 限定名前缀在 org 内唯一。限定名是 `COALESCE(label, provider)`（见 §8.2），
-- 所以唯一性必须落在「前缀」上，而不是 (slug, label)—— 否则
-- 「provider=minimax, label=NULL」和「provider=minimax, label='minimax'」
-- 两张卡会得到同一个前缀，在媒体链路里无法区分。
CREATE UNIQUE INDEX IF NOT EXISTS provider_cards_org_prefix
  ON provider_cards (org_id, COALESCE(label, provider));

ALTER TABLE provider_keys
  ADD COLUMN IF NOT EXISTS card_id TEXT REFERENCES provider_cards(id) ON DELETE SET NULL;
```

**为什么不用「按 slug 分组」省掉这张表**：内置 `deepseek` 与自定义 `deepseek` 同 slug 共存是产品既有能力（migration 039 明确为此把 `model_catalog` 的唯一性从 `(org_id, provider, model)` 改到 `(org_id, provider_key_id, model)`）。按 slug 分组会把它们并进一张卡片，而卡片内「LLM(VLM) 分区单选协议」表达不了「两份 openai 兼容凭证」。显式的 `card_id` 让「一张卡片 = 一组语义上同属一家厂商的分区」成为可存储的事实。

**回填**（058 内，一条数据迁移）：

1. 按 `(org_id, provider, protocol)` 把现有 `provider_keys` 分组，组内按
   `(is_builtin DESC, created_at ASC, id ASC)` 排序，序号 `n`（从 0 开始）即该行的 **slot**。
   `card_id = 'card:' || md5(org_id || ':' || provider || ':' || slot)`。
2. **同一 slot 的所有行落在同一张卡片**；不同 slot 落在不同卡片。
   - 效果：一个厂商的不同协议（openai / realtime-asr / image-gen / video-gen）slot 都是 0 → **一张卡片**。
   - 同厂商同协议的两行（例如内置 `deepseek` + 自定义 `deepseek`）slot 分别是 0 和 1 → **两张卡片**。
3. 卡片 `label`：slot 0 → `NULL`（控制台用 `providerDisplayName(slug)` 兜底）；slot > 0 → `provider || ' #' || (slot + 1)`，管理员可改名。
4. 唯一索引建在 `(org_id, COALESCE(label, provider))` 上 —— 限定名前缀在 org 内唯一（见 §5.1）。
   - slot 0 的前缀是 slug，slot 1 的前缀是 `slug #2` → 不冲突。
   - 同 slug 同协议的两张卡：前缀分别是 `deepseek` 和 `deepseek #2` → 不冲突。

回填结果：12 行 `provider_keys` → 9 张卡片（anthropic / deepseek / minimax / moonshot / openai / qwen / volc / xiaomi / zhipu），MiniMax 卡片含 4 个分区。

> **迁移里不能写 PL/pgSQL。** 生产迁移器按 `;\s*(?:\n|$)` 切分语句（`src/db/migrate.ts` 的 `splitStatements`），`$$ … ; … $$` 的函数体会在内部被切开。回填只能用纯 SQL（窗口函数 + `INSERT … SELECT`）。

### 5.2 模型清单与默认模型（migration 059）

```sql
-- 1. 媒体模型的参数规格（原来只在 provider_keys.config.models[].parameterSpec 里）
ALTER TABLE model_catalog
  ADD COLUMN IF NOT EXISTS parameter_spec JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 2. 每种类型一个默认模型
CREATE TABLE IF NOT EXISTS model_type_defaults (
  org_id   TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  type     TEXT NOT NULL,
  model_id TEXT NOT NULL REFERENCES model_catalog(id) ON DELETE CASCADE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, type)     -- ← 「一种类型只能有一个默认」由主键保证
);
```

**为什么默认标记不直接做成 `model_catalog.is_default` 列**：
一个模型行可以带多个类型（`chat`+`vision`），而「默认」是**按类型**定义的——同一个模型可以同时是 chat 的默认和 vision 的默认。Postgres 的部分唯一索引无法表达「TEXT[] 的每个元素各出现一次」（`unnest` 是 set-returning，不能进索引表达式）。用 `model_type_defaults` 的 `(org_id, type)` 主键来保证唯一性，是唯一能做到「一模型可兼任多个类型默认」且「约束落在数据库」的做法。

> **徽章仍然打在 `model_catalog` 行上**（用户已确认）：模型表格的「类型」列里，默认模型在它默认的那个类型 chip 上挂一个「默认」徽章。存储在 join 表，展示在 model_catalog 行上——这是本设计对「默认模型标记打在 model_catalog 行上」的实现方式。

**回填**（059 内）：

1. 把 `provider_keys.config.models[]` 里的每个 `modelId` 灌成 `model_catalog` 行：
   - `provider_key_id` = 该 `provider_keys` 行 id；`provider` = 该行 provider；`model` = modelId；`display_name` = 原来的 displayName。
   - `types` 按该行 protocol 推导：`image-gen` → `['image-gen']`；`video-gen` → `['video-gen']`；`realtime-asr` → `['asr']`。
   - `parameter_spec` = 原来的 `parameterSpec`（当前 MiniMax 没有 → `{}`）。
   - `enabled` = true。
2. ASR 分区（`realtime-asr`）：`config.model`（若为空则 `asr-1.0`，见 `DEFAULT_ASR_MODEL`）如果不在 catalog 里，**补建一行** `model = 'asr-1.0'`, `types = ['asr']`，并把它设为 type `asr` 的默认模型。
3. `provider_keys.config` 里的 `models` 与 `config.model` **保留不动**（回滚保险），但**读路径全部切到 `model_catalog`**。`config.limitSecondsToday`（ASR 每日秒数上限）继续留在 `config` 里，不动。
   - 注：`config.models` 与 `config.model` 留作 legacy，服务端不再读。写路径也不再写（`PATCH /admin/provider-keys` 若带 `config.models` 则忽略）。

### 5.3 模型类型词表

- 服务端 `ModelTypes`（`src/models/modelCatalog.ts`）已有 9 个值（含 `VideoGen: 'video-gen'`）。
- **前端 `src/api/models.ts` 的 `ModelTypes` 缺 `VideoGen`** → 补上，并加 `TYPE_VALUE_LABEL_KEY` / `TYPE_BG` 条目（`providersModels.model.typeVideoGen`）。
- `model_catalog.types` 是 `TEXT[]` 且**没有 CHECK 约束**（migration 032），加 `video-gen` **不需要迁移**。

### 5.4 Admin API 变更

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin/provider-cards?orgId=` | 列卡片（含分区数组：protocol / baseUrl / apiKeyMasked / enabled / modelCount / isBuiltin） |
| POST | `/admin/provider-cards` | `{ orgId, provider, label? }` → 建卡片（无分区） |
| PATCH | `/admin/provider-cards/:id` | `{ label?, enabled? }` → 改名 / 总开关 |
| DELETE | `/admin/provider-cards/:id` | 删卡片 + 全部分区 + 全部模型 |
| POST | `/admin/provider-keys` | **新增 `cardId` 字段**（现有接口扩展）→ 在指定卡片下新建分区 |
| PATCH | `/admin/provider-keys/:id` | 现有；`protocol` 可改（LLM 分区切协议）；`config.models` 被忽略 |
| PATCH | `/admin/models/:id` | **新增 `defaultForType?: string \| null`** → 设/清某类型的默认模型 |

---

## 6. 模型清单：model_catalog 成为唯一来源

### 6.1 数据流

```
控制台 模型抽屉
   → POST/PATCH /admin/models  (providerKeyId = 分区的 provider_keys.id)
   → model_catalog 行
        ↓
GET /api/media/{kind}/models   (按 types 过滤, enabled)
GET /api/asr/models（新增）
GET /admin/catalog              (按类型过滤, 只给对话模型)
GET /enterprise-models          (按类型过滤, 只给对话模型)
```

`provider_keys.config.models` 退出读路径。

### 6.2 媒体模型清单的对外形状

`GET /api/media/{kind}/models` 现在的返回是 `[{ modelId, displayName, capabilities, parameterSpec }]`（`MediaModelDescriptor`）。新返回：

```ts
{
  code: 0,
  data: [
    {
      modelId: 'minimax/image-01',   // 限定名（见 §8）
      displayName: 'image-01',
      provider: 'minimax',           // 厂商 slug（新增字段）
      capabilities: ['image-gen'],   // 由 model_catalog.types 派生
      parameterSpec: { … },
    },
  ],
  defaultModel: 'minimax/image-01',  // 该类型的默认模型（新增字段）
}
```

`capabilities` 直接由 `types` 派生，**不新增列**（`MediaModelDescriptor.capabilities` 本来就是 `string[]`）。

### 6.3 ASR 模型清单

新增 `GET /api/asr/models`，形状同上（`types = ['asr']`），带 `defaultModel`。

---

## 7. 默认模型

- **存储**：`model_type_defaults (org_id, type, model_id)`。
- **设置**：模型抽屉里，每个类型 chip 旁有「设为默认」；再次点击取消。服务端 `PATCH /admin/models/:id { defaultForType: 'image-gen' | null }`。
- **展示**：模型表格的「类型」列，默认模型在对应类型的 chip 上挂「默认」徽章（`providersModels.model.defaultBadge`）。
- **约束**：一个类型只有一个默认；`model_type_defaults` 主键保证。设置新默认时 `ON CONFLICT (org_id, type) DO UPDATE`。
- **删除模型**：`ON DELETE CASCADE` 自动清掉默认记录。

---

## 8. 模型 ID 消歧

### 8.1 问题

`model_catalog` 的唯一性是 `(org_id, provider_key_id, model)`——两个厂商可以都有 `image-01`。而媒体链路的线上契约里模型是一个裸字符串（`MediaModelDescriptor.modelId`），客户端把它原样回传。

### 8.2 方案：限定名 + 裸名兜底

**对外模型 id = `<厂商>/<模型>`**（厂商 = 卡片显示名，为空时用 slug），例如 `minimax/image-01`。
- 厂商显示名由 `COALESCE(card.label, card.provider)` 得到；(slug, label) 在 org 内唯一 → 限定名唯一。
- 客户端拿到的 `modelId` **原样回传**，不做加工。
- **裸名兜底**：当 `body.model` 是不带 `/` 的裸名时，按裸名匹配；若命中多行，走 §9.3 的回退链（默认模型优先），并在 `modelSelectionReason` 里写明「`image-01` 有多个厂商同名，已选用默认模型 minimax/image-01」。

**桌面端兼容性**：`canonicalizeMediaModelId` 是一张纯别名表（`canvas-20→gpt-image-2` 等），限定名不在表里，**原样透传**，无需改动。

### 8.3 对话模型不受影响

桌面的对话模型选择器用 `model_catalog.id`（UUID）作身份（`mapEnterpriseModelsToModels` 里 `id: model.id`），`/proxy/*` 也按 `model_id` 走 `modelCatalog.getById` —— **对话链路本来就没有重名问题**，本期不动。限定名只用于媒体 / ASR 这两条按名字寻址的链路。

---

## 9. 服务端路由：模型 → provider_key

### 9.1 媒体生成（修 §1.4 的 bug）

`POST /api/media/{kind}/generate` 的选上游逻辑改为：

```
1. 查该类型下已启用的候选模型：
     model_catalog.enabled AND provider_keys.enabled AND types && [kind 类型]
2. 若 body.model 精确命中（限定名或唯一裸名）→ 用它
3. 否则回退链（§9.3）
4. 用命中行的 provider_key_id 解析凭证 → 提交上游
5. media_tasks 记录 model + provider_key_id（列已存在，migration 055）
```

`media_tasks.provider_key_id` 已经存在，worker 已经按它 `resolveConfig` —— **只缺「选哪一行」这一步**。

### 9.2 ASR

`POST /api/asr/realtime/sessions`（桌面端表单只传 `langType`，不传 model）：

```
1. type='asr' 的默认模型 → 其 provider_key_id
2. 没有默认 → 第一个启用的 asr 模型 → 其 provider_key_id
3. 都没有 → 该类型第一个启用的 asr 分区（provider_keys）
4. 都没有 → ConfigInvalid（现状）
```

模型名写进 `ResolvedAsrConfig.config.model`（adapter 已经在读 `config.model`），使上游实际用到的模型与 catalog 一致。

### 9.3 回退链（用户已确认）

> **LLM 显式指定的模型 → 该类型的默认模型 → 该类型第一个启用的模型**

落地为服务端统一逻辑（媒体 / ASR 共用）：

| 情形 | 选择 | `modelSelectionReason` |
|---|---|---|
| 显式模型唯一命中 | 它 | `explicit` |
| 显式模型命中多行（同名） | 该类型默认模型；无默认则第一个启用的 | `ambiguous_fallback` |
| 显式模型未命中 | 该类型默认模型；无默认则第一个启用的 | `not_found_fallback` |
| 都没有 | HTTP 400 `no_provider_configured` | — |

「第一个启用的模型」= 同类型、同 org、`enabled` 且所属分区 `enabled`，`ORDER BY created_at ASC, id ASC` —— **确定**，不是数据库返回顺序。

> 桌面端目前会在 LLM 没给模型时**先拦下请求**（`resolveEffectiveMediaSelection` 返回 `source:'none'` → gate 拒绝），所以「不指定模型 → 用默认」这条链在桌面端需要一处改动（见 §10.2）。**服务端先具备该能力，桌面端改造放 P2 分期。**

### 9.4 类型过滤：堵住对话选择器的泄漏

今天这两个接口**都不按类型过滤**：

- `GET /admin/catalog`（`src/routes/admin/catalog.ts`）—— 把 `model_catalog.list(orgId)` 原样返回。
- `enterpriseModels.listEnabledForOrg`（`src/models/enterpriseModels.ts`）—— 桌面对话模型选择器的数据源。

媒体 / ASR 模型一旦进 `model_catalog`，就会出现在桌面的对话模型下拉里。**必须加过滤**：

```sql
AND c.types && ARRAY['chat','vision','reasoning']::text[]
```

即「至少有一种会话能力」。当前线上 30 行 `model_catalog` 全是 chat/vision/reasoning，**这个过滤对现有数据零影响**。

- `embedding` / `rerank` 被排除在外：桌面的嵌入走的是 `cowork_config.embeddingProvider/embeddingModel` 独立配置（本地/远端），不消费企业 catalog；`rerank` 目前无消费者。将来要接，再单独开口子。
- `decryptKeysForOrg`（`src/models/enterpriseModels.ts`）用同一条过滤，避免给不返回的模型解密密钥。

---

## 10. 桌面端

### 10.1 不变的部分

- 桌面端**不新增**媒体 / 语音模型选择 UI。
- 桌面端**不直接调用厂商 API**；调用链不变：
  `LLM(OpenClaw) → openclaw-extensions/mixcwork-media-generation → 桌面 media bridge → Enterprise server /api/media/{kind}/generate → 厂商`。
- 桌面端只负责：把 LLM 指定的模型名原样发给服务端；用服务端返回的模型清单做**校验**（`resolveEffectiveMediaSelection` 的 `availableModelIds`）。

### 10.2 需要改的部分（P2 分期）

1. **允许不带 model 的生成请求**：
   - `GET /api/media/{kind}/models` 的响应带 `defaultModel`。
   - `src/main/main.ts` 里 `createMediaModelAvailabilityCache({ fetchModels })`（约 4992 行）的 fetch 现在只读 `body.data`；改为同时读 `body.defaultModel`，并把它带回缓存条目。
   - `src/main/media/mediaModelAvailability.ts`：`MediaModelAvailabilityEntry` 增加 `defaultModel?: string`；`get()` 返回的条目集合携带它（缓存 key 仍是 account+kind，60s TTL 不变）。
   - `src/main/media/mediaSelectionFallback.ts` 的 `resolveEffectiveMediaSelection` 增加 `defaultModelId` 入参；无显式模型但有默认模型时，返回 `{ selection: { mode, modelId: defaultModelId }, source: 'default' }`。
   - `MediaSelectionResolutionSource` 增加 `'default'`。
   - `src/main/main.ts` 的 media 工具分支（约 5185 行）：把可用模型列表里的 `defaultModel` 传进 `resolveEffectiveMediaSelection`。
   - 现有的 fail-closed 行为**不变**：显式模型不在清单里 → 仍然 `unavailableModel`，不回退。回退只发生在「LLM 根本没指定模型」这一种情况。
2. **回显实际使用的模型**：服务端已在 `taskWire` 里回 `model` / `upstreamModel` / `modelSelectionReason`；桌面端把 `modelSelectionReason` 透给 LLM（「实际使用：minimax/image-01，因为 image-01 有两个厂商同名」）。

### 10.3 桌面端不需要改的部分

- `canonicalizeMediaModelId`：限定名不在别名表里，原样透传。
- `/proxy/*` 对话链路：按 `model_catalog.id` 路由，不受影响。

---

## 11. 兼容与迁移

| 变更 | 兼容做法 |
|---|---|
| 侧栏从凭证行变卡片 | 058 回填后即生效；`provider_keys` 的 `card_id` 为 NULL 的行（理论上不会残留）在读取时按自身成卡兜底 |
| 媒体模型从 `config.models` 移到 `model_catalog` | 059 回填；`config.models` 保留但不再被读 |
| `config.model`（ASR 默认模型）→ `model_type_defaults` | 059 回填；`config.model` 保留但不再被读 |
| `/api/media/{kind}/models` 返回限定名 | 桌面端原样回传，`canonicalizeMediaModelId` 透传；**旧桌面端**把 `minimax/image-01` 当裸名回传也匹配不上 → 服务端对「带 `/` 但未命中」也走回退链，不会 500 |
| `/admin/catalog`、`/enterprise-models` 加类型过滤 | 对现有 30 行数据零影响 |
| 媒体生成改按模型选上游 | 行为变化：**单厂商时结果完全一致**（原来也只有一家可选）；多厂商时从「静默走错」变成「按模型选对」 |
| 迁移文件不可变 | 058 / 059 都是**新文件**，不改已应用过的迁移 |

---

## 12. 测试策略

### 服务端（`enterprise_server/tests/`，vitest）

- **迁移**：058 回填后，`provider_keys` 每行都有 `card_id`；同厂商的行归到同一张卡；`provider_cards` 数量 = 9（当前数据）。059 回填后，`image-01` / `image-01-live` / 4 个 `MiniMax-H3*` 出现在 `model_catalog` 且 types 正确；`asr-1.0` 存在且是 type `asr` 的默认。
- **卡片 API**：建卡 → 加分区 → 列卡（分区数组正确）→ 改分区协议（LLM openai→anthropic，清空该分区模型）→ 删卡（连带删分区与模型）。
- **唯一性**：同 org 同 `(slug, label)` 建第二张卡 → 409；同 org 同 slug 不同 label → 允许。
- **媒体路由**：
  - 两个 image-gen 分区（不同厂商）→ `GET /api/media/images/models` 返回**两家的模型**，各带限定名与 `provider`。
  - `POST /api/media/images/generate { model: 'kimi/image-01' }` → `media_tasks.provider_key_id` 指向 kimi 那行，**不是**创建最早的那行。
  - 显式模型不存在 → 回退到默认模型，`modelSelectionReason = 'not_found_fallback'`。
  - 显式裸名命中多行 → 回退到默认模型，`modelSelectionReason = 'ambiguous_fallback'`。
  - 没有任何启用模型 → 400 `no_provider_configured`。
  - 幂等：同 `Idempotency-Key` 两次 → 只提交一次上游（现有行为不回归）。
- **ASR**：默认模型可配 → 会话用默认模型的 provider_key；无默认 → 第一个启用的 asr 分区；无任何配置 → `ConfigInvalid`。
- **类型过滤**：`model_catalog` 里塞一行 `types=['image-gen']` → `GET /admin/catalog` 与 `GET /enterprise-models` **不包含**它。
- **默认模型唯一性**：`PATCH /admin/models/:id { defaultForType: 'image-gen' }` 两次 → `model_type_defaults` 只有一行，后者胜出。
- **权限**：卡片与默认模型沿用 `provider:view/edit`、`model:view/edit`；运行时调用端仍用 `requireActiveMember`。

### 前端（`enterprise_server/web/tests/`，vitest + @testing-library/react）

- 卡片渲染：一个厂商一张卡，MiniMax 显示 4 个分区。
- 能力 chips：勾选未配置的类型 → 调 `POST /admin/provider-keys { cardId, protocol }`；取消勾选自定义分区 → 调 `DELETE` 并弹确认。
- 协议切换：`openai → anthropic` → 弹确认「将清空 N 个模型」。
- 模型表格：默认模型的类型 chip 带「默认」徽章；非默认不带。
- 「获取模型」：媒体/视频/语音分区按钮禁用。
- 模型抽屉：类型 chip 按分区锁定（图像分区只有「图像生成」可选）。
- i18n：所有新文案 zh / en 都有。

### 会被改动到的新增/修改测试文件

服务端：
- `tests/media/routes.test.ts`、`tests/media/generateFlow.test.ts`（模型清单来源、路由选择、回退链）
- `tests/asr/sessionRoute.test.ts`（默认模型选分区）
- `tests/models/modelCatalog.test.ts`（`parameter_spec`、默认模型）
- `tests/models/enterpriseModels.test.ts`（类型过滤）
- `tests/models/providerProtocolTypes.test.ts`（协议词表）
- `tests/db/migrate058.test.ts`、`tests/db/migrate059.test.ts`（迁移回填，遵循既有 `migrate05x.test.ts` 约定）
- `tests/db/migrateDrift.test.ts`（已应用迁移不可变，058/059 必须是新文件）

前端：
- `tests/pages/ProvidersModelsPage.test.tsx`（数据源从 provider keys 换成 cards → 大改）
- `tests/pages/providersModels/ProviderRail.test.tsx`（列卡片 → 大改）
- `tests/pages/providersModels/ProviderInfoCard.test.tsx`（表单拆进 `CapabilitySection` → 大改）
- `tests/pages/providersModels/ModelList.test.tsx`（默认徽章、`canRefresh`）
- `tests/pages/ModelDrawer.test.tsx`（类型锁定、设默认）
- `tests/api/modelTypes.test.ts`（补 `video-gen`）
- `tests/api/providers.test.ts`（`cardId`）
- `tests/visual/providers.spec.ts`（视觉快照，UI 改动后需更新）

### 桌面端（`src/`，vitest）

- `resolveEffectiveMediaSelection`：无显式模型 + 有默认 → `source: 'default'`，选默认模型。
- 显式模型优先于默认。
- 显式模型不在清单里 → 仍走 `unavailableModel`（桌面端保持 fail-closed，**不回退**，回退是服务端的事）。

### 手工验证

- `npm run electron:dev` + 企业服务：控制台配两个图像生成厂商 → 桌面端 `action=list` 看到两个带厂商前缀的模型 → 让 LLM 分别指定 → 确认 `media_tasks.provider_key_id` 落在对应厂商。

---

## 13. 分期

| 期 | 内容 | 产出 |
|---|---|---|
| **P0** | migration 058（cards）+ 059（parameter_spec / model_type_defaults / 回填）；`providerCards` 模型 + admin API | 控制台侧栏仍是旧形态，但数据模型就位 |
| **P1** | 控制台卡片 UI（厂商卡片 + 能力分区 + 统一模型清单 + 默认徽章） | 管理员在一个卡片里配完一家厂商的所有能力 |
| **P2** | 服务端路由改造（媒体按模型选上游、ASR 按默认模型、回退链、类型过滤）+ 桌面端允许无 model 生成 | 多厂商并存时行为正确 |
| **P3** | 更多 adapter、配额可配、（日后）积分计费 | — |

**P1 与 P2 的顺序可交换**，但 P1 单独上线时「媒体模型清单」已经来自 `model_catalog`（059 回填），服务端路由还是旧的（取第一行）——**多厂商场景下会是错的**。因此推荐 **P0 → P2 → P1**：先把路由修对，再换界面。

> **推荐顺序：P0 → P2 → P1 → P3。**

---

## 14. 风险

| 风险 | 对策 |
|---|---|
| 回填把内置 + 自定义同 slug 合并成一张卡，导致卡片内同协议两行 | 058 里实现「拆卡」分支；当前数据不触发，但代码必须实现（§5.1.3） |
| 媒体模型进 `model_catalog` 后泄漏进桌面对话模型下拉 | §9.4 类型过滤 + 专门的回归测试 |
| 桌面端旧版本把限定名当裸名回传 → 匹配不上 | 服务端对未命中的显式模型走回退链，不 500（§9.3） |
| LLM 在多个厂商同名模型间摇摆 | 回退链 + `modelSelectionReason` 回显；默认模型给一个确定答案 |
| 桌面端「不指定模型」的改造涉及 gate 逻辑 | 放 P2；`resolveEffectiveMediaSelection` 有单测覆盖三种来源 |
| 迁移文件不可变（ledger 按文件名） | 058 / 059 都是新文件，不动已应用的迁移 |
| `model_type_defaults` 引入第二处模型配置来源 | 它只存「哪个模型是某类型的默认」这一个指针，不复制模型属性；`model_catalog` 仍是模型的唯一真相 |

---

## 15. 我的决策（供审阅时重点看）

以下是用户没有明确表态、由我判断的部分。每条都标明了「如果我判断错了会怎样」。

| # | 决策 | 理由 | 判断错的后果 |
|---|---|---|---|
| D1 | **允许一张卡片里只有「一个 LLM(VLM) 分区」，协议 openai/anthropic 单选** | 用户原话「在选择LLM(VLM)类型时再单选openai/anthropic」 | 想要同厂商同时提供两种兼容线路时，需要再建一张卡片（slug 相同、label 不同），而不是在卡片内并列两段 |
| D2 | **引入 `provider_cards` 表**，而不是按 slug 分组 | 同 slug 多凭证是产品既有能力（migration 039），按 slug 分组会破坏它 | 如果「同厂商只允许一份凭证」才是产品意图，这张表是多余的，可以退回按 slug 分组，migration 058 可整体删除 |
| D3 | **默认模型存 `model_type_defaults` join 表，徽章打在 `model_catalog` 行上** | 一模型可兼任多类型默认，而 PG 部分唯一索引无法对 TEXT[] 逐元素去重 | 存储位置与用户「标记打在 model_catalog 行上」的措辞不完全一致（展示位置是一致的）；若坚持物理列，需要放弃「一模型可任多类型默认」 |
| D4 | **取消勾选能力分区 = 删除该分区**（内置分区除外，内置只停用） | 与今天「自定义行可删、内置行不可删」的规则一致 | 若希望「取消勾选 = 仅停用、可随时恢复」，则分区需要保留模型行，删除语义要改 |
| D5 | **「获取模型」在媒体 / 视频 / 语音分区禁用**，只支持手动添加 | 这些协议没有 `/v1/models` 端点，服务端已经这么回 | 若厂商后续提供模型列表端点，需要在 adapter 层加 `listModels` 的真实实现 |
| D6 | **`tts`（语音合成）不开放能力分区** | 服务端没有 TTS adapter，`/api/tts/*` 不存在 | 需求方要求语音合成时，需要新增 adapter + 路由 + 一条 `provider_keys.protocol` 取值（`tts`）+ 迁移改 CHECK 约束 |
| D7 | **对话模型选择器排除 `embedding` / `rerank`** | 桌面的嵌入走 `cowork_config.embedding*` 独立配置，不消费企业 catalog | 将来要把企业 catalog 的嵌入模型接给桌面记忆系统时，需要放开这两个类型 |
| D8 | **限定名用 `厂商/模型`，厂商 = 卡片显示名（空则 slug）** | (slug, label) 在 org 内唯一，限定名因此唯一 | 卡片改名会让限定名变化；桌面端有 60s 缓存，短时间内可能拿到旧名 → 走回退链（不 500） |
| D9 | **迁移按 P0 → P2 → P1 排**（先修路由再换界面） | P1 单独上线时，多厂商场景下服务端仍会走错厂商 | 若坚持先出界面，需要在 P1 里保留旧的「取第一行」路由并接受多厂商不正确 |
| D10 | **回退链的「第一个启用的模型」按 `created_at ASC, id ASC`** | 需要确定性 | 若期望按「最近配置的优先」，改排序即可 |
| D11 | **切换 LLM 协议会清空该分区模型清单** | 模型类型标签与新协议不再匹配 | 若希望保留模型（只是线路变了），则需按新协议重打类型标签 |

---

## 16. 改动面（给实施者的地图）

### 服务端 `enterprise_server/`

| 文件 | 动作 |
|---|---|
| `src/db/migrations/058_provider_cards.sql` | 新建：`provider_cards` 表 + `provider_keys.card_id` + 回填 |
| `src/db/migrations/059_model_catalog_media.sql` | 新建：`model_catalog.parameter_spec` + `model_type_defaults` + 媒体/ASR 模型回填 |
| `src/models/providerCards.ts` | 新建：卡片的 CRUD + 分区读写 |
| `src/models/modelCatalog.ts` | 改：`parameter_spec` 进 SELECT 列；加 `listByType`、`setDefaultForType`、`clearDefaultForType` |
| `src/routes/admin/providerCards.ts` | 新建：卡片 admin 路由 |
| `src/routes/admin/providerKeys.ts` | 改：add 接受 `cardId`；patch 忽略 `config.models` |
| `src/routes/admin/models.ts` | 改：patch 接受 `defaultForType` |
| `src/routes/admin/catalog.ts` | 改：按 `types && [chat,vision,reasoning]` 过滤 |
| `src/models/enterpriseModels.ts` | 改：`listEnabledForOrg` / `decryptKeysForOrg` 加同一过滤 |
| `src/routes/media.ts` | 改：模型清单改读 `model_catalog`；生成按模型选上游；加 `defaultModel`；回退链 |
| `src/routes/asr.ts` | 改：按默认模型选分区；新增 `GET /api/asr/models` |
| `src/media/providers/minimax.ts` | 改：`listModels` 改为从传入的 catalog 模型读（不再 echo `config.models`） |
| `src/asr/providers/minimax.ts` | 改：`config.model` 由服务端解析结果注入 |
| `src/org/builtinProviders.ts` | 改：内置 provider 种子同时建卡片 |

### 前端 `enterprise_server/web/`

| 文件 | 动作 |
|---|---|
| `src/pages/ProvidersModelsPage.tsx` | 改：数据源从 provider keys 换成 cards；保存/测试按分区下发 |
| `src/pages/providersModels/ProviderCard.tsx` | 新建：厂商卡片外壳 + 能力分区 |
| `src/pages/providersModels/CapabilitySection.tsx` | 新建：单个分区（协议 radio / Base URL / API Key / 模型清单） |
| `src/pages/providersModels/ProviderRail.tsx` | 改：列卡片 |
| `src/pages/providersModels/ProviderInfoCard.tsx` | 拆：表单字段迁入 `CapabilitySection` |
| `src/pages/providersModels/ModelList.tsx` | 改：默认徽章；`canRefresh` 按分区 |
| `src/pages/providersModels/ModelTableRow.tsx` | 改：类型 chip 上的默认徽章 |
| `src/pages/providersModels/ModelDrawer.tsx` | 改：类型按分区锁定；每类型「设为默认」 |
| `src/pages/providersModels/modelType.tsx` | 改：补 `video-gen` 标签/配色 |
| `src/api/providers.ts` | 改：`add` 接受 `cardId`；新增卡片 API |
| `src/api/providerCards.ts` | 新建 |
| `src/api/models.ts` | 改：补 `VideoGen`；`patch` 支持 `defaultForType` |
| `src/i18n.ts` | 改：新增文案 zh + en |

### 桌面端 `src/`

| 文件 | 动作 |
|---|---|
| `src/main/media/mediaSelectionFallback.ts` | 改：`defaultModelId` 入参 + `source: 'default'` |
| `src/main/media/mediaModelAvailability.ts` | 改：缓存带 `defaultModel` |
| `src/main/main.ts` | 改：把 `defaultModel` 传进解析；回显 `modelSelectionReason` |

---

## 17. 待确认（不阻塞实施）

- 首个要支持多厂商并存的类型：图像生成 / 视频生成 / 语音识别，实施时按实际优先级排。
- 卡片显示名是否允许与另一张同 slug 卡片重名：当前实现禁止（唯一索引），如需允许要改成「限定名里带卡片 id 后 6 位」。
