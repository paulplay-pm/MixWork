# Model Provider Capability — P0: Data Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the server a place to store vendor cards and a per-type default model, and move the media/ASR model lists into `model_catalog` so every model in the org lives in one table.

**Architecture:** Two new migrations add `provider_cards` (+ `provider_keys.card_id`), `model_catalog.parameter_spec`, `model_catalog.created_at`, and `model_type_defaults`, and backfill the existing rows. A new `providerCards` model + admin route family expose the cards; a new `modelTypeDefaults` model exposes the default marker. Because the media models now live in `model_catalog`, the two read paths that feed the desktop's *chat* model picker get a type filter so media models cannot leak into it.

**Tech Stack:** TypeScript, Hono, Postgres (pglite in tests), Vitest, Zod.

**Spec:** `docs/superpowers/specs/2026-10-25-model-provider-capability-design.md` (the plan argues from the spec, so the spec travels with it; executors read both)

**Phase order:** P0 (this plan) → P2 (`…-p2-server-routing.md`) → P1 (`…-p1-console-ui.md`).

---

## Global Constraints

- **Migration files are immutable once applied.** The ledger keys on the file NAME (`src/db/migrate.ts`), so a schema change needs a NEW numbered file. 058 and 059 are new files; do not edit 001–057.
- **Migrations are plain SQL only.** The production runner splits on `/;\s*(?:\n|$)/` (`splitStatements` in `src/db/migrate.ts`), so a `$$ … ; … $$` PL/pgSQL body is cut apart mid-statement. Use window functions and `INSERT … SELECT` instead.
- **Migrations must be re-runnable** — the runner replays every file against pglite on each test `resetSchema()`. Use `IF NOT EXISTS` / `ON CONFLICT DO NOTHING` throughout.
- **`model_catalog` uniqueness is `(org_id, provider_key_id, model)`** (migration 039's `model_catalog_org_key_model` index). Every `INSERT` into `model_catalog` must name that conflict target.
- **The legacy `model_catalog.type` column has a 6-value CHECK**: `('chat','reasoning','vision','embedding','image','audio')`. `video-gen` has no legacy value — map it to `'image'`.
- **Cross-tenant guard:** every admin route compares the request's `orgId` against `claims.orgId` and returns `400 { error: 'org_mismatch' }` on mismatch.
- **Permission points:** `PP.ProviderView` for reads, `PP.ProviderEdit` for writes, `PP.ModelView` / `PP.ModelEdit` for models. No new permission points.
- **Do not change the desktop client in this phase.** P0 is server-only plus the server's own read-path filters. The desktop keeps talking to the same endpoints; the filters are no-ops for the current 30 chat models.
- **Do not DELETE `provider_keys.config.models` / `config.model`.** They stay (rollback insurance) and they are still WRITTEN: the console that ships with P0 and P2 still edits media models through the legacy one-id-per-line text field, so Task P0-7 dual-writes them into `model_catalog` and the catalog never drifts from what the admin sees. The P1 phase removes the legacy field and the dual-write together.

---

## Review Focus

Five input classes the spec implies but no task's tests obviously exercise. Each one gets a test in the task that owns the code.

1. **A brand-new org with zero `provider_keys` rows.** The backfill must not create a card, and `provider_cards` must stay empty — a card whose slug has no rows would show up in the console as an empty vendor.
2. **Two `provider_keys` rows with the same `(org, provider, protocol)`, both custom, neither built-in.** The slot ordering must still split them into two cards, and the *second* one must get a distinct limited-name prefix — otherwise two cards would share the prefix `minimax` and the media route could not tell their models apart.
3. **A media model whose `config.models[]` entry has an empty `modelId`.** The backfill must skip it, not insert a row with an empty model name (which would then be un-deletable from the UI and would match every bare-model request).
4. **A `provider_keys` row whose `config` is `NULL` vs `'{}'`.** The media backfill must treat both as "no models" — `config->'models'` on a NULL `config` yields NULL, and `jsonb_array_elements(NULL)` raises instead of returning zero rows.
5. **A model whose `types` array is empty** (`ARRAY[]::text[]`). The desktop type filter uses `types && ARRAY['chat','vision','reasoning']`; an empty array must NOT match (it is not a session model) and must not error.

---

## File Structure

| File | Responsibility |
|---|---|
| `enterprise_server/src/db/migrations/058_provider_cards.sql` | `provider_cards` table, `provider_keys.card_id`, prefix unique index, backfill |
| `enterprise_server/src/db/migrations/059_model_catalog_media.sql` | `model_catalog.parameter_spec` + `created_at`, `model_type_defaults` table, media/ASR model backfill |
| `enterprise_server/src/models/providerCards.ts` | Card reads/writes + the section list a card is made of |
| `enterprise_server/src/models/modelTypeDefaults.ts` | The per-type default model pointer |
| `enterprise_server/src/models/legacyMediaModels.ts` | Bridge: mirrors the legacy `config.models` / `config.model` into the catalog (removed in P1) |
| `enterprise_server/src/models/modelCatalog.ts` | `parameter_spec` in the column lists; `listEnabledByTypes()` for the media/ASR read paths |
| `enterprise_server/src/routes/admin/providerCards.ts` | `/admin/provider-cards` CRUD |
| `enterprise_server/src/routes/admin/providerKeys.ts` | Accept `cardId` on create; dual-write `config.models` into the catalog |
| `enterprise_server/src/routes/admin/models.ts` | Accept `defaultForType` on patch |
| `enterprise_server/src/routes/admin/catalog.ts` | Type filter on the desktop's catalog |
| `enterprise_server/src/models/enterpriseModels.ts` | Type filter on the desktop's model picker |
| `enterprise_server/src/routes/models.ts` | Type filter on the user-facing model list |
| `enterprise_server/src/shared/auditTargetTypeMeta.ts` | `provider_card` target type (zh + en) |
| `enterprise_server/src/org/builtinProviders.ts` | Seed a card for each built-in provider |

---

### Task P0-1: Migration 058 — `provider_cards` and the backfill

**Files:**
- Create: `enterprise_server/src/db/migrations/058_provider_cards.sql`
- Test: `enterprise_server/tests/db/migrate058.test.ts`

**Interfaces:**
- Consumes: `provider_keys (id, org_id, provider, protocol, is_builtin, created_at)` — all exist today.
- Produces:
  - Table `provider_cards (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, provider TEXT NOT NULL, label TEXT, created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`.
  - Unique index `provider_cards_org_prefix` on `(org_id, COALESCE(label, provider))`.
  - Column `provider_keys.card_id TEXT NULL REFERENCES provider_cards(id) ON DELETE SET NULL`.
  - Backfill contract: every `provider_keys` row ends with a non-NULL `card_id`; the id is exactly `'card:' || md5(org_id || ':' || provider || ':' || slot)` where `slot = ROW_NUMBER() OVER (PARTITION BY org_id, provider, protocol ORDER BY is_builtin DESC, created_at ASC, id ASC) - 1`.
  - Card label rule: `slot = 0` → `NULL`; `slot > 0` → `provider || ' #' || (slot + 1)`.

- [ ] **Step 1: Write the failing test**

Create `enterprise_server/tests/db/migrate058.test.ts`:

```ts
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test } from 'vitest';

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

const MIGRATION_058 = '058_provider_cards.sql';

async function seedOrg(): Promise<void> {
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','T') ON CONFLICT DO NOTHING`);
  await testPool.query(
    `INSERT INTO users(id,org_id,username,password_hash) VALUES ('u1','o1','u1','x') ON CONFLICT DO NOTHING`,
  );
}

async function seedKey(
  id: string,
  provider: string,
  protocol: string,
  opts: { builtin?: boolean; createdAt?: string; label?: string } = {},
): Promise<void> {
  await testPool.query(
    `INSERT INTO provider_keys(id, org_id, provider, protocol, is_builtin, created_at, label)
     VALUES ($1,'o1',$2,$3,$4,COALESCE($5::timestamptz, now()),$6)`,
    [id, provider, protocol, opts.builtin ?? false, opts.createdAt ?? null, opts.label ?? null],
  );
}

async function cardIdOf(keyId: string): Promise<string | null> {
  const r = await testPool.query<{ card_id: string | null }>(
    `SELECT card_id FROM provider_keys WHERE id = $1`,
    [keyId],
  );
  return r.rows[0]?.card_id ?? null;
}

