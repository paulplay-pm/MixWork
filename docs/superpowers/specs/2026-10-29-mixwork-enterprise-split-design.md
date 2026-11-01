# MixWork / MixWork-Enterprise 拆分设计 —— 两个独立仓库、独立发版、独立契约

日期：2026-10-29
状态：**设计稿**（待批准 → 转 `superpowers:writing-plans`）

决策来源标注：`[裁定]` = 本次讨论中用户明确拍板；`[判断]` = 我的默认选择，实现者可以推翻。

---

## 1. 意图

把企业服务端从 MixWork 桌面端仓库里剪切出去，成为独立仓库 **MixWork-Enterprise**，
让两个项目由不同团队维护、各自独立发版与回滚。

拆分的直接目标（三条，`[裁定]`）：

1. **服务端能独立发版和回滚** —— 不再被桌面端的发布节奏拖住。
2. **两边的构建流水线彻底分开** —— 桌面端的构建不依赖服务端源码躺在同一个仓里；
   服务端的镜像构建不依赖桌面端仓库做构建上下文。
3. **两个仓由不同的人/团队维护** —— 各自有 `AGENTS.md` / `CLAUDE.md`、各自的 CI、各自的版本。

注意这次拆分的性质：**桌面端与服务端在运行时早就解耦了**（走 HTTP，服务端地址运行时决定）。
所以这不是运行时改造，是**仓库结构与构建/发布责任**的拆分。契约层是唯一需要真正动手改的代码。

---

## 2. 现状盘点（已核对源码）

### 2.1 运行时已经是解耦的

桌面端访问企业服务端走 HTTP，服务端地址在运行时决定，三条来源：

- 构建期烘焙：`scripts/generate-enterprise-build-info.cjs` 读 `ENTERPRISE_SERVER_URL` →
  写 `.enterprise-build/enterprise.json` → 打包进 `process.resourcesPath/enterprise/`。
- 启动种子：`src/main/libs/enterpriseServerUrlConfig.ts`。
- 用户可改：`src/main/auth/enterpriseServerUrlStore.ts`（SQLite）+ `src/renderer/setup/EnterpriseSetupModal.tsx`。

### 2.2 真正缠在一起的是构建与发布

| 位置 | 现状 | 拆分后 |
|---|---|---|
| `enterprise_server/Dockerfile` | `COPY enterprise_server/web/...`、`COPY enterprise_server/src/...`，构建上下文是 MixWork 仓库根 | COPY 路径改为仓内相对路径，上下文 = 新仓根 |
| `scripts/package-enterprise-server.sh` | 以仓库根为 docker context，`REPO_ROOT` 推导 `enterprise_server/Dockerfile`；脚本里的注释还声称 `enterprise_server` 是仓库根的 npm workspace、lock 在根 `package-lock.json` —— **实际根 `package.json` 没有 `workspaces` 字段，服务端有自己的 lockfile**，注释是陈旧的 | 迁移到新仓，上下文 = 新仓根，注释一并更正（`enterprise_server/.npmrc` 里"隔离父 monorepo 的 workspace hoist"那段也随之失效） |
| `scripts/build-enterprise-image.sh` | 同上，`-f enterprise_server/Dockerfile` | 迁移到新仓 |
| `.gitea/workflows/enterprise-server.yml` | `working-directory: enterprise_server`，只跑测试、**不出镜像** | 迁移到新仓；补 tag 触发的镜像构建 |
| 根 `package.json` | `enterprise:install` / `enterprise:test` / `enterprise:init` / `enterprise:dev` 指向 `enterprise_server` | 删除，或改为指向兄弟仓的本地开发便利脚本（`[判断]`：保留便利脚本，路径 `../MixWork-Enterprise`，**不是构建依赖**） |
| `scripts/security-check.cjs` | 同时扫 `src/main/auth` 与 `enterprise_server/src`、`enterprise_server/web/src`、`enterprise_server/web-dist` | 拆成两半（`[判断]`） |

还有一个硬缺口：**服务端根本没有版本号**。`enterprise_server/package.json` 没有 `version` 字段，
版本号只在 Docker 构建时由 `ARG VERSION` 注入、tag 由 `--tag` 手工传。独立发版必须先补上版本号来源。

### 2.3 契约层：两边各抄一份，而且已经漂了

服务端的权威来源是 `enterprise_server/src/shared/*`（**741 行 / 6 个文件**）：

| 文件 | 行数 | 内容 |
|---|---|---|
| `src/shared/enterpriseServerConstants.ts` | 190 | PermissionCode（旧粗粒度）、AuditAction、LoginErrorCode 等 |
| `src/shared/auditActionMeta.ts` | 263 | 审计动作的中英文标签与语气 |
| `src/shared/auditTargetTypeMeta.ts` | 92 | 审计对象类型的标签与语气（被 `src/analytics/{auditQuery,dashboard}.ts` 消费） |
| `src/shared/permissionPoints.ts` | 93 | **细粒度**权限点、角色→权限点映射、数据范围 |
| `src/shared/asr/constants.ts` | 96 | ASR 线上常量 |
| `src/shared/providerKeys/constants.ts` | 7 | provider key 相关 |

一共三份副本：

1. **服务端 web 控制台**：`enterprise_server/web/src/shared/*`（474 行）。因为同仓，它的 parity 测试能直接
   import 权威模块来比对（`web/tests/shared/auditActionMeta.parity.test.ts`），**双向**都能抓到漂移。
2. **桌面端**：`src/shared/enterpriseAccount/{constants,loginErrorCodes,proxyWireSignals,quotaError,types}.ts`、
   `src/shared/asr/constants.ts`、`src/shared/htmlShare/constants.ts`、`src/shared/sso/binding.ts`、
   `src/shared/mcp/constants.ts`、`src/shared/skills/constants.ts`。**只有注释提醒同步，没有任何自动检查**。
   另有两块**桌面端自有的镜像，服务端没有对应物**：`src/shared/site/constants.ts`（261 行）、
   `src/shared/publishing/constants.ts`（132）、`src/shared/shareDeployment/constants.ts`（296）——
   它们对应的是服务端**尚未实现**的 `/api/sites*` 资源族（见附录 A 与 §12 待确认项）。
3. **桌面端的 `EnterpriseRole`**（`src/shared/enterprise/constants.ts`）：定义了，**全仓一次都没被引用** —— 死代码。

**角色词表有四份互相打架的定义**（reviewer 核对）：

| 来源 | 角色集合 |
|---|---|
| 服务端 `src/shared/enterpriseServerConstants.ts` 的 `Role` | `super_admin` / `admin` / `user` —— **陈旧**，真实种子角色里没有 `admin` 和 `user` |
| 服务端 `src/shared/permissionPoints.ts` 的 `BUILTIN_ROLE_POINTS` | 9 个：`super_admin` / `org_admin` / `dept_admin` / `auditor` / `dev` / `member` / `model_admin` / `policy_admin` / `agent_admin` |
| 服务端 `src/db/migrations/029_seed_roles_v2.sql` 实际种子 | 同上 9 个 |
| 服务端 `src/routes/roleVocabulary.ts` 的 `CORE_ROLES` | 5 个（子集） |

`admin` 是**遗留别名** —— 服务端 `src/auth/roleResolver.ts` 把它映射成 `org_admin`；
而 `/me` 返回的是用户表里的原始 `extra_roles`，别名会原样出现在线上。

