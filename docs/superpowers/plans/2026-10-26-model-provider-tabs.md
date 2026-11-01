# 企业控制台「模型配置」模型类型 Tab 化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把企业控制台的厂商卡片从「能力类型 chips + 四个平铺分区」改成「四个恒显的模型类型 Tab」，任何 Tab 都不再提供删除入口，服务商清单行去掉类型标签，并修掉「会话过期后所有写操作返回 `http 401 unauthorized`」这个 bug。

**Architecture:** 全部改动都在 `enterprise_server/` 之内：服务端一处行为改动（协议切换不再连带清空模型清单），控制台一处信息架构改造（Tab 化 + 去掉分区删除），再加一个会话自愈模块（主动轮换 token + 会话失效可见）。数据模型、迁移、API 的请求/响应结构都不动。仓库根目录的 Electron 桌面端本次**不碰**。

**Tech Stack:** Hono + Postgres（服务端，Vitest + `src/db/testDb`）；React 18 + Vite 5 + Vitest 2 + Testing Library + Playwright（控制台）；TypeScript strict。

**Spec:** `docs/superpowers/specs/2026-10-26-model-provider-tabs-design.md`（**先读它**；本计划是它的实现分解，spec 是权威）

## Global Constraints

- 只碰 `enterprise_server/`：`enterprise_server/src/`（服务端）、`enterprise_server/web/src/` + `enterprise_server/web/tests/`（控制台）。仓库根目录的 `src/`（Electron 桌面端）本次不动。
- TypeScript：2 空格缩进、单引号、分号。
- 用户可见文案一律走 `t('key')`（`enterprise_server/web/src/i18n.ts`）；`en` 与 `zh` **两份字典的键集合必须完全一致**。
- 判别值（协议名、状态码、模式名）不得裸字符串字面量：用 `as const` 对象 + 派生类型。
- 迁移文件不可变（账本按**文件名**记账）。本次**不新增、不修改**任何迁移。
- 绝不打印或回显 API Key / 凭据。
- 服务端测试需要 Postgres（`src/db/testDb`）。**一次只跑一个测试文件**（整包跑会耗尽 fd）。
- 控制台测试：`cd enterprise_server/web && npx vitest run <file>`；提交前跑一次整包 `npx vitest run`。
- 提交信息用 Conventional Commits（英文），并以 `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` 结尾。

## Review Focus

spec 是一份愿景文档：它说了软件必须做什么，没说它必须满足什么。以下五类输入 / 状态 spec 没有逐条点名，但最可能咬到真实使用者，每个都要有一条测试钉住（测试写在下面标注的 Task 里）：

1. **管理员在 LLM Tab 把协议从「OpenAI 兼容」切到「Anthropic 兼容」** → 模型清单必须还在，Base URL 必须换成 Anthropic 那个协议的默认地址，一次请求完成，不能出现「新协议 + 旧地址」的中间态。→ Task 4。
2. **管理员在一个从未配置过的 Tab 里只填了 API Key 就点保存** → 该 Tab 必须新建出一个分区；而**一个什么都没填的 Tab 点保存不能凭空多出分区**（否则点一次保存就多四个空分区）。→ Task 8。
3. **管理员停用了某个 Tab 的分区** → 徽章还在、Tab 标签变次要色、分区顶部有「已停用」提示，而且**停用不删模型**。→ Task 7。
4. **管理员把控制台开着不动超过 1 小时** → 到期前 10 分钟必须自动轮换 token，期间任何写操作都不得返回 401。→ Task 1。
5. **会话确实已经失效（离开超过 1 小时后回来）** → 必须看到「登录会话已过期，请重新登录」的可读提示并回到登录页，而不是裸的 `http 401 unauthorized`。→ Task 2。

---

## File Structure

**服务端 `enterprise_server/src/`**

| 文件 | 职责 |
|---|---|
| `vault/providerKeyVault.ts` | 协议枚举的归属地。新增 `CHAT_PROTOCOLS` + `isChatProtocol()`。 |
| `routes/admin/providerKeys.ts` | PATCH 路由。协议切换时按「是否跨过对话协议边界」决定清不清模型清单。 |

**控制台 `enterprise_server/web/src/`**

| 文件 | 职责 |
|---|---|
| `auth/jwt.ts`（新） | `base64UrlDecode()` / `readJwtExpMs()`——浏览器安全的 JWT 读法，不碰 `Buffer`。 |
| `auth/sessionRefresh.ts`（新） | 主动轮换 token 的单飞决策 + 定时器 + 前后台切换检查。 |
| `auth/store.ts` | 会话状态。加 `logoutReason`（手动登出 / 会话过期）。 |
| `api/client.ts` | 401 → 刷新失败 → 抛 `SessionExpiredError`（文案走 i18n）并触发会话失效回调。 |
| `main.tsx` | 接线：轮换定时器、会话失效回调。 |
| `pages/LoginPage.tsx` | 会话过期时在登录页给一句可读提示。 |
| `pages/providersModels/modelTypeTabs.ts`（改名自 `capabilities.ts`） | 模型类型 Tab 的定义：Tab ↔ 协议 ↔ 允许的模型能力。 |
| `pages/providersModels/ModelTypeSection.tsx`（改名自 `CapabilitySection.tsx`） | 一个 Tab 的内容：协议单选、Base URL、Coding Plan、API Key、启用/停用、模型表。 |
| `pages/providersModels/ProviderCard.tsx` | Tab 栏 + 当前 Tab 的内容。 |
| `pages/providersModels/ProviderRail.tsx` | 服务商清单行（去掉类型标签）。 |
| `pages/ProvidersModelsPage.tsx` | Tab 状态、保存语义、协议切换。 |
| `i18n.ts` | 文案 + 导出 `i18nDicts`（给 parity 测试用）。 |

**测试**

| 文件 | 覆盖 |
|---|---|
| `enterprise_server/tests/routes/providerKeysV2.test.ts` | 协议切换保留 / 清空模型清单。 |
| `enterprise_server/web/tests/auth/sessionRefresh.test.ts`（新） | 主动轮换。 |
| `enterprise_server/web/tests/api/clientSessionExpired.test.ts`（新） | 401 → 会话失效。 |
| `enterprise_server/web/tests/shared/i18n.parity.test.ts`（新） | `en` / `zh` 键集合一致。 |
| `enterprise_server/web/tests/pages/providersModels/*.test.tsx` | 随实现改写。 |
| `enterprise_server/web/tests/pages/ProvidersModelsPage.test.tsx` | 随实现改写。 |
| `enterprise_server/web/tests/visual/providers.spec.ts` | 视觉基线的断言从 checkbox 改成 tab。 |

---

### Task 1: 控制台主动轮换 token（F1）

**Files:**
- Create: `enterprise_server/web/src/auth/jwt.ts`
- Create: `enterprise_server/web/src/auth/sessionRefresh.ts`
- Modify: `enterprise_server/web/src/auth/store.ts`（改用共享的 base64url 解码）
- Modify: `enterprise_server/web/src/main.tsx`（启动轮换）
- Test: `enterprise_server/web/tests/auth/sessionRefresh.test.ts`

**Interfaces:**
- Consumes: 无（这是第一个任务）。
- Produces:
  - `auth/jwt.ts`:
    ```ts
    export function base64UrlDecode(b64url: string): string
    export function readJwtExpMs(jwt: string): number | null   // null = 没有可读的 exp
    ```
  - `auth/sessionRefresh.ts`:
    ```ts
    export const DEFAULT_REFRESH_WINDOW_MS = 10 * 60 * 1000;
    export const DEFAULT_REFRESH_INTERVAL_MS = 60 * 1000;
    export type SessionRefreshStatus =
      | 'refreshed' | 'not-due' | 'not-logged-in' | 'jwt-expired' | 'refresh-failed';
    export interface SessionRefreshResult { status: SessionRefreshStatus }
    export interface SessionRefreshDeps {
      getToken: () => string | null;
      refresh: () => Promise<string>;   // resolve 成新 token
      persist: (token: string) => void;
      now?: () => number;
      refreshWindowMs?: number;
    }
    export function refreshSessionIfDue(deps: SessionRefreshDeps): Promise<SessionRefreshResult>;
    export function startSessionRefresh(
      deps: SessionRefreshDeps & { intervalMs?: number },
    ): () => void;                     // 返回停止函数
    export function _resetSessionRefreshForTest(): void;
    ```

