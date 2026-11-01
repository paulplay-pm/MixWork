# 运行分析（用量与审计）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the enterprise server's `/monitoring/usage` quota page and `/monitoring/audit` UUID list with the PRD's 运行分析 pages — org-wide usage analytics with a member-detail drawer, and a filterable audit log with structured payloads — plus the proxy accounting fix that makes the numbers real.

**Architecture:** New `src/analytics/` module owns time-range resolution, SQL aggregation, and CSV emission; `src/routes/admin/usage.ts` is a new HTTP surface mirroring the reworked `src/routes/admin/audit.ts`. The web SPA gains `web/src/components/analytics/*` and rewrites both pages against new typed API clients. `providerProxy` gains SSE usage extraction so streaming calls are finally accounted for.

**Tech Stack:** TypeScript, Hono, PostgreSQL/pglite, `date-fns-tz`, node:test-free Vitest; React 18, TanStack Query, Tailwind, lucide-react, hand-rolled SVG charts.

**Spec:** `docs/superpowers/specs/2026-10-21-analytics-usage-audit-design.md` — read it alongside this plan. Decisions D1–D11 and the 非目标/反目标 sections are binding; where this plan and the spec disagree, the spec wins.

## Global Constraints

- Ship the frontend through the existing i18n system. **No hardcoded user-visible strings.** Every new key goes into `web/src/i18n.ts` in **both** `en` and `zh` objects, under the `analytics.*` prefix. **Chinese is the primary language** — write the `zh` text to match the spec's wording, then translate.
- `web/` must not import from `enterprise_server/src/`. `web/tsconfig.json` includes only `["src","tests"]` relative to `web/`, and `web/src/shared/permissions.ts:1-9` documents the hand-kept mirror convention. Cross-boundary constants are mirrored by hand + guarded by a parity test.
- Ranges are resolved **server-side only**. The client sends a `range` key and never computes `[from, to)`. The page and its CSV export must call the same resolver and the same query functions — never two SQL implementations of the same number.
- All intervals are half-open `[from, to)`.
- Day bucketing uses `orgs.timezone`. A stored value that `timezone.resolveZone` rejects must **fall back to `'UTC'`**, never throw.
- Audit action codes are exhaustive over `AuditAction` (71 values) — `Record<AuditAction, …>`, not `Partial`. Target types are an explicit known-value list with a fallback, because `POST /audit` accepts arbitrary client-supplied strings.
- CSV output always starts with the UTF-8 BOM `﻿`, then a `统计范围：<label>` line, then the header row. All cells go through `csvCell`; never hand-roll comma or quote escaping.
- Every analytics query is scoped by `org_id` from the JWT claims. Never accept an `orgId` query parameter.
- **Seeding `token_usage` in tests:** `token_usage.model_id` is `NOT NULL REFERENCES model_catalog(id)` with no `ON DELETE` (`src/db/migrations/004_audit.sql:26`). Any test that inserts a `token_usage` row must first insert the matching `orgs → provider_keys → model_catalog` chain, or the insert fails with FK violation `23503`. Test helpers take `model_id` from a seeded catalog row, never a bare literal.
- Backend tests import setup as `'../helpers/setupEnv'` from `tests/analytics/`, and `'../../helpers/setupEnv'` from `tests/<dir>/<sub>/`. The wrong relative depth makes vitest collect zero tests and exit non-zero without saying why.
- The usage page shows **no** quota, limit, or usage-rate language anywhere.
- Known baseline at HEAD: `npx vitest run` with `--pool=forks --minWorkers=2 --maxWorkers=2` gives **987 passed, 2 failed** — `tests/routes/shareDeployments.test.ts:125` and `tests/routes/sso.desktop.test.ts:81`. Both are pre-existing and unrelated. Do not fix them in this plan; do not let them block a task.

## Review Focus

Inputs the spec implies but no task's test explicitly exercises. Each has its test pinned into the owning task below.

1. **A member with zero usage in the selected range opens their drawer.** `daily` is all-zero and `by_model` is empty. Expected: a text empty-state in each section, not a bare coordinate axis and not a crash.
2. **An audit event whose `action` is an arbitrary string** written through `POST /audit` by any authenticated user (`src/routes/audit.ts:9-33`). Expected: the badge renders the raw code, `auditActionMeta` returns without throwing, and the facets dropdown still lists it.
3. **`orgs.timezone` contains a hand-edited garbage value.** Expected: every analytics endpoint returns 200 with UTC-bucketed data; a 500 is a bug.
4. **An org has more than 20 models.** Expected: the models table paginates, the footer count equals the CSV row count, and the CSV still contains every merged `(provider, model)` row — not just the visible page.
5. **An upstream SSE stream splits one `usage` JSON object across two TCP chunk boundaries.** Expected: the usage is still parsed; a naive per-chunk `JSON.parse` silently loses it.

---

## File Structure

**New — server**
| Path | Responsibility |
|---|---|
| `src/analytics/range.ts` | `range` key → `{from, to, timezone, days[]}`; the single source of time-window truth |
| `src/analytics/usage.ts` | Usage SQL: merged model rows, full member roster, per-member daily + per-model detail |
| `src/analytics/csv.ts` | `csvCell` / `toCsv` / `csvResponse` — BOM, range line, escaping |
| `src/analytics/auditQuery.ts` | Audit list SQL: filters, facets, paging, `login_events` union |
| `src/shared/auditActionMeta.ts` | 71 action codes → `{zh, en, tone}` (exhaustive) |
| `src/shared/auditTargetTypeMeta.ts` | Known target types → `{zh, en}` with fallback accessor |
| `src/routes/admin/usage.ts` | `GET /admin/usage/*` HTTP surface |
| `src/proxy/streamUsage.ts` | SSE `usage` extraction via `TransformStream`; per-provider capability memory |
| `src/db/migrations/052_analytics_usage_audit.sql` | `usage_missing`, `stream_usage_supported`, indexes, role grants |

**New — web**
| Path | Responsibility |
|---|---|
| `web/src/shared/auditActionMeta.ts` | Mirror of the server table + parity test |
| `web/src/components/analytics/RangeSelect.tsx` | The range dropdown, shared by both pages |
| `web/src/components/analytics/Pager.tsx` | Page controls with boundary-disabled buttons |
| `web/src/components/analytics/DailyBarChart.tsx` | Hand-rolled SVG daily bar chart |
| `web/src/components/analytics/ModelShareBars.tsx` | Hand-rolled SVG horizontal share bars |
| `web/src/components/analytics/UsageDrawer.tsx` | Right-side member drawer, 860px, mask + ESC |
| `web/src/components/analytics/PayloadModal.tsx` | Audit payload modal, mask + ESC |
| `web/src/components/analytics/GapNotice.tsx` | `unaccounted_calls` banner |
| `web/src/analytics/range.ts` | Range key ↔ label/select-option mapping (labels come from `t()`) |

**Modified**
`enterprise_server/package.json` (deps + test script) · `src/shared/permissionPoints.ts` · `src/models/tokenUsage.ts` · `src/proxy/providerProxy.ts` · `src/proxy/upstream.ts` · `src/routes/admin/audit.ts` · `src/audit/auditStore.ts` · `src/server.ts` · `web/src/api/client.ts` · `web/src/api/usage.ts` · `web/src/api/audit.ts` · `web/src/App.tsx` · `web/src/components/Sidebar.tsx` · `web/src/auth/AuthGuard.tsx` · `web/src/components/DeptDetail.tsx` · `web/src/i18n.ts` · delete `web/src/components/QuotaBar.tsx`

---

### Task 1: CI workflow for enterprise_server

The repo has **no CI configuration at all** — no `.github/`, no `.gitlab-ci.yml`. The remote is Gitea (`https://paulgitea.iepose.cn/paul/MixCWork`), so the platform is Gitea Actions, whose workflow syntax is GitHub-Actions-compatible. This task creates it, and fixes the `npm test` invocation that currently aborts.

**Files:**
- Create: `.gitea/workflows/enterprise-server.yml`
- Modify: `enterprise_server/package.json` (test script)

**Interfaces:**
- Consumes: nothing.
- Produces: `npm test` in `enterprise_server` runs the full backend suite to completion; `npm run web:test` runs the web suite. CI runs both on every push and on PRs targeting `main`.

- [ ] **Step 1: Confirm the default `npm test` aborts, and the forks/2-worker invocation passes**

Run: `cd enterprise_server && npm test`
Expected: aborts — `Assertion failed: (errno == EINTR), function uv__io_poll` — exit 134, with no test summary printed.

Run: `cd enterprise_server && npx vitest run --pool=forks --minWorkers=2 --maxWorkers=2 --reporter=dot`
Expected: completes with `Test Files  2 failed | 134 passed (136)` and `Tests  2 failed | 987 passed (989)`. The two failures are `tests/routes/shareDeployments.test.ts` and `tests/routes/sso.desktop.test.ts`.

If the summary does not match, stop and re-check the Global Constraints baseline before continuing.

- [ ] **Step 2: Make `npm test` use the surviving invocation**

In `enterprise_server/package.json`, change `"test"` to:

```json
"test": "vitest run --pool=forks --minWorkers=2 --maxWorkers=2"
```

`--minWorkers` must be set alongside `--maxWorkers`; supplying only `--maxWorkers` fails with `options.minThreads and options.maxThreads must not conflict`.

- [ ] **Step 3: Verify the suite runs green-or-known-red through the script**

Run: `cd enterprise_server && npm test 2>&1 | grep -E "Test Files|Tests "`
Expected: `2 failed | 134 passed (136)` and `2 failed | 987 passed (989)` — same two files as Step 1.

- [ ] **Step 4: Write the workflow**

Create `.gitea/workflows/enterprise-server.yml`:

```yaml
name: enterprise-server

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: enterprise_server
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24.15.0'
      - run: npm ci --no-workspaces
      - run: npm install --prefix web --no-workspaces --force --ignore-scripts --engine-strict=false
      - name: Backend tests
        run: npm test
      - name: Web tests
        run: npm run web:test
```

- [ ] **Step 5: Sanity-check the web suite locally before trusting CI**

Run: `cd enterprise_server && npm run web:test 2>&1 | tail -5`
Expected: exits 0 with a passing file count. If it fails, fix that before adding the CI step — a red CI job is worse than none.

- [ ] **Step 6: Commit**

```bash
git add .gitea/workflows/enterprise-server.yml enterprise_server/package.json
git commit -m "ci(enterprise-server): run backend and web test suites

The repo had no CI. Gitea Actions is GitHub-compatible, so the workflow
lives in .gitea/workflows. Also pins the vitest invocation that actually
completes: the default thread pool aborts on uv__io_poll under fd
exhaustion, and --maxWorkers alone conflicts with the inferred min.

Two pre-existing failures (shareDeployments, sso.desktop) remain red.
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `usage:view` / `usage:export` permission points

**Files:**
- Modify: `enterprise_server/src/shared/permissionPoints.ts`
- Test: `enterprise_server/tests/shared/permissionPoints.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PermissionPoint.UsageView` (`'usage:view'`), `PermissionPoint.UsageExport` (`'usage:export'`), both inside `PERMISSION_POINTS`; a `'usage'` entry in `PERMISSION_MODULES`; `BUILTIN_ROLE_POINTS.auditor` and `.org_admin` containing both. `super_admin` gets them automatically because it is `PERMISSION_POINTS`.

- [ ] **Step 1: Write the failing test**

Create `enterprise_server/tests/shared/permissionPoints.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import {
  BUILTIN_ROLE_POINTS, PERMISSION_MODULES, PERMISSION_POINTS, PermissionPoint,
} from '../../src/shared/permissionPoints';