**病根不是"漂移"，是设计错误**（`[裁定]` 修正）：角色是**用户自定义**的 —— 管理员可以在管理台
建任意权限组合的自定义角色，所以**任何写死在代码里的角色词表都是错的**，桌面端根本不该有。

症状只是表象：桌面端 `src/renderer/components/EnterpriseMtAccountMenu.tsx` 的 `roleLabelKey()` 只认
`'super_admin' / 'admin'`，其余落到 `default`（中文标签是「成员」）。9 个真实内置角色里有 8 个在桌面端
显示成「成员」，包括组织管理员 `org_admin` —— 而自定义角色更是 100% 显示成「成员」。

正确的解法不是"把 9 个内置角色补进桌面端"（那只是把硬编码从 3 个扩到 9 个），而是**服务端把角色的
显示名一起返回，桌面端不翻译**。详见 §6。

**类型契约也在漂移**：桌面端 `MeView` 写成了
`{ id; effective_roles; membersCanSubmitSkills?; [k: string]: unknown }` —— 手写类型早就放弃了精确形状。

### 2.4 隐藏的文件系统依赖（剪切当天就会踩的坑）

- **`src/shared/asr/asrConstantsParity.test.ts` 直接 import 服务端源码**：
  `import * as server from '../../../enterprise_server/src/shared/asr/constants'`。
  该文件自己的注释写着 "This test lives in the DESKTOP repo because only this side can reach across
  and import both files." —— 拆分后这句话不再成立，桌面端 `npm test` 会在剪切当天就红。
- `scripts/security-check.cjs` 扫 `enterprise_server/src` 与 `enterprise_server/web/src`。
- 历史 `docs/superpowers/plans/**`、`docs/superpowers/specs/**` 大量提到 `enterprise_server/` 路径
  （`[判断]`：这些是历史记录，**不改写**）。

### 2.5 个人模式已经存在

个人模式 = 没配 `ENTERPRISE_SERVER_URL`、没有 `enterpriseMt` bridge：
`src/renderer/App.tsx` 的 `probeEnterpriseBootstrap` 在 bridge 缺失时直接放行。
账号身份已按 `personal:` / `enterprise:` 前缀隔离（`src/shared/auth/accountOwner.ts`）；
artifact 分享/部署的订阅闸门已按 `accountMode` 分流（`src/renderer/components/artifacts/artifactSubscriptionGate.ts`）；
`src/main/libs/catalogResolver.ts` 在企业端不可达时清空列表降级。**这一层已经是"失败即降级"的形状。**

---

## 3. 目标 / 非目标 / 反目标

### 目标

1. 企业服务端成为独立仓库、独立 CI、独立版本号、独立镜像发版与回滚。
2. 桌面端仓里不再有任何 `enterprise_server/` 源码，也不再有任何指向服务端源码的 import。
3. 两边的构建流水线互不依赖：桌面端构建不需要服务端仓库，服务端镜像构建不需要桌面端仓库。
4. 桌面端与服务端之间的契约收敛为**单一真相 + 运行时可校验**，两边不再各抄一份并靠人肉同步。
5. 个人模式保持完全离线可用：不连 MixWork-Enterprise 也能启动、能用。

### 非目标（本轮不做）

- 不做服务端内部架构重构，不改业务语义，不改数据模型。
- 不把管理控制台 SPA（`web/`）拆成第三个仓库 —— 它跟着服务端走。
- 不引入私有 npm 包 / 共享 SDK 包来分发契约（`[裁定]`：走生成 + 提交进仓的形状契约）。
- 不做全站 OpenAPI 改造（`[裁定]` 契约范围选 (b)，不是 (c)）。
- 不改鉴权模型、不改部署形态：`ENTERPRISE_SERVER_URL` 的三段式机制原样保留。

### 反目标（做到了也算失败）

- 拆分后桌面端必须连上服务端才能启动或使用个人模式。
- 拆分后桌面端的构建 / CI 需要 checkout 服务端仓库才能跑通（**只有契约新鲜度检查这一个只读例外**）。
- 拆分后进入一段"两边契约对不上"的静默期 —— 漂移必须被机器检出。

---

## 4. 约束

| 约束 | 说明 |
|---|---|
| 镜像仓库 | Gitea 自带容器仓库 `paulgitea.iepose.cn/paul/enterprise-server`（`[裁定]`） |
| CI | Gitea Actions（`.gitea/workflows/`） |
| Node | `>=24.15.0 <25`（两边同） |
| 数据库 | PostgreSQL 14+（容器内 `postgresql16-client`），开发用 pglite |
| 服务端部署 | `mixwork-server` CLI + docker compose，现有模型不变 |
| 桌面端打包 | electron-builder，`.enterprise-build/enterprise.json` 烘焙企业端地址，机制不变 |
| 两个团队 | 契约真相与生成器归服务端团队；桌面端团队只负责 sync 脚本与生成产物（`[裁定]`） |
| CI 运行器 | Gitea Actions **当前没有注册任何 runner**，需先注册 `act_runner`（运维前置条件） |
| 仓库可见性 | 两个仓都是私有仓，跨仓拉契约产物需要 Gitea PAT |
| 许可 | 服务端 **BSL 1.1**（Change License: Apache 2.0，Change Date: 发布日 + 4 年）；契约产物单独 MIT/CC0；桌面端保持 MIT（`[裁定]`） |

---

## 5. 拆分后的形态

### 5.1 MixWork-Enterprise（新仓，服务端）

服务端放**仓根**，不再保留 `enterprise_server/` 这一层前缀（`[判断]`）。

```
MixWork-Enterprise/
├── src/                      # 服务端（从 enterprise_server/src 搬上来）
├── web/                      # 管理控制台 SPA（独立 npm 工程，保留自己的 lockfile）
├── tests/                    # vitest（pglite）
├── seeds/kits/
├── scripts/patch-esm-imports.mjs
├── contract/                 # [新] 契约产物
│   ├── openapi.json          #   REST 端点请求/响应 schema（OpenAPI 3.1）
│   ├── wire.json             #   ASR WS 帧 + proxy 错误体等非 REST 线上结构
├── docs/                     # 部署指南、CHANGELOG、contract.md、superpowers/
├── Dockerfile                # COPY 路径改为仓内相对路径
├── docker-compose.yml        # IMAGE_REPO 默认值改 Gitea
├── caddyfile.example
├── nginx.conf.example
├── package.json              # 服务端根包：[新] 补 "version": "0.1.0"（原 enterprise_server/package.json）
├── package-lock.json
├── tsconfig.json / tsconfig.build.json
├── vitest.config.ts
├── .env.example
├── LICENSE                   # BSL 1.1（替换掉现有的 AGPL-3.0，见下）
├── contract/LICENSE         # [新] 契约产物单独授权（MIT 或 CC0），与 BSL 的 Licensed Work 区分
├── .gitea/workflows/         # 测试 CI + tag 发版 CI
├── CHANGELOG.md              # [新]
└── README.md                  # [新] 为服务端单独撰写（见下）
```

**许可证（`[裁定]`：只有服务端这一侧换成 BSL 1.1；桌面端 MixWork 保持 MIT，不变）**。

选 BSL 的理由与它要满足的三件事一一对应：

| 诉求 | BSL 怎么满足 |
|---|---|
| 源码可见 | BSL 是 source-available：源码公开可读、可自建、可改 |
| 自己能卖私有化 + SaaS | Additional Use Grant 明确允许把 Licensed Work 作为服务提供（SaaS）、也允许内部/私有化使用 |
| 限制别人短期做竞品 SaaS | Additional Use Grant 的核心限制：不得用于 **Competing Offering**（提供相同或实质相似功能并收费） |