describe('db/migrate 058 (provider_cards)', () => {
  beforeEach(async () => {
    await resetSchema();
  });

  test('每行 provider_keys 都拿到 card_id', async () => {
    await runMigrations();
    await seedOrg();
    await seedKey('k1', 'minimax', 'openai');
    await seedKey('k2', 'minimax', 'image-gen');
    expect(await cardIdOf('k1')).not.toBeNull();
    expect(await cardIdOf('k2')).not.toBeNull();
  });

  test('同厂商不同协议的行落在同一张卡片', async () => {
    await runMigrations();
    await seedOrg();
    await seedKey('k1', 'minimax', 'openai');
    await seedKey('k2', 'minimax', 'image-gen');
    expect(await cardIdOf('k1')).toBe(await cardIdOf('k2'));
  });

  test('同厂商同协议的两行落在不同卡片，且第二张有独立前缀', async () => {
    await runMigrations();
    await seedOrg();
    await seedKey('k1', 'minimax', 'openai', { builtin: true, createdAt: '2026-01-01' });
    await seedKey('k2', 'minimax', 'openai', { createdAt: '2026-02-01' });
    const a = await cardIdOf('k1');
    const b = await cardIdOf('k2');
    expect(a).not.toBe(b);
    const rows = await testPool.query<{ label: string | null }>(
      `SELECT label FROM provider_cards WHERE id = ANY($1::text[]) ORDER BY label NULLS FIRST`,
      [[a, b]],
    );
    // slot 0 → label NULL; slot 1 → 'minimax #2'
    expect(rows.rows[0].label).toBeNull();
    expect(rows.rows[1].label).toBe('minimax #2');
  });

  test('没有任何 provider_keys 时不产生卡片', async () => {
    await runMigrations();
    await seedOrg();
    const r = await testPool.query(`SELECT count(*)::int AS n FROM provider_cards`);
    expect(r.rows[0].n).toBe(0);
  });

  test('重复执行不报错（幂等）', async () => {
    await runMigrations();
    await runMigrations();
    await seedOrg();
    await seedKey('k1', 'minimax', 'openai');
    const r = await testPool.query(
      `SELECT count(*)::int AS n FROM provider_cards WHERE id = 'card:' || md5('o1:minimax:0')`,
    );
    expect(r.rows[0].n).toBe(1);
  });

  test('已应用 057 的旧库，补跑 058 后行才拿到 card_id', async () => {
    await runMigrations({ exclude: [MIGRATION_058] });
    await seedOrg();
    await seedKey('k1', 'minimax', 'openai');
    expect(await cardIdOf('k1')).toBeNull();
    await runMigrations();
    expect(await cardIdOf('k1')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/db/migrate058.test.ts`
Expected: FAIL — `relation "provider_cards" does not exist` (and `column "card_id" does not exist`).

- [ ] **Step 3: Write the migration**

Create `enterprise_server/src/db/migrations/058_provider_cards.sql`:

```sql
-- Migration 058: vendor cards.
--
-- A CARD is one vendor. A SECTION is one capability of that vendor, and it
-- is one `provider_keys` row (the row's `protocol` says which upstream wire
-- the section speaks). Today the console lists `provider_keys` rows, so one
-- vendor occupies several rail entries (MiniMax alone is openai /
-- realtime-asr / image-gen / video-gen). This table gives those rows a
-- grouping identity.
--
-- WHY A TABLE AND NOT "GROUP BY provider": a built-in `deepseek` key and a
-- custom `deepseek` key are the same vendor slug, and migration 039 exists
-- precisely so both can coexist. Grouping by slug would merge them into one
-- card, and a card's LLM section single-selects its protocol — two openai
-- credentials in one card cannot be expressed. An explicit `card_id` makes
-- "these rows belong to one vendor" a stored fact instead of a guess.
--
-- The backfill assigns each row a SLOT: within (org, provider, protocol) the
-- rows are ordered by (is_builtin DESC, created_at ASC, id ASC) and numbered
-- from 0. Rows sharing a slot across different protocols land in ONE card
-- (MiniMax's four protocols are all slot 0 → one card); two rows of the same
-- protocol get different slots → different cards. This keeps the invariant
-- "a card never holds two sections of the same protocol".
--
-- Plain SQL only: the migration runner splits statements on `;\s*\n`, so a
-- PL/pgSQL body would be cut apart. Window functions do the ordering.
--
-- The unique index is on (org_id, COALESCE(label, provider)) — the
-- LIMITED-NAME PREFIX, not (slug, label). The media wire format addresses a
-- model as `<prefix>/<model>`, so the prefix has to be unique per org; a
-- (slug, label) index would still let "provider=minimax, label=NULL" and
-- "provider=minimax, label=minimax" produce the same prefix.

CREATE TABLE IF NOT EXISTS provider_cards (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL,
  label      TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_cards_org_prefix
  ON provider_cards (org_id, COALESCE(label, provider));

ALTER TABLE provider_keys
  ADD COLUMN IF NOT EXISTS card_id TEXT REFERENCES provider_cards(id) ON DELETE SET NULL;

-- One card per (org, provider, slot).
INSERT INTO provider_cards (id, org_id, provider, label, created_by, created_at)
SELECT
  'card:' || md5(g.org_id || ':' || g.provider || ':' || g.slot),
  g.org_id,
  g.provider,
  CASE WHEN g.slot = 0 THEN NULL ELSE g.provider || ' #' || (g.slot + 1) END,
  NULL,
  MIN(g.created_at)
FROM (
  SELECT
    pk.org_id, pk.provider, pk.protocol, pk.created_at,
    (ROW_NUMBER() OVER (
       PARTITION BY pk.org_id, pk.provider, pk.protocol
       ORDER BY pk.is_builtin DESC, pk.created_at ASC, pk.id ASC
     ) - 1) AS slot
  FROM provider_keys pk
) g
GROUP BY g.org_id, g.provider, g.slot
ON CONFLICT (id) DO NOTHING;

-- Point every key at its card.
UPDATE provider_keys pk
SET card_id = c.card_id
FROM (
  SELECT
    pk2.id,
    'card:' || md5(pk2.org_id || ':' || pk2.provider || ':' || (
      ROW_NUMBER() OVER (
        PARTITION BY pk2.org_id, pk2.provider, pk2.protocol
        ORDER BY pk2.is_builtin DESC, pk2.created_at ASC, pk2.id ASC
      ) - 1)) AS card_id
  FROM provider_keys pk2
) c
WHERE pk.id = c.id AND pk.card_id IS NULL;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/db/migrate058.test.ts`
Expected: PASS — 6/6.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/db/migrations/058_provider_cards.sql enterprise_server/tests/db/migrate058.test.ts
git commit -m "feat(db): add provider_cards and backfill provider key grouping"
```

---

### Task P0-2: Migration 059 — unified media models and per-type defaults

**Files:**
- Create: `enterprise_server/src/db/migrations/059_model_catalog_media.sql`
- Test: `enterprise_server/tests/db/migrate059.test.ts`

**Interfaces:**
- Consumes: `provider_keys.config JSONB` (holds `models[]` and `model`), `model_catalog (id, org_id, provider_key_id, provider, model, display_name, type, types, enabled)`.
- Produces:
  - `model_catalog.parameter_spec JSONB NOT NULL DEFAULT '{}'::jsonb`.
  - `model_catalog.created_at TIMESTAMPTZ NOT NULL DEFAULT now()`.
  - Table `model_type_defaults (org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, type TEXT NOT NULL, model_id TEXT NOT NULL REFERENCES model_catalog(id) ON DELETE CASCADE, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (org_id, type))`.
  - Backfill contract:
    - Every entry of `provider_keys.config.models[]` on an `image-gen` / `video-gen` key becomes a `model_catalog` row with `types = ['image-gen']` / `['video-gen']`, `type = 'image'`, `parameter_spec` = the entry's `parameterSpec` (or `{}`), `id = 'm:' || md5(org_id || ':' || key_id || ':' || model)`, `created_at` = the key's `created_at`.
    - Every `realtime-asr` key gets a `model_catalog` row for `COALESCE(config->>'model', 'asr-1.0')` with `types = ['asr']`, `type = 'audio'` (created only if that model is not already there).
    - The EARLIEST `realtime-asr` key per org owns the `asr` default: one `model_type_defaults` row `(org_id, 'asr', <that model id>)`.

- [ ] **Step 1: Write the failing test**

Create `enterprise_server/tests/db/migrate059.test.ts`:

```ts
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test } from 'vitest';

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

const MIGRATION_059 = '059_model_catalog_media.sql';

async function seedOrg(): Promise<void> {
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','T') ON CONFLICT DO NOTHING`);
  await testPool.query(
    `INSERT INTO users(id,org_id,username,password_hash) VALUES ('u1','o1','u1','x') ON CONFLICT DO NOTHING`,
  );
}

async function seedKey(id: string, protocol: string, config: unknown): Promise<void> {
  await testPool.query(
    `INSERT INTO provider_keys(id, org_id, provider, protocol, config)
     VALUES ($1,'o1','minimax',$2,$3::jsonb)`,
    [id, protocol, JSON.stringify(config)],
  );
}

describe('db/migrate 059 (media models into model_catalog + model_type_defaults)', () => {
  beforeEach(async () => {
    await resetSchema();
  });

  test('图像生成模型从 config.models 进入 model_catalog', async () => {
    await runMigrations();
    await seedOrg();
    await seedKey('k-img', 'image-gen', {
      models: [
        { modelId: 'image-01', displayName: 'image-01' },
        { modelId: 'image-01-live', displayName: 'live', parameterSpec: { size: '1024x1024' } },
      ],
    });
    const r = await testPool.query<{ model: string; types: string[]; type: string; parameter_spec: unknown }>(
      `SELECT model, types, type, parameter_spec FROM model_catalog WHERE provider_key_id = 'k-img' ORDER BY model`,
    );
    expect(r.rows.map((x) => x.model)).toEqual(['image-01', 'image-01-live']);
    expect(r.rows[0].types).toEqual(['image-gen']);
    expect(r.rows[0].type).toBe('image');
    expect(r.rows[1].parameter_spec).toEqual({ size: '1024x1024' });
  });

  test('视频生成模型的 types 是 video-gen，legacy type 是 image', async () => {
    await runMigrations();
    await seedOrg();
    await seedKey('k-vid', 'video-gen', { models: [{ modelId: 'MiniMax-H3' }] });
    const r = await testPool.query<{ types: string[]; type: string }>(
      `SELECT types, type FROM model_catalog WHERE provider_key_id = 'k-vid'`,
    );
    expect(r.rows[0].types).toEqual(['video-gen']);
    expect(r.rows[0].type).toBe('image');
  });

  test('语音识别分区补建默认模型行，并登记 asr 默认', async () => {
    await runMigrations();
    await seedOrg();
    await seedKey('k-asr', 'realtime-asr', {});
    const m = await testPool.query<{ id: string; model: string; types: string[] }>(
      `SELECT id, model, types FROM model_catalog WHERE provider_key_id = 'k-asr'`,
    );
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0].model).toBe('asr-1.0');
    expect(m.rows[0].types).toEqual(['asr']);
    const d = await testPool.query<{ type: string; model_id: string }>(
      `SELECT type, model_id FROM model_type_defaults WHERE org_id = 'o1'`,
    );
    expect(d.rows).toEqual([{ type: 'asr', model_id: m.rows[0].id }]);
  });

  test('config.model 指定了别的模型名时按它建行', async () => {
    await runMigrations();
    await seedOrg();
    await seedKey('k-asr', 'realtime-asr', { model: 'asr-2.0' });
    const m = await testPool.query<{ model: string }>(
      `SELECT model FROM model_catalog WHERE provider_key_id = 'k-asr'`,
    );
    expect(m.rows[0].model).toBe('asr-2.0');
  });

  test('空 modelId 的条目被跳过', async () => {
    await runMigrations();
    await seedOrg();
    await seedKey('k-img', 'image-gen', { models: [{ modelId: '' }, { modelId: 'image-01' }] });
    const r = await testPool.query(`SELECT model FROM model_catalog WHERE provider_key_id = 'k-img'`);
    expect(r.rows.map((x: { model: string }) => x.model)).toEqual(['image-01']);
  });

  test('config 为 NULL 的分区不产生模型行', async () => {
    await runMigrations();
    await seedOrg();
    await testPool.query(
      `INSERT INTO provider_keys(id, org_id, provider, protocol, config)
       VALUES ('k-null','o1','minimax','image-gen',NULL)`,
    );
    const r = await testPool.query(`SELECT count(*)::int AS n FROM model_catalog`);
    expect(r.rows[0].n).toBe(0);
  });

  test('一个类型只能有一个默认（主键约束）', async () => {
    await runMigrations();
    await seedOrg();
    await testPool.query(
      `INSERT INTO model_catalog(id, org_id, provider_key_id, provider, model, types)
       VALUES ('m1','o1','k-x','minimax','a',ARRAY['image-gen']),
              ('m2','o1','k-x','minimax','b',ARRAY['image-gen'])`,
    );
    await testPool.query(
      `INSERT INTO provider_keys(id, org_id, provider, protocol) VALUES ('k-x','o1','minimax','image-gen')`,
    );
    await testPool.query(
      `INSERT INTO model_type_defaults(org_id, type, model_id) VALUES ('o1','image-gen','m1')`,
    );
    await expect(
      testPool.query(
        `INSERT INTO model_type_defaults(org_id, type, model_id) VALUES ('o1','image-gen','m2')`,
      ),
    ).rejects.toThrow();
  });

  test('重复执行不报错（幂等）', async () => {
    await runMigrations();
    await runMigrations();
    await seedOrg();
    await seedKey('k-img', 'image-gen', { models: [{ modelId: 'image-01' }] });
    const r = await testPool.query(`SELECT count(*)::int AS n FROM model_catalog`);
    expect(r.rows[0].n).toBe(1);
  });

  test('已应用 058 的旧库，补跑 059 后媒体模型才出现', async () => {
    await runMigrations({ exclude: [MIGRATION_059] });
    await seedOrg();
    await seedKey('k-img', 'image-gen', { models: [{ modelId: 'image-01' }] });
    const before = await testPool.query(`SELECT count(*)::int AS n FROM model_catalog`);
    expect(before.rows[0].n).toBe(0);
    await runMigrations();
    const after = await testPool.query(`SELECT count(*)::int AS n FROM model_catalog`);
    expect(after.rows[0].n).toBe(1);
  });
});
```

> Note on the "one default per type" test: it inserts `model_catalog` rows BEFORE the `provider_keys` row it references, which violates the `provider_key_id` FK. Insert the key first — the ordering above is wrong. Write the test with the key insert first:
> ```ts
> await testPool.query(
>   `INSERT INTO provider_keys(id, org_id, provider, protocol) VALUES ('k-x','o1','minimax','image-gen')`,
> );
> await testPool.query(
>   `INSERT INTO model_catalog(id, org_id, provider_key_id, provider, model, types)
>    VALUES ('m1','o1','k-x','minimax','a',ARRAY['image-gen']),
>           ('m2','o1','k-x','minimax','b',ARRAY['image-gen'])`,
> );
> ```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/db/migrate059.test.ts`
Expected: FAIL — `relation "model_type_defaults" does not exist` / `column "parameter_spec" does not exist`.

- [ ] **Step 3: Write the migration**

Create `enterprise_server/src/db/migrations/059_model_catalog_media.sql`:

```sql
-- Migration 059: one model table for every model type + a per-type default.
--
-- 1. `parameter_spec` moves the media parameter spec out of
--    `provider_keys.config.models[].parameterSpec` and into the model row
--    where it belongs. The old JSONB stays on the key (rollback insurance)
--    but nothing reads it after this migration.
-- 2. `created_at` gives the model list a deterministic order. The fallback
--    chain ("the first enabled model of this type") needs a total order that
--    does not depend on the planner's row order.
-- 3. `model_type_defaults` is the per-type default pointer. It is a JOIN
--    TABLE, not a column on `model_catalog`, because one model can carry
--    several types (chat+vision) and can therefore be the default for more
--    than one of them — a partial unique index cannot express "one default
--    per element of a TEXT[]" (unnest is set-returning and cannot appear in
--    an index expression). The (org_id, type) PRIMARY KEY is the constraint.
--    The default is still DISPLAYED on the model_catalog row (see the spec).
-- 4. The backfill lifts the media/ASR model lists out of
--    `provider_keys.config` into `model_catalog`, so every model in the org
--    lives in one table and can be typed, enabled and defaulted.
--
-- Plain SQL only (the runner splits on `;\s*\n`).

ALTER TABLE model_catalog
  ADD COLUMN IF NOT EXISTS parameter_spec JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE model_catalog
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS model_type_defaults (
  org_id     TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  model_id   TEXT NOT NULL REFERENCES model_catalog(id) ON DELETE CASCADE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, type)
);

-- Media models: config.models[] → model_catalog rows.
-- `config` can be NULL, and `jsonb_array_elements(NULL)` raises instead of
-- returning zero rows, so coalesce it first.
INSERT INTO model_catalog (
  id, org_id, provider_key_id, provider, model, display_name,
  type, types, parameter_spec, enabled, created_at
)
SELECT
  'm:' || md5(k.org_id || ':' || k.id || ':' || m->>'modelId'),
  k.org_id,
  k.id,
  k.provider,
  m->>'modelId',
  COALESCE(NULLIF(m->>'displayName', ''), m->>'modelId'),
  'image',
  CASE WHEN k.protocol = 'video-gen' THEN ARRAY['video-gen'] ELSE ARRAY['image-gen'] END,
  COALESCE(m->'parameterSpec', '{}'::jsonb),
  true,
  k.created_at
FROM provider_keys k
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(k.config->'models', '[]'::jsonb)) AS m
WHERE k.protocol IN ('image-gen', 'video-gen')
  AND NULLIF(m->>'modelId', '') IS NOT NULL
ON CONFLICT (org_id, provider_key_id, model) DO NOTHING;

-- ASR: the adapter's model name lives in `config.model`; make it a real
-- catalog row so the ASR model list is the same shape as every other list.
INSERT INTO model_catalog (
  id, org_id, provider_key_id, provider, model, display_name,
  type, types, parameter_spec, enabled, created_at
)
SELECT
  'm:' || md5(k.org_id || ':' || k.id || ':' || COALESCE(k.config->>'model', 'asr-1.0')),
  k.org_id,
  k.id,
  k.provider,
  COALESCE(k.config->>'model', 'asr-1.0'),
  COALESCE(k.config->>'model', 'asr-1.0'),
  'audio',
  ARRAY['asr'],
  '{}'::jsonb,
  true,
  k.created_at
FROM provider_keys k
WHERE k.protocol = 'realtime-asr'
ON CONFLICT (org_id, provider_key_id, model) DO NOTHING;

-- The org's default ASR model: the earliest ASR key wins, so the choice is
-- stable rather than "whatever the planner returned first".
INSERT INTO model_type_defaults (org_id, type, model_id, updated_at)
SELECT DISTINCT ON (k.org_id)
  k.org_id, 'asr', c.id, now()
FROM provider_keys k
JOIN LATERAL (
  SELECT m.id
  FROM model_catalog m
  WHERE m.org_id = k.org_id
    AND m.provider_key_id = k.id
    AND m.model = COALESCE(k.config->>'model', 'asr-1.0')
  LIMIT 1
) c ON true
WHERE k.protocol = 'realtime-asr'
ORDER BY k.org_id, k.created_at ASC, k.id ASC
ON CONFLICT (org_id, type) DO NOTHING;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/db/migrate059.test.ts`
Expected: PASS — 9/9.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/db/migrations/059_model_catalog_media.sql enterprise_server/tests/db/migrate059.test.ts
git commit -m "feat(db): move media models into model_catalog and add per-type defaults"
```

---

### Task P0-3: The `providerCards` model and its admin routes

**Files:**
- Create: `enterprise_server/src/models/providerCards.ts`
- Create: `enterprise_server/src/routes/admin/providerCards.ts`
- Modify: `enterprise_server/src/routes/admin/providerKeys.ts` (accept `cardId` on create)
- Modify: `enterprise_server/src/shared/auditTargetTypeMeta.ts` (add `provider_card`)
- Test: `enterprise_server/tests/models/providerCards.test.ts`
- Test: `enterprise_server/tests/routes/providerCardsAdmin.test.ts`

**Interfaces:**
- Consumes: `provider_cards` + `provider_keys` (Task P0-1), `providerKeyVault.add/list`.
- Produces — `enterprise_server/src/models/providerCards.ts`:

```ts
export interface ProviderCardSection {
  providerKeyId: string;
  protocol: ProviderProtocol;
  endpoint: string | null;
  label: string | null;
  enabled: boolean;
  isBuiltin: boolean;
  codingPlan: boolean;
  apiKeyMasked: string | null;
  modelCount: number;
}

export interface ProviderCardView {
  id: string;
  provider: string;
  label: string | null;
  createdAt: string;
  /** True when any section of the card is a built-in provider key. */
  isBuiltin: boolean;
  /** The card's master switch: on when at least one section is enabled. */
  enabled: boolean;
  sections: ProviderCardSection[];
}

export const providerCards = {
  async list(orgId: string): Promise<ProviderCardView[]>;
  async getById(orgId: string, id: string): Promise<ProviderCardView | null>;
  async create(input: {
    orgId: string;
    provider: string;
    label?: string;
    createdBy?: string;
  }): Promise<{ id: string }>;
  async patch(
    orgId: string,
    id: string,
    fields: { label?: string | null; enabled?: boolean },
  ): Promise<boolean>;
  async remove(orgId: string, id: string): Promise<{ deletedKeys: number; deletedModels: number }>;
};
```

- Produces — routes in `enterprise_server/src/routes/admin/providerCards.ts`:
  - `GET /admin/provider-cards?orgId=` → `ProviderCardView[]`, permission `PP.ProviderView`.
  - `POST /admin/provider-cards` body `{ orgId, provider, label? }` → `{ id }`, permission `PP.ProviderEdit`.
  - `PATCH /admin/provider-cards/:id` body `{ label?, enabled? }` → `{ ok: true }`.
  - `DELETE /admin/provider-cards/:id` → `{ ok: true, deletedKeys, deletedModels }`.
  - `enabled: false` on PATCH disables **every** section of the card (`provider_keys.enabled = false`); `enabled: true` re-enables the sections that were enabled before the card was switched off (track them by `provider_keys.enabled` being restored to `true` only for rows whose key had a key — see the rule below).

    **Rule for re-enable:** a section comes back enabled when it has an API key (`api_key_masked IS NOT NULL`) OR it was enabled before the card was disabled. To keep this implementable without extra state, store the per-section enable state in `provider_keys.enabled` and, on card re-enable, set `enabled = true` for sections that have a key, `false` for keyless ones. State this rule in the route's doc comment.

- Produces — `POST /admin/provider-keys` accepts an optional `cardId`:
  - When `cardId` is present, the new key is attached to that card and inherits the card's `provider` slug. When absent, a card is created for the key's slug on the fly (one card per (slug, protocol) group, same slot rule as the 058 backfill) so every key always belongs to a card.

- [ ] **Step 1: Write the failing model test**

Create `enterprise_server/tests/models/providerCards.test.ts`:

```ts
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { providerCards } from '../../src/models/providerCards';

async function seedOrg(): Promise<void> {
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','T') ON CONFLICT DO NOTHING`);
  await testPool.query(
    `INSERT INTO users(id,org_id,username,password_hash) VALUES ('u1','o1','u1','x') ON CONFLICT DO NOTHING`,
  );
}

describe('models/providerCards', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await seedOrg();
  });

  test('新建一张卡片', async () => {
    const { id } = await providerCards.create({ orgId: 'o1', provider: 'minimax' });
    const card = await providerCards.getById('o1', id);
    expect(card?.provider).toBe('minimax');
    expect(card?.label).toBeNull();
    expect(card?.sections).toEqual([]);
  });

  test('同厂商同前缀再建一张卡片会被拒绝', async () => {
    await providerCards.create({ orgId: 'o1', provider: 'minimax' });
    await expect(
      providerCards.create({ orgId: 'o1', provider: 'minimax' }),
    ).rejects.toThrow(/card_duplicate/);
  });

  test('同厂商不同显示名可以并存', async () => {
    await providerCards.create({ orgId: 'o1', provider: 'minimax' });
    const { id } = await providerCards.create({ orgId: 'o1', provider: 'minimax', label: 'MiniMax 备份' });
    const card = await providerCards.getById('o1', id);
    expect(card?.label).toBe('MiniMax 备份');
  });

  test('卡片总开关关掉后所有分区都停用', async () => {
    const { id } = await providerCards.create({ orgId: 'o1', provider: 'minimax' });
    await testPool.query(
      `INSERT INTO provider_keys(id, org_id, provider, protocol, card_id, enabled, api_key_masked)
       VALUES ('k1','o1','minimax','openai',$1,true,'sk-***')`,
      [id],
    );
    await providerCards.patch('o1', id, { enabled: false });
    const card = await providerCards.getById('o1', id);
    expect(card?.enabled).toBe(false);
    expect(card?.sections[0].enabled).toBe(false);
  });

  test('删除卡片会连带删除分区和模型', async () => {
    const { id } = await providerCards.create({ orgId: 'o1', provider: 'minimax' });
    await testPool.query(
      `INSERT INTO provider_keys(id, org_id, provider, protocol, card_id, enabled)
       VALUES ('k1','o1','minimax','image-gen',$1,true)`,
      [id],
    );
    await testPool.query(
      `INSERT INTO model_catalog(id, org_id, provider_key_id, provider, model, types)
       VALUES ('m1','o1','k1','minimax','image-01',ARRAY['image-gen'])`,
    );
    const r = await providerCards.remove('o1', id);
    expect(r.deletedKeys).toBe(1);
    expect(r.deletedModels).toBe(1);
    const m = await testPool.query(`SELECT count(*)::int AS n FROM model_catalog`);
    expect(m.rows[0].n).toBe(0);
  });

  test('list 返回按厂商分组的分区', async () => {
    const { id } = await providerCards.create({ orgId: 'o1', provider: 'minimax' });
    await testPool.query(
      `INSERT INTO provider_keys(id, org_id, provider, protocol, card_id, enabled)
       VALUES ('k1','o1','minimax','openai',$1,true),
              ('k2','o1','minimax','image-gen',$1,true)`,
      [id],
    );
    const cards = await providerCards.list('o1');
    expect(cards).toHaveLength(1);
    expect(cards[0].sections.map((s) => s.protocol)).toEqual(['openai', 'image-gen']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/models/providerCards.test.ts`
Expected: FAIL — `Cannot find module '../../src/models/providerCards'`.

- [ ] **Step 3: Implement the model**

Create `enterprise_server/src/models/providerCards.ts`:

- `list(orgId)`: one query for the org's cards, one for the org's provider keys joined on `card_id`, one for `model_catalog` counts grouped by `provider_key_id`. Assemble the `ProviderCardView` tree in JS. Order: cards by `provider` then `label` NULLS FIRST then `created_at`; sections by `protocol` in the order `openai, anthropic, realtime-asr, image-gen, video-gen`.
- `getById(orgId, id)`: `list(orgId)` filtered by id, or a direct query — whichever is simpler; keep one code path so the two never drift.
- `create(input)`: `INSERT INTO provider_cards (id, org_id, provider, label, created_by, created_at) VALUES ($1,$2,$3,$4,$5,now())` with `id = 'card:' || crypto.randomUUID()`. On a unique-index violation (SQLSTATE 23505) rethrow as `new Error('card_duplicate')` so the route can answer 409.
- `patch(orgId, id, fields)`: `label` → `UPDATE provider_cards SET label = $2 WHERE id = $1 AND org_id = $3`. `enabled` → update the card's sections: `false` → `UPDATE provider_keys SET enabled = false WHERE card_id = $1`; `true` → `UPDATE provider_keys SET enabled = (api_key_masked IS NOT NULL) WHERE card_id = $1`.
- `remove(orgId, id)`: count and delete the card's `model_catalog` rows, then the card's `provider_keys` rows, then the card. Return `{ deletedKeys, deletedModels }`.

- [ ] **Step 4: Run the model test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/models/providerCards.test.ts`
Expected: PASS — 6/6.

- [ ] **Step 5: Write the failing route test**

Create `enterprise_server/tests/routes/providerCardsAdmin.test.ts` following the pattern in `enterprise_server/tests/routes/adminCatalog.test.ts`: mock `../../src/db/pool` with the pglite pool, build a Hono app with `app.route('/', adminProviderCardRoutes)`, and mint tokens with `signToken({ sub, orgId, roles: ['model_admin'] })`.

Test cases:
- `GET /admin/provider-cards` without a token → 401.
- `POST /admin/provider-cards` with `orgId` different from the token's org → 400 `org_mismatch`.
- `POST /admin/provider-cards` twice with the same slug and no label → the second returns 409 `card_duplicate`.
- `DELETE /admin/provider-cards/:id` of a card in another org → 404 `card_not_found`.

- [ ] **Step 6: Run the route test to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/routes/providerCardsAdmin.test.ts`
Expected: FAIL — the route module does not exist.

- [ ] **Step 7: Implement the routes**

Create `enterprise_server/src/routes/admin/providerCards.ts`:

- Import `providerCards` from `../../models/providerCards`, `requirePermission` from `../../auth/middleware`, `PermissionPoint as PP` from `../../shared/permissionPoints`, `auditStore` from the audit module, `AuditAction` from `../../shared/enterpriseServerConstants`.
- Parse bodies with Zod, matching the style of `src/routes/admin/providerKeys.ts`:
  - `POST` body: `z.object({ orgId: z.string(), provider: z.string().min(1), label: z.string().optional() })`.
  - `PATCH` body: `z.object({ label: z.string().nullable().optional(), enabled: z.boolean().optional() })`.
- Guard `orgId !== claims.orgId` → `400 { error: 'org_mismatch' }`.
- On `create`, write an audit row with `action: AuditAction.ProviderKeyAdd`, `targetType: 'provider_card'`, `targetId: id`.
- On `remove`, `AuditAction.ProviderKeyDelete`.

Modify `enterprise_server/src/shared/auditTargetTypeMeta.ts`: add `provider_card: { zh: '服务商卡片', en: 'Provider card' }` to the target-type map, and `'provider_card'` to the list of known target types.

- [ ] **Step 8: Accept `cardId` on provider-key create**

Modify `enterprise_server/src/routes/admin/providerKeys.ts`:
- Add `cardId: z.string().optional()` to the create body schema.
- Pass it to `providerKeyVault.add({ ..., cardId })`.
- In `enterprise_server/src/vault/providerKeyVault.ts`, add `cardId?: string` to the `add` input and, when it is absent, look up the card the key should join: the card whose `COALESCE(label, provider) = provider` and whose slot matches this key's protocol — i.e. `SELECT id FROM provider_cards WHERE org_id = $1 AND COALESCE(label, provider) = $2 ORDER BY created_at ASC LIMIT 1`. When no card matches, create one with `id = 'card:' || md5(org_id || ':' || provider || ':' || 0)` and `label = NULL`.

  **Careful:** the same slot rule as the 058 backfill means a second key of the same (slug, protocol) must go to slot 1, not slot 0. Reuse the slot expression:
  ```sql
  SELECT 'card:' || md5($1 || ':' || $2 || ':' || (
    SELECT COALESCE(MAX(
      (ROW_NUMBER() OVER (PARTITION BY pk.org_id, pk.provider, pk.protocol
                          ORDER BY pk.is_builtin DESC, pk.created_at ASC, pk.id ASC)) - 1), 0)
      FROM provider_keys pk
      WHERE pk.org_id = $1 AND pk.provider = $2 AND pk.protocol = $3
  )::text))
  ```
  Simpler and just as correct: compute the next slot in application code — count the existing keys of that (org, provider, protocol) and use that count as the slot, then look for an existing card with that id and create it if missing.

- [ ] **Step 9: Run the route tests to verify they pass**

Run: `cd enterprise_server && npx vitest run tests/routes/providerCardsAdmin.test.ts tests/routes/providerKeysV2.test.ts tests/models/providerCards.test.ts`
Expected: PASS — all green.

- [ ] **Step 10: Commit**

```bash
git add enterprise_server/src/models/providerCards.ts enterprise_server/src/routes/admin/providerCards.ts enterprise_server/src/routes/admin/providerKeys.ts enterprise_server/src/vault/providerKeyVault.ts enterprise_server/src/shared/auditTargetTypeMeta.ts enterprise_server/tests/models/providerCards.test.ts enterprise_server/tests/routes/providerCardsAdmin.test.ts
git commit -m "feat(admin): add provider card model and admin routes"
```

---

### Task P0-4: Per-type default models

**Files:**
- Create: `enterprise_server/src/models/modelTypeDefaults.ts`
- Modify: `enterprise_server/src/models/modelCatalog.ts` (add `parameter_spec` to the column lists; add `listEnabledByTypes`)
- Modify: `enterprise_server/src/routes/admin/models.ts` (accept `defaultForType` on patch)
- Test: `enterprise_server/tests/models/modelTypeDefaults.test.ts`

**Interfaces:**
- Consumes: `model_type_defaults` (Task P0-2).
- Produces — `enterprise_server/src/models/modelTypeDefaults.ts`:

```ts
export const modelTypeDefaults = {
  /** The default model id for a type, or null. */
  async get(orgId: string, type: string): Promise<string | null>;
  /** Point the type at a model. Replaces any previous default. */
  async set(orgId: string, type: string, modelId: string): Promise<void>;
  /** Clear the type's default. */
  async clear(orgId: string, type: string): Promise<void>;
  /** Every default in the org: `[{ type, modelId }]`. */
  async listForOrg(orgId: string): Promise<Array<{ type: string; modelId: string }>>;
};
```

- Produces — `enterprise_server/src/models/modelCatalog.ts`:
  - `ModelView` / `AdminModelView` gain `parameter_spec: Record<string, unknown>`.
  - Add `c.parameter_spec` to `MODEL_LIST_COLS` (so `ADMIN_MODEL_LIST_COLS` inherits it).

  There is deliberately **no** new "list by type" method here. The type-filtered
  read paths this phase needs (the chat pickers) are served by `list()` with a
  type filter (Task P0-5); the media/ASR read path needs a richer row (the
  card prefix, the creation order) and gets its own module in the P2 phase
  (`src/models/typedModelSelection.ts`). One query, one owner — not two
  near-identical listers that drift.

- Produces — `PATCH /admin/models/:id` accepts `defaultForType?: { type: string; isDefault: boolean }`:
  - `{ type: 'image-gen', isDefault: true }` → `modelTypeDefaults.set(orgId, 'image-gen', id)`.
  - `{ type: 'image-gen', isDefault: false }` → `modelTypeDefaults.clear(orgId, 'image-gen')` — but ONLY when the current default for that type IS this model. Otherwise the request is a no-op: the console never asks to clear another model's default, and silently clearing it would be a surprise.
  - The `type` is validated against `MODEL_TYPE_VALUES`; an unknown type → `400 { error: 'validation_error', field: 'defaultForType.type' }`.
  - Setting a default for a model that does not carry that type → `400 { error: 'type_mismatch', field: 'defaultForType.type' }`.
  - The route needs the model's `types` to check the mismatch, so read the row with `modelCatalog.getById(id)` first.

  **Why the type is inside the object:** the model id is in the path, but the type is not. A bare `defaultForType: 'image-gen'` can express "set", and a bare `defaultForType: null` cannot say WHICH type to clear — with one default per type, "clear the default" is meaningless without naming the type.

- Produces — `GET /admin/model-type-defaults?orgId=` → `Array<{ type: string; modelId: string }>`, permission `PP.ModelView`. The console needs it to render the "默认" badge on the model table: the badge lives on the model's TYPE chip, so the console has to know which (model, type) pairs are defaults. It is `modelTypeDefaults.listForOrg(orgId)` exposed.

- Produces — `POST /admin/models` and `PATCH /admin/models/:id` accept `parameterSpec?: Record<string, unknown>`:
  - The column was added in 059 and the backfill copies the old
    `provider_keys.config.models[].parameterSpec` into it, but the legacy
    textarea that USED to set it is deleted in the P1 phase. Without a write
    path the value would be read-only forever: the desktop prints
    "Supported parameters" to the LLM from it, so a media model that supports
    `size=1024x1024` has to stay editable.
  - The body field is `parameterSpec` (camelCase, like the rest of the admin
    model API); the column is `parameter_spec`.
  - An absent field means "leave it alone" on PATCH and `{}` on POST. A
    non-object value → `400 { error: 'validation_error', field: 'parameterSpec' }`.

- [ ] **Step 1: Write the failing test**

Create `enterprise_server/tests/models/modelTypeDefaults.test.ts`:

```ts
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { modelTypeDefaults } from '../../src/models/modelTypeDefaults';

describe('models/modelTypeDefaults', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','T') ON CONFLICT DO NOTHING`);
    await testPool.query(
      `INSERT INTO users(id,org_id,username,password_hash) VALUES ('u1','o1','u1','x') ON CONFLICT DO NOTHING`,
    );
    await testPool.query(
      `INSERT INTO provider_keys(id, org_id, provider, protocol) VALUES ('k1','o1','minimax','image-gen')`,
    );
    await testPool.query(
      `INSERT INTO model_catalog(id, org_id, provider_key_id, provider, model, types)
       VALUES ('m1','o1','k1','minimax','a',ARRAY['image-gen']),
              ('m2','o1','k1','minimax','b',ARRAY['image-gen'])`,
    );
  });

  test('默认可以设置和读取', async () => {
    await modelTypeDefaults.set('o1', 'image-gen', 'm1');
    expect(await modelTypeDefaults.get('o1', 'image-gen')).toBe('m1');
  });

  test('同一类型再设一次会替换掉旧的', async () => {
    await modelTypeDefaults.set('o1', 'image-gen', 'm1');
    await modelTypeDefaults.set('o1', 'image-gen', 'm2');
    expect(await modelTypeDefaults.get('o1', 'image-gen')).toBe('m2');
  });

  test('清除后没有默认', async () => {
    await modelTypeDefaults.set('o1', 'image-gen', 'm1');
    await modelTypeDefaults.clear('o1', 'image-gen');
    expect(await modelTypeDefaults.get('o1', 'image-gen')).toBeNull();
  });

  test('不同类型各有各的默认', async () => {
    await modelTypeDefaults.set('o1', 'image-gen', 'm1');
    await modelTypeDefaults.set('o1', 'video-gen', 'm2');
    expect(await modelTypeDefaults.get('o1', 'image-gen')).toBe('m1');
    expect(await modelTypeDefaults.get('o1', 'video-gen')).toBe('m2');
  });

  test('删除模型会连带清掉默认', async () => {
    await modelTypeDefaults.set('o1', 'image-gen', 'm1');
    await testPool.query(`DELETE FROM model_catalog WHERE id = 'm1'`);
    expect(await modelTypeDefaults.get('o1', 'image-gen')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/models/modelTypeDefaults.test.ts`
Expected: FAIL — `Cannot find module '../../src/models/modelTypeDefaults'`.

- [ ] **Step 3: Implement the model**

Create `enterprise_server/src/models/modelTypeDefaults.ts`:

- `get` → `SELECT model_id FROM model_type_defaults WHERE org_id = $1 AND type = $2`.
- `set` → `INSERT INTO model_type_defaults (org_id, type, model_id, updated_at) VALUES ($1,$2,$3,now()) ON CONFLICT (org_id, type) DO UPDATE SET model_id = EXCLUDED.model_id, updated_at = now()`.
- `clear` → `DELETE FROM model_type_defaults WHERE org_id = $1 AND type = $2`.
- `listForOrg` → `SELECT type, model_id FROM model_type_defaults WHERE org_id = $1 ORDER BY type`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/models/modelTypeDefaults.test.ts`
Expected: PASS — 5/5.

- [ ] **Step 5: Extend `modelCatalog` with `parameter_spec`**

In `enterprise_server/src/models/modelCatalog.ts`:
- Add `c.parameter_spec` to `MODEL_LIST_COLS` (so `ADMIN_MODEL_LIST_COLS` inherits it) and `c.parameter_spec` to the `ModelView` interface as `parameter_spec: Record<string, unknown>`.
- `modelCatalog.add` accepts `parameterSpec?: Record<string, unknown>` and writes it to the column; `modelCatalog.patch` accepts it and updates the column only when the field is present.

- [ ] **Step 6: Write the failing route test for `defaultForType`**

Add to `enterprise_server/tests/routes/adminModels.test.ts` (read that file first and follow its setup):

- `PATCH /admin/models/:id` with `{ defaultForType: { type: 'image-gen', isDefault: true } }` on a model whose `types` include `image-gen` → 200, and `modelTypeDefaults.get(orgId, 'image-gen')` returns the model id.
- `PATCH /admin/models/:id` with `{ defaultForType: { type: 'video-gen', isDefault: true } }` on a model whose types do NOT include `video-gen` → 400 `type_mismatch`.
- `PATCH /admin/models/:id` with `{ defaultForType: { type: 'nope', isDefault: true } }` → 400 `validation_error`.
- `PATCH /admin/models/:id` with `{ defaultForType: { type: 'image-gen', isDefault: false } }` → 200 and the default is cleared.
- `GET /admin/model-type-defaults?orgId=` → the org's defaults, as `[{ type, modelId }]`.
- `POST /admin/models` with `parameterSpec: { size: '1024x1024' }` → 200, and the row's `parameter_spec` is `{"size":"1024x1024"}`.
- `PATCH /admin/models/:id` with `parameterSpec: { size: '512x512' }` → 200, and the row's `parameter_spec` is updated.
- `PATCH /admin/models/:id` with `parameterSpec: 'nope'` → 400 `validation_error` with `field: 'parameterSpec'`.

- [ ] **Step 7: Run the route test to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/routes/adminModels.test.ts`
Expected: FAIL — the patch ignores `defaultForType`, so the default is not set.

- [ ] **Step 8: Implement `defaultForType` on the model patch**

In `enterprise_server/src/routes/admin/models.ts`:
- Add `defaultForType?: { type: string; isDefault: boolean }` to `ModelPatchBody`.
- Validate: when `defaultForType` is present, its `type` must be in `MODEL_TYPE_VALUES` → else `400 { error: 'validation_error', field: 'defaultForType.type' }`.
- When `isDefault` is true, load the model with `modelCatalog.getById(id)`; if the model's `types` do not include the type → `400 { error: 'type_mismatch', field: 'defaultForType.type' }`.
- Apply:
  - `defaultForType === undefined` → no change.
  - `isDefault: true` → `modelTypeDefaults.set(orgId, type, id)`.
  - `isDefault: false` → read the current default for the type; clear it ONLY when it is this model.
- The `orgId` used is the validated `orgId` query param (the route already cross-checks it against the token).

- [ ] **Step 9: Add the model-type-defaults read route**

In `enterprise_server/src/routes/admin/models.ts`:

```ts
adminModelRoutes.get('/admin/model-type-defaults', requirePermission(PP.ModelView), async (c) => {
  const orgId = c.req.query('orgId');
  if (!orgId) return c.json({ error: 'orgId required' }, 400);
  const claims = c.get('claims');
  if (orgId !== claims.orgId) return c.json({ error: 'org_mismatch' }, 400);
  return c.json(await modelTypeDefaults.listForOrg(orgId));
});
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `cd enterprise_server && npx vitest run tests/routes/adminModels.test.ts tests/models/modelTypeDefaults.test.ts tests/models/modelCatalog.test.ts`
Expected: PASS — all green.

- [ ] **Step 11: Commit**

```bash
git add enterprise_server/src/models/modelTypeDefaults.ts enterprise_server/src/models/modelCatalog.ts enterprise_server/src/routes/admin/models.ts enterprise_server/tests/models/modelTypeDefaults.test.ts enterprise_server/tests/routes/adminModels.test.ts
git commit -m "feat(models): add per-type default model and parameter_spec"
```

---

### Task P0-5: Keep media models out of the chat model pickers

**Files:**
- Modify: `enterprise_server/src/routes/admin/catalog.ts`
- Modify: `enterprise_server/src/models/enterpriseModels.ts`
- Modify: `enterprise_server/src/routes/models.ts`
- Test: `enterprise_server/tests/routes/adminCatalog.test.ts` (extend)
- Test: `enterprise_server/tests/routes/enterpriseModels.test.ts` (extend)

**Interfaces:**
- Consumes: `modelCatalog.listEnabledByTypes` (Task P0-4) is not needed here — these three read paths need the plain filtered list.
- Produces: a shared constant so the three call sites cannot drift:

```ts
// enterprise_server/src/models/modelCatalog.ts
/** Model types a SESSION can use. A model appears in the chat pickers only
 * if it carries at least one of them. */
export const SESSION_MODEL_TYPES: ModelTypeValue[] = ['chat', 'vision', 'reasoning'];
```

- The filter clause, used by all three read paths: `AND c.types && $n::text[]`.
  - An empty `types` array does not match `&&` → an untyped model is not a session model. Correct.
  - `embedding` / `rerank` are excluded on purpose: the desktop's embedding uses its own `cowork_config.embeddingProvider` / `embeddingModel` settings and does not consume the enterprise catalog.

- [ ] **Step 1: Write the failing tests**

Extend `enterprise_server/tests/routes/adminCatalog.test.ts` with:

```ts
test('媒体模型不会出现在桌面的 catalog 里', async () => {
  const k = await providerKeyVault.add({ orgId: 'o1', provider: 'minimax', plaintextKey: 'sk-test', createdBy: 'root' });
  await modelCatalog.add({
    orgId: 'o1', providerKeyId: k.id, provider: 'minimax', model: 'image-01',
    types: ['image-gen'],
  });
  const res = await a.request('/admin/catalog', { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json() as { models: Array<{ model: string }> };
  expect(body.models.map((m) => m.model)).not.toContain('image-01');
});
```

Extend `enterprise_server/tests/routes/enterpriseModels.test.ts` with the same shape against `GET /enterprise-models`: a model with `types: ['image-gen']` must not be in the list, and a model with `types: ['chat']` must be.

Add to the same file: a model with `types: []` must not be in the list either.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd enterprise_server && npx vitest run tests/routes/adminCatalog.test.ts tests/routes/enterpriseModels.test.ts`
Expected: FAIL — the media model IS in the list.

- [ ] **Step 3: Implement the filter**

- In `enterprise_server/src/models/modelCatalog.ts`, add the `SESSION_MODEL_TYPES` constant.
- In `enterprise_server/src/models/modelCatalog.ts` `list(orgId)`: add `AND c.types && $2::text[]` with `SESSION_MODEL_TYPES` as the second parameter.
- In `enterprise_server/src/models/enterpriseModels.ts` `listEnabledForOrg(orgId)`: add the same clause. Also apply it to `decryptKeysForOrg` so the server does not decrypt keys for models it will not return.
- In `enterprise_server/src/routes/admin/catalog.ts`: the route calls `modelCatalog.list(claims.orgId)`, so it inherits the filter — no change needed there, but add a comment naming the filter.
- In `enterprise_server/src/routes/models.ts`: it calls `modelCatalog.list(claims.orgId)` too — inherits the filter.

  **If you prefer one explicit place**, put the clause only in `modelCatalog.list` and have `enterpriseModels.listEnabledForOrg` call the same helper. Do NOT add the clause in three places with three copies of the type list.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd enterprise_server && npx vitest run tests/routes/adminCatalog.test.ts tests/routes/enterpriseModels.test.ts tests/models/enterpriseModels.test.ts tests/models/modelCatalog.test.ts`
Expected: PASS — all green.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/models/modelCatalog.ts enterprise_server/src/models/enterpriseModels.ts enterprise_server/src/routes/admin/catalog.ts enterprise_server/src/routes/models.ts enterprise_server/tests/routes/adminCatalog.test.ts enterprise_server/tests/routes/enterpriseModels.test.ts
git commit -m "fix(models): keep media models out of the chat model pickers"
```

---

### Task P0-6: Seed a card for every built-in provider

**Files:**
- Modify: `enterprise_server/src/org/builtinProviders.ts`
- Test: `enterprise_server/tests/org/builtinProviders.test.ts` (create if it does not exist; read the existing seed tests first)

**Interfaces:**
- Consumes: `provider_cards` + `provider_keys.card_id` (Task P0-1).
- Produces: `seedBuiltinProviders(orgId)` creates one card per built-in provider and points the built-in key at it. The card id is `builtin:card:<orgId>:<slug>` (deterministic → re-seeding is idempotent), the card label is `NULL` (the console falls back to `providerDisplayName(slug)`), and the card's `provider` is the built-in slug.

- [ ] **Step 1: Write the failing test**

```ts
test('内置 provider 会带上自己的卡片', async () => {
  await seedBuiltinProviders('o1');
  const r = await testPool.query<{ card_id: string | null; card_provider: string | null }>(
    `SELECT k.card_id, c.provider AS card_provider
       FROM provider_keys k LEFT JOIN provider_cards c ON c.id = k.card_id
      WHERE k.id = 'builtin:o1:minimax'`,
  );
  expect(r.rows[0].card_id).toBe('builtin:card:o1:minimax');
  expect(r.rows[0].card_provider).toBe('minimax');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/org/builtinProviders.test.ts`
Expected: FAIL — `card_id` is null.

- [ ] **Step 3: Implement the seeding**

In `enterprise_server/src/org/builtinProviders.ts`, inside `seedBuiltinProviders`, before the `provider_keys` insert:

```ts
await pool.query(
  `INSERT INTO provider_cards(id, org_id, provider, label, created_by, created_at)
   VALUES ($1,$2,$3,NULL,NULL,now())
   ON CONFLICT (id) DO NOTHING`,
  [`builtin:card:${orgId}:${p.slug}`, orgId, p.slug],
);
```

and add `card_id` to the `provider_keys` insert:

```ts
await pool.query(
  `INSERT INTO provider_keys(id, org_id, provider, endpoint, is_builtin, protocol, enabled, card_id)
   VALUES ($1,$2,$3,$4, true, $5, false, $6)
   ON CONFLICT (org_id, provider) WHERE is_builtin DO NOTHING`,
  [pkId, orgId, p.slug, p.endpoint, p.protocol, `builtin:card:${orgId}:${p.slug}`],
);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/org/builtinProviders.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole server suite**

Run: `cd enterprise_server && npm test`
Expected: PASS — the whole server suite green. If a pre-existing failure appears, record it by name and confirm it also fails on the branch base (`git stash` the change and re-run) before treating it as yours.

- [ ] **Step 6: Commit**

```bash
git add enterprise_server/src/org/builtinProviders.ts enterprise_server/tests/org/builtinProviders.test.ts
git commit -m "feat(org): seed a card for every built-in provider"
```

---

### Task P0-7: Bridge — the legacy media-model field keeps the catalog in sync

**Files:**
- Create: `enterprise_server/src/models/legacyMediaModels.ts`
- Modify: `enterprise_server/src/vault/providerKeyVault.ts` (call the bridge on add / patch)
- Test: `enterprise_server/tests/models/legacyMediaModels.test.ts`

**Interfaces:**
- Consumes: `model_catalog` (Task P0-2), `model_type_defaults` (Task P0-2), `provider_keys.protocol` / `config`.
- Produces — `enterprise_server/src/models/legacyMediaModels.ts`:

```ts
/**
 * Mirror a provider key's LEGACY media model config into `model_catalog`.
 *
 * The console that ships with P0/P2 edits media models through a
 * one-id-per-line text field stored in `provider_keys.config.models` (and
 * `config.model` for ASR). P1 replaces that field with the model table. This
 * bridge keeps the catalog — which the P2 routing reads — in step with what
 * the admin sees in the console, so no phase leaves media models invisible.
 *
 * Semantics:
 *  - image-gen / video-gen: the given list REPLACES the key's catalog rows
 *    of that type (the legacy field is a full list, so an id that disappears
 *    from it must disappear from the catalog too).
 *  - realtime-asr: the row for `config.model` is ensured to exist, and the
 *    org's `asr` default is re-pointed at it when the current default
 *    belongs to this same key (the admin renamed the ASR model; the default
 *    must follow).
 *
 * P1 deletes this module and its call sites in the same change that removes
 * the legacy field.
 */
export async function syncLegacyMediaModels(input: {
  orgId: string;
  providerKeyId: string;
  provider: string;
  protocol: string;
  config: Record<string, unknown> | null | undefined;
}): Promise<void>;
```

- **Call sites** (in `enterprise_server/src/vault/providerKeyVault.ts`):
  - `add(...)` — after the row is inserted, call `syncLegacyMediaModels` with the key's `config`.
  - `patch(...)` — after the row is updated, call it **only when `config` was part of the patch** (a patch that does not touch `config` must not wipe the catalog).

- **Type mapping** (same rule as the 059 backfill): `image-gen` → `types = ['image-gen']`, legacy `type = 'image'`; `video-gen` → `types = ['video-gen']`, legacy `type = 'image'`; `realtime-asr` → `types = ['asr']`, legacy `type = 'audio'`. Any other protocol → the function does nothing.

- **Row identity**: the catalog row id for a legacy model is `'m:' || md5(org_id || ':' || key_id || ':' || model)` — the SAME id the 059 backfill uses, so a re-save updates the backfilled row instead of creating a duplicate. The `(org_id, provider_key_id, model)` unique index is the backstop.

- [ ] **Step 1: Write the failing test**

Create `enterprise_server/tests/models/legacyMediaModels.test.ts`:

```ts
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { syncLegacyMediaModels } from '../../src/models/legacyMediaModels';

async function seedKey(id: string, protocol: string): Promise<void> {
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','T') ON CONFLICT DO NOTHING`);
  await testPool.query(
    `INSERT INTO users(id,org_id,username,password_hash) VALUES ('u1','o1','u1','x') ON CONFLICT DO NOTHING`,
  );
  await testPool.query(
    `INSERT INTO provider_keys(id, org_id, provider, protocol, enabled)
     VALUES ($1,'o1','minimax',$2,true)`,
    [id, protocol],
  );
}

const modelRows = async (): Promise<Array<{ model: string; types: string[] }>> => {
  const r = await testPool.query<{ model: string; types: string[] }>(
    `SELECT model, types FROM model_catalog WHERE provider_key_id = 'k1' ORDER BY model`,
  );
  return r.rows;
};

describe('models/legacyMediaModels', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('图像分区的 config.models 进 model_catalog', async () => {
    await seedKey('k1', 'image-gen');
    await syncLegacyMediaModels({
      orgId: 'o1', providerKeyId: 'k1', provider: 'minimax', protocol: 'image-gen',
      config: { models: [{ modelId: 'image-01' }, { modelId: 'image-01-live' }] },
    });
    expect((await modelRows()).map((m) => m.model)).toEqual(['image-01', 'image-01-live']);
    expect((await modelRows())[0].types).toEqual(['image-gen']);
  });

  test('再次保存会替换整份清单（删掉的模型不再留在 catalog）', async () => {
    await seedKey('k1', 'image-gen');
    await syncLegacyMediaModels({
      orgId: 'o1', providerKeyId: 'k1', provider: 'minimax', protocol: 'image-gen',
      config: { models: [{ modelId: 'image-01' }, { modelId: 'image-01-live' }] },
    });
    await syncLegacyMediaModels({
      orgId: 'o1', providerKeyId: 'k1', provider: 'minimax', protocol: 'image-gen',
      config: { models: [{ modelId: 'image-01' }] },
    });
    expect((await modelRows()).map((m) => m.model)).toEqual(['image-01']);
  });

  test('视频分区的类型是 video-gen', async () => {
    await seedKey('k1', 'video-gen');
    await syncLegacyMediaModels({
      orgId: 'o1', providerKeyId: 'k1', provider: 'minimax', protocol: 'video-gen',
      config: { models: [{ modelId: 'MiniMax-H3' }] },
    });
    expect((await modelRows())[0].types).toEqual(['video-gen']);
  });

  test('语音识别分区补建模型行，并把 asr 默认指向它', async () => {
    await seedKey('k1', 'realtime-asr');
    await syncLegacyMediaModels({
      orgId: 'o1', providerKeyId: 'k1', provider: 'minimax', protocol: 'realtime-asr',
      config: { model: 'asr-2.0' },
    });
    expect((await modelRows()).map((m) => m.model)).toEqual(['asr-2.0']);
    const d = await testPool.query<{ model_id: string }>(
      `SELECT model_id FROM model_type_defaults WHERE org_id = 'o1' AND type = 'asr'`,
    );
    expect(d.rows[0].model_id).toBeTruthy();
  });

  test('空清单会清空该分区的模型行', async () => {
    await seedKey('k1', 'image-gen');
    await syncLegacyMediaModels({
      orgId: 'o1', providerKeyId: 'k1', provider: 'minimax', protocol: 'image-gen',
      config: { models: [{ modelId: 'image-01' }] },
    });
    await syncLegacyMediaModels({
      orgId: 'o1', providerKeyId: 'k1', provider: 'minimax', protocol: 'image-gen',
      config: {},
    });
    expect(await modelRows()).toEqual([]);
  });

  test('对话协议不受影响', async () => {
    await seedKey('k1', 'openai');
    await syncLegacyMediaModels({
      orgId: 'o1', providerKeyId: 'k1', provider: 'minimax', protocol: 'openai',
      config: { models: [{ modelId: 'gpt-4o' }] },
    });
    expect(await modelRows()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/models/legacyMediaModels.test.ts`
Expected: FAIL — `Cannot find module '../../src/models/legacyMediaModels'`.

- [ ] **Step 3: Implement the bridge**

Create `enterprise_server/src/models/legacyMediaModels.ts`:

- Read the key's `config.models` (coerce NULL → `{}`).
- For `image-gen` / `video-gen`:
  1. Collect the wanted ids: `String(m.modelId ?? m.id ?? '').trim()`, skipping empties.
  2. `DELETE FROM model_catalog WHERE org_id = $1 AND provider_key_id = $2 AND types && $3::text[]` with `$3 = ['image-gen']` or `['video-gen']`.
  3. Re-insert each wanted id with `id = 'm:' || md5(org_id || ':' || key_id || ':' || model)`, `display_name` = the legacy `displayName` or the id, `type` = `'image'`, `types` = `['image-gen']` / `['video-gen']`, `parameter_spec` = the legacy `parameterSpec` or `{}`, `enabled` = true, `created_at` = the key's `created_at`.
  4. `ON CONFLICT (org_id, provider_key_id, model) DO UPDATE SET display_name = EXCLUDED.display_name, parameter_spec = EXCLUDED.parameter_spec`.
- For `realtime-asr`:
  1. `const model = String(config.model ?? '').trim() || 'asr-1.0';`
  2. Upsert the catalog row (`type = 'audio'`, `types = ['asr']`).
  3. Read the org's `asr` default. If there is no default, or the default's model row belongs to THIS key, set the default to this row (`modelTypeDefaults.set(orgId, 'asr', rowId)`).
- Any other protocol → return without touching anything.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/models/legacyMediaModels.test.ts`
Expected: PASS — 6/6.

- [ ] **Step 5: Wire it into the provider-key write path**

In `enterprise_server/src/vault/providerKeyVault.ts`:
- `add(input)` — after the `INSERT`, call
  `await syncLegacyMediaModels({ orgId: input.orgId, providerKeyId: id, provider: input.provider, protocol: input.protocol ?? 'openai', config: input.config })`.
- `patch(...)` — after the `UPDATE`, call the same, but ONLY when the patch carried a `config` value. A patch that does not mention `config` must not clear the catalog.

  **Careful:** the current `patch` merges the incoming `config` over the stored one. If the incoming config has no `models` key at all, the merged config still has the OLD models (the merge is shallow per top-level key) — so the bridge sees the old list and re-writes the same rows. That is correct but does a redundant write. If the incoming config explicitly sets `models: []`, the merged config has `models: []` → the bridge clears the catalog rows. Both are the intended behavior.

- [ ] **Step 6: Run the provider-key tests to verify they pass**

Run: `cd enterprise_server && npx vitest run tests/routes/providerKeysV2.test.ts tests/routes/providerKeysExtended.test.ts tests/routes/providerKeysNonChat.test.ts tests/models/legacyMediaModels.test.ts`
Expected: PASS — all green.

- [ ] **Step 7: Commit**

```bash
git add enterprise_server/src/models/legacyMediaModels.ts enterprise_server/src/vault/providerKeyVault.ts enterprise_server/tests/models/legacyMediaModels.test.ts
git commit -m "feat(models): mirror legacy media model config into the catalog"
```

---

## Done criteria

- `cd enterprise_server && npm test` is green.
- `cd enterprise_server && npx vitest run tests/db/migrate058.test.ts tests/db/migrate059.test.ts` is green.
- `provider_cards` has one row per vendor slug in the local dev database, MiniMax's card holding 4 sections.
- `model_catalog` holds the 2 image models, the 4 video models and the `asr-1.0` ASR model that used to live in `provider_keys.config`.
- `GET /admin/catalog` and `GET /enterprise-models` do not contain any model whose types lack `chat` / `vision` / `reasoning`.
- Editing the console's legacy media-model field changes `provider_keys.config.models` AND `model_catalog` together (the P0-7 bridge).
- The desktop binary is unchanged: no file under `src/` was touched.
