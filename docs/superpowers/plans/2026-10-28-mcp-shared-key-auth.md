# MCP Shared-Key (Org-Wide) Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `shared-key` (org-wide) MCP connectors usable — the org key stays on the enterprise server, the desktop dials a per-connector enterprise gateway that injects it, and tool policy plus membership are enforced server-side.

**Architecture:** A new stateless enterprise route `/mcp/gateway/:serverKey` authenticates a 90-day gateway service token (GSJ, `Authorization: McpGateway <token>`), re-checks the caller's membership and scope on every request, enforces the org's tool policy, decrypts the org key, and relays the Streamable-HTTP request to the upstream without buffering. The desktop never holds the org key: it stores a GSJ bound to the signed-in member and rewrites the target URL at config-sync and probe time from one resolver.

**Tech Stack:** TypeScript, Hono (+ a hand-written `node:http` adapter) and Postgres/pglite on the enterprise side; React 19 console; Electron main (Node) + React/Redux renderer on the desktop; `jose` for JWTs; Vitest everywhere.

**Spec:** `docs/superpowers/specs/2026-10-28-mcp-shared-key-auth-design.md` — read it alongside this plan. Every `D<n>` below refers to a decision in its §5.

## Global Constraints

- **Org key never leaves the enterprise server.** It may appear only in enterprise process memory, `mcp_connectors.auth_config.__enc__apiKey`, and the upstream request headers (spec §9.1).
- **GSJ signing key is derived, never `JWT_SECRET` itself:** `sha256(JWT_SECRET + '::mcp_gateway')`; TTL 90 days (`90 * 24 * 60 * 60` seconds); re-issue when less than 15 days remain (D3, D18).
- **Scheme is exactly `McpGateway ` (capital M, capital G, one space).** `Bearer` on a gateway route is a 401 (D18(2)).
- **`MEMBER_STATUS_TTL_MS = 30_000`**, and a DB error fails **open** (D18(4)). Do not "fix" the fail-open.
- **Tool policy is fail-closed:** an empty `tools` array means *deny every* `tools/call`, not allow all (D6).
- **Audit only `tools/call`**, action string `mcp_gateway_call`; never buffer a response body to write it (D8, D20(2)).
- **No hardcoded user-visible strings.** Console uses `t()` from `enterprise_server/web/src/i18n.ts`; desktop renderer uses `t()` from `src/renderer/services/i18n.ts`. Add **both** `zh` and `en`.
- **Do not add a migration.** `audit_events.action` is `TEXT NOT NULL` with no CHECK, and the desktop's MCP fields live in `mcp_servers.config_json`. Enterprise migration files are immutable — never edit an applied one.
- **Shared-key upstreams must be `https:`** — loopback addresses excepted (D17).
- **Tests:** enterprise tests are Vitest under `enterprise_server/tests/<area>/`; run **one file at a time** (`cd enterprise_server && npm test -- tests/<area>/<file>.test.ts`) because a full run exhausts file descriptors in this sandbox. Desktop tests are colocated `*.test.ts`; run from the repo root with `npm test -- <filter>`.
- **Lint every touched TS/TSX file:** `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <files>`.
- **Commits:** Conventional Commits, English, no `Co-Authored-By` trailer (project rule).

## Review Focus

The spec is a vision document; these are the five failure modes its silence or its compression most invites. Each has a test pinned in the owning task.

1. **A `shared-key` connector that was never probed** (`tools: []`) — a reasonable person expects "nothing is allowed", not "everything is allowed". `toolFilterFor` returns `undefined` here, so reusing it would open the gate. (Task 6, Task 11)
2. **Two people on one machine** — A logs out, B logs in; B must not ride A's GSJ into A's org permissions. The stored GSJ carries no obvious owner, so nothing breaks visibly. (Task 18, Task 20)
3. **The OpenClaw gateway restarting every 4 minutes** — any change to `openclaw.json`'s `mcp` section forces a hard restart; a credential that rotates on the JWT refresh cadence would restart it on every sync. (Task 19)
4. **A revoked member seeing "gateway credential invalid"** instead of being signed out — the gateway's 401 has two shapes and the desktop's revocation hook is not on the MCP path. (Task 21)
5. **The org key riding in the clear or being sent to an address nobody vetted** — plaintext `http://` upstreams, and member-submitted connectors that an admin approves blind. (Task 8, Task 14, Task 15)

---

## File Structure

**Created — enterprise (`enterprise_server/src`)**

| File | Responsibility |
|---|---|
| `http/responseStreaming.ts` | Pure "must this response be streamed?" decision |
| `http/nodeAdapter.ts` | The `node:http` → Hono adapter, extracted so streaming is testable |
| `mcp/orgCredential.ts` | Upstream auth headers for `shared-key` (probe and gateway share it) |
| `mcp/connectorVisibility.ts` | The single "may this caller see/use this connector?" predicate |
| `mcp/gatewayPolicy.ts` | Per-tool allow decision over `ToolEntry[]`, fail-closed |
| `auth/memberStatus.ts` | `resolveMemberStatus` + its 30s cache (extracted from `requireActiveMember`) |
| `routes/mcpGateway.ts` | The relay route, the token route, the audit write |

`auth/jwt.ts` gains the GSJ pair. Everything else is a modification.

**Modified — enterprise**

`src/server.ts` (mount + adapter), `src/routes/mcpConnectors.ts` (probe headers, sse combination, `apiKeyHeaderName`), `src/routes/mcpSubmissions.ts` (member guard), `src/routes/mcpMarketplace.ts` (use the shared visibility predicate), `src/models/connectorView.ts` (`consumption`, `orgCredentialReady`), `src/auth/requireActiveMember.ts` (import the extracted status check), `src/shared/enterpriseServerConstants.ts` (`AuditAction.McpGatewayCall`).

**Modified — console (`enterprise_server/web/src`)**

`pages/mcpManage/ConnectorAuthFields.tsx`, `ConnectorConnConfig.tsx`, `ConnectorBasicInfo.tsx`, `ReviewDetailDrawer.tsx`, `i18n.ts`.

**Created — desktop**

| File | Responsibility |
|---|---|
| `src/main/mcp/mcpTarget.ts` | `resolveMcpTarget` — the only place a record becomes a dialable URL+headers |
| `src/main/mcp/mcpGatewayToken.ts` | `ensureGatewayToken` — owner check, re-issue, persist |
| `src/main/enterpriseAccount/membershipRevocationBridge.ts` | Module-level entry point so the MCP path can fire the existing revocation handler |

**Modified — desktop**

`src/shared/mcp/constants.ts`, `src/main/mcp/mcpStore.ts`, `src/main/mcp/mcpRuntime.ts`, `src/main/mcp/mcpToolCatalog.ts`, `src/main/auth/enterpriseClient.ts`, `src/main/main.ts`, `src/renderer/components/mcp/enterpriseAuthMode.ts`, `src/renderer/components/mcp/McpManager.tsx`, `src/renderer/components/mcp/McpServerFormModal.tsx`, `src/renderer/types/mcp.ts`, `src/renderer/types/electron.d.ts`, `src/renderer/services/i18n.ts`.

---

## P0 — Unblock streaming (prerequisite)

The gateway relays an upstream SSE stream. Today `serve()` buffers every response body, so a long-lived stream never returns and the gateway's `GET` hangs (spec D15). This phase is independent of the feature and must land first.

### Task 1: The "must this response be streamed?" decision

**Files:**
- Create: `enterprise_server/src/http/responseStreaming.ts`
- Test: `enterprise_server/tests/http/responseStreaming.test.ts`

**Interfaces:**
- Produces: `export function shouldStreamResponse(headers: { get(name: string): string | null }): boolean`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'vitest';
import { shouldStreamResponse } from '../../src/http/responseStreaming';

const h = (m: Record<string, string>) => ({ get: (n: string) => m[n.toLowerCase()] ?? null });