**BSL 1.1 要填的参数**（`[判断]`，除非你另有偏好）：

| 参数 | 取值 |
|---|---|
| Licensor | paulplay / MixWork |
| Licensed Work | MixWork Enterprise Server（本仓除 `contract/` 契约产物之外的全部内容，见下） |
| Change License | **Apache 2.0** |
| Change Date | **每个版本发布日 + 4 年**（发版时随版本更新；`v0.1.0` 即 `2030-10-29`） |
| Additional Use Grant | BSL 1.1 官方模板的标准版本（禁止用于 Competing Offering） |

**三条必须记住的**：

- **BSL 不是 OSI 认可的开源许可**，是 source-available。对外表述用「源码可见 / source-available」，
  不要写成「开源」——README 和销售材料都要注意这个措辞。
- **LICENSE 必须是 BSL 1.1 官方模板原文 + 填入上面的参数**，不能自行改写措辞。
  实施时从官方模板取原文，逐字填参数。
- **Change Date 到达后自动转为 Apache 2.0**（按每个版本各自的 Change Date 算），这是 BSL 的承诺机制，
  也是它比 AGPL 更适合商业闭源托管的原因：竞品限制只在有限窗口内存在，之后必须开源。

**桌面端不动许可** —— MixWork 桌面端继续是 MIT，`package.json` 的 `license: MIT` 和
`MixWork/LICENSE` 都不改。桌面端不链接服务端代码、不复制服务端代码，只通过 HTTP 调用，
所以 BSL 不影响桌面端的许可状态。唯一需要处理的是下面这条契约产物的派生作品问题。

**一个 BSL 特有的连带影响（本设计里最容易被漏掉的一条）**：

`contract/openapi.json` 与 `contract/wire.json` 是从服务端源码生成的**契约产物**。桌面端要把它们
生成成 TS 类型放进自己那个 **MIT** 的仓里 —— 这份生成物属于服务端 Licensed Work 的派生作品，
如果按 BSL 处理，桌面端仓里就会带上一份 BSL 文件，桌面端整体"保持 MIT"就不干净了。

解法（`[判断]`）：**在 BSL 的 Licensed Work 定义里明确把 `contract/` 排除出去，单独授权为 MIT 或 CC0**。
理由站得住：契约产物是**接口定义**，不是实现；接口定义不受许可约束是业界惯例
（参考 AGPL 语境下的 API 互操作豁免思路）。具体做法：

- `LICENSE`（BSL 1.1）覆盖服务端实现代码；
- `contract/LICENSE`（MIT 或 CC0）覆盖契约产物，桌面端拉取时连同这份许可一起遵守；
- 桌面端生成文件头部注明来源与许可，例如
  `// Generated from MixWork-Enterprise contract/openapi.json (MIT). Do not edit.`

另外顺手把两件小事一起定了：① 导入时给 LICENSE 补上项目版权声明
（`Copyright (C) 2026 paulplay`），BSL 模板的 Licensor 段也要写全；② **新仓的 `.gitignore` 必须按
服务端的实际产物重写** —— 详见 §5.3，这是**第一次推送前必须先修**的东西。

**目录搬迁对相对 import 的影响**：`web/tests/shared/*.parity.test.ts` 里的
`import ... from '../../../src/shared/auditActionMeta'` —— 搬迁前后层级完全相同
（`web/tests/shared/` → `../../../` → 仓根 → `src/shared/`），**不需要改**。

### 5.2 MixWork（桌面端，留下的东西）

```
MixWork/
├── src/
│   ├── main/auth/enterpriseClient.ts          # HTTP 客户端（改成用生成的类型）
│   ├── main/auth/enterpriseServerUrlStore.ts  # 地址持久化
│   ├── main/libs/enterpriseServerUrlConfig.ts # 启动种子
│   ├── main/libs/enterpriseConfigSync.ts、agentEnterpriseSync.ts、enterpriseQuotaSignal.ts …
│   ├── main/ipcHandlers/enterpriseMt.ts、sso.ts
│   ├── shared/enterprise/                     # 保留（IPC channel 等桌面端本地常量）
│   ├── shared/enterprise/contract/            # [新] 生成产物（见 §6）
│   └── shared/enterpriseAccount/              # 保留，但内容按 §6 收敛
├── scripts/generate-enterprise-build-info.cjs # 保留（烘焙地址）
├── .enterprise-build/                          # 保留
└── 无 enterprise_server/
```

### 5.3 新仓的 `.gitignore`（`[裁定]`：环境变量与编译产物一律不入库）

新仓现在用的是 Gitea 的 Node 通用模板，**漏掉了服务端实际会产出的东西**：`web-dist/`、
`web/node_modules/`、`.env.generated` 都不在忽略列表里。而
`scripts/package-enterprise-server.sh` 会把生成的 `JWT_SECRET` / `MIXWORK_VAULT_MASTER_KEY`
写进 `.env.generated` —— **第一次推送就可能把构建产物和生成的密钥提交进仓**。

导入时以 `enterprise_server/.gitignore` + `enterprise_server/web/.gitignore` 为基础合并，
写成新仓根的 `.gitignore`（`[判断]`，具体清单如下）：

```
# ---- 依赖 ----
node_modules/
web/node_modules/

# ---- 编译与构建产物 ----
dist/
web-dist/
*.tsbuildinfo
.vite/

# ---- 测试与覆盖率 ----
coverage/
web/test-results/
web/playwright-report/
web/tests/visual/screenshots/

# ---- 环境变量与密钥（最要紧的一类）----
.env
.env.*
!.env.example          # 模板要入库（.env.example 里有占位值，没有真密钥）
.env.generated         # package-enterprise-server.sh --generate-secrets 写出来的密钥文件
*.pem
*.key

# ---- 日志与临时文件 ----
*.log
npm-debug.log*
.tmp-*
.keyfrom-build/
.DS_Store
```

**必须验证的三件事**（写进阶段 0 的验收）：

1. `git status` 在本地跑过一次完整构建 + 一次 `npm run web:build` + 一次
   `scripts/package-enterprise-server.sh --generate-secrets` 之后，**工作区必须干净**。
2. `git ls-files | grep -E '\.env'` 的输出里**只能有 `.env.example`**，不能有 `.env` / `.env.generated`。
3. `git ls-files | grep -E 'web-dist|/dist/'` 必须为空。

**桌面端那侧同步要改**（`[判断]`）：MixWork 的 `.gitignore` 里有一段注释写着
"the repo root, enterprise_server and enterprise_server/web are each standalone npm projects with
their own lockfile" —— 拆分后 `enterprise_server` 不在桌面端仓里了，这段注释要改成只讲根仓与
`SKILLs/`，否则会误导人。

### 5.4 两个仓的边界

| | 服务端（MixWork-Enterprise） | 桌面端（MixWork） |
|---|---|---|
| 拥有 | zod schema、契约生成器、镜像、CHANGELOG、部署文档 | sync 脚本、生成产物（提交进仓）、企业功能 UI、地址配置 |
| 不拥有 | 桌面端任何代码 | 服务端任何源码 |
| 交互方式 | ① 运行时 HTTP（普通业务端点，服务端给可直接渲染的数据）② 发版时从服务端仓的 raw URL 拉契约产物 | 同左 |

---

## 6. 契约层设计（V2：桌面端不翻译服务端语义）

### 6.1 原则：服务端回答"是什么 / 能不能做"，桌面端只负责渲染