- [ ] **Step 1: 写失败测试 `enterprise_server/web/tests/auth/sessionRefresh.test.ts`**

  辅助函数（放在测试文件顶部）：

  ```ts
  function jwtWithExp(expSec: number): string {
    const payload = btoa(JSON.stringify({ exp: expSec }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `h.${payload}.s`;
  }
  ```

  六个用例（`now` 固定为 `1_700_000_000_000`）：

  | 用例名 | 前提 | 断言 |
  |---|---|---|
  | `临近到期才轮换` | token 的 exp = now/1000 + 5 分钟 | `status === 'refreshed'`；`persist` 被调用一次，参数是刷新返回的新 token |
  | `未到期不轮换` | exp = now/1000 + 30 分钟 | `status === 'not-due'`；`refresh` 没被调用 |
  | `已过期不发出请求` | exp = now/1000 - 60 | `status === 'jwt-expired'`；`refresh` 没被调用 |
  | `没有会话` | `getToken()` 返回 `null` | `status === 'not-logged-in'` |
  | `刷新失败` | `refresh` reject | `status === 'refresh-failed'`；不抛异常 |
  | `并发调用只发一次请求` | 两次 `refreshSessionIfDue` 同时进行 | `refresh` 只被调用一次 |

  最后一个用例依赖模块级单飞：两次调用必须**共享同一个 in-flight promise**（第二次调用直接返回第一个的 promise），所以 `expect(refresh).toHaveBeenCalledTimes(1)`。

- [ ] **Step 2: 跑测试确认失败**

  Run: `cd enterprise_server/web && npx vitest run tests/auth/sessionRefresh.test.ts`
  Expected: FAIL —— `Failed to resolve import "../src/auth/sessionRefresh"`（模块还不存在）。

- [ ] **Step 3: 实现 `enterprise_server/web/src/auth/jwt.ts`**

  把 `auth/store.ts` 里现有的 `base64UrlDecode` 原样搬过来并导出（它已经处理了 base64url 的 `-`/`_` 替换和补 `=`），再加：

  ```ts
  /** The `exp` claim of a JWT, in milliseconds. Null when the token has no
   * readable `exp` (the server still re-validates every request, so an
   * unparseable claim is treated as "expiring soon" rather than "expired"). */
  export function readJwtExpMs(jwt: string): number | null {
    const segments = jwt.split('.');
    if (segments.length < 2) return null;
    try {
      const payload = JSON.parse(base64UrlDecode(segments[1])) as { exp?: number };
      return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
    } catch {
      return null;
    }
  }
  ```

  然后 `auth/store.ts` 删掉自己那份私有 `base64UrlDecode`，改成 `import { base64UrlDecode } from './jwt';`——`isTokenExpired` 的行为不变。

- [ ] **Step 4: 实现 `enterprise_server/web/src/auth/sessionRefresh.ts`**

  镜像桌面端 `src/main/libs/enterpriseJwtRefresh.ts` 的判定顺序，**但用浏览器安全的解码**（`atob`，不是 `Buffer`）：

  ```ts
  const inFlight: { current: Promise<SessionRefreshResult> | null } = { current: null };
  ```

  `refreshSessionIfDue(deps)` 的判定顺序（与桌面端一致）：

  1. `inFlight.current` 存在 → 直接返回它（单飞）。
  2. `getToken()` 为空 → `{ status: 'not-logged-in' }`。
  3. `readJwtExpMs(token)` 不为 `null` 且 `<= now()` → `{ status: 'jwt-expired' }`。
     **理由**：`POST /auth/refresh` 会用当前 token 重新验签，过期的 token 永远换不动。
  4. `exp` 为 `null`（读不出来）或 `exp - now() <= refreshWindowMs` → 需要轮换；否则 `{ status: 'not-due' }`。
  5. 调 `deps.refresh()`：抛错 → `{ status: 'refresh-failed' }`；resolve 的 token 为空或与旧 token 相同 → `{ status: 'not-due' }`。
  6. `deps.persist(newToken)` → `{ status: 'refreshed' }`。

  `startSessionRefresh(deps)`：立刻跑一次 `refreshSessionIfDue`；用 `setInterval`（默认 `DEFAULT_REFRESH_INTERVAL_MS`）再跑；监听 `document` 的 `visibilitychange`，当 `document.visibilityState === 'visible'` 时再跑一次。返回的停止函数 `clearInterval` + 移除监听。

  **不抛异常**：所有失败都变成 status。

- [ ] **Step 5: 跑测试确认通过**

  Run: `cd enterprise_server/web && npx vitest run tests/auth/sessionRefresh.test.ts`
  Expected: PASS（6/6）。

- [ ] **Step 6: 在 `main.tsx` 接线**

  `main.tsx` 已经有：

  ```ts
  apiClient.setRefresh(async () => {
    const r = await apiClient.post<{ token: string }>('/auth/refresh');
    useAuthStore.getState().login(r.token);
  });
  ```

  在它下面加：

  ```ts
  // Proactive rotation: the enterprise JWT lives ~1h and /auth/refresh
  // re-verifies the CURRENT token, so an expired one can never be renewed.
  // Rotate while it is still valid (see auth/sessionRefresh.ts).
  startSessionRefresh({
    getToken: () => useAuthStore.getState().token,
    refresh: async () => (await apiClient.post<{ token: string }>('/auth/refresh')).token,
    persist: (token) => useAuthStore.getState().login(token),
  });
  ```

  `apiClient.post('/auth/refresh')` 不会被 401 重试逻辑递归触发（`shouldSkipRefresh` 已经排除了它）。

- [ ] **Step 7: 跑整包控制台测试**

  Run: `cd enterprise_server/web && npx vitest run`
  Expected: 全绿。

- [ ] **Step 8: 提交**

  ```bash
  git add enterprise_server/web/src/auth enterprise_server/web/src/main.tsx enterprise_server/web/tests/auth/sessionRefresh.test.ts
  git commit -m "feat(console): rotate the enterprise session token before it expires

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
  ```

---

### Task 2: 会话失效可见（F2）