describe('permissionPoints — usage points', () => {
  test('usage:view and usage:export are registered', () => {
    expect(PermissionPoint.UsageView).toBe('usage:view');
    expect(PermissionPoint.UsageExport).toBe('usage:export');
    expect(PERMISSION_POINTS).toContain('usage:view');
    expect(PERMISSION_POINTS).toContain('usage:export');
  });

  test('a usage module groups both points', () => {
    const mod = PERMISSION_MODULES.find((m) => m.key === 'usage');
    expect(mod).toBeDefined();
    expect(mod!.points).toEqual(['usage:view', 'usage:export']);
  });

  test('super_admin, auditor and org_admin all hold both usage points', () => {
    for (const role of ['super_admin', 'auditor', 'org_admin'] as const) {
      expect(BUILTIN_ROLE_POINTS[role]).toContain(PermissionPoint.UsageView);
      expect(BUILTIN_ROLE_POINTS[role]).toContain(PermissionPoint.UsageExport);
    }
  });

  test('dept_admin, member and dev do NOT gain usage points', () => {
    for (const role of ['dept_admin', 'member', 'dev'] as const) {
      expect(BUILTIN_ROLE_POINTS[role]).not.toContain(PermissionPoint.UsageView);
    }
  });

  test('every module point is a registered PermissionPoint', () => {
    for (const m of PERMISSION_MODULES) {
      for (const p of m.points) expect(PERMISSION_POINTS).toContain(p);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/shared/permissionPoints.test.ts`
Expected: FAIL — `PermissionPoint.UsageView` is `undefined`.

- [ ] **Step 3: Add the points**

In `src/shared/permissionPoints.ts`, add to the `PermissionPoint` object:

```ts
UsageView: 'usage:view', UsageExport: 'usage:export',
```

Add the module grouping next to the existing ones:

```ts
const usage = [PermissionPoint.UsageView, PermissionPoint.UsageExport];
```

Insert into `PERMISSION_MODULES` (place it next to the `audit` entry):

```ts
{ key: 'usage', name: '用量查看', desc: '查看组织用量明细并导出', points: usage },
```

Update `BUILTIN_ROLE_POINTS`:

```ts
auditor: [PermissionPoint.AuditView, PermissionPoint.AuditExport,
          PermissionPoint.UsageView, PermissionPoint.UsageExport],
org_admin: [...orgAdmin, PermissionPoint.UsageView, PermissionPoint.UsageExport],
```

`super_admin` needs no edit — it is `PERMISSION_POINTS`.

- [ ] **Step 4: Run it to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/shared/permissionPoints.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/shared/permissionPoints.ts enterprise_server/tests/shared/permissionPoints.test.ts
git commit -m "feat(permissions): add usage:view and usage:export points

Granted to super_admin, auditor and org_admin per D3. dept_admin, member
and dev deliberately excluded.
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Migration 052

**Files:**
- Create: `enterprise_server/src/db/migrations/052_analytics_usage_audit.sql`
- Test: `enterprise_server/tests/db/migration052.test.ts`

**Interfaces:**
- Consumes: `PermissionPoint.UsageView` / `UsageExport` values from Task 2 (as literal strings in SQL).
- Produces: column `token_usage.usage_missing BOOLEAN NOT NULL DEFAULT false`; column `provider_keys.stream_usage_supported BOOLEAN` (NULL = untried); indexes `token_usage_org_ts` and `audit_events_org_ts_action`; every `super_admin` / `auditor` / `org_admin` row in `roles` carrying both usage points.

- [ ] **Step 1: Write the failing test**

Create `enterprise_server/tests/db/migration052.test.ts`:

```ts
import '../../helpers/setupEnv';
import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

async function columnsOf(table: string): Promise<string[]> {
  const r = await testPool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [table]);
  return r.rows.map((x) => x.column_name);
}

describe('migration 052', () => {
  beforeEach(async () => { await resetSchema(); await runMigrations(); });

  test('token_usage gains usage_missing defaulting to false', async () => {
    expect(await columnsOf('token_usage')).toContain('usage_missing');
    const r = await testPool.query<{ usage_missing: boolean }>(
      `INSERT INTO token_usage(org_id,user_id,model_id,provider,token_in,token_out,total_tokens,result_code,quota_window_date)
       VALUES ('o1','u1','m1','p',0,0,0,200,'2026-01-01') RETURNING usage_missing`);
    expect(r.rows[0].usage_missing).toBe(false);
  });

  test('provider_keys gains a nullable stream_usage_supported', async () => {
    expect(await columnsOf('provider_keys')).toContain('stream_usage_supported');
  });

  test('both new indexes exist', async () => {
    const r = await testPool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE indexname IN ('token_usage_org_ts','audit_events_org_ts_action')`);
    expect(r.rows.map((x) => x.indexname).sort())
      .toEqual(['audit_events_org_ts_action', 'token_usage_org_ts']);
  });

  test('usage points are granted to super_admin, auditor and org_admin', async () => {
    const r = await testPool.query<{ name: string; permissions: string[] }>(
      `SELECT name, permissions FROM roles
       WHERE name IN ('super_admin','auditor','org_admin')`);
    expect(r.rowCount).toBe(3);
    for (const row of r.rows) {
      expect(row.permissions).toContain('usage:view');
      expect(row.permissions).toContain('usage:export');
    }
  });

  test('re-running is idempotent', async () => {
    await runMigrations();
    await runMigrations();
    const r = await testPool.query<{ permissions: string[] }>(
      `SELECT permissions FROM roles WHERE name='auditor'`);
    expect(r.rows[0].permissions.filter((p) => p === 'usage:view')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/db/migration052.test.ts`
Expected: FAIL — `usage_missing` column missing; roles lack the usage points.

- [ ] **Step 3: Write the migration**

Create `src/db/migrations/052_analytics_usage_audit.sql`:

```sql
-- Migration 052: analytics (运行分析) support.
--
-- 1. usage_missing marks calls whose upstream response carried no parsable
--    `usage`. Every such call is still counted in call_count; the analytics
--    pages surface the aggregate as `unaccounted_calls` so tokens are never
--    silently understated (spec D10).
-- 2. stream_usage_supported is the per-provider-key memory for "does this
--    OpenAI-compatible endpoint accept stream_options.include_usage".
--    NULL means untried; false means a 4xx proved it unsupported, so the
--    proxy stops paying a failed round-trip per streaming request (D9).
-- 3. Indexes: the analytics pages slice by ts (not quota_window_date), and
--    the audit list filters action alongside ts.
-- Idempotent for pglite test replay.

ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS usage_missing BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE provider_keys ADD COLUMN IF NOT EXISTS stream_usage_supported BOOLEAN;

CREATE INDEX IF NOT EXISTS token_usage_org_ts ON token_usage(org_id, ts);
CREATE INDEX IF NOT EXISTS audit_events_org_ts_action ON audit_events(org_id, ts DESC, action);

UPDATE roles
SET permissions = permissions || '["usage:view","usage:export"]'::jsonb
WHERE name IN ('super_admin','auditor','org_admin')
  AND NOT (permissions @> '["usage:view"]'::jsonb);
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/db/migration052.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the full backend suite for regressions**

Run: `cd enterprise_server && npm test 2>&1 | grep -E "Test Files|Tests "`
Expected: `2 failed | 136 passed (138)` files — the same two baseline failures, plus this new file passing.

- [ ] **Step 6: Commit**

```bash
git add enterprise_server/src/db/migrations/052_analytics_usage_audit.sql enterprise_server/tests/db/migration052.test.ts
git commit -m "feat(db): migration 052 for analytics — usage_missing, indexes, role grants

usage_missing makes streaming calls with no parsable upstream usage
visible instead of silently absent. stream_usage_supported is the
per-key memory so an endpoint that rejects stream_options is not retried
on every request.
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Time-range resolution

**Files:**
- Create: `enterprise_server/src/analytics/range.ts`
- Create: `enterprise_server/package.json` (add `date-fns-tz` dependency)
- Test: `enterprise_server/tests/analytics/range.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export const UsageRange = { Today:'today', Last7Days:'7d', Last30Days:'30d', ThisMonth:'this_month', LastMonth:'last_month' } as const;
  export type UsageRange = (typeof UsageRange)[keyof typeof UsageRange];
  export const AuditRange = { ...UsageRange, Custom:'custom' } as const;
  export type AuditRange = (typeof AuditRange)[keyof typeof AuditRange];
  export interface ResolvedRange { from: Date; to: Date; timezone: string; key: AuditRange; days: string[]; }
  export function resolveUsageRange(orgId: string, range: UsageRange): Promise<ResolvedRange>;
  export function resolveAuditRange(orgId: string, range: AuditRange, custom?: { from?: string; to?: string }): Promise<ResolvedRange>;
  ```
  `days` is the list of `'YYYY-MM-DD'` day strings the interval covers; the drawer draws exactly `days.length` bars and the `daily` series returns exactly `days.length` entries.

- [ ] **Step 1: Declare `date-fns-tz` explicitly**

It is currently resolved only by hoisting from the monorepo root. Add to `enterprise_server/package.json` `dependencies`: `"date-fns-tz": "^3.2.0"`. Run `npm install --no-workspaces` from `enterprise_server` and confirm it resolves.

- [ ] **Step 2: Write the failing test**

Create `enterprise_server/tests/analytics/range.test.ts`:

```ts
import '../helpers/setupEnv';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { resolveAuditRange, resolveUsageRange, UsageRange } from '../../src/analytics/range';

async function seedOrg(timezone: string): Promise<string> {
  await testPool.query(`INSERT INTO orgs(id, name, timezone) VALUES ('o1','T',$1)`, [timezone]);
  return 'o1';
}

describe('analytics/range', () => {
  beforeEach(async () => { await resetSchema(); await runMigrations(); });

  test('today spans one day and is half-open at the next midnight', async () => {
    await seedOrg('UTC');
    const r = await resolveUsageRange('o1', UsageRange.Today);
    expect(r.days).toHaveLength(1);
    expect(r.to.getTime() - r.from.getTime()).toBe(24 * 3600 * 1000);
    expect(r.days[0]).toBe(r.from.toISOString().slice(0, 10));
  });

  test('7d and 30d include today and span N days', async () => {
    await seedOrg('UTC');
    expect((await resolveUsageRange('o1', UsageRange.Last7Days)).days).toHaveLength(7);
    expect((await resolveUsageRange('o1', UsageRange.Last30Days)).days).toHaveLength(30);
  });

  test('this_month runs from the 1st to the next month boundary', async () => {
    await seedOrg('UTC');
    const r = await resolveUsageRange('o1', UsageRange.ThisMonth);
    expect(r.from.getUTCDate()).toBe(1);
    expect(r.to.getUTCDate()).toBe(1);
    expect(r.days.length).toBeGreaterThan(0);
  });

  test('last_month covers a whole previous calendar month', async () => {
    await seedOrg('UTC');
    const r = await resolveUsageRange('o1', UsageRange.LastMonth);
    expect(r.from.getUTCDate()).toBe(1);
    expect(r.to.getUTCDate()).toBe(1);
    expect(r.to.getTime() - r.from.getTime()).toBeGreaterThanOrEqual(27 * 86400000);
  });

  test('day boundaries follow orgs.timezone, not the server clock', async () => {
    await seedOrg('Pacific/Kiritimati'); // UTC+14 — the most positive offset
    const r = await resolveUsageRange('o1', UsageRange.Today);
    expect(r.timezone).toBe('Pacific/Kiritimati');
    expect(r.to.getTime() - r.from.getTime()).toBe(24 * 3600 * 1000);
  });

  test('an invalid orgs.timezone falls back to UTC instead of throwing', async () => {
    await seedOrg('Not/AZone');
    const r = await resolveUsageRange('o1', UsageRange.Today);
    expect(r.timezone).toBe('UTC');
  });

  test('audit custom requires both from and to', async () => {
    await seedOrg('UTC');
    await expect(resolveAuditRange('o1', 'custom', { from: '2026-03-01' })).rejects.toThrow();
    await expect(resolveAuditRange('o1', 'custom', { to: '2026-03-01' })).rejects.toThrow();
  });

  test('audit custom is inclusive of both named days', async () => {
    await seedOrg('UTC');
    const r = await resolveAuditRange('o1', 'custom', { from: '2026-03-01', to: '2026-03-05' });
    expect(r.days).toEqual(['2026-03-01','2026-03-02','2026-03-03','2026-03-04','2026-03-05']);
    expect(r.from.toISOString().slice(0,10)).toBe('2026-03-01');
    expect(r.to.toISOString().slice(0,10)).toBe('2026-03-06'); // exclusive upper bound
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/analytics/range.test.ts`
Expected: FAIL — cannot resolve `../../src/analytics/range`.

- [ ] **Step 4: Implement `src/analytics/range.ts`**

**Superseded during Task 4 — do NOT use `fromZonedTime`.** It reads the input `Date`'s *local* fields (`getFullYear`/`getMonth`/`getDate`/`getHours`), so passing a `Date.UTC(...)` argument silently applies the **host's** offset (`fromZonedTime(Date.UTC(2026,3,1),'Asia/Shanghai')` → `2026-03-01T00:00Z`, off by +8h). date-fns v4's `addDays`/`startOfMonth` share the flaw. It is also wrong on both DST shapes: where a zone skips local midnight (00:00→01:00) it lands on the previous day, and where local midnight occurs twice it returns the *second* instant, dropping the day's first hour. The shipped implementation does calendar math on UTC-anchored day strings and resolves each boundary by binary search for the smallest instant whose local date is `>= day`, using `formatInTimeZone` (which wraps Intl, the only authority).

```sql
SELECT timezone FROM orgs WHERE id = $1
```

Wrap it so a value `timezone.resolveZone` rejects becomes `'UTC'`:

```ts
function safeZone(raw: string | null): string {
  try { return timezone.resolveZone(raw ?? 'UTC'); } catch { return 'UTC'; }
}
```

`resolveUsageRange` rejects any key outside `UsageRange`. `resolveAuditRange` delegates to it for the five shared keys and additionally handles `custom`, throwing on a missing `from` or `to`. Both build `days` by formatting `[from, to)` day-by-day in the resolved zone.

- [ ] **Step 5: Run it to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/analytics/range.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add enterprise_server/package.json enterprise_server/package-lock.json \
  enterprise_server/src/analytics/range.ts enterprise_server/tests/analytics/range.test.ts
git commit -m "feat(analytics): resolve range keys to [from, to) in the org timezone

Single source of time-window truth: the page and its CSV export both call
this, so the two can never disagree. Returns days[] so the drawer's bar
count and the daily series length are derived, not re-implemented.

An unparsable orgs.timezone falls back to UTC rather than throwing, so a
hand-edited bad value cannot 500 every analytics request.

Also declares date-fns-tz, which src/org/timezone.ts was already
importing via monorepo hoisting.
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Audit action and target-type metadata

**Files:**
- Create: `enterprise_server/src/shared/auditActionMeta.ts`
- Create: `enterprise_server/src/shared/auditTargetTypeMeta.ts`
- Create: `enterprise_server/web/src/shared/auditActionMeta.ts`
- Test: `enterprise_server/tests/shared/auditActionMeta.test.ts`
- Test: `enterprise_server/tests/shared/auditTargetTypeMeta.test.ts`
- Test: `enterprise_server/web/tests/shared/auditActionMeta.parity.test.ts`

**Interfaces:**
- Consumes: `AuditAction` from `enterprise_server/src/shared/enterpriseServerConstants.ts`.
- Produces:
  ```ts
  export const AuditTone = { Auth:'auth', Success:'success', Failure:'failure', Change:'change', Danger:'danger', Normal:'normal' } as const;
  export type AuditTone = (typeof AuditTone)[keyof typeof AuditTone];
  export interface AuditActionMeta { zh: string; en: string; tone: AuditTone; }
  export const AUDIT_ACTION_META: Record<AuditAction, AuditActionMeta>;
  export function auditActionMeta(action: string): AuditActionMeta;   // unknown → {zh: action, en: action, tone: Normal}

  export const KNOWN_TARGET_TYPES: readonly string[];
  export type KnownTargetType = (typeof KNOWN_TARGET_TYPES)[number];
  export const AUDIT_TARGET_TYPE_META: Record<KnownTargetType, { zh: string; en: string }>;
  export function auditTargetTypeMeta(t: string | null | undefined): { value: string; zh: string; en: string } | null;
  ```

- [ ] **Step 1: Write the failing action-meta test**

Create `enterprise_server/tests/shared/auditActionMeta.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { AuditAction } from '../../src/shared/enterpriseServerConstants';
import { AUDIT_ACTION_META, auditActionMeta } from '../../src/shared/auditActionMeta';

describe('auditActionMeta', () => {
  test('covers every AuditAction code exactly', () => {
    const want = Object.values(AuditAction).sort();
    const got = Object.keys(AUDIT_ACTION_META).sort();
    expect(got).toEqual(want);
  });

  test('every entry has non-empty zh and en', () => {
    for (const [code, m] of Object.entries(AUDIT_ACTION_META)) {
      expect(m.zh.trim(), code).not.toBe('');
      expect(m.en.trim(), code).not.toBe('');
    }
  });

  test('no zh value equals its raw code', () => {
    for (const [code, m] of Object.entries(AUDIT_ACTION_META)) expect(m.zh, code).not.toBe(code);
  });

  test('destructive actions are tone danger', () => {
    for (const c of [AuditAction.ProviderKeyDelete, AuditAction.UserDisable, AuditAction.RoleDelete]) {
      expect(auditActionMeta(c).tone, c).toBe('danger');
    }
  });

  test('login is tone auth', () => {
    expect(auditActionMeta(AuditAction.Login).tone).toBe('auth');
  });

  test('an unregistered code falls back to itself without throwing', () => {
    const m = auditActionMeta('something_a_client_made_up');
    expect(m.zh).toBe('something_a_client_made_up');
    expect(m.en).toBe('something_a_client_made_up');
    expect(m.tone).toBe(AuditTone.Normal); // was 'Normal' — unpassable, the tone value is 'normal'
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Expected: FAIL — cannot resolve `../../src/shared/auditActionMeta`.

Run: `cd enterprise_server && npx vitest run tests/shared/auditActionMeta.test.ts`

- [ ] **Step 3: Write `src/shared/auditActionMeta.ts`**

Declare `AuditTone`, the interfaces, and `AUDIT_ACTION_META` typed as `Record<AuditAction, AuditActionMeta>` so a missing key is a **compile error**, then `auditActionMeta(action)` returning the entry or the fallback.

Tone rules (spec §5.5): authentication → `Auth`; success confirmations → `Success`; failures → `Failure`; configuration mutations → `Change`; revoke/disable/delete → `Danger`; everything else → `Normal`.

Chinese names for the codes the PRD names (use the **actual** `AuditAction` codes, not the PRD's invented ones): `login`→登录, `login_failed`→登录失败, `token_refresh`→令牌刷新, `enterprise_models_sync`→企业模型同步, `quota_exceeded`→配额超限, `quota_warning`→配额预警, `admin_access_denied`→管理访问被拒绝, `setup_redeem`→初始化兑换, `user_disable`→停用用户, `user_enable`→启用用户, `provider_key_delete`→删除服务商密钥, `mcp_connector_create`→创建 MCP 服务, `html_share_create`→创建 HTML 分享. Derive the rest following the same voice; each `*_create`/`*_update`/`*_delete` reads as 创建/更新/删除 + object, each `*_submit`/`*_approve`/`*_reject`/`*_withdraw` as 提交/审核通过/审核拒绝/撤回 + object.

- [ ] **Step 4: Run it to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/shared/auditActionMeta.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing target-type test, then the module**

Create `enterprise_server/tests/shared/auditTargetTypeMeta.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { auditTargetTypeMeta, AUDIT_TARGET_TYPE_META } from '../../src/shared/auditTargetTypeMeta';

describe('auditTargetTypeMeta', () => {
  test('covers the 22 known target types', () => {
    expect(Object.keys(AUDIT_TARGET_TYPE_META).sort()).toEqual([
      'agent','agent_references','archive','connector','connector_category','dept',
      'enterprise_models_sync','html_share','kit','kit_category','login','model','org',
      'provider_key','release','role','route','skill','skill_category','sso_connection',
      'submission','user',
    ]);
  });

  test('every entry has zh and en', () => {
    for (const [k, m] of Object.entries(AUDIT_TARGET_TYPE_META)) {
      expect(m.zh.trim(), k).not.toBe('');
      expect(m.en.trim(), k).not.toBe('');
    }
  });

  test('null yields null (the UI renders an em dash)', () => {
    expect(auditTargetTypeMeta(null)).toBeNull();
  });

  test('an unknown client-supplied value falls back to itself', () => {
    expect(auditTargetTypeMeta('whatever')!.zh).toBe('whatever');
  });
});
```

Then create `src/shared/auditTargetTypeMeta.ts` exporting the 22-entry table and the accessor. Chinese labels: model→模型, user→用户, dept→部门, role→角色, skill→技能, skill_category→技能分类, kit→套件, kit_category→套件分类, agent→智能体, agent_references→智能体引用, connector→MCP 服务, connector_category→MCP 分类, provider_key→服务商密钥, release→版本, html_share→HTML 分享, org→组织, route→接口路径, archive→归档, submission→提交记录, sso_connection→SSO 连接, enterprise_models_sync→企业模型同步, login→登录。

Run: `cd enterprise_server && npx vitest run tests/shared/auditTargetTypeMeta.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Mirror to the web and guard it with a parity test**

Create `enterprise_server/web/src/shared/auditActionMeta.ts` re-exporting `AUDIT_ACTION_META`, `AuditTone` and `auditActionMeta` with identical contents, under a header comment matching the convention in `web/src/shared/permissions.ts:1-9`.

Create `enterprise_server/web/tests/shared/auditActionMeta.parity.test.ts` that imports the server table directly and asserts the mirror matches key-for-key and value-for-value:

```ts
import { describe, expect, test } from 'vitest';
import { AUDIT_ACTION_META as SERVER } from '../../../src/shared/auditActionMeta';
import { AUDIT_ACTION_META as WEB } from '../../src/shared/auditActionMeta';

describe('auditActionMeta mirror', () => {
  test('web mirror matches the server table exactly', () => {
    expect(Object.keys(WEB).sort()).toEqual(Object.keys(SERVER).sort());
    for (const k of Object.keys(SERVER)) expect(WEB[k as keyof typeof WEB], k).toEqual(SERVER[k as keyof typeof SERVER]);
  });
});
```

Run: `cd enterprise_server/web && npx vitest run tests/shared/auditActionMeta.parity.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add enterprise_server/src/shared/auditActionMeta.ts \
  enterprise_server/src/shared/auditTargetTypeMeta.ts \
  enterprise_server/web/src/shared/auditActionMeta.ts \
  enterprise_server/tests/shared/auditActionMeta.test.ts \
  enterprise_server/tests/shared/auditTargetTypeMeta.test.ts \
  enterprise_server/web/tests/shared/auditActionMeta.parity.test.ts
git commit -m "feat(shared): audit action and target-type label tables

71 action codes get a Chinese name, an English name and a tone, keyed by
Record<AuditAction,...> so a missing entry is a compile error. Target
types use a known-value list plus a fallback because POST /audit accepts
arbitrary client-supplied strings, so exhaustiveness cannot be enforced.

The web copy is a hand-kept mirror per web/src/shared/permissions.ts,
guarded by a parity test.
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: CSV emission

**Files:**
- Create: `enterprise_server/src/analytics/csv.ts`
- Test: `enterprise_server/tests/analytics/csv.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export function csvCell(v: unknown): string;
  export function toCsv(meta: { rangeLabel: string }, header: string[], rows: unknown[][]): string;
  export function csvResponse(opts: { body: string; rowCount: number; filename: string }): Response;
  ```
  `toCsv` returns `'﻿' + '统计范围：' + rangeLabel + '\r\n' + header.join(',') + '\r\n' + rows…`. `csvResponse` sets `content-type: text/csv; charset=utf-8`, `content-disposition: attachment; filename*=UTF-8''…`, and `x-export-count: <rowCount>`.

- [ ] **Step 1: Write the failing test**

Create `enterprise_server/tests/analytics/csv.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { csvCell, csvResponse, toCsv } from '../../src/analytics/csv';

describe('analytics/csv', () => {
  test('the document starts with a UTF-8 BOM', () => {
    expect(toCsv({ rangeLabel: '近 7 天' }, ['a'], []).charCodeAt(0)).toBe(0xfeff);
  });

  test('the first line is the range, then the header', () => {
    const out = toCsv({ rangeLabel: '近 7 天' }, ['用户名称', '部门'], [['张伟', '研发中心']]);
    expect(out.replace(/^﻿/, '').split('\r\n').slice(0, 2))
      .toEqual(['统计范围：近 7 天', '用户名称,部门']);
  });

  test('commas, quotes and newlines are escaped, not stripped', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  test('a JSON payload survives as one column', () => {
    expect(csvCell(JSON.stringify({ a: 1, b: 'x,y' }))).toBe('"{""a"":1,""b"":""x,y""}"');
  });

  test('null and undefined become empty cells, not the words', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(0)).toBe('0');
  });

  test('csvResponse carries the count and an attachment filename', () => {
    const res = csvResponse({ body: 'x', rowCount: 42, filename: '近 7 天-用户用量.csv' });
    expect(res.headers.get('x-export-count')).toBe('42');
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toContain("filename*=UTF-8''");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/analytics/csv.test.ts`
Expected: FAIL — cannot resolve `../../src/analytics/csv`.

- [ ] **Step 3: Implement `src/analytics/csv.ts`**

`csvCell` coerces to string, returns `''` for null/undefined, and wraps in double quotes with `"` doubled whenever the value contains `,`, `"`, `\n` or `\r`. `toCsv` joins with `\r\n` and prepends the BOM and range line. `csvResponse` builds the `Response` with the three headers.

- [ ] **Step 4: Run it to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/analytics/csv.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/analytics/csv.ts enterprise_server/tests/analytics/csv.test.ts
git commit -m "feat(analytics): BOM-prefixed CSV with real escaping

Replaces the .replace(/,/g,'\\\\,') approach in the old audit export,
which deleted commas instead of quoting and let payload JSON spill
across columns in Excel.
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: `/admin/usage/models` — merged model rows

**Files:**
- Create: `enterprise_server/src/analytics/usage.ts`
- Create: `enterprise_server/src/routes/admin/usage.ts`
- Modify: `enterprise_server/src/server.ts`
- Test: `enterprise_server/tests/analytics/usageModels.test.ts`

**Interfaces:**
- Consumes: `resolveUsageRange` (Task 4), `UsageView`/`UsageExport` (Task 2), `usage_missing` column (Task 3).
- Produces:
  ```ts
  // src/analytics/usage.ts
  export interface UsageModelRow { provider: string; model: string; display_name: string; total_tokens: number; call_count: number; }
  export interface UsageModelsResult { page: number; pageSize: number; total: number; items: UsageModelRow[]; unaccounted_calls: number; }
  export function queryModels(args: { orgId: string; from: Date; to: Date; page: number; pageSize: number }): Promise<UsageModelsResult>;
  ```
  Route `GET /admin/usage/models?range=&page=&pageSize=` gated by `requirePermission(PermissionPoint.UsageView)`, responding `{range, from, to, timezone, page, pageSize, total, items, unaccounted_calls}`.

- [ ] **Step 1: Write the failing test**

Create `enterprise_server/tests/analytics/usageModels.test.ts`:

```ts
import '../helpers/setupEnv';
import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { Hono } from 'hono';
import { authService } from '../../src/auth/authService';
import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { adminUsageRoutes } from '../../src/routes/admin/usage';
import { queryModels } from '../../src/analytics/usage';

const FROM = new Date('2026-03-01T00:00:00Z');
const TO = new Date('2026-03-08T00:00:00Z');

async function usage(provider: string, model: string, tokens: number, opts?: { modelId?: string; missing?: boolean; ts?: string }) {
  await testPool.query(
    `INSERT INTO token_usage(org_id,user_id,model_id,provider,token_in,token_out,total_tokens,result_code,quota_window_date,usage_missing,ts)
     VALUES ('o1','u1',$1,$2,$3,$3,$3*2,200,'2026-03-01',$4,$5)`,
    [opts?.modelId ?? `builtin:o1:p:${model}`, provider, tokens, opts?.missing ?? false, opts?.ts ?? '2026-03-01T10:00:00Z'],
  );
}

describe('queryModels', () => {
  beforeEach(async () => {
    await resetSchema(); await runMigrations();
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','T')`);
    await authService.createUser({ orgId: 'o1', username: 'a', password: 'pw12345' });
    await testPool.query(`INSERT INTO provider_keys(id,org_id,provider,api_key_encrypted,created_by) VALUES ('pk1','o1','anthropic','x','u1')`);
  });

  test('same-named models under two provider keys merge into one row with summed tokens', async () => {
    await testPool.query(
      `INSERT INTO model_catalog(id,org_id,provider_key_id,provider,model,display_name) VALUES
       ('builtin:o1:anthropic:opus','o1','pk1','anthropic','opus','Claude Opus'),
       ('custom-uuid','o1','pk1','anthropic','opus','Claude Opus')`);
    await usage('anthropic', 'opus', 100, { modelId: 'builtin:o1:anthropic:opus' });
    await usage('anthropic', 'opus', 250, { modelId: 'custom-uuid' });

    const r = await queryModels({ orgId: 'o1', from: FROM, to: TO, page: 1, pageSize: 50 });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ provider: 'anthropic', model: 'opus', display_name: 'Claude Opus', total_tokens: 700, call_count: 2 });
  });

  test('a catalog model with no calls in range still appears at zero', async () => {
    await testPool.query(
      `INSERT INTO model_catalog(id,org_id,provider_key_id,provider,model,display_name)
       VALUES ('builtin:o1:anthropic:sonnet','o1','pk1','anthropic','sonnet','Claude Sonnet')`);
    const r = await queryModels({ orgId: 'o1', from: FROM, to: TO, page: 1, pageSize: 50 });
    expect(r.items).toEqual([
      { provider: 'anthropic', model: 'sonnet', display_name: 'Claude Sonnet', total_tokens: 0, call_count: 0 },
    ]);
  });

  test('a model deleted from the catalog keeps its history', async () => {
    await usage('anthropic', 'ghost', 999, { modelId: 'gone-id' });
    const r = await queryModels({ orgId: 'o1', from: FROM, to: TO, page: 1, pageSize: 50 });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ model: 'ghost', total_tokens: 999, display_name: 'ghost' });
  });

  test('rows outside [from, to) are excluded', async () => {
    await usage('anthropic', 'a', 10, { ts: '2026-02-28T23:00:00Z' });
    await usage('anthropic', 'b', 10, { ts: '2026-03-08T00:00:00Z' });
    await usage('anthropic', 'c', 10, { ts: '2026-03-07T23:00:00Z' });
    const r = await queryModels({ orgId: 'o1', from: FROM, to: TO, page: 1, pageSize: 50 });
    expect(r.items.map((i) => i.model)).toEqual(['c']);
  });

  test('another org is never visible', async () => {
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o2','Other')`);
    await testPool.query(
      `INSERT INTO token_usage(org_id,user_id,model_id,provider,token_in,token_out,total_tokens,result_code,quota_window_date)
       VALUES ('o2','u1','m','deepseek',1,1,2,200,'2026-03-01')`);
    const r = await queryModels({ orgId: 'o1', from: FROM, to: TO, page: 1, pageSize: 50 });
    expect(r.items).toHaveLength(0);
  });

  test('call_count includes zero-token failure rows and unaccounted stream calls', async () => {
    await usage('anthropic', 'a', 0);
    await usage('anthropic', 'a', 0, { missing: true });
    const r = await queryModels({ orgId: 'o1', from: FROM, to: TO, page: 1, pageSize: 50 });
    expect(r.items[0].call_count).toBe(2);
    expect(r.unaccounted_calls).toBe(1);
  });

  test('paging is stable across calls and ordered by tokens desc', async () => {
    for (const [m, tk] of [['a',1],['b',2],['c',3],['d',4],['e',5]] as const) await usage('anthropic', m, tk);
    const p1 = await queryModels({ orgId: 'o1', from: FROM, to: TO, page: 1, pageSize: 2 });
    const p2 = await queryModels({ orgId: 'o1', from: FROM, to: TO, page: 1, pageSize: 2 });
    expect(p1.items.map((i) => i.model)).toEqual(['e','d']);
    expect(p2.items.map((i) => i.model)).toEqual(['e','d']);
    expect(p1.total).toBe(5);
  });
});

describe('GET /admin/usage/models', () => {
  beforeEach(async () => {
    await resetSchema(); await runMigrations();
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','T')`);
    const u = await authService.createUser({ orgId: 'o1', username: 'a', password: 'pw12345' });
    await testPool.query(`UPDATE users SET roles='["super_admin"]' WHERE id=$1`, [u.id]);
  });

  test('requires usage:view and returns the documented envelope', async () => {
    const app = new Hono(); app.route('/', adminUsageRoutes);
    const token = await signToken({ sub: 'u1', orgId: 'o1', roles: ['super_admin'] });
    const res = await app.request('/admin/usage/models?range=7d', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ timezone: expect.any(String) });
    expect(body).toHaveProperty('unaccounted_calls');
    expect(body).toHaveProperty('total');
  });

  test('an unauthenticated caller gets 401', async () => {
    const app = new Hono(); app.route('/', adminUsageRoutes);
    expect((await app.request('/admin/usage/models?range=7d')).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/analytics/usageModels.test.ts`
Expected: FAIL — cannot resolve `../../src/analytics/usage` / `../../src/routes/admin/usage`.

- [ ] **Step 3: Implement `queryModels`**

One statement, aggregating the two sides separately and combining with `FULL JOIN` on `(provider, model)`:

- left side: `SELECT provider, model, MAX(display_name) AS display_name FROM model_catalog WHERE org_id=$1 GROUP BY provider, model`
- right side: `SELECT provider, model, SUM(total_tokens)::bigint, COUNT(*)::bigint, COUNT(*) FILTER (WHERE usage_missing)::bigint FROM token_usage WHERE org_id=$1 AND ts >= $2 AND ts < $3 GROUP BY provider, model`
- `ORDER BY total_tokens DESC NULLS LAST, model ASC`; `total` from a window `COUNT(*) OVER ()` so it survives paging; fall back to `0` and the raw `model` string when `display_name` is null.

Cast the `bigint` sums with `::int` on the way out — `SUM` over `integer` returns `bigint`, which the pg driver hands back as a string.

- [ ] **Step 4: Implement the route**

`src/routes/admin/usage.ts`:

```ts
export const adminUsageRoutes = new Hono();
adminUsageRoutes.use('/admin/usage/*', requireAuth);
```

`requireAuth` first, then per-route `requirePermission(PermissionPoint.UsageView)`. Read `range` (default `7d`), `page` (default 1), `pageSize` (default 50, capped at 200). Call `resolveUsageRange(c.get('claims').orgId, range)` and pass the resolved `from`/`to`/`timezone` into `queryModels`. Reject an unrecognised `range` with 400.

Register in `src/server.ts` next to `app.route('/', adminAuditRoutes);`: `app.route('/', adminUsageRoutes);` with the import.

- [ ] **Step 5: Run it to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/analytics/usageModels.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add enterprise_server/src/analytics/usage.ts enterprise_server/src/routes/admin/usage.ts \
  enterprise_server/src/server.ts enterprise_server/tests/analytics/usageModels.test.ts
git commit -m "feat(analytics): GET /admin/usage/models with (provider, model) merging

FULL JOIN over the catalog aggregate and the usage aggregate, so a
same-named model under a builtin and a custom key renders once with
summed tokens, a never-called catalog model still shows at zero, and a
model hard-deleted from the catalog keeps its history.

call_count is COUNT(*) and covers 429s, 502s and unaccounted stream
calls; usage_missing rows are surfaced separately as unaccounted_calls.
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: `/admin/usage/users` and `/admin/usage/users/:id`

**Files:**
- Modify: `enterprise_server/src/analytics/usage.ts`
- Modify: `enterprise_server/src/routes/admin/usage.ts`
- Test: `enterprise_server/tests/analytics/usageUsers.test.ts`

**Interfaces:**
- Consumes: `queryModels` neighbours from Task 7 (same module, same file).
- Produces:
  ```ts
  export interface UsageUserRow { user_id: string; username: string; display_name: string | null;
    department_name: string | null; total_tokens: number; last_used_at: string | null; }
  export interface UsageUsersResult { page: number; pageSize: number; total: number; items: UsageUserRow[]; unaccounted_calls: number; }
  export function queryUsers(args: { orgId: string; from: Date; to: Date; q?: string; sort: 'desc'|'asc'; page: number; pageSize: number }): Promise<UsageUsersResult>;

  export interface UserDailyPoint { date: string; tokens: number; }
  export interface UserModelShare { provider: string; model: string; display_name: string; tokens: number; pct: number; }
  export interface UserDetailResult { user: { user_id: string; display_name: string | null; department_name: string | null };
    daily: UserDailyPoint[]; by_model: UserModelShare[]; unaccounted_calls: number; }
  export function queryUserDetail(args: { orgId: string; userId: string; from: Date; to: Date; timezone: string; days: string[] }): Promise<UserDetailResult>;
  ```

- [ ] **Step 1: Write the failing list test**

Create `enterprise_server/tests/analytics/usageUsers.test.ts` with a `beforeEach` that resets the schema, seeds `orgs(o1)` and three users (`u1` 张伟/研发中心, `u2` 李娜/市场部, `u3` zero-usage/市场部), and a helper `usage(userId, provider, model, tokens, day)` inserting a `token_usage` row at `<day>T10:00:00Z`. Then:

```ts
test('every member appears, including zero-usage and disabled ones', async () => {
  await testPool.query(`UPDATE users SET status='disabled' WHERE id='u3'`);
  await usage('u1', 'anthropic', 'opus', 500, '2026-03-01');
  const r = await queryUsers({ orgId: 'o1', from: FROM, to: TO, sort: 'desc', page: 1, pageSize: 8 });
  expect(r.items.map((i) => i.user_id).sort()).toEqual(['u1','u2','u3']);
  expect(r.items.find((i) => i.user_id === 'u3')!.total_tokens).toBe(0);
  expect(r.items.find((i) => i.user_id === 'u3')!.last_used_at).toBeNull();
});

test('paging does not shift between identical calls when several members tie at zero', async () => {
  for (const u of ['u2','u3']) await usage(u, 'anthropic', 'opus', 0, '2026-03-01');
  const a = await queryUsers({ orgId: 'o1', from: FROM, to: TO, sort: 'desc', page: 2, pageSize: 1 });
  const b = await queryUsers({ orgId: 'o1', from: FROM, to: TO, sort: 'desc', page: 2, pageSize: 1 });
  expect(a.items[0].user_id).toBe(b.items[0].user_id);
});

test('search matches display name or username, case-insensitively', async () => {
  const zh = await queryUsers({ orgId:'o1', from: FROM, to: TO, q:'张', sort:'desc', page:1, pageSize:8 });
  expect(zh.items.map((i) => i.user_id)).toEqual(['u1']);
  const en = await queryUsers({ orgId:'o1', from: FROM, to: TO, q:'LI', sort:'desc', page:1, pageSize:8 });
  expect(en.items.map((i) => i.user_id)).toEqual(['u2']);
});

test('sort ascending puts the heaviest consumer last', async () => {
  await usage('u1', 'anthropic', 'opus', 900, '2026-03-01');
  await usage('u2', 'anthropic', 'opus', 100, '2026-03-01');
  const r = await queryUsers({ orgId:'o1', from: FROM, to: TO, sort:'asc', page:1, pageSize:8 });
  expect(r.items[r.items.length-1].user_id).toBe('u1');
});

test('department name is joined through, null when unset', async () => {
  await testPool.query(`INSERT INTO departments(id,org_id,name) VALUES ('d1','o1','研发中心')`);
  await testPool.query(`UPDATE users SET department_id='d1' WHERE id='u1'`);
  const r = await queryUsers({ orgId:'o1', from: FROM, to: TO, sort:'desc', page:1, pageSize:8 });
  expect(r.items.find((i) => i.user_id === 'u1')!.department_name).toBe('研发中心');
  expect(r.items.find((i) => i.user_id === 'u2')!.department_name).toBeNull();
});

test('last_used_at is the most recent call in range, not outside it', async () => {
  await usage('u1','anthropic','opus',10,'2026-03-05');
  await usage('u1','anthropic','opus',10,'2026-04-09');
  const r = await queryUsers({ orgId:'o1', from: FROM, to: TO, sort:'desc', page:1, pageSize:8 });
  expect(r.items[0].last_used_at).toBe('2026-03-05T10:00:00.000Z');
});
```

Run: `cd enterprise_server && npx vitest run tests/analytics/usageUsers.test.ts`
Expected: FAIL — `queryUsers` is not exported.

- [ ] **Step 2: Implement `queryUsers`**

`users` is the left table; LEFT JOIN a per-user aggregate subquery scoped to `[from, to)`. No `status` filter and no archive filter (D6). The ORDER BY is fixed and must include a deterministic tiebreaker:

```sql
ORDER BY total_tokens <dir>, COALESCE(display_name, username) ASC, user_id ASC
```

`q` becomes `AND (COALESCE(u.display_name,'') ILIKE $q OR u.username ILIKE $q)` with the parameter `%${q}%`. `total` via `COUNT(*) OVER ()`. `unaccounted_calls` is the org-wide count in range, matching the models endpoint.

- [ ] **Step 3: Add the failing detail tests**

Append to the same file:

```ts
test('daily returns one entry per day of the range, including zero days', async () => {
  await usage('u1','anthropic','opus',700,'2026-03-03');
  const days = ['2026-03-01','2026-03-02','2026-03-03','2026-03-04','2026-03-05'];
  const r = await queryUserDetail({ orgId:'o1', userId:'u1', from: FROM, to: TO, timezone:'UTC', days });
  expect(r.daily).toHaveLength(days.length);
  expect(r.daily[0]).toEqual({ date:'2026-03-01', tokens:0 });
  expect(r.daily[2]).toEqual({ date:'2026-03-03', tokens:700 });
});

test('a member with no calls yields an all-zero daily series and no model rows', async () => {
  const r = await queryUserDetail({ orgId:'o1', userId:'u3', from: FROM, to: TO, timezone:'UTC',
    days:['2026-03-01','2026-03-02'] });
  expect(r.daily).toEqual([{date:'2026-03-01',tokens:0},{date:'2026-03-02',tokens:0}]);
  expect(r.by_model).toEqual([]);
});

test('by_model shares sum to 100 and merge same-named models', async () => {
  await usage('u1','anthropic','opus',300,'2026-03-01');
  await usage('u1','anthropic','opus',100,'2026-03-02');
  await usage('u1','deepseek','v4',600,'2026-03-01');
  const r = await queryUserDetail({ orgId:'o1', userId:'u1', from: FROM, to: TO, timezone:'UTC', days:['2026-03-01','2026-03-02'] });
  expect(r.by_model.map((m) => m.model)).toEqual(['v4','opus']);
  expect(r.by_model[0].pct).toBe(60);
  expect(Math.round(r.by_model.reduce((s,m)=>s+m.pct,0))).toBe(100);
});

test('percentages are zero, not NaN, when the member used nothing', async () => {
  const r = await queryUserDetail({ orgId:'o1', userId:'u3', from: FROM, to: TO, timezone:'UTC', days:['2026-03-01'] });
  expect(r.by_model.every((m) => m.pct === 0)).toBe(true);
});
```

- [ ] **Step 4: Implement `queryUserDetail`**

`daily` is built in JS from the caller-supplied `days` array (that is why `days` is a parameter), filling 0 for days the SQL did not return — this guarantees `daily.length === days.length` by construction rather than by a fill-in query. `by_model` merges on `(provider, model)` like `queryModels`, ordered by tokens desc, with `pct = total === 0 ? 0 : Math.round(tokens / total * 1000) / 10`.

- [ ] **Step 5: Add the two routes**

`GET /admin/usage/users?range=&q=&sort=&page=&pageSize=` (default `pageSize` 8) and `GET /admin/usage/users/:userId?range=`. The detail route passes `timezone` and `days` straight from `resolveUsageRange`. Both call `resolveUsageRange` themselves — do not accept `from`/`to` from the query string.

- [ ] **Step 6: Run it to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/analytics/usageUsers.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 7: Commit**

```bash
git add enterprise_server/src/analytics/usage.ts enterprise_server/src/routes/admin/usage.ts \
  enterprise_server/tests/analytics/usageUsers.test.ts
git commit -m "feat(analytics): member usage list and per-member detail

The list is users LEFT JOIN usage with no status filter, so zero-usage
and disabled members are both present (D6). A deterministic tiebreaker
after total_tokens keeps page boundaries from shifting between identical
requests when many members tie at zero.

The detail endpoint builds its daily series from the resolved days[]
array so its length equals the range by construction.
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: usage CSV export

**Files:**
- Modify: `enterprise_server/src/analytics/usage.ts`
- Modify: `enterprise_server/src/routes/admin/usage.ts`
- Test: `enterprise_server/tests/analytics/usageExport.test.ts`

**Interfaces:**
- Consumes: `queryModels`, `queryUsers` (Tasks 7–8), `csvResponse` (Task 6), `UsageExport` (Task 2).
- Produces: `GET /admin/usage/export.csv?range=&tab=models|users` gated by `requirePermission(PermissionPoint.UsageExport)`, plus an unbounded `queryModelsAll` / `queryUsersAll` pair used only here so the export never inherits the table's `pageSize`.

- [ ] **Step 1: Write the failing test**

Create `enterprise_server/tests/analytics/usageExport.test.ts` reusing Task 8's seeding helpers, with:

```ts
test('models export emits every merged row, not just the visible page', async () => {
  for (const [m, tk] of [['a',1],['b',2],['c',3],['d',4],['e',5]] as const) await usage('u1','anthropic',m,tk*100,'2026-03-01');
  const res = await app.request('/admin/usage/export.csv?range=7d&tab=models', { headers: auth });
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body.charCodeAt(0)).toBe(0xfeff);
  const lines = body.replace(/^﻿/,'').trim().split('\r\n');
  expect(lines[0]).toBe('统计范围：近 7 天');
  expect(lines[1]).toBe('模型提供商,模型名称,模型用量(tokens),调用次数');
  expect(lines.slice(2)).toHaveLength(5);
  expect(res.headers.get('x-export-count')).toBe('5');
});

test('the export row count matches the models list total', async () => {
  await usage('u1','anthropic','a',100,'2026-03-01');
  const csv = await app.request('/admin/usage/export.csv?range=7d&tab=models', { headers: auth });
  const list = await app.request('/admin/usage/models?range=7d', { headers: auth });
  expect(csv.headers.get('x-export-count')).toBe(String((await list.json()).total));
});

test('users export carries the range line and a — for members who never called', async () => {
  const res = await app.request('/admin/usage/export.csv?range=7d&tab=users', { headers: auth });
  const lines = (await res.text()).replace(/^﻿/,'').trim().split('\r\n');
  expect(lines[0]).toBe('统计范围：近 7 天');
  expect(lines[1]).toBe('用户名称,部门,用量,最近使用时间');
  const zero = lines.find((l) => l.includes('u3') || l.includes('赵'));
  expect(zero).toBeDefined();
});

test('export needs usage:export, not merely usage:view', async () => {
  const token = await signToken({ sub:'u2', orgId:'o1', roles:['auditor_view_only'] });
  // seed a role granting only usage:view
  expect((await app.request('/admin/usage/export.csv?range=7d&tab=models', { headers: { authorization:`Bearer ${token}` } })).status).toBe(403);
});

test('the models list still succeeds for that same caller', async () => {
  // ...same token as above...
  expect((await app.request('/admin/usage/models?range=7d', { headers: { authorization:`Bearer ${token}` } })).status).toBe(200);
});
```

Seed the role in `beforeEach`: insert a non-builtin role granting only `["usage:view"]` and attach it to `u2`.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/analytics/usageExport.test.ts`
Expected: FAIL — no such route.

- [ ] **Step 3: Implement the export**

`queryModelsAll` / `queryUsersAll` share the SQL of their paged siblings with the `LIMIT`/`OFFSET` window dropped — factor the base statement into one local function per query so the table and the CSV cannot drift. Render with `toCsv({ rangeLabel }, header, rows)`, map the range key to its Chinese label via a small server-side `RANGE_LABELS` record (`today`→今天, `7d`→近 7 天, `30d`→近 30 天, `this_month`→本月, `last_month`→上月), and return `csvResponse({ body, rowCount, filename: `${key}-模型用量.csv` })`.

Mount `requirePermission(PermissionPoint.UsageExport)` on `/admin/usage/export.csv` **before** the `UsageView` middleware, since Hono matches in registration order.

- [ ] **Step 4: Run it to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/analytics/usageExport.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/analytics/usage.ts enterprise_server/src/routes/admin/usage.ts \
  enterprise_server/tests/analytics/usageExport.test.ts
git commit -m "feat(analytics): usage CSV export gated on usage:export

The export reuses the table's SQL with LIMIT/OFFSET dropped rather than
re-implementing it, so the footer count and the CSV row count cannot
diverge. The export route is mounted before the UsageView middleware
because Hono matches in registration order.
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Audit list endpoint rework

**Files:**
- Create: `enterprise_server/src/analytics/auditQuery.ts`
- Modify: `enterprise_server/src/routes/admin/audit.ts`
- Modify: `enterprise_server/src/audit/auditStore.ts`
- Test: `enterprise_server/tests/analytics/auditList.test.ts`
- Modify: `enterprise_server/tests/routes/admin/audit.test.ts`

**Interfaces:**
- Consumes: `resolveAuditRange` (Task 4), `auditActionMeta` / `auditTargetTypeMeta` (Task 5), `AuditView` (existing).
- Produces:
  ```ts
  export interface AuditListFilters { userId?: string; action?: string; targetType?: string; targetId?: string; }
  export interface AuditListItem { id: string; ts: string; user_id: string | null; user_name: string | null;
    action: string; action_zh: string; action_en: string; tone: AuditTone;
    target_type: string | null; target_type_zh: string | null; target_id: string | null; payload: unknown; }
  export interface AuditFacets { users: {value:string;label:string}[]; actions: {value:string;label:string;label_en:string}[];
    target_types: {value:string;label:string;label_en:string}[]; }
  export interface AuditListResult { page: number; pageSize: number; total: number; items: AuditListItem[];
    facets: AuditFacets; from: Date; to: Date; }
  export function queryAudit(args: { orgId: string; from: Date; to: Date; filters: AuditListFilters;
    includeLogin: boolean; page: number; pageSize: number }): Promise<AuditListResult>;
  ```

- [ ] **Step 1: Write the failing list test**

Create `enterprise_server/tests/analytics/auditList.test.ts` seeding an org, two users (张伟/李娜), and a mix of `audit_events` rows, plus one `login_events` row that duplicates an existing `login` action row. Assert:

```ts
test('user_name is a display name, never a UUID', ...)
test('an anonymous event has null user_name', ...)
test('an action with no registered label falls back to its raw code', ...)   // Review Focus #2
test('targetType and targetId filters stack', ...)
test('facets contain only values present in the range, never nulls', ...)
test('includeLogin unions login_events and does not double-count the login row', ...)
test('total counts both sources when includeLogin is on', ...)             // Review Focus: the UNION total
test('paging is stable when two events share a timestamp', ...)
test('another org is never visible', ...)
test('a custom range narrows the result', ...)
```

Run: `cd enterprise_server && npx vitest run tests/analytics/auditList.test.ts`
Expected: FAIL — cannot resolve `../../src/analytics/auditQuery`.

- [ ] **Step 2: Implement `queryAudit`**

Materialise a CTE `base` that is either `audit_events` alone or, when `includeLogin`, `audit_events` UNION ALL the `login_events` rows cast into the same shape (`target_type='login'`, `payload=jsonb_build_object('ip',…,'device',…,'result',…)`), **excluding `audit_events` rows whose action is `login`** — superseded: the plan originally said the opposite. `src/routes/auth.ts:103-108` writes the `audit_events` login row with **no payload** (org/user/action only); `login_events` is the richer per-attempt record carrying ip/device/result. Keeping the `audit_events` twin would render successful logins with an empty payload and fail `tests/routes/admin/audit.test.ts`'s `payload?.result === 'success'` assertion. Apply the four filters in the CTE, then LEFT JOIN `users` for `display_name` with `COALESCE(display_name, username)` as the fallback.

The response `total` and the facets `COUNT(DISTINCT …)` must both run against `base` **after** the filters — computing them against `audit_events` alone would under-report whenever `includeLogin` is on. `payload` passes through untouched; `ts` is serialised as an ISO string.

- [ ] **Step 3: Rework the route**

`src/routes/admin/audit.ts`: drop the `format === 'csv'` branch (Task 11 replaces it) and split the path-level middleware so `/admin/audit/export.csv` is not shadowed by the `AuditView` guard. `GET /admin/audit` reads `range` (default `30d`), `from`/`to` for `custom`, the four filters, `page`, `pageSize` (default 15), and always passes `includeLogin: true`.

- [ ] **Step 4: Update the existing route test**

`tests/routes/admin/audit.test.ts` currently asserts the bare-array response. Update its `include=login` case to read `body.items` and `body.total`, and assert the dedup still holds.

Run: `cd enterprise_server && npx vitest run tests/routes/admin/audit.test.ts`
Expected: PASS.

- [ ] **Step 5: Run and commit**

Run: `cd enterprise_server && npx vitest run tests/analytics/auditList.test.ts tests/routes/admin/audit.test.ts`
Expected: PASS.

```bash
git add enterprise_server/src/analytics/auditQuery.ts enterprise_server/src/routes/admin/audit.ts \
  enterprise_server/src/audit/auditStore.ts enterprise_server/tests/analytics/auditList.test.ts \
  enterprise_server/tests/routes/admin/audit.test.ts
git commit -m "feat(analytics): paged, filtered audit list with facets

Adds range, action, targetType and targetId filters, returns display
names instead of UUIDs, and ships the facet lists in the same response
so the dropdowns cost no extra round trip. total and the facet counts
are computed over the post-filter base, which includes the login_events
union when includeLogin is on.

DeptDetail.tsx needs targetId; the export path is split off the
path-level AuditView middleware in Task 11.
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: audit CSV export

**Files:**
- Modify: `enterprise_server/src/routes/admin/audit.ts`
- Test: `enterprise_server/tests/analytics/auditExport.test.ts`

**Interfaces:**
- Consumes: `queryAudit` (Task 10), `csvResponse` (Task 6), `AuditExport` (Task 2).
- Produces: `GET /admin/audit/export.csv?range=&from=&to=&userId=&action=&targetType=&targetId=` gated by `requirePermission(PermissionPoint.AuditExport)`.

- [ ] **Step 1: Write the failing test**

Create `enterprise_server/tests/analytics/auditExport.test.ts`:

```ts
test('the export has a BOM, a range line, and the six documented columns', ...)
test('the operation column carries the Chinese label, not the code', ...)
test('a payload containing commas and quotes stays in one column', ...)
test('the export honours the filters and is not capped at the page size', ...)
test('the export needs audit:export, not merely audit:view', ...)
```

Run: `cd enterprise_server && npx vitest run tests/analytics/auditExport.test.ts`
Expected: FAIL — no such route.

- [ ] **Step 2: Implement**

Reuse `queryAudit` with a large `pageSize` (or an unbounded sibling) and the same `resolveAuditRange` call the list uses. Header: `时间,用户,操作,对象类型,对象ID,载荷`. Time formatted `YYYY/MM/DD HH:mm:ss`, anonymous users as `—`, absent targets as `—`, payload as `csvCell(JSON.stringify(payload))`. Filename `${key}-审计记录.csv`.

- [ ] **Step 3: Run and commit**

Run: `cd enterprise_server && npx vitest run tests/analytics/auditExport.test.ts`
Expected: PASS, 5 tests.

```bash
git add enterprise_server/src/routes/admin/audit.ts enterprise_server/tests/analytics/auditExport.test.ts
git commit -m "feat(analytics): audit CSV export gated on audit:export

Chinese operation labels, em dashes for anonymous users and absent
targets, and real CSV escaping so a JSON payload cannot spill columns.
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: Streaming usage extraction in the proxy

This is the task the whole feature rests on. Without it the usage page's token columns are near-empty, because every OpenClaw gateway request sets `stream: true`.

**Files:**
- Create: `enterprise_server/src/proxy/streamUsage.ts`
- Modify: `enterprise_server/src/proxy/upstream.ts`
- Modify: `enterprise_server/src/proxy/providerProxy.ts`
- Modify: `enterprise_server/src/models/tokenUsage.ts`
- Test: `enterprise_server/tests/proxy/streamUsage.test.ts`
- Test: `enterprise_server/tests/proxy/proxyAccounting.test.ts`

**Interfaces:**
- Consumes: `stream_usage_supported` (Task 3), `usage_missing` (Task 3).
- Produces:
  ```ts
  // src/proxy/streamUsage.ts
  export interface UpstreamUsage { tokenIn: number; tokenOut: number; }
  export function withUsageTap(src: ReadableStream<Uint8Array>, onUsage: (u: UpstreamUsage) => void): ReadableStream<Uint8Array>;
  export async function streamUsageSupported(providerKeyId: string): Promise<boolean>;
  export async function markStreamUsageUnsupported(providerKeyId: string): Promise<void>;
  export function buildStreamBody(body: Record<string, unknown>, supported: boolean): Record<string, unknown>;
  ```
  And `tokenUsage.write` gains `usageMissing?: boolean`.

- [ ] **Step 1: Write the failing SSE-parsing test**

Create `enterprise_server/tests/proxy/streamUsage.test.ts`. Build a `ReadableStream` that emits an SSE response and assert on both the parsed value and the pass-through bytes:

```ts
function sseStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); },
  });
}

test('usage is parsed from the final SSE chunk', async () => {
  let got: UpstreamUsage | undefined;
  const src = sseStream(
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":34}}\n\n',
    'data: [DONE]\n\n',
  );
  await new Response(withUsageTap(src, (u) => { got = u; })).arrayBuffer();
  expect(got).toEqual({ tokenIn: 120, tokenOut: 34 });
});

test('a usage object split across two chunk boundaries is still parsed', async () => {  // Review Focus #5
  let got: UpstreamUsage | undefined;
  const src = sseStream(
    'data: {"choices":[],"usage":{"prompt_to',
    'kens":7,"completion_tokens":9}}\n\ndata: [DONE]\n\n',
  );
  await new Response(withUsageTap(src, (u) => { got = u; })).arrayBuffer();
  expect(got).toEqual({ tokenIn: 7, tokenOut: 9 });
});

test('pass-through bytes are byte-for-byte identical to the source', async () => {
  const chunks = ['data: {"a":1}\n\n', 'data: {"b":2}\n\n', 'data: [DONE]\n\n'];
  const original = new TextDecoder().decode(
    new Uint8Array(await new Response(sseStream(...chunks)).arrayBuffer()),
  );
  const tapped = new TextDecoder().decode(
    new Uint8Array(await new Response(withUsageTap(sseStream(...chunks), () => {})).arrayBuffer()),
  );
  expect(tapped).toBe(original);
});

test('a stream with no usage chunk leaves the callback un-fired', ...)
test('malformed data lines do not throw', ...)
```

Run: `cd enterprise_server && npx vitest run tests/proxy/streamUsage.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 2: Implement `withUsageTap`**

A `TransformStream` that enqueues every chunk unchanged while accumulating a line buffer. On each flush, split the buffer on `/\n\n/`, keep the trailing partial, and for each complete SSE event scan its `data:` lines with `JSON.parse` in a `try/catch`; when a parsed object has a numeric `usage`, call `onUsage({ tokenIn: usage.prompt_tokens ?? 0, tokenOut: usage.completion_tokens ?? 0 })` and stop scanning further chunks. The line buffer is what makes the split-chunk case work; do not parse per raw chunk.

- [ ] **Step 3: Write the failing accounting test**

Create `enterprise_server/tests/proxy/proxyAccounting.test.ts`, driving `providerProxy` with a stubbed `callOpenAI`. Seed an org, user, provider key and model with no quota. Two cases:

```ts
test('a stream that never carries usage still records the call, flagged missing', ...)  // asserts token_usage has a row with usage_missing=true, total_tokens=0, result_code=200, and that an audit_events provider_call row exists
test('a stream carrying usage records the real token counts', ...)
test('the quota reservation path is unchanged', ...)   // a model with quota_per_user_per_day set, over-limit call → 429 and a token_usage row
```

Run: `cd enterprise_server && npx vitest run tests/proxy/proxyAccounting.test.ts`
Expected: FAIL — no row is written today.

- [ ] **Step 4: Make accounting unconditional**

In `providerProxy.ts`, hoist the usage values above the write and drop the `if (upstream.usage)` guard:

```ts
const usage = upstream.usage;                 // null for streams we could not parse
const tokenIn = usage?.tokenIn ?? 0;
const tokenOut = usage?.tokenOut ?? 0;
const usageMissing = usage === null;
```

Write `token_usage` and the `provider_call` audit event unconditionally, passing `usageMissing` and adding `"usage_missing": true` to the audit payload when set. Keep the quota-warning check where it is, now unconditional; `usageInWindow` simply will not include this call when the tokens are unknown.

Extend `tokenUsage.write`'s input with `usageMissing?: boolean` and include the column in the INSERT.

- [ ] **Step 5: Send `stream_options` and degrade once**

In `upstream.ts`, when `req.body.stream` is true, consult `streamUsageSupported(providerKeyId)`; if true, add `stream_options: { include_usage: true }` to the outgoing body. Wrap the streamed body in `withUsageTap`. On a 4xx response **while `stream_options` was sent**, retry once without it and call `markStreamUsageUnsupported(providerKeyId)` so later requests skip the failed round-trip.

`providerKeyId` must reach `callOpenAI` — thread it through `UpstreamRequest` (`src/proxy/upstream.ts`) from `model.provider_key_id`.

- [ ] **Step 6: Run and commit**

Run: `cd enterprise_server && npx vitest run tests/proxy/streamUsage.test.ts tests/proxy/proxyAccounting.test.ts`
Expected: PASS, 8 tests.

```bash
git add enterprise_server/src/proxy/streamUsage.ts enterprise_server/src/proxy/upstream.ts \
  enterprise_server/src/proxy/providerProxy.ts enterprise_server/src/models/tokenUsage.ts \
  enterprise_server/tests/proxy/streamUsage.test.ts enterprise_server/tests/proxy/proxyAccounting.test.ts
git commit -m "fix(proxy): account for streaming calls and extract their usage

stream:true made upstream.usage null by construction, so no token_usage
row and no provider_call audit event was written for the gateway traffic
this deployment actually generates.

Requests now ask for stream_options.include_usage and the response body
is teed through a TransformStream that parses the usage chunk while
passing the bytes through unchanged. A provider that rejects
stream_options is remembered so it costs one failed round-trip, not one
per request. Calls we still cannot account for are written with
usage_missing=true and surfaced by the analytics pages rather than
vanishing.
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 13: Web plumbing — clients, gate, nav, DeptDetail

**Files:**
- Modify: `enterprise_server/web/src/api/client.ts`
- Modify: `enterprise_server/web/src/api/usage.ts`
- Modify: `enterprise_server/web/src/api/audit.ts`
- Modify: `enterprise_server/web/src/auth/AuthGuard.tsx`
- Modify: `enterprise_server/web/src/components/Sidebar.tsx`
- Modify: `enterprise_server/web/src/components/DeptDetail.tsx`
- Modify: `enterprise_server/web/src/App.tsx`
- Create: `enterprise_server/web/src/analytics/range.ts`
- Delete: `enterprise_server/web/src/components/QuotaBar.tsx`
- Test: `enterprise_server/web/tests/pages/DeptDetail.test.tsx`

**Interfaces:**
- Consumes: all backend contracts from Tasks 7–11; `usePermissions()` from `web/src/auth/usePermissions.ts`.
- Produces:
  ```ts
  // web/src/api/client.ts
  export interface RawResponse { text: string; headers: Headers; }
  // ApiClient gains: getRawWithHeaders(path: string): Promise<RawResponse>;

  // web/src/analytics/range.ts  — the single declaration site for both key types
  export type UsageRangeKey = 'today'|'7d'|'30d'|'this_month'|'last_month';
  export type AuditRangeKey = UsageRangeKey | 'custom';
  export const USAGE_RANGE_KEYS: readonly UsageRangeKey[];
  export const AUDIT_RANGE_KEYS: readonly AuditRangeKey[];
  export function rangeOptionLabel(key: UsageRangeKey | AuditRangeKey): string;  // via t()

  // web/src/api/usage.ts  — imports UsageRangeKey from ../analytics/range
  export interface UsageModelsResponse { range: string; from: string; to: string; timezone: string;
    page: number; pageSize: number; total: number; unaccounted_calls: number;
    items: { provider: string; model: string; display_name: string; total_tokens: number; call_count: number }[]; }
  export interface UsageUsersResponse { page: number; pageSize: number; total: number; unaccounted_calls: number;
    items: { user_id: string; username: string; display_name: string|null; department_name: string|null;
             total_tokens: number; last_used_at: string|null }[]; }
  export interface UsageUserDetailResponse { user: {...}; daily: {date:string;tokens:number}[];
    by_model: {provider:string;model:string;display_name:string;tokens:number;pct:number}[];
    unaccounted_calls: number; }
  export const usageApi: { models(...); users(...); userDetail(userId, range); exportCsv(range, tab): Promise<RawResponse> };

  // web/src/api/audit.ts  — imports AuditRangeKey from ../analytics/range
  export interface AuditListResponse { page; pageSize; total; from; to;
    items: AuditListItem[]; facets: AuditFacets; }
  export const auditApi: { list(...); exportCsv(...): Promise<RawResponse> };
  ```

- [ ] **Step 1: Extend `getRaw` and add `getRawWithHeaders`**

In `web/src/api/client.ts`, add `getRawWithHeaders(path: string): Promise<RawResponse>` returning `{ text: await res.text(), headers: res.headers }`; reimplement `getRaw` as `(await apiClient.getRawWithHeaders(path)).text` so there is one fetch path. Add the type to the `ApiClient` interface.

- [ ] **Step 2: Rewrite the two API clients**

`usage.ts` and `audit.ts` become thin typed wrappers over the response interfaces above. Every method takes the `range` key and sends it verbatim — **no client-side date math**. `exportCsv` returns `RawResponse` so the caller can read `x-export-count`.

- [ ] **Step 3: Switch the two routes to the permission gate**

`AuthGuard` currently takes a `requires` role name. Extend it to also accept a permission point: when the value contains `:` treat it as a point and test it with `usePermissions().hasPermission`, otherwise keep the existing `hasCapability` path. While `useMe().loading` is true, render a spinner instead of redirecting — otherwise the gate flashes a redirect before `/me` resolves. In `App.tsx`, set `requires="usage:view"` on `/monitoring/usage` and `requires="audit:view"` on `/monitoring/audit`. In `Sidebar.tsx`, set the matching `requires` on the two items and reword `nav.groups.monitor`.

- [ ] **Step 4: Fix the DeptDetail regression**

`web/src/components/DeptDetail.tsx` calls `auditApi.list({ orgId, limit: 200 })` and filters client-side, which against the new contract would silently render at most 15 rows. Replace it with `auditApi.list({ range: '7d', targetType: 'dept', targetId: detail.id, page, pageSize: 15 })`, read `.items`, and add a small visible range selector plus pager to that tab so the user can see and change the window.

- [ ] **Step 5: Delete `QuotaBar.tsx`**

Confirm `grep -rn "QuotaBar" web/src` returns only its own definition and `UsagePage.tsx`; then delete it. `UsagePage.tsx` is rewritten wholesale in Tasks 14–15, so it is safe to delete the component first as long as no other file imports it.

- [ ] **Step 6: Write and run the DeptDetail regression test**

Create `web/tests/pages/DeptDetail.test.tsx` mocking `fetch` as `web/tests/smoke.test.tsx` does. Assert the audit tab issues a request whose query string contains `targetType=dept`, `targetId=<id>` and `range=7d`, and that it renders the rows from `.items`.

Run: `cd enterprise_server/web && npx vitest run tests/pages/DeptDetail.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add enterprise_server/web/src/api/client.ts enterprise_server/web/src/api/usage.ts \
  enterprise_server/web/src/api/audit.ts enterprise_server/web/src/auth/AuthGuard.tsx \
  enterprise_server/web/src/components/Sidebar.tsx enterprise_server/web/src/components/DeptDetail.tsx \
  enterprise_server/web/src/App.tsx enterprise_server/web/src/analytics/range.ts \
  enterprise_server/web/tests/pages/DeptDetail.test.tsx
git rm enterprise_server/web/src/components/QuotaBar.tsx
git commit -m "feat(web): analytics API clients, permission-point gate, DeptDetail fix

Reuses the existing usePermissions() rather than adding a JWT claim. The
gate waits on useMe().loading so it does not redirect before /me resolves.

DeptDetail pulled 200 audit rows and filtered client-side; against the
paged contract that would have silently rendered 15 rows, so it now asks
the server for targetType=dept&targetId=<id> over a visible range.
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 14: Usage page — range, models tab, gap notice

**Files:**
- Create: `enterprise_server/web/src/components/analytics/RangeSelect.tsx`
- Create: `enterprise_server/web/src/components/analytics/Pager.tsx`
- Create: `enterprise_server/web/src/components/analytics/GapNotice.tsx`
- Modify: `enterprise_server/web/src/pages/UsagePage.tsx`
- Modify: `enterprise_server/web/src/i18n.ts`
- Test: `enterprise_server/web/tests/pages/UsagePageModels.test.tsx`

**Interfaces:**
- Consumes: `usageApi.models`, `usageApi.exportCsv`, `rangeOptionLabel`, `RawResponse` (Task 13).
- Produces:
  ```tsx
  // RangeSelect.tsx
  export function RangeSelect(props: { value: UsageRangeKey | AuditRangeKey;
    onChange: (k: UsageRangeKey | AuditRangeKey) => void; allowCustom?: boolean }): JSX.Element;
  // Pager.tsx
  export function Pager(props: { page: number; pageCount: number;
    onChange: (page: number) => void; summary?: string }): JSX.Element;
  // GapNotice.tsx
  export function GapNotice(props: { count: number }): JSX.Element;
  ```

- [ ] **Step 1: Write the failing test**

Create `web/tests/pages/UsagePageModels.test.tsx`, stubbing `fetch` and seeding a `usageApi.models` response of two rows plus `unaccounted_calls: 0`. Assert: the range selector renders 今天/近 7 天/近 30 天/本月/上月; the models table shows provider, name, tokens and call count; `共 2 个模型 · 统计范围：近 7 天` appears in the footer; and no page contains the strings 配额, 额度 or 使用率.

Add a second case with `unaccounted_calls: 37` asserting `GapNotice` renders, and one with `0` asserting it does not.

Run: `cd enterprise_server/web && npx vitest run tests/pages/UsagePageModels.test.tsx`
Expected: FAIL.

- [ ] **Step 2: Add the i18n keys**

Add `analytics.*` keys to **both** `en` and `zh` in `web/src/i18n.ts` for: page title, subtitle, the five range labels, both tab labels, the four model columns, the three user columns, the footer template, the drawer subtitle, empty states, the gap notice, the export button and both toast messages. Chinese text follows the spec's wording; English is the translation. `rangeOptionLabel` maps each key to `t('analytics.range.<key>')`.

- [ ] **Step 3: Build `RangeSelect`, `Pager`, `GapNotice`**

`RangeSelect` is a native `<select>` styled to match the existing controls. `Pager` renders prev/next buttons with `disabled` at the boundaries and shows `page / pageCount` centred, with an optional `summary` line. `GapNotice` renders a neutral (not error-coloured) strip: `本周期内 {count} 次调用未能取得 token 统计，实际用量可能偏低`.

- [ ] **Step 4: Implement the models tab**

`UsagePage` owns `range` (default `'7d'`), `tab`, `page`, `pageSize` (default 50) and `drawerUserId`. Query keys are `['usage','models',orgId,range,page]`. Changing `range` or `tab` resets `page` to 1 and clears `drawerUserId` (the drawer closes). The footer count comes from `response.total`, so it agrees with the CSV by construction.

The export button calls `usageApi.exportCsv(range, 'models')`, downloads via `Blob` + `URL.createObjectURL`, and toasts `已导出 {count} 条用量记录（{label}）` using `x-export-count`.

- [ ] **Step 5: Run and commit**

Run: `cd enterprise_server/web && npx vitest run tests/pages/UsagePageModels.test.tsx`
Expected: PASS.

```bash
git add enterprise_server/web/src/components/analytics/RangeSelect.tsx \
  enterprise_server/web/src/components/analytics/Pager.tsx \
  enterprise_server/web/src/components/analytics/GapNotice.tsx \
  enterprise_server/web/src/pages/UsagePage.tsx enterprise_server/web/src/i18n.ts \
  enterprise_server/web/tests/pages/UsagePageModels.test.tsx
git commit -m "feat(web): usage page range selector and models tab

Chinese-primary i18n keys for the whole page in both dictionaries. The
footer count comes from the response total so it agrees with the CSV.
No quota wording appears anywhere on the page.
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 15: Usage page — user tab, drawer, charts

**Files:**
- Create: `enterprise_server/web/src/components/analytics/DailyBarChart.tsx`
- Create: `enterprise_server/web/src/components/analytics/ModelShareBars.tsx`
- Create: `enterprise_server/web/src/components/analytics/UsageDrawer.tsx`
- Modify: `enterprise_server/web/src/pages/UsagePage.tsx`
- Modify: `enterprise_server/web/src/i18n.ts`
- Test: `enterprise_server/web/tests/pages/UsagePageUsers.test.tsx`

**Interfaces:**
- Consumes: `usageApi.users`, `usageApi.userDetail` (Task 13), `Pager` (Task 14).
- Produces:
  ```tsx
  export function DailyBarChart(props: { days: {date:string;tokens:number}[] }): JSX.Element;
  export function ModelShareBars(props: { rows: {display_name:string;tokens:number;pct:number}[] }): JSX.Element;
  export function UsageDrawer(props: { userId: string; range: UsageRangeKey;
    onClose: () => void }): JSX.Element;
  ```

- [ ] **Step 1: Write the failing tests**

Create `web/tests/pages/UsagePageUsers.test.tsx` covering:

```ts
test('the member list renders a row for a member with zero usage and an em dash for last used')
test('search sends the q parameter and resets to page 1')
test('the previous button is disabled on page 1 and next on the last page')
test('changing the range closes an open drawer')
test('the drawer shows one bar slot per day in the range and draws no bar for a zero day')
test('a member with no calls shows both empty states, not a bare axis')     // Review Focus #1
test('the drawer closes on Escape and on mask click')
```

Run: `cd enterprise_server/web && npx vitest run tests/pages/UsagePageUsers.test.tsx`
Expected: FAIL.

- [ ] **Step 2: Implement the user tab**

Five columns — member (surname initial in a role-coloured circle, `display_name` falling back to `username`), department, usage, last used (`MM/DD HH:mm`, `—` when null), and a 查看明细 link. Search is a debounced input over `display_name`/`username`; it resets `page` to 1. Sort select is `desc`/`asc`. `pageSize` is 8.

- [ ] **Step 3: Implement the charts**

`DailyBarChart` draws one bar slot per entry of `daily`, skipping the rect when `tokens === 0` but keeping the slot, with dashed gridlines and y-axis ticks rounded to 1/2/5 × 10ⁿ. x labels are `MM/DD` for every day when there are ≤ 10 slots, otherwise every fifth. `ModelShareBars` renders one row per entry: name, proportional bar, `数值 · 占比 %`.

- [ ] **Step 4: Implement `UsageDrawer`**

860px wide, `max-width: calc(100vw - 60px)`, right-anchored, mask behind it, closing on ✕, mask click and Escape. Header shows the avatar and name with the subtitle `{范围}用量与每日趋势 · {部门}`, dropping the separator when the department is null. Both chart sections render an empty-state line instead of a chart when they have no rows. `GapNotice` also renders here when the detail response's `unaccounted_calls` is non-zero.

- [ ] **Step 5: Add the remaining i18n keys**

Add the user-tab, drawer and chart strings to both dictionaries.

- [ ] **Step 6: Run and commit**

Run: `cd enterprise_server/web && npx vitest run tests/pages/UsagePageUsers.test.tsx`
Expected: PASS, 7 tests.

```bash
git add enterprise_server/web/src/components/analytics/DailyBarChart.tsx \
  enterprise_server/web/src/components/analytics/ModelShareBars.tsx \
  enterprise_server/web/src/components/analytics/UsageDrawer.tsx \
  enterprise_server/web/src/pages/UsagePage.tsx enterprise_server/web/src/i18n.ts \
  enterprise_server/web/tests/pages/UsagePageUsers.test.tsx
git commit -m "feat(web): usage member tab, drawer and SVG charts

Hand-rolled SVG per the no-chart-library constraint. The daily chart
keeps a slot for every day in the range but draws no bar at zero, and a
member with no calls gets an empty state rather than an empty axis.
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 16: Audit page

**Files:**
- Create: `enterprise_server/web/src/components/analytics/PayloadModal.tsx`
- Modify: `enterprise_server/web/src/pages/AuditPage.tsx`
- Modify: `enterprise_server/web/src/i18n.ts`
- Test: `enterprise_server/web/tests/pages/AuditPage.test.tsx`

**Interfaces:**
- Consumes: `auditApi.list`, `auditApi.exportCsv`, `auditActionMeta` (mirror), `auditTargetTypeMeta` labels from the response, `RangeSelect` / `Pager` (Task 14).
- Produces: `export function PayloadModal(props: { item: AuditListItem; onClose: () => void }): JSX.Element;`

- [ ] **Step 1: Write the failing tests**

Create `web/tests/pages/AuditPage.test.tsx` covering:

```ts
test('the six columns render, with the user column showing a name rather than an id')
test('an anonymous event shows an em dash in the user column')
test('an unregistered action code renders as the raw code instead of blank')   // Review Focus #2
test('the three facet selects populate from the response facets')
test('changing any filter resets to page 1')
test('the four filters stack and all appear in the request query string')
test('the payload modal shows formatted JSON from the already-loaded row and issues no second request')
test('the modal closes on Escape and on mask click')
test('an empty result shows the no-records message')
test('the custom range reveals two date inputs')
test('export toasts the count from x-export-count')
```

Run: `cd enterprise_server/web && npx vitest run tests/pages/AuditPage.test.tsx`
Expected: FAIL.

- [ ] **Step 2: Implement the list**

Six columns per spec §6.3. The action badge renders `action_zh` and maps the six-value `AuditTone` onto the five-value `BadgeTone` from `web/src/components/Badge.tsx` — `success`→`success`, `danger`→`danger`, `failure`→`danger`, `change`→`warning`, `auth`→`info`, `normal`→`neutral`. Export that mapping as a `const TONE_TO_BADGE: Record<AuditTone, BadgeTone>` rather than inlining it, so the two-tone collapse of `failure`/`danger` is visible in one place. Because the badge always carries text, colour is never the only signal. The payload cell renders a truncated single-line summary and opens the modal on click.

- [ ] **Step 3: Implement `PayloadModal`**

Takes the `AuditListItem` object directly — it must not refetch. Metadata block (time, user, action name, target type, target id) plus `JSON.stringify(item.payload, null, 2)` in a scrollable monospace block. Closes on ✕, mask and Escape.

- [ ] **Step 4: Add the remaining i18n keys**

Both dictionaries, `analytics.audit.*`.

- [ ] **Step 5: Run the whole web suite and commit**

Run: `cd enterprise_server && npm run web:test`
Expected: PASS, all files green.

```bash
git add enterprise_server/web/src/components/analytics/PayloadModal.tsx \
  enterprise_server/web/src/pages/AuditPage.tsx enterprise_server/web/src/i18n.ts \
  enterprise_server/web/tests/pages/AuditPage.test.tsx
git commit -m "feat(web): audit page with facet filters and payload modal

Filters server-side and reset to page 1 on change. The payload modal
renders from the row already in memory, so the summary and the detail
can never disagree.
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 17: Full verification

**Files:** none.

**Interfaces:**
- Consumes: everything.
- Produces: a verified branch.

- [ ] **Step 1: Backend suite**

Run: `cd enterprise_server && npm test 2>&1 | grep -E "Test Files|Tests "`
Expected: the only failures are `tests/routes/shareDeployments.test.ts` and `tests/routes/sso.desktop.test.ts`.

- [ ] **Step 2: Web suite**

Run: `cd enterprise_server && npm run web:test 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 3: Type checks**

Run: `cd enterprise_server && npx tsc -p tsconfig.build.json --noEmit`
Expected: no errors.

Run: `cd enterprise_server/web && npx tsc --project tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 4: Lint the changed files**

Run: `cd /Users/paulwang/work/MixCWork && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 $(git diff --name-only main...HEAD | grep -E '\.tsx?$' | tr '\n' ' ')`
Expected: clean. Do not add broad `eslint-disable` comments to get there.

- [ ] **Step 5: Review Focus sweep**

Confirm each of the five Review Focus items is pinned by a test that actually runs:

```bash
cd enterprise_server && npx vitest run tests/analytics tests/proxy
```

Expected: green. If any Review Focus line has no matching test, add it before finishing.

- [ ] **Step 6: Manual smoke**

Run `npm run web:dev` against a server with `npm run dev`, load `/monitoring/usage`, switch ranges and tabs, open and close a drawer, export a CSV and open it in Excel. Load `/monitoring/audit`, stack filters, open a payload, export. Confirm no console errors and no quota wording on the usage page.

- [ ] **Step 7: Commit any fixes**

```bash
git commit -m "fix(analytics): address verification findings"
```