这一条原则是整个契约设计的地基，它推翻了早期"桌面端要认识服务端词汇表"的假设：

- **服务端角色的词表是开放的** —— 管理员可以在管理台建任意权限组合的自定义角色
  （`routes/admin/roles.ts` 的 CRUD + `roles.permissions JSONB`），所以任何写死在代码里的角色列表
  都是**设计错误**，不是"会漂移"。
- **桌面端不需要验证角色** —— 桌面端 `effective_roles` 全仓只出现在一个地方：账号菜单里的角色标签
  芯片，**纯展示**，没有任何基于角色的功能门控。认证与授权全部由服务端负责。
- **连审计动作都不需要契约** —— 服务端的 `/audit` 收 `action: z.string()`，不校验取值。
  桌面端那套 `ClientAuditAction` 是它自己的事件词汇，服务端原样存。

由此得到三条硬规则：

1. **服务端词表一律不进桌面端代码** —— 角色、权限点、审计动作、配额原因、代理错误信号，
   桌面端一个都不持有。
2. **桌面端要门控的能力，由服务端给专用布尔字段** —— 而不是桌面端拿权限点自己去推。
   模式已经存在：`/me` 里的 `membersCanSubmitConnectors` / `membersCanSubmitSkills`。
3. **唯一例外是登录错误码** —— 因为桌面端要把它变成一句人话（"密码错了" / "账号被停用"）。
   这张表因此是**桌面端自己的 UX 映射**，不是契约：它只覆盖"桌面端想给友好提示"的少数几个码，
   **服务端新增码时桌面端不用同步**，认不出来就走通用文案。

### 6.2 契约只剩两层

```
┌─ 真相层（服务端，MixWork-Enterprise）───────────────────────────┐
│  zod schema：REST 端点请求/响应 + ASR WS 帧 + proxy 错误体      │
│  src/routes/**  +  src/contract/**（新增）                      │
└──────────────────────────┬────────────────────────────────────┘
                           │ contract:build（构建期）
                           ▼
┌─ 形状契约（服务端仓内文件，随 git tag 发布；桌面端提交生成物）───┐
│  contract/openapi.json   REST 端点的请求/响应 schema             │
│  contract/wire.json      ASR WebSocket 帧 + proxy 错误体等       │
│  contract/LICENSE         单独授权（MIT/CC0），见 §5.1            │
└──────────────────────────┬────────────────────────────────────┘
                           │ 桌面端 contract:sync（拉 tag 对应的 raw 文件）
                           ▼
┌─ 消费层（桌面端，生成物提交进仓）──────────────────────────────┐
│  src/shared/enterprise/contract/api.generated.ts   ← 只有类型   │
│  CI 新鲜度检查（定期重拉比对，不一致就 fail）                    │
└────────────────────────────────────────────────────────────────┘

运行时层：**没有独立的契约端点**。服务端在正常响应里给可直接渲染的值
（角色显示名、能力布尔、scope 求值结果、版本号）。
```

对比早期设计，**整层"运行时契约 + 枚举载荷"被删掉了**：
`GET /contract` 端点取消，`enums` 载荷取消，桌面端的静态枚举表取消。

### 6.3 服务端"给可直接渲染的数据"

| 数据 | 服务端现状 | 改动 |
|---|---|---|
| 角色显示名 | `roles.display_name` 列**已经存在**（'组织管理员'、'部门管理员'…），但 `/me` 只返回原始 `extra_roles` | `/me` 的 `effective_roles` 改成带显示名的结构，或新增 `roles: [{ code, displayName }]`。**桌面端不再有 `roleLabelKey` 的 switch** |
| 能力布尔 | `/me` 已有 `membersCanSubmitConnectors` / `membersCanSubmitSkills` | 按需继续加；桌面端只消费布尔字段 |
| 权限点全集 | `/me` 返回 `permissions`（细粒度 39 个点） | **可以继续返回**（web 控制台要用），但**桌面端不用它做判断** |
| 策略 scope 求值 | 桌面端 `src/main/policies/policyResolver.ts` 解析 `org-wide` / `role:` / `user:` / `dept-path:` 表达式 | **服务端做 scope 求值**（`/policies/{type}` 返回对该用户已生效的策略），桌面端不再解析这个 DSL。该端点本来就要新建，正好一次做对 |
| 服务端版本号 | `GET /health` 只返回 `{ ok: true }` | `/health` 带上 version（或加 `X-MixWork-Version` 响应头），供桌面端提示"服务端版本过旧" |

### 6.4 桌面端侧的变化（相对早期设计）

| 位置 | 现状 | 改动 |
|---|---|---|
| `src/shared/enterprise/constants.ts` 的 `EnterpriseRole` | 死代码 | **删除** |
| `EnterpriseMtAccountMenu.tsx` 的 `roleLabelKey()` | 写死 3 个角色，其余显示「成员」 | **删除该函数**，直接渲染服务端给的显示名；认不出显示名时退回通用「成员」 |
| `src/shared/asr/constants.ts` | 手抄副本，靠跨目录 import 的 parity 测试保同步 | **改为生成**（来自 `contract/wire.json`） |
| `src/shared/asr/asrConstantsParity.test.ts` | `import '../../../enterprise_server/src/shared/asr/constants'` —— 拆分当天必红 | **删除**（同步性由 CI 新鲜度检查保证） |
| `src/shared/enterpriseAccount/loginErrorCodes.ts` | 镜像服务端的 8 个码 + 2 个客户端码 | **保留但缩小**：只留桌面端想给友好提示的少数几个；不认识走通用文案。不再当契约维护 |
| `src/shared/enterpriseAccount/proxyWireSignals.ts` | 手抄服务端的 proxy 错误判别式 | **改为生成**（来自 `contract/wire.json`） |
| `src/shared/enterpriseAccount/constants.ts` 的数字错误码 / 配额原因 | 桌面端独有，服务端从没发过 41606/41607/41608 | 服务端在错误体里给**结构化 code**；桌面端不再用 `message.match(/\b4160[678]\b/)` 从错误**消息文本**里刮码 |
| `src/shared/site|publishing|shareDeployment/constants.ts` | 桌面端独有的字段定义 | 随 `/api/sites*` 资源一起挪到服务端，桌面端改为生成 |

### 6.5 个人模式的边界（大幅简化）

早期设计里最重的一条约束是"生成物含运行时枚举，个人模式路径不得 import"。**V2 下生成物只剩
TypeScript 类型**（编译期存在，无运行时值），所以：

- 个人模式路径 import 一个企业类型，**没有运行时风险**，只是编译期依赖。
- ESLint `no-restricted-imports` 规则**保留但降级** —— 它的作用从"防止正确性 bug"变成
  "防止个人模式代码悄悄长出对企业契约的依赖"。仍然值得加，因为这条依赖会让服务端改形状时
  个人模式跟着编译失败。

### 6.6 服务端团队的 schema 工作量

`[裁定]` 范围 = **请求 + 响应都收，但只覆盖桌面端调用的端点**（附录 A），不做全站 OpenAPI。

- 请求侧：这些端点大多已经有 zod 请求 schema（`src/routes/**` 里 24 个文件在用 zod），
  生成器一建就有产出。
- 响应侧：服务端现在 546 处 `c.json()` 全是手搓 JSON，**没有 schema**。需要为桌面端用到的端点补上。
- **新增 `contract/wire.json`**：覆盖 REST 之外、桌面端确实解析的线上结构 ——
  ASR WebSocket 帧（`st.partial` / `seg_id` / `AsrRealtimeSessionData`）与 proxy 错误体
  （`error` / `reason` 判别式）。这些今天全靠手抄，桌面端 ASR 那份正是靠跨目录 import 的
  parity 测试保同步 —— 拆分后必须进契约。