**Files:**
- Modify: `enterprise_server/web/src/api/client.ts`
- Modify: `enterprise_server/web/src/auth/store.ts`
- Modify: `enterprise_server/web/src/main.tsx`
- Modify: `enterprise_server/web/src/pages/LoginPage.tsx`
- Modify: `enterprise_server/web/src/i18n.ts`
- Test: `enterprise_server/web/tests/api/clientSessionExpired.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `auth/sessionRefresh.ts`（不直接依赖，只是同属会话自愈）。
- Produces:
  - `api/client.ts`:
    ```ts
    export class SessionExpiredError extends ApiError { constructor(); }
    apiClient.setSessionExpiredHandler(fn: (() => void) | null): void;
    ```
  - `auth/store.ts`:
    ```ts
    export type LogoutReason = 'manual' | 'session-expired';
    // AuthState 增加 logoutReason: LogoutReason | null;
    // logout(reason?: LogoutReason) —— 默认 'manual'
    ```

- [ ] **Step 1: 写失败测试 `enterprise_server/web/tests/api/clientSessionExpired.test.ts`**

  用 `vi.stubGlobal('fetch', ...)` 拦请求。三个用例：

  | 用例名 | 前提 | 断言 |
  |---|---|---|
  | `401 → 刷新成功 → 重试并成功` | 第一次请求 401，`refresh` resolve | 第二次请求发出并返回 200；结果值是 200 的 body；不抛异常 |
  | `401 → 刷新也 401 → 抛 SessionExpiredError 并触发会话失效回调` | 第一次请求 401，`refresh` reject 一个 `ApiError(401, {error:'unauthorized'})` | 抛出的错误 `instanceof SessionExpiredError`；`e.message` 是 `t('auth.session.expired')`（**不是** `http 401 unauthorized`）；会话失效回调被调用一次 |
  | `401 → 刷新因网络错误失败 → 仍然抛原始 401，不清会话` | `refresh` reject 一个 `ApiError(0, {error:'network'})` | 抛出的错误是 `ApiError` 且 `status === 401`（**不是** `SessionExpiredError`）；会话失效回调**没有**被调用 |

  第三条是刻意的：网络抖一下不该把管理员踢出登录。

  测试里用 `apiClient.setSessionExpiredHandler(spy)` 挂回调，用完 `afterEach` 里 `apiClient.setSessionExpiredHandler(null)` 清掉。

- [ ] **Step 2: 跑测试确认失败**

  Run: `cd enterprise_server/web && npx vitest run tests/api/clientSessionExpired.test.ts`
  Expected: FAIL —— `SessionExpiredError` 未导出 / `setSessionExpiredHandler` 不是函数。

- [ ] **Step 3: 实现 `api/client.ts` 的改动**

  加导出类（**继承 `ApiError`**，这样别处 `e instanceof ApiError` 和 `e.status === 401` 的判断继续成立）：

  ```ts
  /** Thrown when the server rejects a call AND the session cannot be
   * renewed. The message is user-facing (i18n), so a page's generic
   * `toast.error(e.message)` shows "your session expired" instead of a bare
   * `http 401 unauthorized`. */
  export class SessionExpiredError extends ApiError {
    constructor() {
      super(401, null);
      this.name = 'SessionExpiredError';
      this.message = t('auth.session.expired');
    }
  }
  ```

  客户端里加一个模块级 `onSessionExpired` + `setSessionExpiredHandler`，并把 401 分支改成：

  ```ts
  if (res.status === 401 && !retried && !shouldSkipRefresh(path)) {
    try {
      await refresh();
    } catch (e) {
      // The refresh itself 401s: the token is dead and cannot be renewed
      // (/auth/refresh re-verifies the current token). Clear the session so
      // the app returns to the login page, and say so in words the admin
      // can act on. A refresh that failed for a NETWORK reason is not a
      // dead session — keep the original 401 and the session.
      if (e instanceof ApiError && e.status === 401) {
        onSessionExpired?.();
        throw new SessionExpiredError();
      }
      throw new ApiError(401, await readErrorBody(res));
    }
    return call<T>(method, path, body, true);
  }
  ```

  `api/client.ts` 需要 `import { t } from '../i18n';`。

- [ ] **Step 4: `auth/store.ts` 加 `logoutReason`**

  ```ts
  export type LogoutReason = 'manual' | 'session-expired';
  ```

  `AuthState` 增加 `logoutReason: LogoutReason | null`，`logout` 改成：

  ```ts
  logout: (reason: LogoutReason = 'manual') => {
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* localStorage unavailable */ }
    set({ token: null, claims: null, logoutReason: reason });
  },
  ```

  初始值 `logoutReason: null`。

- [ ] **Step 5: `main.tsx` 接线**

  ```ts
  apiClient.setSessionExpiredHandler(() => {
    useAuthStore.getState().logout('session-expired');
  });
  ```

- [ ] **Step 6: `LoginPage.tsx` 显示提示**

  组件里读一次 `useAuthStore.getState().logoutReason`；若是 `'session-expired'`，渲染一句 `t('auth.session.expiredHint')`，并把 reason 复位为 `null`（用 `useAuthStore.setState({ logoutReason: null })`），免得提示一直挂着。

- [ ] **Step 7: 补 i18n**

  `i18n.ts` 的 `en` 与 `zh` **各加两条**：

  | key | en | zh |
  |---|---|---|
  | `auth.session.expired` | `Your session has expired. Please sign in again.` | `登录会话已过期，请重新登录` |
  | `auth.session.expiredHint` | `Your session is no longer valid. Please sign in again to continue.` | `登录状态已失效，请重新登录后继续` |

- [ ] **Step 8: 跑测试确认通过**

  Run: `cd enterprise_server/web && npx vitest run tests/api/clientSessionExpired.test.ts`
  Expected: PASS（3/3）。

- [ ] **Step 9: 跑整包控制台测试**

  Run: `cd enterprise_server/web && npx vitest run`
  Expected: 全绿。

- [ ] **Step 10: 提交**

  ```bash
  git add enterprise_server/web/src enterprise_server/web/tests/api/clientSessionExpired.test.ts
  git commit -m "fix(console): make an expired session say so instead of a bare 401

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
  ```

---

### Task 3: 服务端——协议切换保留模型清单

**Files:**
- Modify: `enterprise_server/src/vault/providerKeyVault.ts`
- Modify: `enterprise_server/src/routes/admin/providerKeys.ts`
- Test: `enterprise_server/tests/routes/providerKeysV2.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `providerKeyVault.ts` 导出
  ```ts
  export const CHAT_PROTOCOLS: readonly ProviderProtocol[];
  export function isChatProtocol(protocol: ProviderProtocol): boolean;
  ```