describe('shouldStreamResponse', () => {
  test('streams text/event-stream', () => {
    expect(shouldStreamResponse(h({ 'content-type': 'text/event-stream; charset=utf-8' }))).toBe(true);
  });
  test('keeps streaming range responses', () => {
    expect(shouldStreamResponse(h({ 'accept-ranges': 'bytes', 'content-type': 'application/zip' }))).toBe(true);
  });
  test('buffers an ordinary json response', () => {
    expect(shouldStreamResponse(h({ 'content-type': 'application/json' }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd enterprise_server && npm test -- tests/http/responseStreaming.test.ts`
Expected: FAIL — cannot resolve `../../src/http/responseStreaming`.

- [ ] **Step 3: Implement it**

Two conditions, in this order: `accept-ranges` present (the existing installer-download behavior), then `content-type` starting with `text/event-stream`. Everything else buffers.

- [ ] **Step 4: Run it and see it pass**

Run: `cd enterprise_server && npm test -- tests/http/responseStreaming.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/http/responseStreaming.ts enterprise_server/tests/http/responseStreaming.test.ts
git commit -m "feat(enterprise): decide streaming responses by content type"
```

### Task 2: Extract the node:http adapter and use the streaming decision

**Files:**
- Create: `enterprise_server/src/http/nodeAdapter.ts`
- Modify: `enterprise_server/src/server.ts` (the `serve()` listener body)
- Test: `enterprise_server/tests/http/nodeAdapter.test.ts`

**Interfaces:**
- Consumes: `shouldStreamResponse` (Task 1)
- Produces: `export function createNodeRequestHandler(app: { fetch(req: Request): Response | Promise<Response> }): (req: IncomingMessage, res: ServerResponse) => Promise<void>`

- [ ] **Step 1: Write the failing test**

The adapter is not covered by `app.request()` route tests — it needs a real socket. The stream stays open until the test closes it, so a buffering adapter never delivers a chunk; the sentinel rejects instead of hanging.

```ts
import { afterEach, expect, test } from 'vitest';
import http from 'node:http';
import { createNodeRequestHandler } from '../../src/http/nodeAdapter';

let close: (() => void) | null = null;
afterEach(() => close?.());

test('an sse chunk reaches the client before the stream closes', async () => {
  let push!: (s: string) => void;
  let end!: () => void;
  const body = new ReadableStream({
    start(c) {
      push = (s) => c.enqueue(new TextEncoder().encode(s));
      end = () => c.close();
    },
  });
  const app = {
    fetch: async () =>
      new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
  };
  const server = http.createServer(createNodeRequestHandler(app));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  close = () => server.close();
  const port = (server.address() as { port: number }).port;

  const received = await new Promise<string>((resolve, reject) => {
    const sentinel = setTimeout(
      () => reject(new Error('adapter buffered: no chunk arrived while the stream was open')),
      2000,
    );
    http.get({ port, host: '127.0.0.1' }, (res) => {
      res.once('data', (buf) => {
        clearTimeout(sentinel);
        resolve(buf.toString());
      });
    });
    push('data: hello\n\n');
  });
  expect(received).toContain('data: hello');
  // `end` stays unused on the happy path: the stream is meant to outlive the
  // assertion, which is exactly what a buffering adapter cannot do.
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd enterprise_server && npm test -- tests/http/nodeAdapter.test.ts`
Expected: FAIL — cannot resolve `../../src/http/nodeAdapter`.

- [ ] **Step 3: Extract and rewire**

Move the request-listener body out of `serve()` into `createNodeRequestHandler` unchanged (read headers, buffer the request body unless GET/HEAD, `app.fetch(new Request(url, {...}))`), and replace the streaming gate: today it is `honoRes.headers.get('accept-ranges') && honoRes.body`; it becomes `shouldStreamResponse(honoRes.headers) && honoRes.body`, with the `Readable.fromWeb(...)` pipe unchanged. The buffered path stays `Buffer.from(await honoRes.arrayBuffer())` + `res.end(buf)`. `serve()` keeps only what surrounds it (server creation, `listen`, error handling).

- [ ] **Step 4: Run the adapter test and the enterprise suite for the mount**

Run: `cd enterprise_server && npm test -- tests/http/nodeAdapter.test.ts`
Expected: PASS, 1/1. A failure with "adapter buffered" means the gate was wired to the wrong header set.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/http/nodeAdapter.ts enterprise_server/src/server.ts enterprise_server/tests/http/nodeAdapter.test.ts
git commit -m "feat(enterprise): stream sse responses through the node adapter"
```

---

## P1 — The enterprise gateway

Everything a desktop needs to call a `shared-key` connector through the org: credential injection, visibility, tool policy, the member-status check, the GSJ, the relay, the public-view fields, the audit action, and the console forms.

### Task 3: Build upstream credential headers

**Files:**
- Create: `enterprise_server/src/mcp/orgCredential.ts`
- Test: `enterprise_server/tests/mcp/orgCredential.test.ts`

**Interfaces:**
- Consumes: `AuthMode6` from `../../models/connectorView`
- Produces: `export function buildOrgCredentialHeaders(authMode: string, plainAuthConfig: Record<string, unknown>): Record<string, string>`

> Ruling against spec §7, which sketched a one-argument signature: the mode cannot be inferred from a decrypted config (an `apiKey` may exist on a retired `client-creds` row), so the caller passes it. The caller always passes **decrypted** config — this function never touches `__enc__` ciphertext, so a ciphertext can never be forwarded as a key.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'vitest';
import { buildOrgCredentialHeaders } from '../../src/mcp/orgCredential';

describe('buildOrgCredentialHeaders', () => {
  test('defaults to Authorization: Bearer <key>', () => {
    expect(buildOrgCredentialHeaders('shared-key', { apiKey: 'k-1' })).toEqual({
      Authorization: 'Bearer k-1',
    });
  });
  test('a custom header name carries the raw key, no prefix', () => {
    expect(
      buildOrgCredentialHeaders('shared-key', { apiKey: 'k-1', apiKeyHeaderName: 'X-API-Key' }),
    ).toEqual({ 'X-API-Key': 'k-1' });
  });
  test('no key means no headers', () => {
    expect(buildOrgCredentialHeaders('shared-key', {})).toEqual({});
    expect(buildOrgCredentialHeaders('shared-key', { apiKey: '   ' })).toEqual({});
  });
  test('modes other than shared-key never leak a key', () => {
    expect(buildOrgCredentialHeaders('user-key', { apiKey: 'k-1' })).toEqual({});
    expect(buildOrgCredentialHeaders('none', { apiKey: 'k-1' })).toEqual({});
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd enterprise_server && npm test -- tests/mcp/orgCredential.test.ts`
Expected: FAIL — cannot resolve `../../src/mcp/orgCredential`.

- [ ] **Step 3: Implement it**

`authMode !== 'shared-key'` → `{}`. `apiKey` not a string or empty after trim → `{}`. `apiKeyHeaderName` a non-empty trimmed string → `{ [name]: apiKey }`. Otherwise `{ Authorization: 'Bearer ' + apiKey }`.

- [ ] **Step 4: Run it and see it pass**

Run: `cd enterprise_server && npm test -- tests/mcp/orgCredential.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/mcp/orgCredential.ts enterprise_server/tests/mcp/orgCredential.test.ts
git commit -m "feat(enterprise): build org credential headers for upstream mcp calls"
```

### Task 4: Move the member-status check into its own module

**Files:**
- Create: `enterprise_server/src/auth/memberStatus.ts`
- Modify: `enterprise_server/src/auth/requireActiveMember.ts`
- Test: `enterprise_server/tests/auth/memberStatus.test.ts`

**Interfaces:**
- Produces:
  - `export type MemberStatusResult = { kind: 'missing' } | { kind: 'status'; status: string } | { kind: 'error' }`
  - `export async function resolveMemberStatus(userId: string): Promise<MemberStatusResult>`
  - `export function _resetMemberStatusCacheForTest(): void`

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, expect, test, vi } from 'vitest';
import '../helpers/setupEnv';
import { pool } from '../../src/db/pool';
import { _resetMemberStatusCacheForTest, resolveMemberStatus } from '../../src/auth/memberStatus';

beforeEach(() => _resetMemberStatusCacheForTest());

test('an absent row is missing', async () => {
  expect(await resolveMemberStatus('nobody')).toEqual({ kind: 'missing' });
});

test('a db error fails open', async () => {
  const spy = vi.spyOn(pool, 'query').mockRejectedValueOnce(new Error('boom'));
  expect(await resolveMemberStatus('anyone')).toEqual({ kind: 'error' });
  spy.mockRestore();
});
```

(The `pglite` test DB needs `resetSchema()`/`runMigrations()` from `../../src/db/testDb` when the suite does not already do it globally — copy the setup used by `tests/routes/mcpConnectors.test.ts`. Add a `status`/`active` case once a member row exists.)

- [ ] **Step 2: Run it and see it fail**

Run: `cd enterprise_server && npm test -- tests/auth/memberStatus.test.ts`
Expected: FAIL — cannot resolve `../../src/auth/memberStatus`.

- [ ] **Step 3: Move the code**

Cut `MEMBER_STATUS_TTL_MS`, the cache map, and `resolveMemberStatus` out of `requireActiveMember.ts` into `memberStatus.ts` **verbatim** — same TTL (30 s), same "cache every outcome including `error`", same fail-open. `requireActiveMember.ts` imports it and keeps both exports (`requireActiveMember`, `requireActiveMemberNumeric`) and both body shapes byte-identical. Keep `_resetRequireActiveMemberCacheForTest` exported from `requireActiveMember.ts` as an alias, because `tests/asr/sessionRoute.test.ts` and `tests/routes/proxyChatCompletions.test.ts` import it.

- [ ] **Step 4: Run the moved test and the two tests that reset the old name**

Run: `cd enterprise_server && npm test -- tests/auth/memberStatus.test.ts`
Run: `cd enterprise_server && npm test -- tests/asr/sessionRoute.test.ts`
Run: `cd enterprise_server && npm test -- tests/routes/proxyChatCompletions.test.ts`
Expected: PASS — the first with the new cases, the other two unchanged (they prove the extraction kept the gate's behavior).

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/auth/memberStatus.ts enterprise_server/src/auth/requireActiveMember.ts enterprise_server/tests/auth/memberStatus.test.ts
git commit -m "refactor(enterprise): share the member status check and its cache"
```

### Task 5: The gateway service token pair

**Files:**
- Modify: `enterprise_server/src/auth/jwt.ts`
- Test: `enterprise_server/tests/auth/gatewayToken.test.ts`

**Interfaces:**
- Produces:
  - `export async function signGatewayToken(c: { orgId: string; sub: string; serverKey: string }): Promise<{ token: string; expiresAt: string }>`
  - `export async function verifyGatewayToken(token: string): Promise<{ orgId: string; sub: string; serverKey: string; purpose: string } | null>`

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'vitest';
import '../helpers/setupEnv';
import { signGatewayToken, signToken, verifyGatewayToken, verifyToken } from '../../src/auth/jwt';

const claims = { sub: 'u1', orgId: 'o1', roles: [] as string[] };

test('a gsj round-trips with its server key and purpose', async () => {
  const { token, expiresAt } = await signGatewayToken({ ...claims, serverKey: 'sk-1' });
  const v = await verifyGatewayToken(token);
  expect(v).toMatchObject({ sub: 'u1', orgId: 'o1', serverKey: 'sk-1', purpose: 'mcp_gateway' });
  expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now() + 89 * 24 * 3600 * 1000);
});

test('the two token families never verify into each other', async () => {
  const memberJwt = await signToken(claims);
  expect(await verifyGatewayToken(memberJwt)).toBeNull();
  const { token: gsj } = await signGatewayToken({ ...claims, serverKey: 'sk-1' });
  await expect(verifyToken(gsj)).rejects.toBeTruthy();
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd enterprise_server && npm test -- tests/auth/gatewayToken.test.ts`
Expected: FAIL — `signGatewayToken` is not exported.

- [ ] **Step 3: Implement it**

A separate `Uint8Array` key: `createHash('sha256').update(process.env.JWT_SECRET + '::mcp_gateway').digest()`. `signGatewayToken` signs `{ sub, orgId, serverKey, purpose: 'mcp_gateway' }` with `.setExpirationTime(90 * 24 * 60 * 60)` and returns the token plus the ISO expiry (`Date.now() + 90d`). `verifyGatewayToken` verifies against the derived key and returns `null` — never throws — unless `purpose === 'mcp_gateway'` and `sub`/`orgId`/`serverKey` are all strings. The existing `signToken`/`verifyToken` are not touched and neither function calls the other.

- [ ] **Step 4: Run it and see it pass**

Run: `cd enterprise_server && npm test -- tests/auth/gatewayToken.test.ts`
Expected: PASS, 2/2. If the second test fails, both families share a key — revert and derive a distinct one.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/auth/jwt.ts enterprise_server/tests/auth/gatewayToken.test.ts
git commit -m "feat(enterprise): add the mcp gateway service token pair"
```

### Task 6: One visibility predicate for the market and the gateway

**Files:**
- Create: `enterprise_server/src/mcp/connectorVisibility.ts`
- Modify: `enterprise_server/src/routes/mcpMarketplace.ts:20-44`
- Test: `enterprise_server/tests/mcp/connectorVisibility.test.ts`

**Interfaces:**
- Consumes: `descendantsOf` and `scopeApi.deptIdsFor` from `../auth/scopeResolver` (as `mcpMarketplace.ts` already does)
- Produces:
  - `export interface ConnectorCaller { userId: string; isSuperAdmin: boolean; deptIds: string[] }`
  - `export function connectorVisibleToCaller(row: { scope: ConnectorScope }, caller: ConnectorCaller, deptPath: Map<string, string>): boolean`
  - `export async function loadConnectorDeptPath(orgId: string): Promise<Map<string, string>>` — the org's `id → path` map, cached 30 s per org (the gateway is a hot path and must not scan `departments` per request)

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'vitest';
import { connectorVisibleToCaller } from '../../src/mcp/connectorVisibility';

const paths = new Map([['d1', 'd1'], ['d2', 'd1.d2'], ['d9', 'd9']]);
const caller = { userId: 'u1', isSuperAdmin: false, deptIds: ['d2'] };

test('granting a parent dept reaches the child dept member', () => {
  expect(connectorVisibleToCaller({ scope: { allCompany: false, deptIds: ['d1'], userIds: [] } }, caller, paths)).toBe(true);
});
test('another dept does not', () => {
  expect(connectorVisibleToCaller({ scope: { allCompany: false, deptIds: ['d9'], userIds: [] } }, caller, paths)).toBe(false);
});
test('a user exception and allCompany both grant', () => {
  expect(connectorVisibleToCaller({ scope: { allCompany: false, deptIds: [], userIds: ['u1'] } }, caller, paths)).toBe(true);
  expect(connectorVisibleToCaller({ scope: { allCompany: true, deptIds: [], userIds: [] } }, caller, paths)).toBe(true);
});
test('a super admin sees everything', () => {
  expect(
    connectorVisibleToCaller(
      { scope: { allCompany: false, deptIds: ['d9'], userIds: [] } },
      { ...caller, isSuperAdmin: true },
      paths,
    ),
  ).toBe(true);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd enterprise_server && npm test -- tests/mcp/connectorVisibility.test.ts`
Expected: FAIL — cannot resolve `../../src/mcp/connectorVisibility`.

- [ ] **Step 3: Move the predicate, verbatim and in order**

Copy the four checks from `mcpMarketplace.ts` in their existing order — super admin, `allCompany`, `userIds` includes caller, then `descendantsOf(granted deptIds, deptPath)` ∩ caller's own depts. `mcpMarketplace.ts` then builds the caller once (`scopeApi.deptIdsFor`, `isSuperAdmin` from claims) and calls this function in place of its inline block. Do not "improve" the predicate while moving it; a behavior change here silently widens access.

- [ ] **Step 4: Run it, then the marketplace route test**

Run: `cd enterprise_server && npm test -- tests/mcp/connectorVisibility.test.ts`
Run: `cd enterprise_server && npm test -- tests/routes/mcpMarketplace.test.ts`
Expected: PASS — the second is the parity proof that the market still returns the same rows after the extraction.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/mcp/connectorVisibility.ts enterprise_server/src/routes/mcpMarketplace.ts enterprise_server/tests/mcp/connectorVisibility.test.ts
git commit -m "refactor(enterprise): share one connector visibility predicate"
```

### Task 7: The tool policy, fail-closed

**Files:**
- Create: `enterprise_server/src/mcp/gatewayPolicy.ts`
- Test: `enterprise_server/tests/mcp/gatewayPolicy.test.ts`

**Interfaces:**
- Consumes: `ToolEntry` from `../models/connectorView`
- Produces: `export function toolAllowedByPolicy(tools: ToolEntry[], toolName: string): boolean`

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'vitest';
import { toolAllowedByPolicy } from '../../src/mcp/gatewayPolicy';
import type { ToolEntry } from '../../src/models/connectorView';

const t = (name: string, extra: Partial<ToolEntry> = {}): ToolEntry => ({ name, enabled: true, ...extra });

test('a connector that was never probed denies every tool', () => {
  expect(toolAllowedByPolicy([], 'create_lead')).toBe(false);
});
test('every entry removed denies every tool', () => {
  expect(toolAllowedByPolicy([t('a', { removed: true })], 'a')).toBe(false);
});
test('an enabled live tool is allowed, a disabled one is not', () => {
  expect(toolAllowedByPolicy([t('a'), t('b', { enabled: false })], 'a')).toBe(true);
  expect(toolAllowedByPolicy([t('a'), t('b', { enabled: false })], 'b')).toBe(false);
});
test('all live tools enabled allows each of them', () => {
  expect(toolAllowedByPolicy([t('a', { syncedAt: 'x' }), t('b', { syncedAt: 'x' })], 'b')).toBe(true);
});
test('a hand-declared list is a whitelist', () => {
  const tools = [t('a'), t('b', { enabled: false })];
  expect(toolAllowedByPolicy(tools, 'a')).toBe(true);
  expect(toolAllowedByPolicy(tools, 'b')).toBe(false);
  expect(toolAllowedByPolicy(tools, 'never-declared')).toBe(false);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd enterprise_server && npm test -- tests/mcp/gatewayPolicy.test.ts`
Expected: FAIL — cannot resolve `../../src/mcp/gatewayPolicy`.

- [ ] **Step 3: Implement it**

```ts
const live = tools.filter((t) => !t.removed);
if (live.length === 0) return false;            // never probed, never declared → deny all
return live.some((t) => t.name === toolName && t.enabled);
```

The spec's five-row table (D6) collapses to this because "all enabled → all", "hand-declared → declared∩enabled" and "0 enabled → none" are all the same answer once `removed` entries are dropped. Do **not** reuse `toolFilterFor`: it returns `undefined` for both "no policy" and "no restriction", which is exactly the ambiguity that would open the gate.

- [ ] **Step 4: Run it and see it pass**

Run: `cd enterprise_server && npm test -- tests/mcp/gatewayPolicy.test.ts`
Expected: PASS, 5/5.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/mcp/gatewayPolicy.ts enterprise_server/tests/mcp/gatewayPolicy.test.ts
git commit -m "feat(enterprise): add a fail-closed mcp tool policy"
```

### Task 8: Publish `consumption` and `orgCredentialReady`

**Files:**
- Modify: `enterprise_server/src/models/connectorView.ts` (`ConnectorPublicView`, `mapPublicConnector` at ~:311)
- Test: `enterprise_server/tests/models/connectorView.test.ts`

**Interfaces:**
- Produces: `ConnectorPublicView.consumption?: 'direct' | 'gateway'`, `ConnectorPublicView.orgCredentialReady?: boolean`

- [ ] **Step 1: Write the failing test**

Add to the existing file, using its `row()` helper (or a minimal `ConnectorRow` builder):

```ts
test('shared-key is a gateway mode and reports whether the org key is stored', () => {
  const v = mapPublicConnector(row({ auth_mode: 'shared-key', auth_config: { __enc__apiKey: 'cipher' } }));
  expect(v.consumption).toBe('gateway');
  expect(v.orgCredentialReady).toBe(true);
});
test('a shared-key row with no stored key is not ready', () => {
  const v = mapPublicConnector(row({ auth_mode: 'shared-key', auth_config: {} }));
  expect(v.orgCredentialReady).toBe(false);
});
test('other modes are direct and carry no readiness claim', () => {
  const v = mapPublicConnector(row({ auth_mode: 'user-key', auth_config: {} }));
  expect(v.consumption).toBe('direct');
  expect(v.orgCredentialReady).toBeUndefined();
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd enterprise_server && npm test -- tests/models/connectorView.test.ts`
Expected: FAIL — `consumption` is `undefined`, not `'gateway'`.

- [ ] **Step 3: Implement it**

`consumption: row.auth_mode === 'shared-key' ? 'gateway' : 'direct'`. `orgCredentialReady` only for `shared-key`, and computed from `__enc__apiKey` directly — **not** `hasStoredSecret`, which is true for `shared-key` rows carrying only a `__enc__clientSecret` (a leftover from a mode change) and would claim readiness for a key that does not exist.

- [ ] **Step 4: Run it and see it pass**

Run: `cd enterprise_server && npm test -- tests/models/connectorView.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/models/connectorView.ts enterprise_server/tests/models/connectorView.test.ts
git commit -m "feat(enterprise): publish connector consumption and key readiness"
```

### Task 9: Probe with the org credential, and refuse shared-key over SSE

**Files:**
- Modify: `enterprise_server/src/routes/mcpConnectors.ts` (`:206` `sseOauthCombination`, the `/test` header block at `:654-657`)
- Test: `enterprise_server/tests/routes/mcpConnectors.test.ts`

**Interfaces:**
- Consumes: `buildOrgCredentialHeaders` (Task 3)

- [ ] **Step 1: Write the failing tests**

```ts
test('the probe sends the org key under a custom header name', async () => {
  // create a shared-key connector with authConfig { apiKey: 'k-1', apiKeyHeaderName: 'X-API-Key' }
  // POST /admin/mcp-connectors/:id/test, then read the mocked probeConnector call
  expect(probeSpy).toHaveBeenCalledWith(expect.objectContaining({ headers: { 'X-API-Key': 'k-1' } }));
});
test('shared-key cannot be published over sse', async () => {
  expect(sseOauthCombination('sse', 'shared-key')).toBe(true);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd enterprise_server && npm test -- tests/routes/mcpConnectors.test.ts`
Expected: FAIL — headers are `{ Authorization: 'Bearer k-1' }` and `sseOauthCombination('sse','shared-key')` is `false`.

- [ ] **Step 3: Implement it**

Replace the hardcoded `Authorization: Bearer` block with `buildOrgCredentialHeaders(row.auth_mode, plain)` (the same decrypted `plain` already computed above it). Add `'shared-key'` to the list in `sseOauthCombination`. Leave `missingAuthField('shared-key')` requiring an `apiKey`.

- [ ] **Step 4: Run it and see it pass**

Run: `cd enterprise_server && npm test -- tests/routes/mcpConnectors.test.ts`
Expected: PASS, whole file.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/routes/mcpConnectors.ts enterprise_server/tests/routes/mcpConnectors.test.ts
git commit -m "feat(enterprise): probe shared-key connectors with the configured header name"
```

### Task 10: Members cannot propose an org-credential mode

**Files:**
- Modify: `enterprise_server/src/routes/mcpSubmissions.ts:108-114`
- Test: `enterprise_server/tests/routes/mcpSubmissions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('a member cannot submit a shared-key connector', async () => {
  const res = await app.request('/mcp-submissions', {
    method: 'POST',
    headers: { authorization: `Bearer ${memberJwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({ cfg: { ...validCfg, authMode: 'shared-key', authConfig: { apiKey: 'k' } } }),
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: 'org_credential_mode_not_submittable' });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd enterprise_server && npm test -- tests/routes/mcpSubmissions.test.ts`
Expected: FAIL — status 200/201, the submission is accepted.

- [ ] **Step 3: Implement it**

Right after the `sseOauthCombination` guard, reject `cfg.authMode === 'shared-key' || cfg.authMode === 'client-creds'` with 400 `{ error: 'org_credential_mode_not_submittable' }`. A member-supplied URL plus an admin-approved org key is the D16 escalation path; this guard is what closes it. Add the disabled reason to the console error copy in Task 19.

- [ ] **Step 4: Run it and see it pass**

Run: `cd enterprise_server && npm test -- tests/routes/mcpSubmissions.test.ts`
Expected: PASS, and the existing `none`/`user-key`/`user-oauth` submissions still pass.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/routes/mcpSubmissions.ts enterprise_server/tests/routes/mcpSubmissions.test.ts
git commit -m "fix(enterprise): reject member-submitted org credential modes"
```

### Task 11: The audit action

**Files:**
- Modify: `enterprise_server/src/shared/enterpriseServerConstants.ts` (`AuditAction`, ~:22)
- Test: `enterprise_server/tests/shared/enterpriseServerConstants.test.ts` (create only if the file does not exist)

**Interfaces:**
- Produces: `AuditAction.McpGatewayCall` = `'mcp_gateway_call'`

- [ ] **Step 1: Write the failing test**

```ts
test('the gateway call action is a lowercase snake_case id', () => {
  expect(AuditAction.McpGatewayCall).toBe('mcp_gateway_call');
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd enterprise_server && npm test -- tests/shared/enterpriseServerConstants.test.ts`
Expected: FAIL — `McpGatewayCall` does not exist.

- [ ] **Step 3: Implement it**

Add `McpGatewayCall: 'mcp_gateway_call'` to the `as const` map. **No migration**: `audit_events.action` is `TEXT NOT NULL` with no CHECK constraint (migration 004; 052 only adds an index).

- [ ] **Step 4: Run it and see it pass**

Run: `cd enterprise_server && npm test -- tests/shared/enterpriseServerConstants.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/shared/enterpriseServerConstants.ts enterprise_server/tests/shared/enterpriseServerConstants.test.ts
git commit -m "feat(enterprise): add the mcp gateway call audit action"
```

### Task 12: Issue and refresh a GSJ

**Files:**
- Create: `enterprise_server/src/routes/mcpGateway.ts`
- Test: `enterprise_server/tests/routes/mcpGateway.test.ts` (the issuing half; the relay half lands in Task 13 in the same file)

**Interfaces:**
- Consumes: `requireAuth` (`../auth/middleware`), `connectorVisibleToCaller` + `loadConnectorDeptPath` (Task 6), `signGatewayToken` (Task 5)
- Produces: `export const mcpGatewayRoutes = new Hono()` with `POST /mcp/gateway/:serverKey/token` → `{ token, expiresAt }`

- [ ] **Step 1: Write the failing tests**

Seed with the admin API the way `tests/routes/mcpConnectors.test.ts` does: `POST /admin/mcp-connectors` as a super-admin, then `POST /admin/mcp-connectors/:id/publish`.

```ts
test('a member gets a gsj for a shared-key connector they can see', async () => {
  const res = await app.request('/mcp/gateway/sk-1/token', {
    method: 'POST',
    headers: { authorization: `Bearer ${memberJwt}` },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(typeof body.token).toBe('string');
  expect((await verifyGatewayToken(body.token))?.serverKey).toBe('sk-1');
});

test('a connector the caller cannot see is 403', async () => { /* scope dept d9, caller in d2 */ });
test('a non shared-key connector is 400', async () => { /* authMode none */ });
test('an unknown server key is 404', async () => { /* path sk-nope */ });
test('an unauthenticated request is 401', async () => { /* no header */ });
test('a plaintext http upstream is 400', async () => { /* url http://example.com/mcp */ });
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd enterprise_server && npm test -- tests/routes/mcpGateway.test.ts`
Expected: FAIL — cannot resolve `../../src/routes/mcpGateway`.

- [ ] **Step 3: Implement the route**

Checks in exactly this order (each a distinct status, because the desktop distinguishes them):

| Check | Response |
|---|---|
| `requireAuth` passes | else 401 |
| connector exists with this `server_key` and the caller's `org_id` | else 404 |
| `enabled` | else 404 |
| `connectorVisibleToCaller` | else 403 |
| `auth_mode === 'shared-key'` | else 400 `{ error: 'not_gateway_mode' }` |
| upstream URL is `https:` or loopback | else 400 `{ error: 'upstream_insecure' }` |

Then `signGatewayToken({ orgId, sub: claims.sub, serverKey })` and return `{ token, expiresAt }`. Mount the module into its own `Hono` and let the test do `new Hono().route('/', mcpGatewayRoutes)`, mirroring the other route tests. The loopback predicate is `new URL(url).hostname` in `{'localhost', '127.0.0.1', '::1'}`.

- [ ] **Step 4: Run them and see them pass**

Run: `cd enterprise_server && npm test -- tests/routes/mcpGateway.test.ts`
Expected: PASS, 6/6.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/routes/mcpGateway.ts enterprise_server/tests/routes/mcpGateway.test.ts
git commit -m "feat(enterprise): issue mcp gateway service tokens"
```

### Task 13: Relay a request and its response

**Files:**
- Modify: `enterprise_server/src/routes/mcpGateway.ts`
- Test: `enterprise_server/tests/routes/mcpGateway.test.ts`

**Interfaces:**
- Consumes: `verifyGatewayToken` (Task 5), `resolveMemberStatus` (Task 4), `buildOrgCredentialHeaders` (Task 3)
- Produces: `ALL /mcp/gateway/:serverKey`

- [ ] **Step 1: Write the failing tests**

The relay dials with the global `fetch`, so the test replaces it: `const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);` (Hono's `app.request()` never uses global `fetch`, so nothing else in the suite is disturbed).

```ts
test('injects the org key and relays the upstream answer', async () => {
  upstream.mockResolvedValue(new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
    status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 's1' },
  }));
  const res = await app.request('/mcp/gateway/sk-1', {
    method: 'POST',
    headers: { authorization: `McpGateway ${gsj}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('mcp-session-id')).toBe('s1');
  const [, init] = upstream.mock.calls[0];
  const sent = new Headers(init.headers);
  expect(sent.get('authorization')).toBe('Bearer k-1');       // the org key, not the GSJ
  expect(sent.get('accept')).toContain('text/event-stream');  // the client's accept survives
});

test('an upstream 401 is reported as 502 upstream_unauthorized', async () => {
  upstream.mockResolvedValue(new Response('nope', { status: 401 }));
  const res = await app.request('/mcp/gateway/sk-1', { method: 'POST', headers: authG, body: initBody });
  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ error: 'upstream_unauthorized' });
});

test('a bearer token is not a gateway credential', async () => {
  const res = await app.request('/mcp/gateway/sk-1', {
    method: 'POST', headers: { authorization: `Bearer ${gsj}` }, body: initBody,
  });
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: 'unauthorized' });
});

test('a gsj for another connector is 404', async () => {
  const other = (await signGatewayToken({ orgId, sub: memberId, serverKey: 'sk-2' })).token;
  const res = await app.request('/mcp/gateway/sk-1', { method: 'POST', headers: { authorization: `McpGateway ${other}` }, body: initBody });
  expect(res.status).toBe(404);
});

test('a revoked member is 401 not_member with code 41602', async () => { /* status='disabled' */ });
test('a disabled connector is 404, an invisible one is 403', async () => { /* … */ });
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd enterprise_server && npm test -- tests/routes/mcpGateway.test.ts`
Expected: FAIL — the `ALL /mcp/gateway/:serverKey` route does not exist (404 with an empty body).

- [ ] **Step 3: Implement the relay**

Authorize, in order, each failure its own status:
1. Parse `Authorization`; the scheme must be exactly `McpGateway` (case-insensitive), anything else → 401 `{ error: 'unauthorized' }`. **Do not** accept `Bearer` — a member JWT arriving here is a 401, not a 403.
2. `verifyGatewayToken(token)` → `null` → 401 `{ error: 'unauthorized' }`.
3. Verified `serverKey` ≠ path param → 404 (a token for connector A must not open B).
4. `resolveMemberStatus(sub)`: `missing` or `status !== 'active'` → 401 `{ error: 'not_member', code: 41602 }`; `error` → continue (fail open, same as `requireActiveMember`).
5. Load the connector by `server_key` + `org_id` → missing or `!enabled` → 404.
6. `connectorVisibleToCaller` → 403 `{ error: 'forbidden' }`.
7. `transport === 'sse'` → 400 `{ error: 'unsupported_transport' }`.
8. Upstream not https and not loopback → 502 `{ error: 'upstream_insecure' }`.

Then relay:
- Forward every incoming header **except** `authorization`, `host`, `content-length`, `connection`, `accept-encoding`; then merge `buildOrgCredentialHeaders(row.auth_mode, decryptConnectorSecrets(row.auth_config))` (the org credential replaces any client-supplied authorization).
- Forward the request body for `POST`/`PUT`/`PATCH`; no body for `GET`/`DELETE`.
- Upstream 401/403 → 502 `{ error: 'upstream_unauthorized' }` (the org key is wrong; the member's own credential is not involved, so a 401 from upstream must never be reported as a GSJ failure).
- Else return `new Response(upstream.body, { status, headers })` with the response headers filtered to drop `content-encoding`, `content-length`, `transfer-encoding`, `set-cookie`, keeping `content-type` and `mcp-session-id`. `upstream.body` is passed through as the `ReadableStream` — never `await upstream.text()` or `arrayBuffer()`.

- [ ] **Step 4: Run them and see them pass**

Run: `cd enterprise_server && npm test -- tests/routes/mcpGateway.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/routes/mcpGateway.ts enterprise_server/tests/routes/mcpGateway.test.ts
git commit -m "feat(enterprise): relay mcp requests through the org credential gateway"
```

### Task 14: Enforce the tool policy, including batch requests

**Files:**
- Modify: `enterprise_server/src/routes/mcpGateway.ts`
- Test: `enterprise_server/tests/routes/mcpGateway.test.ts`

**Interfaces:**
- Consumes: `toolAllowedByPolicy` (Task 7)
- Produces: a `-32601` JSON-RPC error for a denied `tools/call`, checked **before** dialing upstream

- [ ] **Step 1: Write the failing tests**

```ts
test('a disabled tool is refused without touching upstream', async () => {
  const res = await app.request('/mcp/gateway/sk-1', {
    method: 'POST', headers: authG,
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'disabled_tool', arguments: {} } }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ jsonrpc: '2.0', id: 7, error: { code: -32601 } });
  expect(upstream).not.toHaveBeenCalled();
});

test('one denied element refuses the whole batch', async () => {
  const batch = [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'good_tool', arguments: {} } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'disabled_tool', arguments: {} } },
  ];
  const res = await app.request('/mcp/gateway/sk-1', { method: 'POST', headers: authG, body: JSON.stringify(batch) });
  const body = await res.json();
  expect(body).toHaveLength(2);
  expect(body.every((r: any) => r.error?.code === -32601)).toBe(true);
  expect(upstream).not.toHaveBeenCalled();
});

test('a connector with no tools denies every call', async () => {
  // seed with tools: [] — never probed
});

test('a batch of only allowed calls is relayed', async () => { /* upstream called once with the array body */ });
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd enterprise_server && npm test -- tests/routes/mcpGateway.test.ts`
Expected: FAIL — `upstream` was called, and the response is the mock's body.

- [ ] **Step 3: Implement it**

Parse the body once (it is small; buffering the **request** is fine — the no-buffering rule is about responses). If it is an array, collect every element whose `method === 'tools/call'`; otherwise consider the single message. For each such element, `toolAllowedByPolicy(row.tools, params?.name)`; if **any** fails, return `200` with a JSON-RPC error per offending element — id echoed, `code: -32601`, `message` naming the tool as not exposed — and **do not dial upstream**. A batch with one violation is refused as a whole: relaying a partial batch desynchronizes the client's id/response pairing. Requests whose body is not JSON, or that carry no `tools/call`, pass through untouched.

- [ ] **Step 4: Run them and see them pass**

Run: `cd enterprise_server && npm test -- tests/routes/mcpGateway.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/routes/mcpGateway.ts enterprise_server/tests/routes/mcpGateway.test.ts
git commit -m "feat(enterprise): enforce the mcp tool policy in the gateway"
```

### Task 15: Audit a `tools/call` when the upstream answers

**Files:**
- Modify: `enterprise_server/src/routes/mcpGateway.ts`
- Test: `enterprise_server/tests/routes/mcpGateway.test.ts`

**Interfaces:**
- Consumes: `auditStore.write` (`../audit/auditStore`), `AuditAction.McpGatewayCall` (Task 11)

- [ ] **Step 1: Write the failing test**

```ts
test('a tools/call writes one audit row with the http status, not the body', async () => {
  // a stream upstream that yields headers then never ends
  upstream.mockResolvedValue(new Response(new ReadableStream({ start() {} }), {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  }));
  const res = await app.request('/mcp/gateway/sk-1', { method: 'POST', headers: authG, body: toolsCallBody('good_tool') });
  expect(res.status).toBe(200);
  const rows = await auditRows(orgId, 'mcp_gateway_call');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ user_id: memberId, target_id: 'sk-1' });
  expect(JSON.stringify(rows[0].payload)).toContain('good_tool');
  expect(JSON.stringify(rows[0].payload)).not.toContain('k-1');   // no key material
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd enterprise_server && npm test -- tests/routes/mcpGateway.test.ts`
Expected: FAIL — no audit row is written.

- [ ] **Step 3: Implement it**

Only for a message (or batch element) whose `method === 'tools/call'`. Record `{ action: AuditAction.McpGatewayCall, orgId, userId: sub, targetType: 'mcp_connector', targetId: row.server_key, payload: { method, tool: params.name, status: upstream.status, latencyMs } }` at the moment the upstream **response headers** arrive — never after reading the body, because the body may be an unbounded stream. Wrap the write in `try/catch`: an audit failure logs and does not fail the call. Do not add `result.isError` (it needs the body).

- [ ] **Step 4: Run it and see it pass**

Run: `cd enterprise_server && npm test -- tests/routes/mcpGateway.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/routes/mcpGateway.ts enterprise_server/tests/routes/mcpGateway.test.ts
git commit -m "feat(enterprise): audit mcp gateway tool calls"
```

### Task 16: Mount the gateway before the SPA fallback

**Files:**
- Modify: `enterprise_server/src/server.ts` (the API `app.route(...)` block at `:63`-`:122`, inside `buildApp()`)
- Test: `enterprise_server/tests/routes/mcpGatewayMount.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { buildApp } from '../../src/server';

test('an unauthenticated gateway GET answers JSON, not the console html', async () => {
  const res = await buildApp().request('/mcp/gateway/sk-1');
  expect(res.headers.get('content-type')).toContain('application/json');
  expect(res.status).toBe(401);
});

test('the token route is reachable', async () => {
  const res = await buildApp().request('/mcp/gateway/sk-1/token', { method: 'POST' });
  expect(res.status).toBe(401);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd enterprise_server && npm test -- tests/routes/mcpGatewayMount.test.ts`
Expected: FAIL — `content-type: text/html`, 200: `app.get('*')` at `:226` answered with `index.html`.

- [ ] **Step 3: Mount it**

Add `app.route('/', mcpGatewayRoutes)` among the other API routes — before `pagesRoutes` and the `app.get('*')` SPA fallback. Hono matches in registration order, so a gateway route registered after the fallback answers `GET` with HTML: `POST`/`DELETE` would still work, and only the SSE stream would break — in production, on a customer's machine, intermittently. That is why this file gets its own mount test.

- [ ] **Step 4: Run it and see it pass**

Run: `cd enterprise_server && npm test -- tests/routes/mcpGatewayMount.test.ts`
Run: `cd enterprise_server && npm test -- tests/routes/mcpGateway.test.ts`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/server.ts enterprise_server/tests/routes/mcpGatewayMount.test.ts
git commit -m "feat(enterprise): mount the mcp gateway route before the spa fallback"
```

### Task 17: The console's shared-key auth block

**Files:**
- Modify: `enterprise_server/web/src/pages/mcpManage/ConnectorAuthFields.tsx` (`:93-118`)
- Modify: `enterprise_server/web/src/i18n.ts`
- Test: `enterprise_server/web/tests/pages/mcpManage/ConnectorAuthFields.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
test('shared-key asks for an optional header name and says the key stays server-side', () => {
  render(<ConnectorAuthFields {...props} authMode="shared-key" />);
  expect(screen.queryByText(/暂未开放/)).toBeNull();          // the reserve notice is gone
  expect(screen.getByLabelText(i18n.mcpDrawer.auth.apiKeyHeaderName)).toBeTruthy();
  expect(screen.getByText(/企业网关/)).toBeTruthy();
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd enterprise_server/web && npm test -- tests/pages/mcpManage/ConnectorAuthFields.test.tsx`
Expected: FAIL — the reserve notice is rendered and there is no header-name input.

- [ ] **Step 3: Rework the branch**

Drop `reserveNotice` from the `shared-key` branch (keep it for `client-creds`, which stays retired). Replace the body with: an informational line ("the org key is stored on the enterprise server; desktops reach it through the enterprise gateway and never hold it"), the existing `apiKey` password input, the secret metadata line, and a new optional text input bound to `state.apiKeyHeaderName` whose hint states both defaults (`Authorization: Bearer <key>` when empty, the raw key under that name otherwise). `ConnectorDrawer.tsx` already round-trips `apiKeyHeaderName` through `state` (`:142`, `:215`), so no form plumbing changes. Add every new string to **both** `zh` and `en` in `i18n.ts`; rewrite `mcp.authHint.sharedKey` and `mcpDrawer.auth.orgApiKey.hint`, whose "无法按人审计" claim is now false (the gateway records `userId`).

- [ ] **Step 4: Run it and see it pass**

Run: `cd enterprise_server/web && npm test -- tests/pages/mcpManage/ConnectorAuthFields.test.tsx`
Expected: PASS, whole file.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/web/src/pages/mcpManage/ConnectorAuthFields.tsx enterprise_server/web/src/i18n.ts enterprise_server/web/tests/pages/mcpManage/ConnectorAuthFields.test.tsx
git commit -m "feat(console): configure a shared-key connector's header name"
```

### Task 18: Transport and URL rules in the console

**Files:**
- Modify: `enterprise_server/web/src/pages/mcpManage/ConnectorConnConfig.tsx:35` (`SSE_INCOMPATIBLE_AUTH_MODES`)
- Modify: `enterprise_server/web/src/pages/mcpManage/ConnectorBasicInfo.tsx` (`PLAINTEXT_RISK_MODES`, the test-connection hint)
- Modify: `enterprise_server/web/src/i18n.ts`
- Test: `enterprise_server/web/tests/pages/mcpManage/ConnectorConnConfig.test.tsx`, `…/ConnectorBasicInfo.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
test('choosing sse with shared-key resets the mode to none', async () => {
  // select transport sse while authMode is shared-key
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ authMode: 'none' }));
});
test('opening an existing shared-key + sse record warns', () => {
  render(<ConnectorConnConfig {...props} transport="sse" authMode="shared-key" />);
  expect(screen.getByText(/切换传输方式|改认证方式/)).toBeTruthy();
});
test('a plaintext http url blocks publishing a shared-key connector', () => {
  render(<ConnectorBasicInfo {...props} authMode="shared-key" url="http://example.com/mcp" />);
  expect(screen.getByRole('button', { name: /发布/ })).toBeDisabled();
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd enterprise_server/web && npm test -- tests/pages/mcpManage/ConnectorConnConfig.test.tsx`
Run: `cd enterprise_server/web && npm test -- tests/pages/mcpManage/ConnectorBasicInfo.test.tsx`
Expected: FAIL — `shared-key` + `sse` is selectable, and the plaintext URL is only a warning.

- [ ] **Step 3: Implement it**

Add `'shared-key'` to `SSE_INCOMPATIBLE_AUTH_MODES` so `onTransportChange` resets to `none`, and render an explanatory line when a loaded record is already in that combination (stored rows predate the rule). In `ConnectorBasicInfo`, make a plaintext URL a **hard** block for `shared-key` — not the existing warning — because the org key would travel in the clear (D17); keep the warning for the other modes in `PLAINTEXT_RISK_MODES`. Change the "test connection" hint for shared-key to say it handshakes with the org key.

- [ ] **Step 4: Run them and see them pass**

Run: `cd enterprise_server/web && npm test -- tests/pages/mcpManage/ConnectorConnConfig.test.tsx`
Run: `cd enterprise_server/web && npm test -- tests/pages/mcpManage/ConnectorBasicInfo.test.tsx`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/web/src/pages/mcpManage enterprise_server/web/src/i18n.ts enterprise_server/web/tests/pages/mcpManage
git commit -m "feat(console): keep shared-key connectors off sse and off plaintext"
```

### Task 19: Show the destination address at approval time

**Files:**
- Modify: `enterprise_server/web/src/pages/mcpManage/ReviewDetailDrawer.tsx`
- Modify: `enterprise_server/web/src/i18n.ts`
- Test: `enterprise_server/web/tests/pages/mcpManage/ReviewDetailDrawer.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
test('approving a shared-key submission names the url the org key will reach', () => {
  render(<ReviewDetailDrawer {...props} cfg={{ ...cfg, authMode: 'shared-key', url: 'https://mcp.vendor.example/sse' }} />);
  const warning = screen.getByText(/组织密钥将被发送到/);
  expect(warning.textContent).toContain('https://mcp.vendor.example/sse');
});
test('the same drawer for a user-key submission shows no such warning', () => { /* … */ });
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd enterprise_server/web && npm test -- tests/pages/mcpManage/ReviewDetailDrawer.test.tsx`
Expected: FAIL — no such text.

- [ ] **Step 3: Implement it**

When the submission's `authMode === 'shared-key'`, render a warning next to the existing URL and auth-mode rows: after publishing, the org key will be sent to **this address** — confirm it is trusted. Interpolate the URL into the sentence (`fill()` from `./types`, as the other drawers do). New strings in `zh` and `en`.

- [ ] **Step 4: Run it and see it pass**

Run: `cd enterprise_server/web && npm test -- tests/pages/mcpManage/ReviewDetailDrawer.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/web/src/pages/mcpManage/ReviewDetailDrawer.tsx enterprise_server/web/src/i18n.ts enterprise_server/web/tests/pages/mcpManage/ReviewDetailDrawer.test.tsx
git commit -m "feat(console): name the destination before approving an org key"
```

---

## P2 — Desktop wiring

The org key never reaches this code. The desktop stores a GSJ per gateway connector, resolves one target for both config sync and the detail-page probe, and treats "no usable token" as "skip this server", never as "dial the upstream directly".

### Task 20: The shared constant and the public-view fields

**Files:**
- Modify: `src/shared/mcp/constants.ts`
- Modify: `src/renderer/types/mcp.ts:181-210` (`McpEnterpriseMarketServer`)
- Modify: `src/main/auth/enterpriseClient.ts:424-470` and `:481-520` (both copies of the inline server type)
- Test: `src/shared/mcp/constants.test.ts` (create if absent)

**Interfaces:**
- Produces:
  - `export const ConnectorConsumption = { Direct: 'direct', Gateway: 'gateway' } as const;`
  - `export type ConnectorConsumption = typeof ConnectorConsumption[keyof typeof ConnectorConsumption];`
  - `McpEnterpriseMarketServer.consumption?: ConnectorConsumption` and `.orgCredentialReady?: boolean`

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'vitest';
import { ConnectorConsumption } from './constants';

test('the consumption discriminants match the enterprise wire', () => {
  expect(ConnectorConsumption.Direct).toBe('direct');
  expect(ConnectorConsumption.Gateway).toBe('gateway');
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npm test -- constants`
Expected: FAIL — `ConnectorConsumption` is not exported.

- [ ] **Step 3: Add the constant and the two optional fields**

`enterpriseClient.ts` declares the marketplace server type twice (the `Promise<…>` return type and the cast). Add both fields to **both** copies; do not refactor the duplication — it is out of scope here and the file is large. Fields are optional, so older servers' responses still type-check.

- [ ] **Step 4: Run it, and typecheck**

Run: `npm test -- constants`
Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS, and no new type errors.

- [ ] **Step 5: Commit**

```bash
git add src/shared/mcp/constants.ts src/renderer/types/mcp.ts src/main/auth/enterpriseClient.ts src/shared/mcp/constants.test.ts
git commit -m "feat(mcp): carry connector consumption on the desktop wire types"
```

### Task 21: Persist the gateway credential on the local record

**Files:**
- Modify: `src/main/mcp/mcpStore.ts` (`McpServerRecord`, `McpServerFormData`, `McpConfigJson`, the read/write mapping)
- Test: `src/main/mcp/mcpStore.test.ts`

**Interfaces:**
- Produces:
  - `McpServerRecord` / `McpServerFormData` gain `consumption?: ConnectorConsumption`, `gatewayToken?: string`, `gatewayTokenOwner?: string`, `gatewayTokenExpiresAt?: string`
  - `McpStore.saveGatewayToken(serverId: string, token: string, owner: string, expiresAt: string): void`
  - `McpStore.clearGatewayTokens(): number` — clears the three token fields on every `consumption === 'gateway'` record, returns how many it touched

> Ruling against spec §6.3, which lists three new fields: `gatewayTokenExpiresAt` is a fourth. The 15-day refresh rule needs a remaining lifetime, and decoding an unverified JWT to get it is worse than storing the `expiresAt` the token endpoint already returns.

- [ ] **Step 1: Write the failing test**

```ts
test('a gateway record round-trips its token and owner', async () => {
  // `createServer` is async from Task 29 on (it exchanges a GSJ before the
  // insert); awaiting here keeps this test valid across both tasks.
  const s = await store.createServer({ name: 'x', transportType: 'streamable-http', url: 'https://e/mcp/gateway/sk-1', consumption: 'gateway', serverKey: 'sk-1' });
  store.saveGatewayToken(s.id, 'gsj-1', 'u1', '2030-01-01T00:00:00.000Z');
  const back = store.getServer(s.id)!;
  expect(back).toMatchObject({ consumption: 'gateway', gatewayToken: 'gsj-1', gatewayTokenOwner: 'u1', gatewayTokenExpiresAt: '2030-01-01T00:00:00.000Z' });
});

test('clearing tokens leaves direct servers alone', () => {
  // one gateway record + one direct record → clearGatewayTokens() === 1
  expect(store.getServer(gatewayId)!.gatewayToken).toBeUndefined();
  expect(store.getServer(directId)!.url).toBe('https://up.example/mcp');
});
```

- [ ] **Step 2: Run it and see them fail**

Run: `npm test -- mcpStore`
Expected: FAIL — `saveGatewayToken` is not a function.

- [ ] **Step 3: Implement the fields and the two methods**

All four fields live in the `config_json` blob, so there is **no SQLite migration**. Add them to the private `McpConfigJson` and to both mapping directions; an enterprise catalog update that omits `consumption` clears it (the catalog is the authority for records that came from it). `clearGatewayTokens` is hygiene for the logout path — correctness comes from the owner check in Task 23, so a missed call site cannot reopen the hole.

- [ ] **Step 4: Run it and see them pass**

Run: `npm test -- mcpStore`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/mcp/mcpStore.ts src/main/mcp/mcpStore.test.ts
git commit -m "feat(mcp): store a gateway token per connector record"
```

### Task 22: One resolver for the dialable target

**Files:**
- Create: `src/main/mcp/mcpTarget.ts`
- Test: `src/main/mcp/mcpTarget.test.ts`

**Interfaces:**
- Consumes: `ConnectorConsumption` (Task 20)
- Produces:
  - `export interface McpTarget { url: string; headers: Record<string, string> }`
  - `export function gatewayUrlFor(baseUrl: string, serverKey: string): string`
  - `export function resolveMcpTarget(record: { url?: string; headers?: Record<string, string>; consumption?: ConnectorConsumption; serverKey?: string; gatewayToken?: string }, ctx: { enterpriseBaseUrl: string | null }): McpTarget | null`
  - `export function enterpriseBaseUrlOrNull(): string | null`

- [ ] **Step 1: Write the failing test**

```ts
const gw = (over: Partial<Parameters<typeof resolveMcpTarget>[0]> = {}) => ({
  url: 'https://up.example/mcp', consumption: 'gateway' as const, serverKey: 'sk-1', gatewayToken: 'gsj-1', ...over,
});

test('a gateway record points at the enterprise gateway with the gsj', () => {
  expect(resolveMcpTarget(gw(), { enterpriseBaseUrl: 'https://ent' })).toEqual({
    url: 'https://ent/mcp/gateway/sk-1',
    headers: { authorization: 'McpGateway gsj-1' },
  });
});
test('missing base url, server key or token yields null — never the upstream', () => {
  for (const ctx of [{ enterpriseBaseUrl: null }] as const)
    expect(resolveMcpTarget(gw(), ctx)).toBeNull();
  expect(resolveMcpTarget(gw({ serverKey: undefined }), { enterpriseBaseUrl: 'https://ent' })).toBeNull();
  expect(resolveMcpTarget(gw({ gatewayToken: undefined }), { enterpriseBaseUrl: 'https://ent' })).toBeNull();
});
test('a direct record is unchanged', () => {
  expect(resolveMcpTarget({ url: 'https://up/mcp', headers: { 'x-a': 'b' } }, { enterpriseBaseUrl: null })).toEqual({
    url: 'https://up/mcp', headers: { 'x-a': 'b' },
  });
});
test('the server key is path-encoded', () => {
  expect(gatewayUrlFor('https://ent', 'a b')).toBe('https://ent/mcp/gateway/a%20b');
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npm test -- mcpTarget`
Expected: FAIL — cannot resolve `./mcpTarget`.

- [ ] **Step 3: Implement it**

`enterpriseBaseUrlOrNull` wraps `getServerApiBaseUrl()` (from `../libs/endpoints`) in `try/catch` returning `null`: the getter throws when `ENTERPRISE_SERVER_URL` is unset, which is normal for a non-enterprise build and for local dev. **Do not** add an accessor to `enterpriseClient` — its `baseUrl` is module-private and stays that way. `resolveMcpTarget` stays **synchronous**: the token comes from the local record, not from the session. Returning `null` for a gateway record is deliberate — a URL that points at the upstream would let the desktop call it with no org authorization at all.

- [ ] **Step 4: Run it and see it pass**

Run: `npm test -- mcpTarget`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/mcp/mcpTarget.ts src/main/mcp/mcpTarget.test.ts
git commit -m "feat(mcp): resolve one dialable target for gateway connectors"
```

### Task 23: Issue, own and refresh the gateway token

**Files:**
- Modify: `src/main/auth/enterpriseClient.ts` (new method next to `listEnterpriseMcps`)
- Create: `src/main/mcp/mcpGatewayToken.ts`
- Test: `src/main/mcp/mcpGatewayToken.test.ts`

**Interfaces:**
- Consumes: `enterpriseClient.issueGatewayToken`, `sessionStorage.load()` (`userId`), `ConnectorConsumption` (Task 20)
- Produces:
  - `enterpriseClient.issueGatewayToken(serverKey: string): Promise<{ token: string; expiresAt: string }>`
  - `export interface GatewayTokenResult { token: string; owner: string; expiresAt: string }`
  - `export async function ensureGatewayToken(record: { serverKey?: string; consumption?: ConnectorConsumption; gatewayToken?: string; gatewayTokenOwner?: string; gatewayTokenExpiresAt?: string }): Promise<GatewayTokenResult | null>`

- [ ] **Step 1: Write the failing test**

```ts
vi.mock('../auth/enterpriseClient', () => ({ enterpriseClient: { issueGatewayToken: vi.fn() } }));
vi.mock('../auth/sessionStorage', () => ({ sessionStorage: { load: () => ({ userId: 'u1' }) } }));
const DAY = 86_400_000;
const later = (d: number) => new Date(Date.now() + d * DAY).toISOString();

test('a fresh token owned by the current user is used as-is', async () => {
  await expect(ensureGatewayToken({ consumption: 'gateway', serverKey: 'sk', gatewayToken: 't', gatewayTokenOwner: 'u1', gatewayTokenExpiresAt: later(60) }))
    .resolves.toEqual({ token: 't', owner: 'u1', expiresAt: later(60) });
  expect(issue).not.toHaveBeenCalled();
});
test('a token minted for someone else is never used', async () => {
  issue.mockResolvedValue({ token: 'new', expiresAt: later(90) });
  const r = await ensureGatewayToken({ consumption: 'gateway', serverKey: 'sk', gatewayToken: 'A-token', gatewayTokenOwner: 'u2', gatewayTokenExpiresAt: later(60) });
  expect(r).toEqual({ token: 'new', owner: 'u1', expiresAt: later(90) });
});
test('a token inside the 15-day window is refreshed', async () => { /* later(10) → issue called */ });
test('logged out means no token and no request', async () => { /* load() → null */ });
test('logging out is not an error path', async () => { /* resolves null, issue not called */ });
```

- [ ] **Step 2: Run it and see it fail**

Run: `npm test -- mcpGatewayToken`
Expected: FAIL — cannot resolve `./mcpGatewayToken`.

- [ ] **Step 3: Implement it**

`issueGatewayToken` is `call<{token, expiresAt}>(`/mcp/gateway/${encodeURIComponent(serverKey)}/token`, { method: 'POST' })` — `call` already attaches the member's enterprise JWT as `Bearer`, which is exactly the endpoint's prerequisite.

`ensureGatewayToken` returns `null` when `consumption !== 'gateway'`, when `serverKey` is absent, or when `sessionStorage.load()` is `null` (logged out — not an error). Otherwise it is usable iff all three hold: a `gatewayToken`, `gatewayTokenOwner === userId`, and `now + 15 days <= Date.parse(gatewayTokenExpiresAt)`. Anything else re-issues. It **never persists** — it returns the pair and the caller writes it, so there is one writer per call site and no hidden I/O in a hot path.

- [ ] **Step 4: Run it and see it pass**

Run: `npm test -- mcpGatewayToken`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/auth/enterpriseClient.ts src/main/mcp/mcpGatewayToken.ts src/main/mcp/mcpGatewayToken.test.ts
git commit -m "feat(mcp): issue and refresh the gateway token per member"
```

### Task 24: Make the revocation handler reachable from the MCP path

**Files:**
- Create: `src/main/enterpriseAccount/membershipRevocationBridge.ts`
- Modify: `src/main/main.ts:4880-4898` (the closure) and every `handleEnterpriseMembershipRevocation` call site
- Test: `src/main/enterpriseAccount/membershipRevocationBridge.test.ts`

**Interfaces:**
- Produces:
  - `export function setMembershipRevocationHandler(fn: ((source: EnterpriseMembershipRevocationSource) => void) | null): void`
  - `export function handleEnterpriseMembershipRevocation(code: unknown, source: EnterpriseMembershipRevocationSource): boolean` — returns whether a handler ran

- [ ] **Step 1: Write the failing test**

```ts
test('forwards to the installed handler only for 41602', () => {
  const handler = vi.fn();
  setMembershipRevocationHandler(handler);
  expect(handleEnterpriseMembershipRevocation(41602, 'JsonApi')).toBe(true);
  expect(handler).toHaveBeenCalledWith('JsonApi');
  expect(handleEnterpriseMembershipRevocation(undefined, 'JsonApi')).toBe(false);
  expect(handler).toHaveBeenCalledTimes(1);
});
test('no handler installed is not a crash', () => {
  setMembershipRevocationHandler(null);
  expect(handleEnterpriseMembershipRevocation(41602, 'JsonApi')).toBe(false);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npm test -- membershipRevocationBridge`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Extract the closure**

The handler created at `main.ts:4880` becomes `main.ts` calling `setMembershipRevocationHandler((source) => { … })` with the same body (`clearLocalAuthSession()` etc.) — behavior unchanged, only the entry point moves. Keep `createEnterpriseMembershipRevocationHandler` and `readEnterpriseApiErrorCode` where they are. The MCP path cannot reach a closure defined in `main.ts`, which is why this bridge exists at all; the bridge itself does the `EnterpriseApiErrorCode.NotMember` comparison once, so callers pass a raw `code` they just read off a response body.

Then, inside `clearLocalAuthSession` (`main.ts:6301`), call `mcpStore.clearGatewayTokens()` before the existing `syncOpenClawConfig(...)`: a revoked member's GSJ should not sit on disk, and the sync that follows writes the now-token-less config. This is hygiene, not the correctness boundary — a future logout path that forgets it cannot leak access, because Task 23 refuses a token whose owner is not the signed-in member. The follow-up sync keeps `restartGatewayIfRunning: false`, as it already does; the `mcp` section change makes the restart decision on its own.

- [ ] **Step 4: Run it and see it pass**

Run: `npm test -- membershipRevocation`
Expected: PASS — the new file plus the existing `membershipRevocation` tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/enterpriseAccount/membershipRevocationBridge.ts src/main/main.ts src/main/enterpriseAccount/membershipRevocationBridge.test.ts
git commit -m "refactor(enterprise): expose the membership revocation handler to mcp"
```

### Task 25: Config sync dials the gateway

**Files:**
- Modify: `src/main/mcp/mcpRuntime.ts:308-320` (the remote branch of `getResolvedServers`)
- Test: `src/main/mcp/mcpRuntime.test.ts`

**Interfaces:**
- Consumes: `resolveMcpTarget`, `enterpriseBaseUrlOrNull` (Task 22), `ensureGatewayToken` (Task 23), `McpStore.saveGatewayToken` (Task 21)

- [ ] **Step 1: Write the failing test**

```ts
test('a gateway record resolves to the enterprise gateway url with a McpGateway header', async () => {
  // store: consumption 'gateway', serverKey 'sk-1', a fresh gatewayToken owned by the signed-in user
  const servers = await runtime.getResolvedServers();
  expect(servers[0]).toMatchObject({
    url: 'https://ent/mcp/gateway/sk-1',
    headers: { authorization: 'McpGateway gsj-1' },
  });
});
test('a failed refresh keeps the existing token instead of dropping the server', async () => {
  issue.mockRejectedValue(new Error('network'));
  const servers = await runtime.getResolvedServers();
  expect(servers).toHaveLength(1);                    // not removed from the config
  expect(servers[0].headers.authorization).toBe('McpGateway gsj-old');
});
test('no token at all skips the server', async () => { /* no token, exchange fails → length 0 */ });
```

- [ ] **Step 2: Run it and see it fail**

Run: `npm test -- mcpRuntime`
Expected: FAIL — `url` is still the upstream URL.

- [ ] **Step 3: Implement the three fetch-failure rules**

For `consumption === 'gateway'`: `await ensureGatewayToken(record)` inside a `try`. On success, `saveGatewayToken(...)` when the pair differs from the record, then `resolveMcpTarget(record, { enterpriseBaseUrl: enterpriseBaseUrlOrNull() })`. On failure: if the record already has a `gatewayToken`, use it and `console.warn` (the config must not change, or OpenClaw restarts); if it has none, skip the server with a `console.warn` naming the server and the reason. A `null` target is always a skip, never a fallback to `record.url`.

- [ ] **Step 4: Run it and see it pass**

Run: `npm test -- mcpRuntime`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/mcp/mcpRuntime.ts src/main/mcp/mcpRuntime.test.ts
git commit -m "feat(mcp): dial gateway connectors through the enterprise gateway"
```

### Task 26: The detail-page probe goes through the gateway too

**Files:**
- Modify: `src/main/mcp/mcpToolCatalog.ts:200-260` (`listViaHttp`), the 401 handling around `listServerTools`
- Test: `src/main/mcp/mcpToolCatalog.test.ts`

**Interfaces:**
- Consumes: `resolveMcpTarget`, `ensureGatewayToken`, `handleEnterpriseMembershipRevocation` (Task 24), `readEnterpriseApiErrorCode` (`../enterpriseAccount/membershipRevocation`)

- [ ] **Step 1: Write the failing tests**

```ts
test('the probe hits the gateway, not the upstream', async () => {
  // record: consumption gateway; assert fetchImpl saw https://ent/mcp/gateway/sk-1
  expect(calls[0].url).toBe('https://ent/mcp/gateway/sk-1');
});
test('a 401 unauthorized re-issues the token once and retries', async () => {
  fetchImpl.mockResolvedValueOnce(res(401, { error: 'unauthorized' })).mockResolvedValueOnce(ok);
  const out = await listServerTools(record, { fetchImpl });
  expect(out.status).toBe('ok');
  expect(issue).toHaveBeenCalledTimes(1);
});
test('a 401 not_member revokes instead of refreshing', async () => {
  fetchImpl.mockResolvedValueOnce(res(401, { error: 'not_member', code: 41602 }));
  await listServerTools(record, { fetchImpl });
  expect(issue).not.toHaveBeenCalled();
  expect(revoked).toHaveBeenCalledWith(41602, 'JsonApi');
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npm test -- mcpToolCatalog`
Expected: FAIL — the probe still fetches `record.url`.

- [ ] **Step 3: Implement it**

Replace the direct `record.url` / `record.headers` reads with `resolveMcpTarget(...)` — the same resolver config sync uses, so the detail page cannot report "connected" for a server the agent cannot reach. On a 401/403 with a body, read the body once with `readEnterpriseApiErrorCode`: `41602` → `handleEnterpriseMembershipRevocation(41602, 'JsonApi')` and report unauthorized (no retry — a refreshed token would be issued to a revoked member); anything else on a gateway record → one `ensureGatewayToken` re-issue, persist via `saveGatewayToken`, retry once, then report `McpToolListStatus.Unauthorized`.

- [ ] **Step 4: Run them and see them pass**

Run: `npm test -- mcpToolCatalog`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/mcp/mcpToolCatalog.ts src/main/mcp/mcpToolCatalog.test.ts
git commit -m "feat(mcp): probe gateway connectors through the gateway"
```

### Task 27: Split the two org-credential predicates

**Files:**
- Modify: `src/renderer/components/mcp/enterpriseAuthMode.ts`
- Test: `src/renderer/components/mcp/enterpriseAuthMode.test.ts`

**Interfaces:**
- Produces: `isGatewayAuthMode(mode)`, `isRetiredAuthMode(mode)`, `isGatewayServer(record, catalog)`, `isRetiredServer(record, catalog)`; `isOrgManagedAuthMode` / `isOrgManagedServer` are removed

- [ ] **Step 1: Write the failing test**

```ts
test('shared-key is a gateway mode, not a retired one', () => {
  expect(isGatewayAuthMode('shared-key')).toBe(true);
  expect(isRetiredAuthMode('shared-key')).toBe(false);
});
test('client-creds is retired and not a gateway mode', () => {
  expect(isRetiredAuthMode('client-creds')).toBe(true);
  expect(isGatewayAuthMode('client-creds')).toBe(false);
});
test('the catalog fallback still identifies an older local record', () => {
  expect(isGatewayServer({ serverKey: 'sk' }, { sk: 'shared-key' })).toBe(true);
  expect(isRetiredServer({ serverKey: 'sk' }, { sk: 'client-creds' })).toBe(true);
  expect(isGatewayServer({ enterpriseAuthMode: 'user-key' })).toBe(false);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npm test -- enterpriseAuthMode`
Expected: FAIL — the new names are not exported.

- [ ] **Step 3: Split the file**

Each predicate keeps the existing two-step shape (the record's own `enterpriseAuthMode` first, else the catalog entry for `serverKey`). Delete the merged predicates rather than keeping them as aliases: a call site that still means "both modes" is a call site that would keep blocking `shared-key`, and a compile error is the right way to find every one. `mapEnterpriseAuthModeToMcpAuthMethod` is unchanged.

- [ ] **Step 4: Run it and typecheck the renderer**

Run: `npm test -- enterpriseAuthMode`
Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS, with `McpManager.tsx` type errors that Task 28 resolves.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/mcp/enterpriseAuthMode.ts src/renderer/components/mcp/enterpriseAuthMode.test.ts
git commit -m "refactor(mcp): separate gateway and retired org credential modes"
```

### Task 28: Unblock installation and label the gateway

**Files:**
- Modify: `src/renderer/components/mcp/McpManager.tsx` (`:1835`, `:1838`, `:989`/`:1034`, `:996`, `:1232`)
- Modify: `src/renderer/services/i18n.ts`
- Test: `src/renderer/components/mcp/McpManager.enterprise.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
test('a shared-key market card offers install and says it goes through the gateway', () => {
  // render the market list with one shared-key entry
  expect(screen.getByRole('button', { name: /安装/ })).toBeTruthy();
  expect(screen.getByText(/经企业网关/)).toBeTruthy();
});
test('a client-creds market card still offers no install', () => {
  expect(screen.queryByRole('button', { name: /安装/ })).toBeNull();
  expect(screen.getByText(/暂未开放/)).toBeTruthy();
});
test('an installed shared-key card is labelled gateway, not unavailable', () => { /* … */ });
test('the detail panel reports the org key as not configured when the catalog says so', () => {
  // catalog entry: authMode 'shared-key', orgCredentialReady false
  expect(screen.getByText(/组织密钥未配置/)).toBeTruthy();
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npm test -- McpManager.enterprise`
Expected: FAIL — the install button is absent for `shared-key` (the card is still gated) and there is no gateway badge.

- [ ] **Step 3: Rework the five sites**

| Site | Change |
|---|---|
| `:1835` market card actions | gate on `isRetiredAuthMode` only; `shared-key` gets the normal install button |
| `:1838` market card meta | add a "through the enterprise gateway" badge when the auth mode is gateway |
| `:989`/`:1034` installed card `orgManaged` | label becomes "org credential · through the enterprise gateway" for `shared-key`, unchanged for `client-creds` |
| `:996` "configure" button | leave the condition as it is — `authMethod === None` already excludes these records |
| `:1232` "reauthorize" | same; do not widen it to the new predicate |
| detail panel | two new rows for gateway records: **authorization** = "org credential · through the enterprise gateway", and **org key status** = configured / not configured, read from the catalog's `orgCredentialReady`. When it is `false` (or the entry is absent from the catalog), say so explicitly — the connector is installed and reachable but cannot work until an admin stores the key, and "not configured" is the one message that tells the member who to ask. |

Every new string goes in `zh` **and** `en` in `src/renderer/services/i18n.ts`.

- [ ] **Step 4: Run them and see them pass**

Run: `npm test -- McpManager`
Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/mcp/McpManager.tsx src/renderer/services/i18n.ts src/renderer/components/mcp/McpManager.enterprise.test.tsx
git commit -m "feat(mcp): install and label shared-key connectors"
```

### Task 29: Install without an authorization step

**Files:**
- Modify: `src/renderer/components/mcp/McpServerFormModal.tsx`
- Modify: `src/main/mcp/mcpStore.ts` (`createServer` — the gateway token exchange before the insert)
- Modify: `src/renderer/types/mcp.ts`, `src/renderer/types/electron.d.ts` (form field types)
- Modify: `src/renderer/services/i18n.ts`
- Test: `src/renderer/components/mcp/McpServerFormModal.test.tsx`, `src/main/mcp/mcpStore.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// mcpStore.test.ts
test('installing a gateway connector stores a gsj, with no user-visible step', async () => {
  issue.mockResolvedValue({ token: 'gsj-new', expiresAt: later(90) });
  const s = await store.createServer({ name: 'x', transportType: 'streamable-http', url: 'https://ent/mcp/gateway/sk-1', consumption: 'gateway', serverKey: 'sk-1' });
  expect(s).toMatchObject({ gatewayToken: 'gsj-new', gatewayTokenOwner: 'u1', consumption: 'gateway' });
});
test('a failed exchange fails the install and leaves no row', async () => {
  issue.mockRejectedValue(new Error('boom'));
  await expect(store.createServer({ … })).rejects.toThrow();
  expect(store.listServers()).toHaveLength(0);
});
```

```tsx
// McpServerFormModal.test.tsx
test('a shared-key connector shows a read-only url via the gateway', () => {
  // install from a shared-key market entry
  expect(screen.getByLabelText(/URL/)).toHaveProperty('readOnly', true);
  expect(screen.getByText(/经企业网关/)).toBeTruthy();
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npm test -- mcpStore`
Run: `npm test -- McpServerFormModal`
Expected: FAIL — no token is stored; the URL is editable.

- [ ] **Step 3: Implement it**

The form sends `consumption` (from the market entry) and does not ask for any credential. `createServer`, when `consumption === 'gateway'`, awaits `ensureGatewayToken({ consumption, serverKey })` **before** inserting: a `null` (logged out) or a throw fails the install with a translated reason, and no row is written. The URL for a gateway entry renders read-only with the gateway note — a member who edits it would point at the upstream, which answers 401 (a safe failure, but an unexplained one).

- [ ] **Step 4: Run them and see them pass**

Run: `npm test -- mcpStore`
Run: `npm test -- McpServerFormModal`
Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/mcp/McpServerFormModal.tsx src/main/mcp/mcpStore.ts src/renderer/types src/renderer/services/i18n.ts
git commit -m "feat(mcp): install gateway connectors without an auth step"
```

---

## P3 — Prove it end to end

### Task 30: A real socket, a fake upstream, and an audit row

Route tests go through `app.request()`, which never touches the `node:http` adapter — the one place where a buffering bug kills the whole feature. This task runs the real stack.

**Files:**
- Create: `enterprise_server/tests/e2e/mcpGatewayE2e.test.ts`

**Interfaces:**
- Consumes: `buildApp` + `createNodeRequestHandler` (Task 2), everything from P1

- [ ] **Step 1: Write the failing test**

```ts
import http from 'node:http';
import { buildApp } from '../../src/server';
import { createNodeRequestHandler } from '../../src/http/nodeAdapter';

const ORG_KEY = 'org-key-xyz';

/** A minimal MCP server: initialize, tools/list, tools/call, and an SSE GET. */
function startUpstream(): Promise<{ url: string; seen: Array<Record<string, string|undefined>>; stop(): Promise<void> }> {
  const seen: Array<Record<string, string | undefined>> = [];
  // Loopback on purpose: it is the D17 exception, so this harness needs no TLS.
  const server = http.createServer((req, res) => {
    const seenHeaders = { authorization: req.headers.authorization as string | undefined };
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = body ? JSON.parse(body) : null;
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"jsonrpc":"2.0","method":"notifications/message"}\n\n');  // then stay open
        return;
      }
      const result =
        msg?.method === 'tools/list' ? { tools: [{ name: 'create_lead' }, { name: 'disabled_tool' }] }
        : msg?.method === 'tools/call' ? { content: [{ type: 'text', text: 'ok' }] }
        : { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1' } };
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg?.id ?? null, result }));
      seen.push(seenHeaders);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${(server.address() as {port:number}).port}/mcp`, seen, stop: () => new Promise<void>((done) => server.close(() => done())) })));
}
```

Then the assertions, against an enterprise server started the same way (`http.createServer(createNodeRequestHandler(buildApp()))` on port 0):

1. Admin creates a `shared-key` connector at the fake upstream's loopback URL with `apiKey: ORG_KEY`, **and probes it** so `tools` is populated; publishes it. Disable `disabled_tool` afterwards via `PATCH`.
2. Member with a department grant calls `POST /mcp/gateway/sk-1/token` → 200 → GSJ.
3. `POST /mcp/gateway/sk-1` with `tools/list` → 200, both tools listed, and the upstream saw `authorization: Bearer org-key-xyz` (**not** the GSJ).
4. `POST /mcp/gateway/sk-1` with `tools/call` on `create_lead` → 200, upstream called once.
5. `POST /mcp/gateway/sk-1` with `tools/call` on `disabled_tool` → `-32601`, upstream call count unchanged.
6. `GET /mcp/gateway/sk-1` with an `accept: text/event-stream` → the `data:` chunk arrives **while the response is still open** (same sentinel pattern as Task 2's test) — this is the assertion that fails if the adapter buffers.
7. `SELECT … FROM audit_events WHERE action = 'mcp_gateway_call'` → one row per `tools/call`, `user_id` = the member, `payload` contains `create_lead` and **not** `org-key-xyz`.

- [ ] **Step 2: Run it and see it fail**

Run: `cd enterprise_server && npm test -- tests/e2e/mcpGatewayE2e.test.ts`
Expected: FAIL at the first gateway call (nothing is wired yet), or at step 6 if Task 2's gate was mis-wired.

- [ ] **Step 3: Fix what the run reveals**

No new production code should be needed; a failure here is a defect in P1 or P0. Do not weaken the test — step 6 in particular is the only automated proof that a desktop can hold an SSE session through the gateway.

- [ ] **Step 4: Run it and see it pass**

Run: `cd enterprise_server && npm test -- tests/e2e/mcpGatewayE2e.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/tests/e2e/mcpGatewayE2e.test.ts
git commit -m "test(enterprise): end-to-end proof of the mcp gateway relay"
```

### Task 31: Documentation and the full gate

**Files:**
- Modify: `docs/superpowers/specs/2026-10-28-mcp-shared-key-auth-design.md` (status line)
- Modify: `docs/superpowers/specs/2026-10-26-connector-auth-governance-design.md` (the `shared-key` / M2 status)
- Modify: `CLAUDE.md` only if a new invariant needs recording (not expected)

- [ ] **Step 1: Mark the design implemented**

Add a status line near the top of the 2026-10-28 spec: implemented on <date>, with the one place the implementation deviates from the document — `buildOrgCredentialHeaders` takes `(authMode, authConfig)` (Task 3), and the local record carries `gatewayTokenExpiresAt` as a fourth field (Task 21). Say why in one line each. In the 2026-10-26 governance spec, change the `shared-key` entry from "reserved / not usable" to "usable through the enterprise gateway" and point at the new spec.

- [ ] **Step 2: Run the desktop gate**

```bash
npm test
npm run compile:electron
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 \
  src/shared/mcp/constants.ts src/main/mcp/mcpTarget.ts src/main/mcp/mcpGatewayToken.ts \
  src/main/mcp/mcpStore.ts src/main/mcp/mcpRuntime.ts src/main/mcp/mcpToolCatalog.ts \
  src/main/auth/enterpriseClient.ts src/main/enterpriseAccount/membershipRevocationBridge.ts \
  src/main/main.ts src/renderer/components/mcp/McpManager.tsx \
  src/renderer/components/mcp/McpServerFormModal.tsx src/renderer/components/mcp/enterpriseAuthMode.ts \
  src/renderer/services/i18n.ts src/renderer/types/mcp.ts
```
Expected: `npm test` green (baseline was 380/380 for the desktop suite), `compile:electron` clean, eslint clean on every touched file. Report any pre-existing failure by name rather than fixing unrelated debt.

- [ ] **Step 3: Run the enterprise gate, one file at a time**

```bash
cd enterprise_server
for f in tests/http/responseStreaming tests/http/nodeAdapter tests/mcp/orgCredential \
         tests/mcp/gatewayPolicy tests/mcp/connectorVisibility tests/auth/memberStatus \
         tests/auth/gatewayToken tests/models/connectorView tests/routes/mcpConnectors \
         tests/routes/mcpSubmissions tests/routes/mcpMarketplace tests/routes/mcpGateway \
         tests/routes/mcpGatewayMount tests/e2e/mcpGatewayE2e \
         tests/asr/sessionRoute tests/routes/proxyChatCompletions; do
  npm test -- "$f" || echo "FAILED: $f"
done
cd web && npm test
```
Expected: every line passes. Per-file is not optional here: a single run exhausts file descriptors in this sandbox.

- [ ] **Step 4: Manual desktop check**

`npm run electron:dev` with `ENTERPRISE_SERVER_URL` pointing at a local server, then walk behaviors 1–2, 12, 19, 25 of spec §8: install a shared-key connector, confirm no authorization prompt, `grep -r "<the org key>" "$(node -e "console.log(require('electron').app.getPath('userData'))" 2>/dev/null || echo ~/Library/Application\ Support/MixCWork)"` returns nothing, then log out and back in as another member and confirm the config re-syncs to a new `McpGateway` header (one OpenClaw restart).

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs
git commit -m "docs(specs): record the shared-key gateway as implemented"
```

---

## Execution notes

- **Phase order is a dependency order.** P0 unblocks the SSE relay; P1 must be complete before P2 can be verified against a live server; P3 is the only place the adapter and the desktop meet reality.
- **Do not batch the enterprise test files into one run** in this sandbox (fd exhaustion — see Global Constraints).
- **The five Review Focus items are pinned** to Tasks 7/11 (empty-tool fail-closed), Tasks 23/25 (owner binding), Task 21/25 (no config flap), Tasks 24/26 (revocation vs. token refresh), and Tasks 3/10/12/13 (key destination and protocol).
- **No Co-Authored-By trailer** on these commits, per the repository's own rule.