- 服务端 web 控制台的镜像（`web/src/shared/*`）保持现状不动 —— 它本来就有 parity 测试，
  且与生成器同仓，不构成漂移源。

**工具链**（`[判断]`）：

- 服务端：`zod-to-json-schema`（devDependency）把 zod schema 转成 JSON Schema，
  由 `npm run contract:build` 组装出 `contract/openapi.json` 与 `contract/wire.json`。
  端点清单用一个显式的 registry 声明（方法 + 路径 + 请求 schema + 响应 schema），
  顺便成为"哪些端点属于桌面端契约"的唯一声明处。
- 桌面端：`openapi-typescript`（devDependency）把 `contract/openapi.json` 生成为
  `src/shared/enterprise/contract/api.generated.ts`；`wire.json` 同理生成 WS/错误体类型。
- 两端都是成熟、MIT、无运行时开销的库。服务端若更想直接上 `@hono/zod-openapi` 也可以，
  那是更大的改造，不在本轮范围。

### 6.7 为什么最终不需要"运行时契约"（取舍记录）

C2 最初的目的是：服务端比桌面端新时，桌面端能发现并优雅降级。V2 下这个目的**由别的方式
更好地达成了**：

| 早期 C2 的担心 | V2 的处理 |
|---|---|
| 服务端新增了角色/枚举，桌面端不认识 | 桌面端不再持有任何词表 —— 不存在"不认识" |
| 服务端改了错误码，桌面端映射过时 | 错误码进 OpenAPI schema → CI 新鲜度检查报出来 → 人改映射；运行时表现是"文案不够友好"，不是错误行为 |
| 服务端改了响应形状 | 形状契约 + CI 新鲜度检查 + 服务端"只加字段不删改"的硬性要求 |
| 服务端新增 scope 种类，桌面端解析不了 | scope 求值收进服务端，桌面端不再解析这个 DSL |

**结论**：剩余的漂移风险全部落在**形状**上，而形状正是契约产物能覆盖的部分。
所以运行时枚举载荷那一层是多余的，删掉它让整体简单了一大截。

**仍然保留的两条降级规则**（个人模式的直接后果）：

1. 服务端不可达 → 桌面端行为与今天完全一致，不阻塞任何流程。
2. 桌面端遇到不认识的错误码 → 通用文案，不报错、不崩。

## 7. 独立发版与回滚

### 7.1 版本号与 tag（`[判断]`）

- **版本号写在 `MixWork-Enterprise/package.json` 的 `"version"` 字段**（`[裁定]`）—— 即搬过去之后
  服务端那个仓根的 `package.json`（原 `enterprise_server/package.json`，加上 `private: true` 与
  `type: module` 保持不变）。**初值 `0.1.0`** —— 三位数字的 semver，不是日期版本。
- **两个仓的版本号彼此独立，不同步**。桌面端 MixWork 的版本在 `MixWork/package.json`（今天也是
  `0.1.0`，纯属巧合），桌面端的自动更新、electron-builder 打包用的都是它；服务端的版本只用于
  服务端自己的镜像 tag、`mixwork-server version` 和 `/health` 里返回的 `version` 字段。
  **两边同号不代表同版本** —— 不要在文档或发布说明里把两者混着提。
- git tag：`v0.1.0`；镜像 tag：`v0.1.0`；`mixwork-server version` 输出同一个值。
- 版本推进规则（服务端正处 `0.x`，破坏性变更走 minor）：
  - **patch**（`0.1.0` → `0.1.1`）：修复，不改任何线上形状。
  - **minor**（`0.1.0` → `0.2.0`）：新增端点 / 新增响应字段 / 新增枚举 code；**允许删除或改形状**
    （`0.x` 阶段不必守 semver 的 major 承诺，但必须写进 CHANGELOG 并同步桌面端）。
  - 契约产物的**形状**变了（新增/删除端点、改请求或响应结构）就是 minor 版本；
    只改描述文案不动。
- 发版 = 打 git tag。契约产物 `contract/*.json` 在打 tag **之前**生成并提交
  （这样桌面端从一个稳定路径拉，而不是依赖 CI artifact 的保留期）。
- **版本号只有一个真相：`package.json` 的 `version`**（`[判断]`）。目前服务端
  `src/cli/version.ts` 只读 `process.env.VERSION ?? 'dev'`（Dockerfile 的 `ARG VERSION` 注入），
  所以光加 `version` 字段不会改变 `mixwork-server version` 的输出，也不改变容器上报的版本 ——
  需要同时改代码：CLI 优先读 `process.env.VERSION`、回退到 `package.json` 的 version；
  `/health` 返回的 `version` 字段同样取自 `package.json.version`。
  CI 构建镜像时把 `--build-arg VERSION=$(node -p "require('./package.json').version")` 传进去，
  这样 `VERSION` 与 `package.json.version` 不可能对不上。

### 7.2 CI

| workflow | 触发 | 做什么 |
|---|---|---|
| `enterprise-server.yml`（搬现有） | push / PR 到 main | backend `npm test`（`--pool=forks --minWorkers=2 --maxWorkers=2`，注释里说明了原因，别动）+ web `npm run web:test` |
| `release.yml`（新） | tag push `v*` | ① 校验 tag 与 `package.json` 的 version 一致，且 `contract/*.json` 已是最新 ② docker buildx 构建多架构镜像（`linux/amd64,linux/arm64`）③ 推 `paulgitea.iepose.cn/paul/enterprise-server:v<version>` ④ 推送 tag 注释 / 发布说明 |
| `desktop-ci.yml`（新，在**桌面端仓**，`[裁定]`：建一套完整 CI） | push / PR 到 main | ① ESLint（CI 口径：`--report-unused-disable-directives --max-warnings 0`，只针对变更文件）② `npm test`（vitest）③ 契约新鲜度检查（从服务端仓的某个 tag 拉 `contract/openapi.json`，与仓内提交的生成产物比对，不一致就 fail） |

**桌面端 CI 的两个前置**：① Gitea Actions 要先注册 runner（§7.2 前提）；② 拉契约产物需要 Gitea PAT ——
CI 里配 secret，开发机走本地 token / `~/.netrc`（`[判断]`，细节见 §12）。

**CI 落地的两个前提**（reviewer 核对 Gitea API 后发现，属于运维事实，不是设计选择）：

- **Gitea Actions 目前没有 runner。** `paul/MixWork` 的 `enterprise-server.yml` 已注册且 `state: active`，
  但 runner 列表 `total_count: 0`，历史运行记录也是 0 条 —— 也就是说这条 workflow 从没真正跑过。
  新仓也零 workflow。**注册一个 `act_runner` 是整个拆分 CI 计划的前置条件**。
- **桌面端仓今天没有任何自己的 CI。** 没有 `.github/` 目录，唯一的 workflow 就是本次要删掉的
  `enterprise-server.yml`。而 `CLAUDE.md` 写的 "GitHub CI runs `npm test`" 在这个仓里没有对应物。
  所以桌面端需要**从零**建一套 workflow（至少：lint + vitest + 契约新鲜度检查）。
- **两个仓都是私有仓**，匿名读 raw 文件会 404。桌面端的 `contract:sync` 与新鲜度检查都需要一个
  Gitea PAT：CI 里配 secret，开发机走本地 token / `~/.netrc`（`[判断]`，细节见 §12）。