- [ ] **Step 1: 写失败测试（改写 `enterprise_server/tests/routes/providerKeysV2.test.ts`）**

  把现有的 `'切换协议会清空该分区的模型'` 改写成 `'切换协议保留该分区的模型'`：

  ```ts
  test('切换协议保留该分区的模型', async () => {
    const tok = await admin();
    const id = (await testPool.query<{ id: string }>(
      `SELECT id FROM provider_keys WHERE org_id='o1' AND provider='openai' AND is_builtin`,
    )).rows[0].id;
    const before = await testPool.query<{ n: number }>(
      `SELECT count(*)::int n FROM model_catalog WHERE provider_key_id=$1`, [id]);
    expect(before.rows[0].n).toBeGreaterThan(0);
    await testPool.query(
      `INSERT INTO model_type_defaults(org_id, type, model_id)
       SELECT 'o1','chat', id FROM model_catalog WHERE provider_key_id=$1 LIMIT 1`, [id]);

    const res = await app.request(`/admin/provider-keys/${id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: 'anthropic' }),
    });
    expect(res.status).toBe(200);
    // The switch is no longer destructive: the models stay.
    expect((await res.json() as { clearedModels?: number }).clearedModels).toBe(0);
    const after = await testPool.query<{ n: number }>(
      `SELECT count(*)::int n FROM model_catalog WHERE provider_key_id=$1`, [id]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    // The default-model pointer survives too.
    const defaults = await testPool.query<{ n: number }>(
      `SELECT count(*)::int n FROM model_type_defaults WHERE org_id='o1' AND type='chat'`);
    expect(defaults.rows[0].n).toBe(1);
  });
  ```

  同文件**新增**一条：

  ```ts
  test('跨协议族切换仍然清空该分区的模型', async () => {
    // openai → image-gen crosses out of the chat family: a chat model id
    // means nothing to an image adapter, so the list must go.
    const tok = await admin();
    const id = (await testPool.query<{ id: string }>(
      `SELECT id FROM provider_keys WHERE org_id='o1' AND provider='openai' AND is_builtin`,
    )).rows[0].id;
    const res = await app.request(`/admin/provider-keys/${id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: 'image-gen' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { clearedModels?: number }).clearedModels).toBeGreaterThan(0);
    const after = await testPool.query<{ n: number }>(
      `SELECT count(*)::int n FROM model_catalog WHERE provider_key_id=$1`, [id]);
    expect(after.rows[0].n).toBe(0);
  });
  ```

  另外把现有的 `'切换协议不影响别的分区的模型'` 里的
  `expect((await res.json() as { clearedModels?: number }).clearedModels).toBeGreaterThan(0);`
  改成 `toBe(0)`（现在 openai→anthropic 不清任何东西），并加一句注释。

  `enterprise_server/tests/routes/providerKeysExtended.test.ts` **不用改**：它的
  `expect(await res.json()).toEqual({ ok: true, clearedModels: 0 })` 断言的是**空 body** 的 PATCH，
  `clearedModels` 字段保留，值仍然是 0。

- [ ] **Step 2: 跑测试确认失败**

  Run: `cd enterprise_server && npx vitest run tests/routes/providerKeysV2.test.ts`
  Expected: FAIL —— `'切换协议保留该分区的模型'` 失败（`clearedModels` 是模型总数，模型被清空了）；`'跨协议族切换仍然清空该分区的模型'` 通过。

- [ ] **Step 3: 加 `isChatProtocol`**

  `enterprise_server/src/vault/providerKeyVault.ts`，紧跟 `ProviderProtocol` 定义之后：

  ```ts
  /** The chat protocols: the two wires a model LIST is meaningful for. A
   * protocol switch WITHIN this family keeps the section's model list; a
   * switch ACROSS it invalidates the list. */
  export const CHAT_PROTOCOLS: readonly ProviderProtocol[] = [
    ProviderProtocol.Openai,
    ProviderProtocol.Anthropic,
  ];

  export function isChatProtocol(protocol: ProviderProtocol): boolean {
    return CHAT_PROTOCOLS.includes(protocol);
  }
  ```

- [ ] **Step 4: 收窄 PATCH 路由的清空规则**

  `enterprise_server/src/routes/admin/providerKeys.ts`：

  1. 把存在性查询的类型从 `protocol: string` 改成 `protocol: ProviderProtocol`。
  2. 把清空那段改成：

     ```ts
     // A protocol switch only invalidates the section's model list when it
     // CROSSES the chat boundary: a chat model id means nothing to an ASR or
     // image adapter, and keeping the rows would keep routing the desktop to
     // a model this section can no longer serve. A switch WITHIN the chat
     // family (openai <-> anthropic) keeps the list — both speak the same
     // model ids, and the cataloged models are the admin's work.
     let clearedModels = 0;
     if (
       ok
       && fields.protocol !== undefined
       && fields.protocol !== storedProtocol
       && !(isChatProtocol(fields.protocol) && isChatProtocol(storedProtocol))
     ) {
       clearedModels = await modelCatalog.deleteByProviderKey(claims.orgId, id);
     }
     ```

  3. 补 import：`import { isChatProtocol, ... } from '../../vault/providerKeyVault';`

  响应字段 `clearedModels` **保留**（`0` = 本次没清），控制台不读它。

- [ ] **Step 5: 跑测试确认通过**

  Run: `cd enterprise_server && npx vitest run tests/routes/providerKeysV2.test.ts`
  Expected: PASS（含新增的跨协议族用例）。

  再跑一次同包的另一个文件确认没被带坏：
  Run: `cd enterprise_server && npx vitest run tests/routes/providerKeysExtended.test.ts`
  Expected: PASS。

- [ ] **Step 6: 提交**

  ```bash
  git add enterprise_server/src enterprise_server/tests/routes/providerKeysV2.test.ts
  git commit -m "fix(server): keep a section's models when its protocol stays in the chat family

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
  ```

---

### Task 4: 控制台——协议切换不再清空模型、一次 PATCH

**Files:**
- Modify: `enterprise_server/web/src/pages/ProvidersModelsPage.tsx`
- Modify: `enterprise_server/web/src/pages/providersModels/CapabilitySection.tsx`
- Modify: `enterprise_server/web/src/i18n.ts`
- Test: `enterprise_server/web/tests/pages/ProvidersModelsPage.test.tsx`
- Test: `enterprise_server/web/tests/pages/providersModels/CapabilitySection.test.tsx`

**Interfaces:**
- Consumes: Task 3 的服务端行为。
- Produces: 无新导出（只是改行为）。

- [ ] **Step 1: 改写失败测试 `enterprise_server/web/tests/pages/ProvidersModelsPage.test.tsx`**

  把 `'switching the protocol asks first'` 整条替换为：

  ```ts
  test('switching the protocol submits the protocol and the new Base URL in one PATCH', async () => {
    mockFetchData([card()], [model()]);
    renderPage();
    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Anthropic compatible' })).toBeInTheDocument()
    );
    await user.click(screen.getByRole('radio', { name: 'Anthropic compatible' }));
    // No confirm dialog: the switch is not destructive any more.
    expect(screen.queryByRole('heading', { level: 2, name: 'Switch protocol' })).toBeNull();
    await waitFor(() =>
      expect(requestBody('/admin/provider-keys/pk1', 'PATCH')).toMatchObject({
        protocol: 'anthropic',
        // The 'openai' slug has no anthropic endpoint in the catalog, so the
        // global protocol default is used.
        baseUrl: 'https://api.anthropic.com',
      })
    );
  });
  ```

  `enterprise_server/web/tests/pages/providersModels/CapabilitySection.test.tsx`：
  - 把 `'switching the protocol asks the card instead of editing the row'` 的注释改成「协议切换交给页面提交（协议 + Base URL 一次请求）」，断言 `onProtocolChange` 仍被调用 `'anthropic'`（不变）。
  - **新增**一条 `'the protocol radio is disabled while the card is busy'`：以 `busy: true` 渲染，断言两个 radio 都是 `toBeDisabled()`。

- [ ] **Step 2: 跑测试确认失败**

  Run: `cd enterprise_server/web && npx vitest run tests/pages/ProvidersModelsPage.test.tsx tests/pages/providersModels/CapabilitySection.test.tsx`
  Expected: FAIL —— 页面仍然弹「Switch protocol」确认框；radio 在 busy 时没有禁用。

- [ ] **Step 3: 改 `ProvidersModelsPage.tsx`**

  1. 删掉 `const [pendingProtocolSwitch, setPendingProtocolSwitch] = useState<...>(null);`
  2. `selectCard` 里删掉 `setPendingProtocolSwitch(null);`
  3. 删掉那个 `pendingProtocolSwitch` 的 `<ConfirmDialog>` 整块。
  4. `switchProtocolMut` 改成：

     ```ts
     const switchProtocolMut = useMutation({
       mutationFn: ({
         id, protocol, baseUrl, codingPlan,
       }: {
         id: string;
         protocol: ProviderProtocol;
         baseUrl: string;
         codingPlan?: boolean;
       }) =>
         providersApi.patch(id, {
           protocol,
           baseUrl,
           ...(codingPlan === undefined ? {} : { codingPlan }),
         }),
       onSuccess: () => {
         invalidate();
         toast.success(t('providersModels.toast.saved'));
       },
       onError: (e: Error) => toast.error(e.message),
     });
     ```

  5. `handleProtocolChange` 改成：

     ```ts
     function handleProtocolChange(
       section: ProviderCardSectionView,
       next: ProviderProtocol
     ): void {
       if (next === section.protocol) return;
       const provider = activeCard?.provider ?? '';
       switchProtocolMut.mutate({
         id: section.providerKeyId,
         protocol: next,
         // The Base URL travels WITH the protocol: the stored endpoint speaks
         // the old wire, and a switch must not leave "new protocol, old
         // address" behind. Coding Plan is an OpenAI-wire feature, so it is
         // cleared when the section leaves the OpenAI wire.
         baseUrl: defaultBaseUrlFor(provider, next),
         ...(next === 'openai' ? {} : { codingPlan: false }),
       });
     }
     ```

- [ ] **Step 4: 改 `CapabilitySection.tsx`**

  - 协议 radio 的 `disabled={!canManage}` 改成 `disabled={!canManage || busy}`。
  - `onProtocolChange` 的注释改成：「The admin asked to switch the section's protocol. The page submits the switch (protocol + Base URL) in one request — there is no confirm dialog, because the model list survives the switch.」
  - 组件顶部那段「A PROTOCOL switch is different: … (the server clears the section's models too)」的注释删掉括号里那半句。

- [ ] **Step 5: 删掉 i18n 里失效的 key**

  `i18n.ts` 的 `en` 与 `zh` **各删两条**：
  `providersModels.card.switchProtocolTitle`、`providersModels.card.switchProtocolMessage`。

- [ ] **Step 6: 跑测试确认通过**

  Run: `cd enterprise_server/web && npx vitest run tests/pages/ProvidersModelsPage.test.tsx tests/pages/providersModels/CapabilitySection.test.tsx`
  Expected: PASS。

- [ ] **Step 7: 跑整包控制台测试**

  Run: `cd enterprise_server/web && npx vitest run`
  Expected: 全绿。

- [ ] **Step 8: 提交**

  ```bash
  git add enterprise_server/web/src enterprise_server/web/tests/pages
  git commit -m "feat(console): switch a section's protocol without a confirm dialog

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
  ```

---

### Task 5: 服务商清单行去掉类型标签

**Files:**
- Modify: `enterprise_server/web/src/pages/providersModels/ProviderRail.tsx`
- Modify: `enterprise_server/web/src/pages/providersModels/capabilities.ts`
- Modify: `enterprise_server/web/src/i18n.ts`
- Test: `enterprise_server/web/tests/pages/providersModels/ProviderRail.test.tsx`

**Interfaces:**
- Consumes: 无。
- Produces: `capabilities.ts` 的 `CapabilityDef` **不再有** `tagLabelKey` 字段。

- [ ] **Step 1: 改写失败测试 `enterprise_server/web/tests/pages/providersModels/ProviderRail.test.tsx`**

  找到断言清单行上类型标签的那条（形如 `expect(screen.getByText('LLM')).toBeInTheDocument()`），
  改成断言**没有**类型标签：

  ```ts
  test('the rail row does not tag the vendor with its model types', () => {
    renderRail({ cards: [card({ sections: [llmSection, imageSection] })] });
    expect(screen.queryByText('LLM')).toBeNull();
    expect(screen.queryByText('Image')).toBeNull();
  });
  ```

  （`tagLlm` / `tagImage` 的英文值就是 `'LLM'` / `'Image'`，见 i18n。）

- [ ] **Step 2: 跑测试确认失败**

  Run: `cd enterprise_server/web && npx vitest run tests/pages/providersModels/ProviderRail.test.tsx`
  Expected: FAIL —— 清单行上还有 `LLM` 标签。

- [ ] **Step 3: 改 `ProviderRail.tsx`**

  - 删掉 `function capabilityTags(card: ProviderCardView): string[] { … }`。
  - 删掉渲染它的那段 `<span className="flex shrink-0 items-center gap-1">…</span>`。
  - 删掉因此不再使用的 import（`capabilityForProtocol`、`CAPABILITIES`）。

- [ ] **Step 4: 改 `capabilities.ts`**

  - `CapabilityDef` 删掉 `tagLabelKey: string;` 字段。
  - `CAPABILITIES` 里四条定义各删掉 `tagLabelKey: '…',` 那一行。

- [ ] **Step 5: 删掉 i18n 里失效的 key**

  `en` 与 `zh` **各删四条**：
  `providersModels.card.tagLlm`、`providersModels.card.tagAsr`、`providersModels.card.tagImage`、`providersModels.card.tagVideo`。

- [ ] **Step 6: 跑测试确认通过**

  Run: `cd enterprise_server/web && npx vitest run tests/pages/providersModels/ProviderRail.test.tsx`
  Expected: PASS。

  Run: `cd enterprise_server/web && npx vitest run`
  Expected: 全绿。

- [ ] **Step 7: 提交**

  ```bash
  git add enterprise_server/web/src enterprise_server/web/tests
  git commit -m "feat(console): drop the model-type tags from the provider rail

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
  ```

---

### Task 6: 模块改名（capability → model type）

**Files:**
- Rename: `enterprise_server/web/src/pages/providersModels/capabilities.ts` → `modelTypeTabs.ts`
- Rename: `enterprise_server/web/src/pages/providersModels/CapabilitySection.tsx` → `ModelTypeSection.tsx`
- Rename: `enterprise_server/web/tests/pages/providersModels/capabilities.test.ts` → `modelTypeTabs.test.ts`
- Rename: `enterprise_server/web/tests/pages/providersModels/CapabilitySection.test.tsx` → `ModelTypeSection.test.tsx`
- Modify: `enterprise_server/web/src/pages/providersModels/ProviderCard.tsx`
- Modify: `enterprise_server/web/src/pages/providersModels/ProviderRail.tsx`
- Modify: `enterprise_server/web/src/pages/providersModels/useProviderCardDrafts.ts`
- Modify: `enterprise_server/web/src/pages/ProvidersModelsPage.tsx`

**Interfaces:**
- Consumes: Task 5（`tagLabelKey` 已删）。
- Produces: 新模块 `modelTypeTabs.ts` 导出
  ```ts
  export const ModelTypeTabId = { Llm: 'llm', Asr: 'asr', Image: 'image', Video: 'video' } as const;
  export type ModelTypeTabId = (typeof ModelTypeTabId)[keyof typeof ModelTypeTabId];
  export interface ModelTypeTabDef {
    id: ModelTypeTabId;
    labelKey: string;          // i18n key of the tab label
    protocol: ProviderProtocol;      // the protocol a NEW section of this tab is created with
    protocols: ProviderProtocol[];   // the protocols this tab's section may speak
    modelTypes: ModelTypeValue[];    // the model capabilities a model in this tab may carry
    canRefreshModels: boolean;
  }
  export const MODEL_TYPE_TABS: ModelTypeTabDef[];
  export function tabForProtocol(protocol: ProviderProtocol): ModelTypeTabDef | undefined;
  export function modelTypesForProtocol(protocol: ProviderProtocol): ModelTypeValue[];
  export function defaultBaseUrlFor(slug: string, protocol: ProviderProtocol): string;
  export const PROTOCOL_LABEL_KEY: Record<ProviderProtocol, string>;
  export const PROTOCOL_ORDER: ProviderProtocol[];
  export const PROTOCOL_DEFAULT_BASE_URL: Record<ProviderProtocol, string>;
  /** The draft key an UNCONFIGURED tab's section uses. */
  export function draftKeyForTab(tabId: ModelTypeTabId): string;
  ```

  `ModelTypeSection.tsx` 导出 `ModelTypeSection`（组件）与 `SectionDraft`（类型）。

- [ ] **Step 1: 先补一条失败测试（改名后的行为不变，只是名字变了）**

  `enterprise_server/web/tests/pages/providersModels/modelTypeTabs.test.ts`（改名前先 `git mv`）里补一条：

  ```ts
  test('draftKeyForTab keys an unconfigured tab by its tab id', () => {
    expect(draftKeyForTab(ModelTypeTabId.Image)).toBe('draft-image');
  });
  ```

  同时把文件里所有 `CAPABILITIES` / `CapabilityId` / `capabilityForProtocol` 的引用改成新名字。

- [ ] **Step 2: 跑测试确认失败**

  Run: `cd enterprise_server/web && npx vitest run tests/pages/providersModels/modelTypeTabs.test.ts`
  Expected: FAIL —— `draftKeyForTab` 未导出。

- [ ] **Step 3: 改名 + 改符号**

  ```bash
  git mv enterprise_server/web/src/pages/providersModels/capabilities.ts \
         enterprise_server/web/src/pages/providersModels/modelTypeTabs.ts
  git mv enterprise_server/web/src/pages/providersModels/CapabilitySection.tsx \
         enterprise_server/web/src/pages/providersModels/ModelTypeSection.tsx
  git mv enterprise_server/web/tests/pages/providersModels/capabilities.test.ts \
         enterprise_server/web/tests/pages/providersModels/modelTypeTabs.test.ts
  git mv enterprise_server/web/tests/pages/providersModels/CapabilitySection.test.tsx \
         enterprise_server/web/tests/pages/providersModels/ModelTypeSection.test.tsx
  ```

  符号改名表（`modelTypeTabs.ts` 与它的所有使用者）：

  | 旧 | 新 |
  |---|---|
  | `CapabilityId` | `ModelTypeTabId` |
  | `CapabilityDef` | `ModelTypeTabDef` |
  | `CAPABILITIES` | `MODEL_TYPE_TABS` |
  | `capabilityForProtocol` | `tabForProtocol` |
  | `CapabilitySection`（组件） | `ModelTypeSection` |
  | `from './capabilities'` | `from './modelTypeTabs'` |
  | `from './CapabilitySection'` | `from './ModelTypeSection'` |

  字符串值（`'llm'` / `'asr'` / `'image'` / `'video'`）**不变**。

  在 `modelTypeTabs.ts` 里加：

  ```ts
  /** The draft key an UNCONFIGURED tab's section uses. A configured tab is
   * keyed by its provider key id. */
  export function draftKeyForTab(tabId: ModelTypeTabId): string {
    return `draft-${tabId}`;
  }
  ```

- [ ] **Step 4: 跑测试确认通过**

  Run: `cd enterprise_server/web && npx vitest run`
  Expected: 全绿（`modelTypeTabs.test.ts`、`ModelTypeSection.test.tsx` 改名后仍要跑）。

- [ ] **Step 5: 提交**

  ```bash
  git add -A enterprise_server/web/src enterprise_server/web/tests
  git commit -m "refactor(console): rename the capability module to model-type tabs

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
  ```

---

### Task 7: 卡片用四个模型类型 Tab 取代 chips

**Files:**
- Modify: `enterprise_server/web/src/pages/providersModels/ProviderCard.tsx`
- Modify: `enterprise_server/web/src/pages/providersModels/ModelTypeSection.tsx`
- Modify: `enterprise_server/web/src/pages/ProvidersModelsPage.tsx`
- Modify: `enterprise_server/web/src/i18n.ts`
- Test: `enterprise_server/web/tests/pages/providersModels/ProviderCard.test.tsx`
- Test: `enterprise_server/web/tests/pages/providersModels/ModelTypeSection.test.tsx`
- Test: `enterprise_server/web/tests/pages/ProvidersModelsPage.test.tsx`

**Interfaces:**
- Consumes: Task 6 的 `modelTypeTabs.ts` 与 `ModelTypeSection.tsx`。
- Produces:
  - `ModelTypeSection` 的新 props：`enabled: boolean`、`onToggleEnabled: (enabled: boolean) => void`；`capability: CapabilityDef` 换成 `tab: ModelTypeTabDef`。
  - `ProviderCard` 的 props：**删掉** `onToggleCapability`；`onProtocolChange` 签名不变。
  - `ProvidersModelsPage`：**删掉** `draftCapabilities`、`pendingCapabilityRemove`、`removeSectionMut`、`handleToggleCapability` 与那个删除确认框；`disableSectionMut` 换成 `setSectionEnabledMut`。
  - `SectionDraft` 增加 `protocol: ProviderProtocol`（见 Step 3）。

- [ ] **Step 1: 改写失败测试 `enterprise_server/web/tests/pages/providersModels/ProviderCard.test.tsx`**

  把 `'renders one chip per capability'` 改成：

  ```ts
  test('always renders the four model-type tabs', () => {
    renderCard();
    expect(screen.getByRole('tab', { name: /LLM \(VLM\)/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Speech recognition/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Image generation/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Video generation/ })).toBeInTheDocument();
  });
  ```

  把 `'ticking an absent capability asks the card to create it'` 与 `'unticking a capability asks the card to remove it'` 两条**删掉**（chips 没有了）。

  新增：

  ```ts
  test('an unconfigured tab opens an empty form instead of a section', () => {
    renderCard();
    // The card has an LLM and an image section; the speech tab is empty.
    fireEvent.click(screen.getByRole('tab', { name: /Speech recognition/ }));
    // The speech section's Base URL field is present and empty-ish.
    expect(screen.getByLabelText('Base URL')).toBeInTheDocument();
    // No remove button anywhere in the tab content.
    expect(screen.queryByRole('button', { name: /^Remove$/ })).toBeNull();
  });
  ```

  `enterprise_server/web/tests/pages/providersModels/ModelTypeSection.test.tsx` 新增：

  ```ts
  test('the section has an enable switch and no remove action', () => {
    renderSection();
    expect(screen.getByRole('switch')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Remove$/ })).toBeNull();
  });
  ```

  `enterprise_server/web/tests/pages/ProvidersModelsPage.test.tsx`：
  - `'the page lists cards, not credential rows'` 里那两行 checkbox 断言改成 tab 断言：
    ```ts
    expect(screen.getByRole('tab', { name: 'LLM (VLM)' })).toBeInTheDocument();
    ```
  - `'ticking a capability creates the section'`、`'unticking a custom capability asks first, then deletes'`、
    `'unticking a built-in capability does not delete'` 三条**删掉**（chips 没有了；新建分区的路径在 Task 8 覆盖）。
  - `'saving a new card creates it and one key per checked capability'` 改成
    `'saving a new card creates it and one key per configured tab'`（Task 8 实现，先把这条删掉）。

- [ ] **Step 2: 跑测试确认失败**

  Run: `cd enterprise_server/web && npx vitest run tests/pages/providersModels/ProviderCard.test.tsx tests/pages/providersModels/ModelTypeSection.test.tsx tests/pages/ProvidersModelsPage.test.tsx`
  Expected: FAIL —— 没有 `tab` 角色、没有 switch。

- [ ] **Step 3: 改 `ModelTypeSection.tsx`**

  1. `Props` 里 `capability: CapabilityDef` 换成 `tab: ModelTypeTabDef`；新增 `enabled: boolean;` 与 `onToggleEnabled: (enabled: boolean) => void;`。
  2. `SectionDraft` 增加 `protocol: ProviderProtocol`：
     ```ts
     export interface SectionDraft {
       /** The Base URL the admin typed. */
       baseUrl: string;
       /** The "Coding Plan" switch. */
       codingPlan: boolean;
       /** The API Key exactly as typed: '' → keep the stored key. */
       apiKey: string;
       /** The protocol this tab's section speaks. Only the LLM tab can differ
        * from the tab's default (its protocol radio). */
       protocol: ProviderProtocol;
     }
     ```
  3. 组件里把 `capability.` 全换成 `tab.`（`tab.labelKey`、`tab.protocols`、`tab.modelTypes`、`tab.canRefreshModels`、`tab.id`）。
  4. **顶部那行**（协议 radio 的右侧）加上启用/停用开关：
     ```tsx
     <Switch
       checked={enabled}
       disabled={!canManage || busy}
       onChange={onToggleEnabled}
       label={enabled ? t('providersModels.header.enabled') : t('providersModels.header.disabled')}
     />
     ```
     `Switch` 从 `'../../components/Switch'` 导入（文件里已经在用 `Switch` 组件渲染 Coding Plan）。
  5. **停用提示**：`enabled === false` 时，在分区内容顶部渲染
     ```tsx
     <p className="mb-3 rounded-[var(--radius-sm)] bg-[var(--warning-light)]/40 px-3 py-2 text-xs text-[var(--text-secondary)]">
       {t('providersModels.card.sectionDisabled')}
     </p>
     ```
  6. **协议 radio 的本地协议**：新增
     ```ts
     const [activeProtocol, setActiveProtocol] = useState(protocol);
     ```
     radio 的 `checked={activeProtocol === value}`；`onChange` 走新的 `handleProtocol`：
     ```ts
     function handleProtocol(next: ProviderProtocol): void {
       if (next === activeProtocol) return;
       if (providerKeyId === null) {
         // No row yet: the choice is local and travels in the draft, so 保存
         // creates the section with the right wire.
         setActiveProtocol(next);
         setBaseUrl(defaultBaseUrlFor(providerSlug, next));
         setCodingPlanOn(false);
         return;
       }
       onProtocolChange(next);
     }
     ```
     那个重置草稿的 `useEffect` 里补一句 `setActiveProtocol(protocol);`（服务端协议变化时跟随），
     并把依赖数组保持 `[providerKeyId, protocol, providerSlug, endpoint, codingPlan]`。
     推送草稿的 `useEffect` 的依赖改成 `[baseUrl, codingPlanOn, apiKey, activeProtocol]`，
     推送的内容加上 `protocol: activeProtocol`。
  7. `showsProtocolRadio` 改成 `tab.protocols.length > 1`；`showsCodingPlan` 改成
     `!!codingPlanEndpoint && activeProtocol === 'openai'`。
  8. `fallbackBaseUrl` 改成 `defaultBaseUrlFor(providerSlug, activeProtocol)`。

- [ ] **Step 4: 改 `ProviderCard.tsx`**

  1. 删掉 `onToggleCapability` prop 与它在 `Props` 里的声明。
  2. 新增状态：`const [activeTab, setActiveTab] = useState<ModelTypeTabId>(ModelTypeTabId.Llm);`
  3. 删掉整个 `<fieldset>`（能力类型 chips），换成 Tab 栏：

     ```tsx
     <div className="mt-4">
       <div className="mb-1.5 text-xs font-medium text-[var(--text-secondary)]">
         {t('providersModels.card.capabilities')}
       </div>
       <div role="tablist" aria-label={t('providersModels.card.capabilities')} className="flex gap-4 border-b border-[var(--border-subtle)]">
         {MODEL_TYPE_TABS.map((tab) => {
           const section = card.sections.find((s) => tabForProtocol(s.protocol)?.id === tab.id);
           const count = section ? (modelsBySection[section.providerKeyId]?.length ?? 0) : 0;
           const disabled = !!section && !section.enabled;
           return (
             <button
               key={tab.id}
               type="button"
               role="tab"
               aria-selected={activeTab === tab.id}
               onClick={() => setActiveTab(tab.id)}
               className={`-mb-px border-b-2 px-1 pb-2 text-sm ${
                 activeTab === tab.id
                   ? 'border-[var(--accent-primary)] font-semibold text-[var(--accent-primary)]'
                   : disabled
                     ? 'border-transparent text-[var(--text-tertiary)]'
                     : 'border-transparent text-[var(--text-secondary)]'
               }`}
             >
               {t(tab.labelKey)}
               {count > 0 && (
                 <span className="ml-1.5 rounded-full bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">
                   {count}
                 </span>
               )}
             </button>
           );
         })}
       </div>
     </div>
     ```

  4. 把原来「渲染所有 section」的那段 `orderedSections.map(...)` 换成「只渲染当前 Tab 的 section」：

     ```tsx
     {(() => {
       const tab = MODEL_TYPE_TABS.find((x) => x.id === activeTab);
       if (!tab) return null;
       const section = card.sections.find((s) => tabForProtocol(s.protocol)?.id === tab.id);
       const draftKey = section ? section.providerKeyId : draftKeyForTab(tab.id);
       return (
         <ModelTypeSection
           key={draftKey}
           tab={tab}
           providerKeyId={section?.providerKeyId ?? null}
           protocol={section?.protocol ?? tab.protocol}
           providerSlug={card.provider}
           endpoint={section?.endpoint ?? null}
           codingPlan={section?.codingPlan ?? false}
           apiKeyMasked={section?.apiKeyMasked ?? null}
           isBuiltin={section?.isBuiltin ?? false}
           enabled={section ? section.enabled : true}
           canManage={canManage}
           busy={busy}
           models={section ? (modelsBySection[section.providerKeyId] ?? []) : []}
           defaultTypesByModel={defaultTypesByModel}
           onDraftChange={(draft) => handleSectionDraft(draftKey, draft)}
           onProtocolChange={(next) => section && onProtocolChange(section, next)}
           onToggleEnabled={(next) => section && onToggleSectionEnabled(section, next)}
           onRefreshModels={() => section && onRefreshModels(section)}
           onAddModel={() => section && onAddModel(section)}
           onEditModel={(model) => section && onEditModel(section, model)}
           onDeleteModel={(id) => section && onDeleteModel(section, id)}
           onToggleModel={(id, enabled) => section && onToggleModel(section, id, enabled)}
         />
       );
     })()}
     ```

  5. 新增 prop `onToggleSectionEnabled: (section: ProviderCardSectionView, enabled: boolean) => void;`。
  6. `handleSectionDraft` 的比较里加上 `cur.protocol === draft.protocol`（草稿多了 protocol 字段）。
  7. `sectionRank` / `orderedSections` / `useMemo` 不再需要，删掉（连带 `CAPABILITIES` 的 import 改成 `MODEL_TYPE_TABS`）。

- [ ] **Step 5: 改 `ProvidersModelsPage.tsx`**

  1. 删掉 `draftCapabilities` state、`pendingCapabilityRemove` state、`removeSectionMut`、`handleToggleCapability`、删除确认框。
  2. `disableSectionMut` 换成：
     ```ts
     const setSectionEnabledMut = useMutation({
       mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
         providersApi.setEnabled(id, enabled),
       onSuccess: (_r, { enabled }) => {
         invalidate();
         toast.success(
           t(enabled ? 'providersModels.enable.titleOn' : 'providersModels.enable.titleOff')
         );
       },
       onError: (e: Error) => toast.error(e.message),
     });
     ```
  3. `useProviderCardDrafts` 的 `setSectionDraft` 比较里加上 `protocol`（`useProviderCardDrafts.ts`）。
  4. 传新 prop：`onToggleSectionEnabled={(section, enabled) => setSectionEnabledMut.mutate({ id: section.providerKeyId, enabled })}`。
  5. `createCardMut` / `saveCardMut` 的分区遍历在 Task 8 改；本任务先让它们**只处理已存在的分区**（草稿卡没有分区，等于什么都不建）。

- [ ] **Step 6: 补 i18n**

  `en` 与 `zh` **各加两条**：

  | key | en | zh |
  |---|---|---|
  | `providersModels.card.sectionNotConfigured` | `This model type is not configured yet` | `该模型类型尚未配置` |
  | `providersModels.card.sectionDisabled` | `This model type is disabled` | `该模型类型已停用` |

  同时 `en` 与 `zh` **各删两条**（分区删除入口没了）：
  `providersModels.card.removeTitle`、`providersModels.card.removeMessage`、
  `providersModels.card.builtinLocked`（三条，`en`/`zh` 各删同一条）。

- [ ] **Step 7: 跑测试确认通过**

  Run: `cd enterprise_server/web && npx vitest run tests/pages/providersModels/ProviderCard.test.tsx tests/pages/providersModels/ModelTypeSection.test.tsx tests/pages/ProvidersModelsPage.test.tsx`
  Expected: PASS。

  Run: `cd enterprise_server/web && npx vitest run`
  Expected: 全绿。

- [ ] **Step 8: 提交**

  ```bash
  git add -A enterprise_server/web/src enterprise_server/web/tests
  git commit -m "feat(console): configure each model type in its own tab

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
  ```

---

### Task 8: 保存时为「已填内容」的 Tab 建分区

**Files:**
- Modify: `enterprise_server/web/src/pages/ProvidersModelsPage.tsx`
- Test: `enterprise_server/web/tests/pages/ProvidersModelsPage.test.tsx`

**Interfaces:**
- Consumes: Task 7 的 Tab 草稿键（`draftKeyForTab`）与 `SectionDraft.protocol`。
- Produces: 无新导出。

- [ ] **Step 1: 写失败测试 `enterprise_server/web/tests/pages/ProvidersModelsPage.test.tsx`**

  三条：

  ```ts
  test('saving a card creates a section for a tab the admin filled in', async () => {
    mockFetchData([card()]);
    renderPage();
    const user = userEvent.setup();
    // Open the image tab, which this card has no section for.
    await user.click(await screen.findByRole('tab', { name: 'Image generation' }));
    // Type an API key: that is what makes the tab "configured".
    await user.type(await screen.findByLabelText('API Key'), 'sk-image');
    await user.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(calledWith('/admin/provider-keys', 'POST')).toBe(true));
    expect(requestBody('/admin/provider-keys', 'POST')).toMatchObject({
      cardId: 'c1',
      provider: 'openai',
      protocol: 'image-gen',
      apiKey: 'sk-image',
    });
  });
  ```

  ```ts
  test('saving a card does not create sections for untouched tabs', async () => {
    mockFetchData([card()]);
    renderPage();
    const user = userEvent.setup();
    // Visit an unconfigured tab and leave it empty.
    await user.click(await screen.findByRole('tab', { name: 'Video generation' }));
    await user.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(calledWith('/admin/provider-cards/c1', 'PATCH')).toBe(true));
    expect(calledWith('/admin/provider-keys', 'POST')).toBe(false);
  });
  ```

  ```ts
  test('saving a new card creates one key per configured tab', async () => {
    mockFetchData([]);
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Add provider/i }));
    // Fill the LLM tab only.
    await user.type(await screen.findByLabelText('API Key'), 'sk-llm');
    await user.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(calledWith('/admin/provider-cards', 'POST')).toBe(true));
    await waitFor(() => expect(calledWith('/admin/provider-keys', 'POST')).toBe(true));
    const bodies = fetchMock.mock.calls
      .filter((c) => String(c[0]).startsWith('/admin/provider-keys')
        && ((c[1] as RequestInit | undefined)?.method ?? 'GET') === 'POST')
      .map((c) => JSON.parse(String((c[1] as RequestInit).body)) as Record<string, unknown>);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ protocol: 'openai', apiKey: 'sk-llm' });
  });
  ```

- [ ] **Step 2: 跑测试确认失败**

  Run: `cd enterprise_server/web && npx vitest run tests/pages/ProvidersModelsPage.test.tsx`
  Expected: FAIL —— 三个用例都建不出分区（保存只 PATCH 已存在的分区）。

- [ ] **Step 3: 实现**

  在 `ProvidersModelsPage.tsx` 里加一个模块级助手：

  ```ts
  /** A tab the admin actually filled in: a typed API key, or a Base URL that
   * is not the protocol's default. An untouched tab is NOT created — a save
   * must not conjure empty sections. */
  function isTabConfigured(
    draft: SectionDraft,
    slug: string,
    protocol: ProviderProtocol,
  ): boolean {
    if (draft.apiKey.trim() !== '') return true;
    return draft.baseUrl.trim() !== defaultBaseUrlFor(slug, protocol);
  }
  ```

  把 `saveCardMut` 改成遍历**所有 Tab**：

  ```ts
  const saveCardMut = useMutation({
    mutationFn: async (target: ProviderCardView) => {
      await providerCardsApi.patch(target.id, { label: drafts.label.trim() || null });
      for (const tab of MODEL_TYPE_TABS) {
        const section = target.sections.find(
          (s) => tabForProtocol(s.protocol)?.id === tab.id,
        );
        const draft = drafts.sections[section ? section.providerKeyId : draftKeyForTab(tab.id)];
        if (!draft) continue;
        if (section) {
          await providersApi.patch(section.providerKeyId, {
            baseUrl: draft.baseUrl.trim() || null,
            codingPlan: draft.codingPlan,
            ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
          });
          continue;
        }
        // A tab that does not exist yet: create it only if the admin filled
        // something in.
        if (!isTabConfigured(draft, target.provider, draft.protocol)) continue;
        await providersApi.add({
          orgId,
          cardId: target.id,
          provider: target.provider,
          protocol: draft.protocol,
          endpoint: draft.baseUrl.trim() || defaultBaseUrlFor(target.provider, draft.protocol),
          codingPlan: draft.codingPlan,
          ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
        });
      }
    },
    onSuccess: () => {
      invalidate();
      toast.success(t('providersModels.toast.saved'));
    },
    onError: (e: Error) => toast.error(e.message),
  });
  ```

  把 `createCardMut` 改成同样的遍历（先建卡片，再按 Tab 建分区）：

  ```ts
  const createCardMut = useMutation({
    mutationFn: async (): Promise<string> => {
      const provider = slug;
      const { id } = await providerCardsApi.create({
        orgId,
        provider,
        label: drafts.label.trim() || undefined,
      });
      for (const tab of MODEL_TYPE_TABS) {
        const draft = drafts.sections[draftKeyForTab(tab.id)];
        if (!draft) continue;
        if (!isTabConfigured(draft, provider, draft.protocol)) continue;
        await providersApi.add({
          orgId,
          cardId: id,
          provider,
          protocol: draft.protocol,
          endpoint: draft.baseUrl.trim() || defaultBaseUrlFor(provider, draft.protocol),
          codingPlan: draft.codingPlan,
          ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
        });
      }
      return id;
    },
    onSuccess: (id) => {
      invalidate();
      toast.success(t('providersModels.toast.saved'));
      reset({});
      setSelectedId(id);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  ```

  删掉 `checkedCapabilities`（不再使用）与 `createCardMut.onSuccess` 里的 `setDraftCapabilities([])`。

- [ ] **Step 4: 跑测试确认通过**

  Run: `cd enterprise_server/web && npx vitest run tests/pages/ProvidersModelsPage.test.tsx`
  Expected: PASS。

  Run: `cd enterprise_server/web && npx vitest run`
  Expected: 全绿。

- [ ] **Step 5: 提交**

  ```bash
  git add enterprise_server/web/src enterprise_server/web/tests
  git commit -m "feat(console): create a section for every model type the admin filled in

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
  ```

---

### Task 9: 文案改名 + i18n parity 测试

**Files:**
- Modify: `enterprise_server/web/src/i18n.ts`
- Create: `enterprise_server/web/tests/shared/i18n.parity.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `i18n.ts` 导出 `i18nDicts: { en: Dict; zh: Dict }`。

- [ ] **Step 1: 写失败测试 `enterprise_server/web/tests/shared/i18n.parity.test.ts`**

  ```ts
  import { describe, expect, test } from 'vitest';

  import { i18nDicts } from '../../src/i18n';

  describe('i18n parity', () => {
    test('en and zh carry exactly the same keys', () => {
      const en = Object.keys(i18nDicts.en).sort();
      const zh = Object.keys(i18nDicts.zh).sort();
      expect(zh.filter((k) => !en.includes(k))).toEqual([]);
      expect(en.filter((k) => !zh.includes(k))).toEqual([]);
    });
  });
  ```

- [ ] **Step 2: 跑测试确认失败**

  Run: `cd enterprise_server/web && npx vitest run tests/shared/i18n.parity.test.ts`
  Expected: FAIL —— `i18nDicts` 未导出。

- [ ] **Step 3: 导出 `i18nDicts`**

  `i18n.ts` 末尾把 `const dicts = { en, zh };` 改成
  `export const i18nDicts = { en, zh };`，并把 `t()` / `Lang` 里对 `dicts` 的引用一起改掉
  （`export type Lang = keyof typeof i18nDicts;`，`t()` 里用 `i18nDicts[currentLang]`）。

- [ ] **Step 4: 跑测试确认通过**

  Run: `cd enterprise_server/web && npx vitest run tests/shared/i18n.parity.test.ts`
  Expected: PASS。

- [ ] **Step 5: 改文案（改值不改 key）**

  `i18n.ts` 的 `en` 与 `zh` 各改三条：

  | key | en 新值 | zh 新值 |
  |---|---|---|
  | `providersModels.card.capabilities` | `Model types` | `模型类型` |
  | `providersModels.model.colType` | `Model capability` | `模型能力` |
  | `providersModels.drawer.types` | `Model capabilities` | `模型能力` |

- [ ] **Step 6: 跑整包控制台测试**

  Run: `cd enterprise_server/web && npx vitest run`
  Expected: 全绿。

  有测试断言旧文案（`'Type'` / `'Types'`）的话，一并改成新文案
  （`enterprise_server/web/tests/pages/ProvidersModelsPage.test.tsx` 里断言
  `screen.getByText('Type')` 的那条要改成 `'Model capability'`）。

- [ ] **Step 7: 提交**

  ```bash
  git add enterprise_server/web/src/i18n.ts enterprise_server/web/tests/shared/i18n.parity.test.ts enterprise_server/web/tests
  git commit -m "feat(console): call the model types and capabilities what they are

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
  ```

---

### Task 10: 视觉基线的断言改成 Tab

**Files:**
- Modify: `enterprise_server/web/tests/visual/providers.spec.ts`

**Interfaces:**
- Consumes: Task 7 的 Tab 角色。
- Produces: 无。

- [ ] **Step 1: 改写 `enterprise_server/web/tests/visual/providers.spec.ts`**

  1. 文件头注释里「the detail pane is one card whose capability chips gate one section per capability」
     改成「the detail pane is one card whose four model-type tabs gate one section per tab」。
  2. `'vendor card rail: one row per card, grouped, with capability tags'` 这条：
     - 改名成 `'vendor card rail: one row per card, grouped, with no type tags'`；
     - 删掉 `expect(await page.getByText('LLM', { exact: true }).count()).toBeGreaterThan(0);`
       这条断言（清单行不再有类型标签），改成
       `expect(await page.getByText('LLM', { exact: true }).count()).toBe(0);`。
  3. `'vendor card: header, name, capability chips, LLM section'` 这条：
     - 改名成 `'vendor card: header, name, model-type tabs, LLM section'`；
     - 四条 checkbox 断言换成：
       ```ts
       await expect(page.getByRole('tab', { name: 'LLM (VLM)' })).toBeVisible();
       await expect(page.getByRole('tab', { name: 'Speech recognition' })).toBeVisible();
       await expect(page.getByRole('tab', { name: 'Image generation' })).toBeVisible();
       await expect(page.getByRole('tab', { name: 'Video generation' })).toBeVisible();
       ```
  4. `'model drawer: the section types + context + sampling'` 这条里
     `await expect(drawer.getByText('Types', { exact: true })).toBeVisible();`
     改成 `await expect(drawer.getByText('Model capabilities', { exact: true })).toBeVisible();`。

- [ ] **Step 2: 跑视觉测试**

  Run: `cd enterprise_server/web && npx playwright test tests/visual/providers.spec.ts`
  Expected: 需要一个带种子的后端（`WEB_PORT` / `WEB_PROXY_TARGET` / `WEB_ORG_ID` / `WEB_JWT_SECRET`）。
  **没有种子后端时这一步跑不了**——此时只做静态检查（`npx tsc --noEmit -p tsconfig.json` 通过），
  并在交付说明里写明「视觉基线未在本地重生成（需要带种子的后端），基线不入库」。

- [ ] **Step 3: 类型检查**

  Run: `cd enterprise_server/web && npx tsc --project tsconfig.json --noEmit`
  Expected: 无错误。

- [ ] **Step 4: 提交**

  ```bash
  git add enterprise_server/web/tests/visual/providers.spec.ts
  git commit -m "test(console): assert the model-type tabs in the visual spec

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
  ```

---

## 交付前自检

- [ ] `cd enterprise_server/web && npx vitest run` 全绿
- [ ] `cd enterprise_server && npx vitest run tests/routes/providerKeysV2.test.ts` 全绿
- [ ] `cd enterprise_server && npx vitest run tests/routes/providerKeysExtended.test.ts` 全绿
- [ ] `cd enterprise_server/web && npx tsc --project tsconfig.json --noEmit` 无错误
- [ ] `cd enterprise_server && npx tsc --noEmit` 无错误（服务端类型）
- [ ] `rg -n "Capability|capability" enterprise_server/web/src` 只剩跟「模型能力（capability）」语义无关的残留，且没有未使用的导出
- [ ] `rg -n "removeSectionMut|pendingCapabilityRemove|draftCapabilities|pendingProtocolSwitch" enterprise_server/web/src` 无命中
- [ ] `git diff main --stat` 里没有顺手改动的无关文件