### 7.3 镜像与 registry

- registry：`paulgitea.iepose.cn/paul/enterprise-server`（`[裁定]`）。
- `docker-compose.yml` 的 `IMAGE_REPO` 默认值改成这个；`.env.example` 同步。
- `scripts/package-enterprise-server.sh` 迁到新仓，docker context 改为仓根；`--registry` / `--platform`
  / `--push` / `--load-only` / `--generate-secrets` 这些既有能力全部保留。

### 7.4 回滚

`mixwork-server upgrade --to <旧tag>` 这条路**已经存在**：拉镜像 → dry-run 迁移 → 换镜像 →
健康检查失败自动回滚。拆分后需要保证两件事：

- **registry 保留历史 tag**，不做自动清理（`[判断]`：不配自动清理策略，靠人看 CHANGELOG 决定）。
- **数据库迁移不可回滚**（现有 CLI 已这样设计）：回滚镜像时数据库停在较新版本。
  这一条必须在部署文档里写明，并给出"哪些迁移是向后兼容的"的说明。
- **`IMAGE_REPO` 现在到不了 CLI**（reviewer 核对）：`src/cli/upgrade.ts:77` 读的是
  `process.env.IMAGE_REPO`，**CLI 从不加载 `/etc/mixwork/.env`**；而
  `scripts/package-enterprise-server.sh` 的提示文案却告诉运维"CLI 从 `/etc/mixwork/.env` 读
  IMAGE_REPO"—— 这句是错的。既然镜像要推到 Gitea 容器仓库，registry 路径必须打通：
  `/etc/mixwork/.env` → compose → CLI 三处一致（`[判断]`：CLI 的 `init`/`upgrade` 显式读
  `/etc/mixwork/.env`，并把打包脚本里那句错误的提示文案一并改掉）。
- **tag 格式必须只有一处真相**：compose 默认 `${IMAGE_REPO:-enterprise-server}:${IMAGE_TAG:-latest}`、
  `src/cli/init.ts` 写死 `IMAGE_TAG=latest`、`src/cli/upgrade.ts` 用运维手输的 `--to`、
  `package-enterprise-server.sh` 又给 `--tag` 追加 `-${SHA}` —— 四处现在互不一致。
  统一为：`package.json.version` → tag `v<version>` → 镜像 tag `v<version>`（不带 SHA 后缀，
  SHA 记在镜像的 OCI label 里）。

发版前演练一次完整发版 + 一次回滚（`[判断]`：写进计划的验收步骤）。

### 7.5 CHANGELOG（`[判断]`）

服务端新增 `CHANGELOG.md`，每次发版记录：破坏性变更、新增/变更端点、契约版本变化、
需要桌面端配合的项。独立发版没有 changelog = 出问题时无法判断该回退到哪个 tag。

### 7.6 版本兼容

- **桌面端不硬编码最低服务端版本**（`[判断]`）。契约运行时下发 + 静态表降级，
  "新桌面端 + 老服务端" = 老服务端没有 `/contract` → 404 → 用静态表 → 行为等同今天。
- `/health` 返回服务端 `version`（或加 `X-MixWork-Version` 响应头），桌面端在设置里提示
  "服务端版本过旧"。**不需要专门的契约端点。**
- 反向组合"老桌面端 + 新服务端"由服务端保证向后兼容：新增字段而不删改既有字段。
  这是服务端团队的硬性要求，需要写进新仓的 `AGENTS.md`。
- 契约产物每次发版都会重新生成并随 tag 发布，桌面端的 CI 新鲜度检查会比对 ——
  **形状漂移在发版前就被拦住**，这是 V2 下唯一的自动化漂移防线（不再有枚举那一层）。

---

## 8. MixWork 侧的改动清单

### 8.1 删除

- `enterprise_server/` 整个目录（**768** 个跟踪文件）。
- 根 `package.json` 的 `enterprise:install` / `enterprise:test` / `enterprise:init` / `enterprise:dev`
  （或改为指向兄弟仓的本地开发便利脚本）。
- `.gitea/workflows/enterprise-server.yml`。
- `scripts/package-enterprise-server.sh`、`scripts/build-enterprise-image.sh`。
- `scripts/security-check.cjs` 中扫 `enterprise_server/**` 的**四条**规则（迁到新仓）：
  `:46` 服务端不记录明文 key、`:49` web SPA 源码无 `api_key` 赋值、`:50` web 构建产物无 `api_key` 字面量
  （此条只在 SPA 已构建时才有意义，因为 `enterprise_server/web-dist` 是 gitignore 的）、
  `:54-57` 服务端用 `bcryptjs` 而非 `bcrypt`（原生绑定漂移防护）。

### 8.2 迁移到新仓

| 从 | 到 | 备注 |
|---|---|---|
| `enterprise_server/**` | 新仓根 | 去掉一层前缀 |
| `enterprise_server/Dockerfile` | 新仓根 `Dockerfile` | COPY 路径重写（**5 处全列，别漏**）：① web-build 阶段 `enterprise_server/web/package.json` + `package-lock.json` → `web/...` ② `enterprise_server/web/` → `web/` ③ web-build 阶段的 `enterprise_server/src/shared/` → `src/shared/`（web 的 parity 测试要 import 它） ④ build 阶段 `enterprise_server/package*.json` → `package*.json` ⑤ `enterprise_server/src` → `src` ⑥ `enterprise_server/scripts/patch-esm-imports.mjs` → `scripts/patch-esm-imports.mjs` ⑦ `enterprise_server/src/db/migrations` → `src/db/migrations` |
| `enterprise_server/docker-compose.yml` | 新仓根 | `IMAGE_REPO` 默认值改 Gitea |
| `enterprise_server/docs/**` | 新仓 `docs/` | 含 `superpowers/` 历史计划与 spec |
| `enterprise_server/README.md` | 新仓 `README.md` | **重写，不直接搬**（见下） |
| `docs/enterprise-deployment.md`、`docs/enterprise-server-deploy.md` | 新仓 `docs/` | 其中"桌面端兼容矩阵"一节留在 MixWork（`[判断]`） |
| `.gitea/workflows/enterprise-server.yml` | 新仓 `.gitea/workflows/` | 去掉 `working-directory` |

### 8.3 保留（桌面端自己的）

`src/main/auth/enterpriseClient.ts`、`enterpriseServerUrlStore.ts`、`sessionStorage.ts`、
`enterpriseModelCache.ts`、`loginGate.ts`；`src/main/libs/enterpriseServerUrlConfig.ts`、
`enterpriseConfigSync.ts`、`agentEnterpriseSync.ts`、`enterpriseQuotaSignal.ts`、
`enterpriseAgentPrefsStore.ts` 等；`src/main/ipcHandlers/enterpriseMt.ts`、`sso.ts`；
`src/shared/enterprise/**`；`src/renderer/components/EnterpriseServerSetting.tsx`、
`EnterpriseMtAccountMenu.tsx`、`src/renderer/setup/EnterpriseSetupModal.tsx`；
`scripts/generate-enterprise-build-info.cjs`、`.enterprise-build/`、`scripts/migrate-to-multi-tenant.cjs`。

### 8.4 修改

| 文件 | 改动 |
|---|---|
| `src/shared/asr/asrConstantsParity.test.ts` | 现在 import 服务端源码，拆分后必然失败。**删除**（同步性由 CI 新鲜度检查保证，§6.4） |
| `src/shared/enterprise/constants.ts` | 删除死代码 `EnterpriseRole` |
| `src/renderer/components/EnterpriseMtAccountMenu.tsx` | **删掉 `roleLabelKey()` 这个 switch**，改为直接渲染服务端 `/me` 返回的角色**显示名**；服务端没给显示名时退回通用「成员」 |
| `src/main/auth/enterpriseClient.ts` | `MeView` 等改为生成类型；`effective_roles` 的类型随服务端改成带显示名的结构；**不消费 `permissions` 做门控**（要门控就用服务端的专用布尔字段） |
| 根 `package.json` | 新增 `contract:sync` / `contract:check` 脚本 |
| ESLint 配置 | 新增 `no-restricted-imports` 边界规则（§6.5；V2 下生成物只剩类型，规则从"防 bug"降级为"防依赖渗漏"） |
| `src/shared/asr/constants.ts`、`src/shared/enterpriseAccount/proxyWireSignals.ts` | 改为**生成**（来自 `contract/wire.json`），不再是手抄副本 |
| `src/shared/enterpriseAccount/loginErrorCodes.ts` | 缩小成"认得就给友好文案、不认识走通用"的本地 UX 映射；不再当契约维护 |
| `src/shared/enterpriseAccount/constants.ts` 的数字错误码 / 配额原因 | 服务端在错误体里给结构化 code；桌面端不再用 `message.match(/\b4160[678]\b/)` 从错误**消息文本**里刮码 |
| `README.md` / `README_zh.md` | 删掉 `enterprise_server/` 目录说明与 `enterprise:*` 脚本说明，加"企业服务端已独立成仓"的指向 |
| `.env.example` | `enterprise_server` 字样改成新仓/新地址说明 |
| `scripts/security-check.cjs` | 拆成桌面端一半（留在本仓）+ 服务端一半（迁新仓） |
| `.gitignore` | 删掉/改写那段提到 `enterprise_server` 与 `enterprise_server/web` 的注释（拆分后桌面端仓里不再有这两个独立工程） |

### 8.5 文档

- 历史 `docs/superpowers/plans/**`、`docs/superpowers/specs/**` **不改写**（`[判断]`）——
  它们是当时的记录，改写会破坏历史可追溯性。

---

## 9. 分工边界（`[裁定]`）

**服务端团队负责**：zod schema（真相）、契约生成器（`contract:build`，产出 `openapi.json` + `wire.json`）、
给桌面端**可直接渲染的数据**（角色显示名、能力布尔、`/policies` 的 scope 求值、`/health` 的版本号）、
发版 CI 与镜像、CHANGELOG、部署与回滚文档、新仓的 `AGENTS.md` / `CLAUDE.md`。

**桌面端团队负责**：`contract:sync` 脚本、生成产物（提交进仓）、CI 新鲜度检查、
桌面端改用 `/me` 的权限字段、删死代码、修 `roleLabelKey`、个人模式边界规则。

**交接物**：

- 新仓 `AGENTS.md` / `CLAUDE.md`：服务端工作模型（命令、目录、迁移、测试、部署）。
- 新仓 `docs/contract.md`：契约说明 —— 哪些是 code、哪些是文案、版本策略、
  向后兼容的硬性要求、新桌面端配老服务端的行为。
- 新仓 `README.md`：**为服务端单独撰写的一份完整文档**（`[裁定]`），不沿用 `enterprise_server/README.md` 的原文。
  现有那份 145 行是开发者视角的 quickstart（Requirements / Install / Dev quickstart / Vault master key /
  Running tests / Logs / Layout），新 README 在此基础上补齐服务端作为**独立产品**该有的部分：
  这是什么、与桌面端是什么关系、需求与依赖、快速开始（本地开发 / 容器）、配置项与密钥、
  测试与 CI、发版与回滚（含 `mixwork-server` CLI 的日常运维）、**与桌面端的契约说明**
  （§6.3 的 code/文案分工、版本策略、新桌面端配老服务端的行为）、目录结构、许可与致谢。

---

## 10. 实施顺序（分阶段）

### 阶段 0：搬（不改变任何行为）

- 0.1 新仓初始化 + **从当前最新代码导入**（不搬历史，见 0.3）+ 目录搬到仓根 + Dockerfile 路径重写
      + 迁移测试 CI + 在新仓跑通 `npm test`、`npm run web:test`、`docker build`。
- 0.2 MixWork 侧删掉 `enterprise_server/` 与全部引用，桌面端 `npm test` 与 `npm run build` 通过。
- 0.4 **桌面端建自己的 CI**（`[裁定]`：`desktop-ci.yml`，lint + vitest；契约新鲜度检查在阶段 3.5 补上）。
- 0.5 **新仓 `.gitignore` 按 §5.3 重写，并在第一次推送前跑完那三项验证**（这一步在 0.1 之后、
      第一次 push 之前，不能拖）。
- 0.3 **历史处理（`[裁定]`）**：新仓**不搬历史**，服务端代码以当前最新状态作为一次导入提交进入新仓。
      后果：服务端代码在新仓里的 `git blame` 从导入提交开始，之前的演进记录不随代码前进。
      旧历史仍可追溯 —— MixWork 仓里删除 `enterprise_server/` 的那个提交，其父提交仍带着全部服务端历史。
      导入提交与 MixWork 侧的删除提交应放在同一次推送里，避免中间态两边都没有。

### 阶段 1：独立发版（服务端）

- 1.1 `version` 字段 + tag 规则 + `CHANGELOG.md`。
- 1.2 发版 CI：构建多架构镜像 → 推 Gitea 容器仓库。
- 1.3 `docker-compose.yml` 默认 `IMAGE_REPO` 改 Gitea；部署文档更新。
- 1.4 **演练一次完整发版 + 一次回滚**。

### 阶段 2：契约（服务端侧）

- 2.0 **新建缺失的两族资源**（`[裁定]` 服务端要实现）：`/api/sites*`（9 个端点 + 表 + 迁移 +
      管理端，响应信封 `{ code, message, data }`）与 `/policies/{type}`（路由 + 表 + 迁移 + 管理端）。
      这一步是**新功能**，独立排期；它完成前，附录 A 里这两族仍然标为未实现。
- 2.1 `/me` 返回角色**显示名**；`/policies/{type}` 改为**服务端做 scope 求值**；`/health` 带版本号。
- 2.2 `contract:build` → `contract/openapi.json` + `contract/wire.json`。
- 2.3 按附录 A 给桌面端用到的端点补 zod 请求 + 响应 schema。

### 阶段 3：契约（桌面端侧）

- 3.1 `contract:sync` 脚本 + 生成产物提交进仓。
- 3.2 桌面端改用生成类型；删 `EnterpriseRole`；修 `roleLabelKey`；修 ASR parity 测试。
- 3.3 桌面端改用服务端给的显示名与能力布尔；删 `roleLabelKey` 的 switch；
      错误码映射缩小成"认得就给友好文案，不认识走通用"。
- 3.4 改用 `GET /me` 的 `permissions` 做 UI 门控。
- 3.5 CI 新鲜度检查。
- 3.6 ESLint 边界规则。

阶段 2 / 3 **不阻塞**阶段 0 / 1：桌面端在阶段 3 完成前继续用现有手写类型。

---

## 11. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 服务端补响应 schema 的工作量落在服务端团队 | 阶段 2 拖期 | 阶段 2/3 与阶段 0/1 解耦；桌面端在阶段 3 前继续用现有类型 |
| 服务端代码在新仓的 blame 历史从导入提交起算（已接受，`[裁定]`） | 服务端团队追溯某段代码的来龙去脉时，看不到桌面端仓里的旧提交 | 旧历史保留在 MixWork 仓删除提交的父节点上，需要时回查 |
| 契约生成工具链（`zod-to-json-schema` + `openapi-typescript`）选型 | 生成结果形态不符合预期 | 阶段 2.2 先做一个端点的最小验证再铺开 |
| 桌面端 CI 新鲜度检查需要访问 Gitea | 检查跑不起来 | Gitea Actions runner 在内网；用 raw URL 只读拉取 |
| 桌面端 `permissions` 消费改动面比预期大 | 阶段 3 拖期 | 先只改"用户可见"的门控（连接器提交、技能提交、归档），其余按需 |
| 服务端"只加字段不删改"的兼容要求 | 服务端开发习惯改变 | 写进新仓 `AGENTS.md` 的硬性要求；契约版本号只在形状变化时 +1 |
| 阶段 2.0 要新建 `/api/sites*` 与 `/policies/*` 两族资源（新功能，非收口） | 服务端工作量超出「补 schema」的预期，排期变长 | 独立成 2.0 子阶段并单独排期；契约收口（2.1-2.3）不依赖它完成 |
| `/policies/skill` 等于重新面对迁移 023「删掉技能策略」的决定 | 服务端可能反对 | 开工前由服务端团队给结论；本设计不替他们定 |
| Gitea Actions 没有 runner | 两个仓的 CI 全部落空 | 运维前置条件：先注册 `act_runner`，再谈阶段 0.4 与阶段 1.2 |
| 服务端许可从 MIT 变成 BSL 1.1（`[裁定]` 确认） | BSL 不是 OSI 开源许可；竞品限制有窗口期，Change Date 后必须转 Apache 2.0 | 对外措辞用「源码可见」而非「开源」；每版发版时更新 Change Date |
| 契约产物若不单独授权，桌面端 MIT 仓里会带上一份 BSL 派生文件 | 桌面端仓许可不干净 | 在 Licensed Work 定义里排除 `contract/`，单独放 `contract/LICENSE`（MIT/CC0）（§5.1） |

---

## 12. 留给实现者的部分

- 契约 schema 的具体组织方式（按端点分文件 vs 一份集中 registry）。
- `openapi-typescript` 的具体配置与输出形态（单文件 vs 按端点分文件）。
- 桌面端消费 `permissions` 的具体 UI 改动范围。
- 个人模式边界的 ESLint 规则写法与作用域。
- 新仓 `AGENTS.md` / `CLAUDE.md` 与 `docs/contract.md` 的具体内容。
- 附录 A 的完整端点清单（计划阶段做穷举核对）。
- 契约新鲜度检查的触发频率与失败策略（fail / 开 PR）。
- 桌面端 `roleLabelKey` 补齐 9 个内置角色的中英文 i18n 标签（约 7 组新键），以及 `admin` 遗留别名
  在桌面端的映射（服务端 `roleResolver.ts` 把它当作 `org_admin`）。
- 契约拉取用的 Gitea 凭据怎么给到桌面端开发机（本地 `~/.netrc` / token 文件 / 只在 CI 里拉）。
- 角色显示名是走 `/me` 的结构变更（`effective_roles` 变对象数组）还是新增独立字段 ——
  前者是破坏性变更（桌面端在读 `string[]`），要按 §7.1 的 minor 版本规则走。
- `src/cli/version.ts` 改为优先读 `process.env.VERSION`、回退到 `package.json` 的 version。
- 新仓 `.gitignore` 需要按服务端的实际产物重写（现用的是 Gitea 的 Node 通用模板）。
- `src/cli/upgrade.ts` / `src/cli/init.ts` 读取 `/etc/mixwork/.env` 的 `IMAGE_REPO` / `IMAGE_TAG`。

**待确认（只有人能回答，见 §12 的提问轮）**

1. `/api/sites*`（9 个端点）与 `/policies/{type}`：服务端要实现，还是不属服务端契约？
2. CI 跑在哪：Gitea Actions 目前**没有任何 runner**（已注册 workflow，但 runner 数为 0、从未跑过），
   且桌面端仓**没有自己的 CI**（CLAUDE.md 写的 "GitHub CI runs `npm test`" 在本仓没有对应物）。

---

## 附录 A：桌面端调用的服务端端点清单（初稿）

完整清单在计划阶段做穷举核对。下表是已核对出的部分，用于给服务端团队估工作量。

**注意**：`/api/sites*`（9 个）与 `/policies/{type}`（2 个）是**桌面端在调、服务端根本没实现**的端点 ——
这是拆分前就存在的缺口，不是拆分造成的。`[裁定]`：**服务端要实现它们**，所以它们属于阶段 2 的范围，
而且是**新功能**（建资源 + 建表 + 迁移 + 管理端），不是补 schema 那么简单（详见 §6.5）。

| 方法 | 路径 | 桌面端调用点 | 备注 |
|---|---|---|---|
| GET | `/auth/orgs` | 登录选 org | 免鉴权 |
| POST | `/auth/login` | 登录 | |
| POST | `/auth/refresh` | JWT 刷新 | |
| POST | `/auth/change-password` | 改密码 | |
| GET | `/auth/sso/providers?orgName=` | SSO IdP 列表 | |
| GET | `/me` | 当前用户 | **含 `permissions` / `effective_roles` / `effectiveDataScope`** |
| PATCH | `/me` | 改昵称 | |
| GET | `/me/sso-binding` | SSO 绑定状态 | |
| GET | `/me/sso-binding/connections` | SSO 连接列表 | `main.ts` |
| POST | `/me/sso-binding/start` | 发起绑定 | `main.ts` |
| DELETE | `/me/sso-binding` | 解绑 | `main.ts` |
| GET | `/models` | 模型列表 | |
| GET | `/admin/catalog` | 目录（providers + models） | `catalogResolver` |
| GET | `/policies/{type}`（`mcp` / `skill`） | 策略 | **服务端要新建**（`[裁定]`）。无路由、无 `mcp_policies` 表；`skill_policies` 被迁移 023 删除。桌面端本地做 scope 过滤 |
| GET | `/usage/today` | 今日用量 | |
| POST | `/audit` | 客户端审计上报 | |
| GET | `/admin/mcp-connectors/submissions` | 连接器市场 | |
| GET | `/api/admin/skill-marketplace/submissions` | 技能市场 | |
| POST | `/admin/users/{id}/archive` | 用户归档 | |
| POST | `/mcp/gateway/{serverKey}` | MCP 网关 | |
| GET/PATCH/DELETE | `/api/sites`、`/api/sites/{id}`、`/api/sites/{id}/access-mode`、`/api/sites/{id}/access-status`、`/api/sites/{id}/analytics` | 站点 | **服务端要新建**（`[裁定]`）。`src/main/libs/site/siteClient.ts`；响应信封必须是 `{ code, message, data }` |
| GET/POST/DELETE | `/api/sites/deployment-quota`、`/api/sites/deployment-quota/reservations`、`.../reservations/{id}` | 部署额度 | **服务端要新建**（`[裁定]`） |
| GET | `/api/media/images/models`、`/api/media/videos/models` | 媒体模型 | `main.ts` |
| WS | ASR 实时通道 | 语音输入 | 常量契约见 `src/shared/asr/constants.ts` |
| — | `/proxy/{provider}` | **OpenClaw 直连，不经桌面端主进程** | 走 provider key，契约面较小 |
