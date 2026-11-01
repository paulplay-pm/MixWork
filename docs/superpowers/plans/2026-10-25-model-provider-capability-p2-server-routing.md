# Model Provider Capability — P2: Server Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the model in the request decide which vendor runs it, give every model type a default, and let the desktop ask for a media generation without naming a model.

**Architecture:** One new server module owns "which model runs this request": it lists the enabled models of a type, resolves the requested name against them (qualified name first, then bare name), and applies the fallback chain (explicit → the type's default → the first enabled model). The media and ASR routes both go through it, so the media route stops choosing the vendor by `created_at` and the ASR route stops choosing by "whichever key was created first". The desktop learns one new thing — the server's default model for a kind — and uses it when the LLM named no model.

**Tech Stack:** TypeScript, Hono, Postgres (pglite in tests), Vitest. Desktop: TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-25-model-provider-capability-design.md` (§6, §8, §9, §10, §12).

**Phase order:** P0 (data model) → P2 (this plan) → P1 (console UI).

---

## Global Constraints

- **P0 must be in place.** This plan reads `provider_cards`, `model_type_defaults`, `model_catalog.parameter_spec` and `model_catalog.created_at`. If P0's migrations have not run, every query here fails.
- **The qualified model id is `<prefix>/<model>`.** The prefix is `COALESCE(provider_cards.label, provider_cards.provider, provider_keys.provider)` — the card's display name, or the slug when the card has none. A card label containing `/` is sanitized to `_` in the qualified name (the prefix is the part before the FIRST `/`; a model name may itself contain `/`).
- **The upstream vendor only ever sees the BARE model name.** `provider.submit(cfg, { model })` and the ASR adapter's `config.model` take the bare `model_catalog.model`. The qualified name is the CLIENT-facing identity and is what goes into `media_tasks.model`.
- **A bare name that matches exactly one candidate is an exact match.** A bare name that matches several is ambiguous; a name that matches none is not found. Both fall back — they never 500.
- **The fallback chain is fixed**: explicit model → the type's default model → the first enabled model of that type. "First enabled" means `ORDER BY created_at ASC, id ASC` — a total order, not the planner's row order.
- **`modelSelectionReason` values** are `explicit`, `ambiguous_fallback`, `not_found_fallback`, `default`. The first three are the spec's; `default` is the reason when the client named NO model at all and the server used the type's default (the spec's table only covers the "client named a model" cases).
- **The desktop stays fail-closed.** A model the LLM named that is not in the account's list is still rejected with `unavailableModel`. The default-model fallback applies ONLY when the LLM named no model.
- **The desktop never calls a vendor API.** Every upstream call still goes through the Enterprise server.
- **Do not change the chat proxy path.** `/proxy/*` routes by `model_catalog.id` and is unaffected.
- **Do not change the console in this phase.** The console keeps writing the legacy media-model field; P0-7's bridge keeps the catalog in step. P1 replaces both.

---

## Review Focus

Five input classes the spec implies but no task's tests obviously exercise. Each one gets a test in the task that owns the code.

1. **A model whose card was renamed after the client cached the old name.** The client sends the OLD qualified name; the server must not 500 — it must fall back (the bare part still matches) and say so in `modelSelectionReason`.
2. **Two vendors that both publish `image-01`, and the admin sets NO default.** The chain must still land somewhere deterministic — the first enabled model by `created_at ASC, id ASC` — and the reason must say `ambiguous_fallback`, not `explicit`.
3. **A media model whose provider key is DISABLED.** It must not appear in the model list and must not be selectable, even though its `model_catalog.enabled` is true. (A disabled key is an org-wide off switch.)
4. **A model an admin disabled through `model_policies`** (the org-wide policy table) while its catalog row says enabled. It must not be offered.
5. **The desktop asks for a model by its bare name while the server's list is qualified.** The desktop's availability gate must still accept it (the bare forms match), and the server must resolve it — otherwise the desktop rejects a model the server would happily run.

---

## File Structure

| File | Responsibility |
|---|---|
| `enterprise_server/src/models/typedModelSelection.ts` | The one place that answers "which model runs this request" |
| `enterprise_server/src/routes/media.ts` | Model list from the catalog; generate routes by model |
| `enterprise_server/src/routes/asr.ts` | New `GET /api/asr/models`; the session route picks its key by model |
| `enterprise_server/src/media/providers/minimax.ts` | The legacy `config.models` echo in `listModels` goes away |
| `enterprise_server/src/media/types.ts` | `MediaProvider.listModels` is removed |
| `src/shared/mediaModelAliases.ts` | Prefix-aware canonicalization + the bare-id helper |
| `src/main/media/mediaSelectionFallback.ts` | The default-model fallback and the bare-name gate |
| `src/main/media/mediaModelAvailability.ts` | The cached entries carry the default model |
| `src/main/main.ts` | Wires the default model through and shows the reason |

---

### Task P2-1: The typed model selection module

**Files:**
- Create: `enterprise_server/src/models/typedModelSelection.ts`
- Test: `enterprise_server/tests/models/typedModelSelection.test.ts`

**Interfaces:**
- Consumes: `model_catalog` (+ `parameter_spec`, `created_at`), `provider_keys` (+ `card_id`), `provider_cards` (+ `label`), `model_policies`, `model_type_defaults` (all from P0).
- Produces — `enterprise_server/src/models/typedModelSelection.ts`:

```ts
export const ModelSelectionReason = {
  /** The client named the model and it matched exactly one row. */
  Explicit: 'explicit',
  /** The client named a bare model that several vendors publish. */
  AmbiguousFallback: 'ambiguous_fallback',
  /** The client named a model no enabled row carries. */
  NotFoundFallback: 'not_found_fallback',
  /** The client named no model; the type's default was used. */
  Default: 'default',
} as const;
export type ModelSelectionReason = typeof ModelSelectionReason[keyof typeof ModelSelectionReason];

export interface TypedModelCandidate {
  /** `model_catalog.id`. */
  id: string;
  /** The bare upstream model name. */
  model: string;
  /** `<prefix>/<model>` — the client-facing identity. */
  qualifiedId: string;
  /** The prefix half of `qualifiedId`. */
  providerPrefix: string;
  /** The `provider_keys` row that owns the model. */
  providerKeyId: string;
  /** The owning key's provider slug. */
  provider: string;
  displayName: string | null;
  types: string[];
  parameterSpec: Record<string, unknown>;
}

export interface TypedModelSelection {
  candidate: TypedModelCandidate;
  reason: ModelSelectionReason;
}

export const typedModelSelection = {
  /** Every enabled model of `type` in the org, in `created_at ASC, id ASC` order. */
  async listCandidates(orgId: string, type: string): Promise<TypedModelCandidate[]>;
  /** The org's default model for `type`, or null when there is none (or it is not enabled). */
  async defaultCandidate(orgId: string, type: string): Promise<TypedModelCandidate | null>;
  /** Resolve a requested model name to a row. `requested` may be empty. */
  async select(
    orgId: string,
    type: string,
    requested?: string | null,
  ): Promise<TypedModelSelection | null>;
};
```

- [ ] **Step 1: Write the failing test**

Create `enterprise_server/tests/models/typedModelSelection.test.ts`:

```ts
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { typedModelSelection } from '../../src/models/typedModelSelection';

async function seed(): Promise<void> {
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','T') ON CONFLICT DO NOTHING`);
  await testPool.query(
    `INSERT INTO users(id,org_id,username,password_hash) VALUES ('u1','o1','u1','x') ON CONFLICT DO NOTHING`,
  );
}

/** A provider key, optionally attached to a card. */
async function seedKey(
  id: string,
  provider: string,
  protocol: string,
  opts: { cardId?: string; enabled?: boolean; createdAt?: string } = {},
): Promise<void> {
  await testPool.query(
    `INSERT INTO provider_keys(id, org_id, provider, protocol, card_id, enabled, created_at)
     VALUES ($1,'o1',$2,$3,$4,$5,COALESCE($6::timestamptz, now()))`,
    [id, provider, protocol, opts.cardId ?? null, opts.enabled ?? true, opts.createdAt ?? null],
  );
}

async function seedModel(
  id: string,
  keyId: string,
  model: string,
  types: string[],
  opts: { enabled?: boolean; createdAt?: string } = {},
): Promise<void> {
  await testPool.query(
    `INSERT INTO model_catalog(id, org_id, provider_key_id, provider, model, types, enabled, created_at)
     VALUES ($1,'o1',$2,'minimax',$3,$4::text[],$5,COALESCE($6::timestamptz, now()))`,
    [id, keyId, model, types, opts.enabled ?? true, opts.createdAt ?? null],
  );
}

describe('models/typedModelSelection', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await seed();
  });

  test('列出该类型下已启用的模型，限定名带厂商前缀', async () => {
    await seedKey('k1', 'minimax', 'image-gen');
    await seedModel('m1', 'k1', 'image-01', ['image-gen']);
    const list = await typedModelSelection.listCandidates('o1', 'image-gen');
    expect(list).toHaveLength(1);
    expect(list[0].qualifiedId).toBe('minimax/image-01');
    expect(list[0].model).toBe('image-01');
    expect(list[0].providerKeyId).toBe('k1');
  });

  test('分区被停用时模型不出现', async () => {
    await seedKey('k1', 'minimax', 'image-gen', { enabled: false });
    await seedModel('m1', 'k1', 'image-01', ['image-gen']);
    expect(await typedModelSelection.listCandidates('o1', 'image-gen')).toEqual([]);
  });

  test('模型本身被停用时不出���', async () => {
    await seedKey('k1', 'minimax', 'image-gen');
    await seedModel('m1', 'k1', 'image-01', ['image-gen'], { enabled: false });
    expect(await typedModelSelection.listCandidates('o1', 'image-gen')).toEqual([]);
  });

  test('被策略停用的模型不出现', async () => {
    await seedKey('k1', 'minimax', 'image-gen');
    await seedModel('m1', 'k1', 'image-01', ['image-gen']);
    await testPool.query(
      `INSERT INTO model_policies(id, org_id, model_id, disabled, created_by)
       VALUES ('pol1','o1','m1',true,'u1')`,
    );
    expect(await typedModelSelection.listCandidates('o1', 'image-gen')).toEqual([]);
  });

  test('类型不匹配的模型不出现', async () => {
    await seedKey('k1', 'minimax', 'image-gen');
    await seedModel('m1', 'k1', 'image-01', ['video-gen']);
    expect(await typedModelSelection.listCandidates('o1', 'image-gen')).toEqual([]);
  });

  test('显式指定限定名 → explicit', async () => {
    await seedKey('k1', 'minimax', 'image-gen');
    await seedModel('m1', 'k1', 'image-01', ['image-gen']);
    const sel = await typedModelSelection.select('o1', 'image-gen', 'minimax/image-01');
    expect(sel?.reason).toBe('explicit');
    expect(sel?.candidate.id).toBe('m1');
  });

  test('显式指定裸名且唯一命中 → explicit', async () => {
    await seedKey('k1', 'minimax', 'image-gen');
    await seedModel('m1', 'k1', 'image-01', ['image-gen']);
    const sel = await typedModelSelection.select('o1', 'image-gen', 'image-01');
    expect(sel?.reason).toBe('explicit');
    expect(sel?.candidate.id).toBe('m1');
  });

  test('裸名命中多行 → 回退到默认模型，reason=ambiguous_fallback', async () => {
    await seedKey('k1', 'minimax', 'image-gen');
    await seedKey('k2', 'kimi', 'image-gen');
    await seedModel('m1', 'k1', 'image-01', ['image-gen']);
    await seedModel('m2', 'k2', 'image-01', ['image-gen']);
    await testPool.query(
      `INSERT INTO model_type_defaults(org_id, type, model_id) VALUES ('o1','image-gen','m2')`,
    );
    const sel = await typedModelSelection.select('o1', 'image-gen', 'image-01');
    expect(sel?.reason).toBe('ambiguous_fallback');
    expect(sel?.candidate.id).toBe('m2');
  });

  test('裸名命中多行且没有默认 → 落到第一个启用的模型', async () => {
    await seedKey('k1', 'minimax', 'image-gen');
    await seedKey('k2', 'kimi', 'image-gen');
    await seedModel('m1', 'k1', 'image-01', ['image-gen'], { createdAt: '2026-01-01' });
    await seedModel('m2', 'k2', 'image-01', ['image-gen'], { createdAt: '2026-02-01' });
    const sel = await typedModelSelection.select('o1', 'image-gen', 'image-01');
    expect(sel?.reason).toBe('ambiguous_fallback');
    expect(sel?.candidate.id).toBe('m1');
  });

  test('模型不存在 → 回退到默认模型，reason=not_found_fallback', async () => {
    await seedKey('k1', 'minimax', 'image-gen');
    await seedModel('m1', 'k1', 'image-01', ['image-gen']);
    await testPool.query(
      `INSERT INTO model_type_defaults(org_id, type, model_id) VALUES ('o1','image-gen','m1')`,
    );
    const sel = await typedModelSelection.select('o1', 'image-gen', 'nope');
    expect(sel?.reason).toBe('not_found_fallback');
    expect(sel?.candidate.id).toBe('m1');
  });

  test('没有指定模型 → 用默认模型，reason=default', async () => {
    await seedKey('k1', 'minimax', 'image-gen');
    await seedModel('m1', 'k1', 'image-01', ['image-gen']);
    await seedModel('m2', 'k1', 'image-02', ['image-gen'], { createdAt: '2026-02-01' });
    await testPool.query(
      `INSERT INTO model_type_defaults(org_id, type, model_id) VALUES ('o1','image-gen','m2')`,
    );
    const sel = await typedModelSelection.select('o1', 'image-gen', undefined);
    expect(sel?.reason).toBe('default');
    expect(sel?.candidate.id).toBe('m2');
  });

  test('没有指定模型也没有默认 → 第一个启用的模型', async () => {
    await seedKey('k1', 'minimax', 'image-gen');
    await seedModel('m1', 'k1', 'image-01', ['image-gen'], { createdAt: '2026-01-01' });
    await seedModel('m2', 'k1', 'image-02', ['image-gen'], { createdAt: '2026-02-01' });
    const sel = await typedModelSelection.select('o1', 'image-gen', '');
    expect(sel?.reason).toBe('default');
    expect(sel?.candidate.id).toBe('m1');
  });

  test('被停用的默认模型不算默认，退回第一个启用的模型', async () => {
    await seedKey('k1', 'minimax', 'image-gen');
    await seedModel('m1', 'k1', 'image-01', ['image-gen'], { createdAt: '2026-01-01' });
    await seedModel('m2', 'k1', 'image-02', ['image-gen'], { createdAt: '2026-02-01' });
    await testPool.query(
      `INSERT INTO model_type_defaults(org_id, type, model_id) VALUES ('o1','image-gen','m2')`,
    );
    await testPool.query(`UPDATE model_catalog SET enabled = false WHERE id = 'm2'`);
    const sel = await typedModelSelection.select('o1', 'image-gen', undefined);
    expect(sel?.candidate.id).toBe('m1');
  });

  test('卡片有显示名时限定名用显示名', async () => {
    await testPool.query(
      `INSERT INTO provider_cards(id, org_id, provider, label) VALUES ('c1','o1','minimax','MiniMax 图像')`,
    );
    await seedKey('k1', 'minimax', 'image-gen', { cardId: 'c1' });
    await seedModel('m1', 'k1', 'image-01', ['image-gen']);
    const list = await typedModelSelection.listCandidates('o1', 'image-gen');
    expect(list[0].qualifiedId).toBe('MiniMax 图像/image-01');
  });

  test('没有任何启用模型时 select 返回 null', async () => {
    expect(await typedModelSelection.select('o1', 'image-gen', 'image-01')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/models/typedModelSelection.test.ts`
Expected: FAIL — `Cannot find module '../../src/models/typedModelSelection'`.

- [ ] **Step 3: Implement the module**

Create `enterprise_server/src/models/typedModelSelection.ts`:

- The candidate query (one query, used by every method):

```sql
SELECT c.id, c.model, c.display_name, c.types, c.parameter_spec,
       c.provider_key_id, c.provider,
       COALESCE(pc.label, pc.provider, c.provider) AS provider_prefix
  FROM model_catalog c
  JOIN provider_keys k ON k.id = c.provider_key_id AND k.org_id = c.org_id
  LEFT JOIN provider_cards pc ON pc.id = k.card_id
  LEFT JOIN model_policies p ON p.org_id = c.org_id AND p.model_id = c.id
 WHERE c.org_id = $1
   AND c.enabled
   AND k.enabled
   AND COALESCE(p.disabled, false) = false
   AND c.types && $2::text[]
 ORDER BY c.created_at ASC, c.id ASC
```

- `qualifiedId` = `sanitizePrefix(prefix) + '/' + model`, where `sanitizePrefix` replaces every `/` with `_` (the prefix is the part before the FIRST `/`).
- `listCandidates(orgId, type)` maps the rows to `TypedModelCandidate`.
- `defaultCandidate(orgId, type)` reads `model_type_defaults` for the type, then finds that row among the candidates (so a disabled default is not a default).
- `select(orgId, type, requested)`:
  1. `const candidates = await listCandidates(orgId, type); if (candidates.length === 0) return null;`
  2. `const wanted = (requested ?? '').trim();`
  3. If `wanted` is non-empty:
     - `const exact = candidates.find((c) => c.qualifiedId === wanted)` → `{ candidate: exact, reason: Explicit }`.
     - Otherwise take the bare part: `const bare = wanted.includes('/') ? wanted.slice(wanted.indexOf('/') + 1) : wanted;` and `const byBare = candidates.filter((c) => c.model === bare)`.
       - `byBare.length === 1` → `{ candidate: byBare[0], reason: Explicit }`.
       - `byBare.length > 1` → fall back with reason `AmbiguousFallback`.
       - `byBare.length === 0` → fall back with reason `NotFoundFallback`.
  4. If `wanted` is empty → fall back with reason `Default`.
  5. The fallback itself: the default candidate if there is one, else `candidates[0]`.

  **Note on the bare part:** the bare part is everything after the FIRST `/`, so a model name that itself contains `/` (`hf/model`) survives. A client that sends a BARE name containing `/` (`hf/model`) is treated as prefix `hf`, bare `model` — such names are not supported; document it in the module's doc comment.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/models/typedModelSelection.test.ts`
Expected: PASS — 14/14.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/models/typedModelSelection.ts enterprise_server/tests/models/typedModelSelection.test.ts
git commit -m "feat(models): add typed model selection with the default-model fallback chain"
```

---

### Task P2-2: The media model list comes from the catalog

**Files:**
- Modify: `enterprise_server/src/routes/media.ts`
- Modify: `enterprise_server/src/media/types.ts` (drop `listModels` from the interface)
- Modify: `enterprise_server/src/media/providers/minimax.ts` (drop the implementation)
- Test: `enterprise_server/tests/media/routes.test.ts` (extend)

**Interfaces:**
- Consumes: `typedModelSelection.listCandidates` / `defaultCandidate` (Task P2-1).
- Produces — the `GET /api/media/:kind/models` response:

```ts
{
  code: 0,
  data: Array<{
    /** The qualified id — `minimax/image-01`. */
    modelId: string;
    displayName: string;
    /** The owning key's provider slug. */
    provider: string;
    /** The model's types, e.g. `['image-gen']`. */
    capabilities: string[];
    parameterSpec: Record<string, unknown>;
  }>;
  /** The type's default model, qualified. `null` when there is none. */
  defaultModel: string | null;
}
```

- `MediaProvider.listModels(cfg)` is **removed** from the interface in `src/media/types.ts` and its implementation is removed from `src/media/providers/minimax.ts`. After this change no caller remains (the route built the list itself), and the implementation only echoed `config.models` — the field the catalog now owns. The three test stubs that provide `listModels: async () => []` (`tests/media/generateFlow.test.ts`, `tests/media/worker.test.ts`) drop the property.

  **Why delete rather than re-point:** the adapter has no access to the catalog, and a method that takes a catalog list and returns it unchanged is a pass-through with no behavior. Leaving it would be dead code that a future reader mistakes for the live path.

- [ ] **Step 1: Write the failing test**

Add to `enterprise_server/tests/media/routes.test.ts`:

```ts
test('列模型来自 model_catalog，且带厂商限定名', async () => {
  const token = await seed();
  const list = await json<Envelope<ModelDescriptor[] & { defaultModel?: string }>>(
    await app().request('/api/media/images/models', { headers: { authorization: `Bearer ${token}` } }),
  );
  expect(list.code).toBe(0);
  expect(list.data?.[0]?.modelId).toBe('minimax/gpt-image-2');
  expect(list.data?.[0]?.provider).toBe('minimax');
  expect(list.data?.[0]?.capabilities).toEqual(['image-gen']);
});

test('列模型带出该类型的默认模型', async () => {
  const token = await seed();
  await testPool.query(
    `INSERT INTO model_type_defaults(org_id, type, model_id)
     SELECT 'o1','image-gen', id FROM model_catalog WHERE model = 'gpt-image-2'`,
  );
  const res = await app().request('/api/media/images/models', {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await json<{ data?: unknown[]; defaultModel?: string }>(res);
  expect(body.defaultModel).toBe('minimax/gpt-image-2');
});
```

The `seed()` helper in that file must also create the catalog rows. Add to `seed()`:

```ts
await testPool.query(
  `INSERT INTO model_catalog(id, org_id, provider_key_id, provider, model, display_name, type, types, enabled)
   VALUES ('mc1','o1','pk1','minimax','gpt-image-2','GPT Image 2','image',ARRAY['image-gen'],true),
          ('mc2','o1','pk2','minimax','happyhorse-1.1-t2v','HappyHorse 1.1','image',ARRAY['video-gen'],true)`,
);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/media/routes.test.ts`
Expected: FAIL — the list still comes from `config.models` and the ids are bare (`gpt-image-2`, not `minimax/gpt-image-2`).

- [ ] **Step 3: Implement the new list endpoint**

In `enterprise_server/src/routes/media.ts`:

- Delete `modelsFromConfig` and `findMediaProvider` (the generate route stops using it in Task P2-3; until then, keep `findMediaProvider`).
- Add a type constant next to `protocolForKind`:

```ts
/** The model TYPE that serves a media kind. */
function modelTypeForKind(kind: 'images' | 'videos'): 'image-gen' | 'video-gen' {
  return kind === 'images' ? 'image-gen' : 'video-gen';
}
```

- Rewrite the list handler:

```ts
const type = modelTypeForKind(kind);
const candidates = await typedModelSelection.listCandidates(claims.orgId, type);
const defaultCandidate = await typedModelSelection.defaultCandidate(claims.orgId, type);
return c.json({
  code: 0,
  data: candidates.map((candidate) => ({
    modelId: candidate.qualifiedId,
    displayName: candidate.displayName ?? candidate.model,
    provider: candidate.provider,
    capabilities: candidate.types,
    parameterSpec: candidate.parameterSpec,
  })),
  defaultModel: defaultCandidate ? defaultCandidate.qualifiedId : null,
});
```

The old handler answered `{ code: 41400, message: 'no media provider configured' }` when there was no provider. The new one answers `code: 0` with an empty `data` array and `defaultModel: null` — "the org has no image models" is a normal state, not an error, and the desktop renders "No image models available." for it.

- Remove `listModels` from `MediaProvider` in `src/media/types.ts` and from `src/media/providers/minimax.ts`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/media/routes.test.ts tests/media/worker.test.ts tests/media/generateFlow.test.ts tests/media/minimaxProviders.test.ts`
Expected: PASS — all green.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/routes/media.ts enterprise_server/src/media/types.ts enterprise_server/src/media/providers/minimax.ts enterprise_server/tests/media/routes.test.ts enterprise_server/tests/media/worker.test.ts enterprise_server/tests/media/generateFlow.test.ts
git commit -m "feat(media): serve the media model list from the model catalog"
```

---

### Task P2-3: The media generate route picks the vendor by model

**Files:**
- Modify: `enterprise_server/src/routes/media.ts`
- Test: `enterprise_server/tests/media/routes.test.ts` (extend)

**Interfaces:**
- Consumes: `typedModelSelection.select` (Task P2-1).
- Produces — the generate route's contract:
  - `body.model` is **optional**. A request with no model uses the type's default.
  - `media_tasks.model` stores the QUALIFIED id (the client's identity for the model).
  - The upstream receives the BARE model name.
  - `media_tasks.provider_key_id` is the OWNING key of the selected model.
  - `media_tasks.provider` is the owning key's provider slug.
  - `result.upstreamModel` is the bare model name; `result.modelSelectionReason` is the reason.
  - No usable model → HTTP 400 `{ code: 400, message: 'no_provider_configured' }`.

- [ ] **Step 1: Write the failing test**

Add to `enterprise_server/tests/media/routes.test.ts`:

```ts
test('两个厂商都开了图像生成时，请求的模型决定走哪家', async () => {
  const token = await seedTwoVendors();
  const res = await post(token, '/api/media/images/generate', {
    model: 'kimi/kimi-image-01', type: 'image', prompt: 'cat', params: {},
  });
  expect(res.status).toBe(200);
  const task = await testPool.query<{ provider_key_id: string }>(
    `SELECT provider_key_id FROM media_tasks WHERE id = $1`,
    [(await json<Envelope<TaskData>>(res)).data?.taskId],
  );
  // NOT the earliest-created key — the key that owns the requested model.
  expect(task.rows[0].provider_key_id).toBe('pk-kimi');
});

test('模型不存在时回退到默认模型，并在 result 里写明原因', async () => {
  const token = await seedTwoVendors();
  await testPool.query(
    `INSERT INTO model_type_defaults(org_id, type, model_id)
     SELECT 'o1','image-gen', id FROM model_catalog WHERE model = 'kimi-image-01'`,
  );
  const res = await post(token, '/api/media/images/generate', {
    model: 'does-not-exist', type: 'image', prompt: 'cat', params: {},
  });
  const body = await json<Envelope<TaskData>>(res);
  expect(body.code).toBe(0);
  expect(body.data?.modelSelectionReason).toBe('not_found_fallback');
  expect(body.data?.upstreamModel).toBe('kimi-image-01');
});

test('不指定模型时用该类型的默认模型', async () => {
  const token = await seedTwoVendors();
  await testPool.query(
    `INSERT INTO model_type_defaults(org_id, type, model_id)
     SELECT 'o1','image-gen', id FROM model_catalog WHERE model = 'kimi-image-01'`,
  );
  const res = await post(token, '/api/media/images/generate', {
    type: 'image', prompt: 'cat', params: {},
  });
  const body = await json<Envelope<TaskData>>(res);
  expect(body.code).toBe(0);
  expect(body.data?.modelSelectionReason).toBe('default');
  expect(body.data?.upstreamModel).toBe('kimi-image-01');
});

test('没有任何启用模型时返回 400 no_provider_configured', async () => {
  const token = await seed();
  await testPool.query(`UPDATE model_catalog SET enabled = false`);
  const res = await post(token, '/api/media/images/generate', {
    model: 'gpt-image-2', type: 'image', prompt: 'cat', params: {},
  });
  expect(res.status).toBe(400);
  expect((await json<Envelope<TaskData>>(res)).message).toBe('no_provider_configured');
});
```

The `seedTwoVendors()` helper adds a second image-gen key and its catalog row:

```ts
async function seedTwoVendors(): Promise<string> {
  const token = await seed();
  await testPool.query(
    `INSERT INTO provider_keys(id,org_id,provider,api_key_encrypted,created_by,protocol,enabled,config,created_at)
     VALUES ('pk-kimi','o1','kimi',$1,'u1','image-gen',true,'{}'::jsonb, now() + interval '1 day')`,
    [encrypt('sk-kimi')],
  );
  await testPool.query(
    `INSERT INTO model_catalog(id, org_id, provider_key_id, provider, model, display_name, type, types, enabled, created_at)
     VALUES ('mc-kimi','o1','pk-kimi','kimi','kimi-image-01','Kimi Image','image',ARRAY['image-gen'],true, now() + interval '1 day')`,
  );
  return token;
}
```

The `pk-kimi` key is created LATER than `pk1` on purpose: the old route picked the earliest key, so this test fails against the old code.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/media/routes.test.ts`
Expected: FAIL — the request goes to `pk1` (the earliest key) regardless of the model, and a request with no model returns 400 `model is required`.

- [ ] **Step 3: Implement the routing**

In `enterprise_server/src/routes/media.ts`:

- Replace the provider lookup with the selection:

```ts
const type = modelTypeForKind(kind);
const selection = await typedModelSelection.select(claims.orgId, type, body.model ?? null);
if (!selection) {
  return c.json({ code: 400, message: 'no_provider_configured' }, 400);
}
const { candidate } = selection;
```

- Load the owning key row (endpoint + config) by id, scoped to the org:

```ts
const providerRow = await pool.query<ProviderRow>(
  `SELECT id, provider, protocol, endpoint, config
     FROM provider_keys
    WHERE id = $1 AND org_id = $2 AND enabled`,
  [candidate.providerKeyId, claims.orgId],
);
const row = providerRow.rows[0];
if (!row) {
  return c.json({ code: 400, message: 'no_provider_configured' }, 400);
}
```

- The `!body.model` early return is **removed** — a request with no model is legal now.

- The reserved task row stores the qualified id and the owning key:

```ts
[ taskId, claims.orgId, claims.sub, mediaKind,
  candidate.qualifiedId,                      // media_tasks.model
  JSON.stringify({ type, prompt: body.prompt ?? '', params: body.params ?? {} }),
  row.provider,                               // media_tasks.provider
  row.id,                                     // media_tasks.provider_key_id
  idempotencyKey, now ],
```

- The upstream submit uses the BARE model:

```ts
const submitted = await provider.submit(cfg, {
  model: candidate.model,
  type,
  prompt: body.prompt ?? '',
  params: body.params ?? {},
});
```

- The result records the reason and the bare upstream model:

```ts
JSON.stringify(
  immediate
    ? { resultUrls: immediate.resultUrls, upstreamModel: candidate.model, modelSelectionReason: selection.reason }
    : { upstreamModel: candidate.model, modelSelectionReason: selection.reason },
),
```

- The failure path is unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/media/routes.test.ts`
Expected: PASS — all green.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/routes/media.ts enterprise_server/tests/media/routes.test.ts
git commit -m "fix(media): route a generation to the vendor that owns the requested model"
```

---

### Task P2-4: ASR picks its vendor by the default model

**Files:**
- Modify: `enterprise_server/src/routes/asr.ts`
- Modify: `enterprise_server/src/asr/ticket.ts` (`AsrTicketClaims` gains `model`)
- Modify: `enterprise_server/src/asr/relay.ts` (the resolved config's `config.model` follows the ticket)
- Test: `enterprise_server/tests/asr/sessionRoute.test.ts` (extend)
- Test: `enterprise_server/tests/asr/ticket.test.ts` (extend)
- Test: `enterprise_server/tests/asr/modelsRoute.test.ts` (new)

**Interfaces:**
- Consumes: `typedModelSelection` (Task P2-1).
- Produces:
  - `GET /api/asr/models` → `{ code: 0, data: MediaModelDescriptor[], defaultModel: string | null }`, where the descriptors are the same shape the media list uses and `types` is `['asr']`.
  - `POST /api/asr/realtime/sessions` selects its provider key by: the `asr` default model → the first enabled `asr` model → the first enabled `realtime-asr` key (the old behavior) → `ConfigInvalid`.
  - The selected model's BARE name travels on the ASR **ticket** (`AsrTicketClaims.model`), and the relay overrides the resolved config's `config.model` with it.

    **The ticket is the only channel that works.** The session route builds a
    `ResolvedAsrConfig`, but the relay does not use it: when the socket opens,
    `resolveAsrConfigFromProviderKey` re-reads the provider row from the
    database and hands THAT config to the adapter. Anything the session route
    put in its own config object is discarded, and the adapter then reads the
    stale `provider_keys.config.model` (e.g. `asr-1.0`). The ticket is signed
    and single-use, so it is the right place to carry the resolved model: the
    relay overrides `cfg.config.model` with `claims.model` after it resolves
    the row, and the catalog's choice reaches the upstream.

    `provider_keys.config.model` is left in place (it is what the 059 backfill
    reads to seed the ASR catalog row). The ticket's value wins when it is
    present, so a stale stored value can no longer override the catalog.

- [ ] **Step 1: Write the failing test**

Add to `enterprise_server/tests/asr/sessionRoute.test.ts`:

```ts
test('有默认 ASR 模型时，会话用默认模型所属的分区', async () => {
  await seedAsrProvider('pk1');
  await seedAsrProvider('pk2');
  await testPool.query(
    `INSERT INTO model_catalog(id, org_id, provider_key_id, provider, model, type, types, enabled)
     VALUES ('ma1','o1','pk1','minimax','asr-1.0','audio',ARRAY['asr'],true),
            ('ma2','o1','pk2','kimi','kimi-asr','audio',ARRAY['asr'],true)`,
  );
  await testPool.query(
    `INSERT INTO model_type_defaults(org_id, type, model_id) VALUES ('o1','asr','ma2')`,
  );
  const res = await post(await seedOrgUser());
  expect(res.status).toBe(200);
  const body = await json(res);
  expect(body.code).toBe(0);
  // The ticket names the provider key; the ws server resolves the key.
  // Assert on the resolved config instead: the session's key is pk2.
  expect(body.data?.requestId).toBeTruthy();
});
```

**The assertion above is weak — replace it with a real one.** The session response does not name the provider key, so assert on the thing that IS observable: the ticket. `issueAsrTicket` writes a row; read it back:

```ts
const ticket = await testPool.query<{ provider_key_id: string; protocol: string }>(
  `SELECT provider_key_id, protocol FROM asr_tickets WHERE request_id = $1`,
  [body.data?.requestId],
);
expect(ticket.rows[0].provider_key_id).toBe('pk2');
```

Read `tests/asr/sessionRoute.test.ts` and `src/asr/ticket.ts` first and use the real ticket table name and columns. If the ticket does not store the provider key id, assert instead that the RESOLVED CONFIG's model is the default's model — which means the route must expose it, and the way to observe it is through `resolveAsrProvider` (see below).

**A better, observable contract:** extract the selection into a named function in `src/routes/asr.ts` and test it directly:

```ts
// exported for the test
export async function resolveAsrProvider(
  orgId: string,
): Promise<{ row: AsrProviderRow; model: string | null } | null>;
```

Then the test asserts:

```ts
const resolved = await resolveAsrProvider('o1');
expect(resolved?.row.id).toBe('pk2');
expect(resolved?.model).toBe('kimi-asr');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/asr/sessionRoute.test.ts`
Expected: FAIL — `resolveAsrProvider` does not exist, and the current route picks `pk1` (the earliest key).

- [ ] **Step 3: Implement the selection**

In `enterprise_server/src/routes/asr.ts`:

- Add the import of `typedModelSelection`.
- Replace `findAsrProvider` with:

```ts
/**
 * The org's ASR provider, and the model it should run.
 *
 * The chain: the `asr` default model → the first enabled `asr` model → the
 * first enabled ASR key (the old "earliest created key" behavior) → nothing.
 */
export async function resolveAsrProvider(
  orgId: string,
): Promise<{ row: AsrProviderRow; model: string | null } | null> {
  const selection = await typedModelSelection.select(orgId, 'asr', null);
  if (selection) {
    const r = await pool.query<AsrProviderRow>(
      `SELECT id, provider, protocol, endpoint, config
         FROM provider_keys
        WHERE id = $1 AND org_id = $2 AND enabled`,
      [selection.candidate.providerKeyId, orgId],
    );
    const row = r.rows[0];
    if (row) return { row, model: selection.candidate.model };
  }
  // No catalog row: fall back to the first enabled ASR key, as before.
  const protocols = asrProtocols();
  if (protocols.length === 0) return null;
  const r = await pool.query<AsrProviderRow>(
    `SELECT id, provider, protocol, endpoint, config
       FROM provider_keys
      WHERE org_id = $1 AND enabled AND protocol = ANY($2)
      ORDER BY created_at ASC
      LIMIT 1`,
    [orgId, protocols],
  );
  const row = r.rows[0];
  return row ? { row, model: null } : null;
}
```

- In the session handler, use it and put the model ON THE TICKET:

```ts
const resolved = await resolveAsrProvider(orgId);
if (!resolved) {
  return c.json({ code: AsrApiCode.ConfigInvalid, message: 'no asr provider configured' });
}
const row = resolved.row;
...
const cfg: ResolvedAsrConfig = {
  id: row.id,
  protocol: row.protocol,
  provider: row.provider,
  endpoint: row.endpoint,
  apiKey,
  config: row.config ?? {},
  sampleRate: typeof row.config?.sampleRate === 'number' ? row.config.sampleRate : DEFAULT_SAMPLE_RATE,
};
...
const ticket = await issueAsrTicket({
  orgId,
  userId,
  requestId,
  langType,
  providerKeyId: cfg.id,
  protocol: cfg.protocol,
  // The catalog's model, carried to the relay. Absent when the selection
  // fell back to "the first enabled ASR key" with no catalog row.
  ...(resolved.model ? { model: resolved.model } : {}),
});
```

- In `enterprise_server/src/asr/ticket.ts`, add the field to the claims and
  carry it through the round trip:

```ts
export interface AsrTicketClaims {
  orgId: string;
  userId: string;
  requestId: string;
  langType: string;
  providerKeyId: string;
  protocol: string;
  /** The model the catalog selected for this session (the BARE model name).
   * Optional: absent when the server fell back to a key with no catalog row. */
  model?: string;
}
```

`issueAsrTicket` already serializes the whole claims object, so the field rides
along. `redeemAsrTicket` returns a hand-built object — add `model: parsed.model`
to it, or the claim is dropped on redemption.

- In `enterprise_server/src/asr/relay.ts`, override the model AFTER the row is
  resolved. The resolve call is `const cfg = await resolveConfig(claims.providerKeyId, claims.orgId);`
  — immediately after it:

```ts
// The catalog picked the model; the stored `config.model` may be stale.
if (claims.model) {
  cfg.config = { ...cfg.config, model: claims.model };
}
```

`cfg.config` is the object the adapter reads (`cfg.config.model` in
`src/asr/providers/minimax.ts`), so this is the line that makes the catalog's
choice reach the upstream.

**The catalog's model wins over the stored `config.model`** — the catalog is
the source of truth now, and the ticket is what carries that truth across the
session-route/relay boundary.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/asr/sessionRoute.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the ASR model list route**

Create `enterprise_server/tests/asr/modelsRoute.test.ts`:

```ts
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { asrRoutes } from '../../src/routes/asr';

describe('GET /api/asr/models', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('列出 ASR 模型，带限定名和默认模型', async () => {
    await testPool.query(`INSERT INTO orgs(id,name,timezone) VALUES ('o1','T','UTC')`);
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, status)
       VALUES ('u1','o1','u1','x','active')`,
    );
    await testPool.query(
      `INSERT INTO provider_keys(id,org_id,provider,created_by,protocol,enabled)
       VALUES ('pk1','o1','minimax','u1','realtime-asr',true)`,
    );
    await testPool.query(
      `INSERT INTO model_catalog(id, org_id, provider_key_id, provider, model, type, types, enabled)
       VALUES ('ma1','o1','pk1','minimax','asr-1.0','audio',ARRAY['asr'],true)`,
    );
    await testPool.query(
      `INSERT INTO model_type_defaults(org_id, type, model_id) VALUES ('o1','asr','ma1')`,
    );
    const token = signToken({ sub: 'u1', orgId: 'o1', roles: ['org_admin'] });
    const a = new Hono();
    a.route('/', asrRoutes);
    const res = await a.request('/api/asr/models', { headers: { authorization: `Bearer ${token}` } });
    const body = await res.json() as {
      code?: number;
      data?: Array<{ modelId?: string; capabilities?: string[] }>;
      defaultModel?: string | null;
    };
    expect(body.code).toBe(0);
    expect(body.data?.[0]?.modelId).toBe('minimax/asr-1.0');
    expect(body.data?.[0]?.capabilities).toEqual(['asr']);
    expect(body.defaultModel).toBe('minimax/asr-1.0');
  });
});
```

- [ ] **Step 6: Run the new test to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/asr/modelsRoute.test.ts`
Expected: FAIL — 404, the route does not exist.

- [ ] **Step 7: Implement `GET /api/asr/models`**

In `enterprise_server/src/routes/asr.ts`:

```ts
asrRoutes.get('/api/asr/models', requireActiveMemberNumeric, async (c) => {
  const claims = c.get('claims');
  const candidates = await typedModelSelection.listCandidates(claims.orgId, 'asr');
  const defaultCandidate = await typedModelSelection.defaultCandidate(claims.orgId, 'asr');
  return c.json({
    code: 0,
    data: candidates.map((candidate) => ({
      modelId: candidate.qualifiedId,
      displayName: candidate.displayName ?? candidate.model,
      provider: candidate.provider,
      capabilities: candidate.types,
      parameterSpec: candidate.parameterSpec,
    })),
    defaultModel: defaultCandidate ? defaultCandidate.qualifiedId : null,
  });
});
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd enterprise_server && npx vitest run tests/asr/`
Expected: PASS — all green.

- [ ] **Step 9: Commit**

```bash
git add enterprise_server/src/routes/asr.ts enterprise_server/tests/asr/sessionRoute.test.ts enterprise_server/tests/asr/modelsRoute.test.ts
git commit -m "feat(asr): pick the ASR vendor by the default model and expose the ASR model list"
```

---

### Task P2-5: The desktop understands qualified model ids

**Files:**
- Modify: `src/shared/mediaModelAliases.ts`
- Modify: `src/main/media/mediaSelectionFallback.ts`
- Modify: `src/main/media/mediaModelAvailability.ts`
- Test: `src/shared/mediaModelAliases.test.ts` (extend)
- Test: `src/main/media/mediaSelectionFallback.test.ts` (extend)
- Test: `src/main/media/mediaModelAvailability.test.ts` (extend)

**Interfaces:**
- Consumes: nothing from the server modules — the desktop speaks the wire shapes P2-2/P2-4 define.
- Produces — `src/shared/mediaModelAliases.ts`:

```ts
/**
 * The bare model name of a possibly qualified id.
 *
 * The server addresses media models as `<prefix>/<model>` so two vendors that
 * both publish `image-01` stay distinguishable. The prefix is the part
 * before the FIRST `/`; a model name may itself contain `/`.
 */
export function bareMediaModelId(modelId: string | null | undefined): string;

/**
 * Canonicalize a model id, prefix included.
 *
 * `canvas-20` → `gpt-image-2` and `minimax/canvas-20` → `minimax/gpt-image-2`:
 * the alias table is about the MODEL, so it applies to the bare part and the
 * prefix is carried through untouched.
 */
export function canonicalizeMediaModelId(modelId: string | null | undefined): string;
```

- `canonicalizeMediaModelId` keeps its current signature and its current behavior for un-prefixed ids (the existing tests must still pass). The prefixed form is new.

- Produces — `src/main/media/mediaModelAvailability.ts`:

```ts
export interface MediaModelAvailabilityEntry {
  modelId: string;
  displayName?: string;
  /**
   * The server's default model for this kind, carried on every entry.
   *
   * The list is empty when the org has no models of this kind, and then
   * there is no default either — so the first entry is the only place to
   * read it from.
   */
  defaultModel?: string;
}
```

- Produces — `src/main/media/mediaSelectionFallback.ts`:

```ts
export type MediaSelectionResolutionSource = 'bound' | 'tool' | 'default' | 'none';

export const resolveEffectiveMediaSelection = (input: {
  tool: string;
  boundSelection?: MediaSelectionState;
  explicitModel?: string;
  availableModelIds: string[];
  /** The server's default model for this kind, when it has one. */
  defaultModelId?: string;
}): MediaSelectionResolution => { … };
```

- [ ] **Step 1: Write the failing tests**

Extend `src/shared/mediaModelAliases.test.ts`:

```ts
test('限定名的别名只作用在裸名上', () => {
  expect(canonicalizeMediaModelId('minimax/canvas-20')).toBe('minimax/gpt-image-2');
  expect(canonicalizeMediaModelId('canvas-20')).toBe('gpt-image-2');
  expect(canonicalizeMediaModelId('minimax/gpt-image-2')).toBe('minimax/gpt-image-2');
});

test('裸名取第一个斜杠之后的部分', () => {
  expect(bareMediaModelId('minimax/image-01')).toBe('image-01');
  expect(bareMediaModelId('image-01')).toBe('image-01');
  expect(bareMediaModelId('minimax/hf/model')).toBe('hf/model');
});
```

Extend `src/main/media/mediaSelectionFallback.test.ts`:

```ts
test('没有指定模型但有默认模型时用默认模型', () => {
  const result = resolveEffectiveMediaSelection({
    tool: MediaGenerationTool.Image,
    boundSelection: undefined,
    explicitModel: '',
    availableModelIds: ['minimax/image-01'],
    defaultModelId: 'minimax/image-01',
  });
  expect(result.source).toBe('default');
  expect(result.selection?.modelId).toBe('minimax/image-01');
});

test('显式模型优先于默认模型', () => {
  const result = resolveEffectiveMediaSelection({
    tool: MediaGenerationTool.Image,
    boundSelection: undefined,
    explicitModel: 'minimax/image-02',
    availableModelIds: ['minimax/image-01', 'minimax/image-02'],
    defaultModelId: 'minimax/image-01',
  });
  expect(result.source).toBe('tool');
  expect(result.selection?.modelId).toBe('minimax/image-02');
});

test('默认模型不在清单里时不算数', () => {
  const result = resolveEffectiveMediaSelection({
    tool: MediaGenerationTool.Image,
    boundSelection: undefined,
    explicitModel: '',
    availableModelIds: ['minimax/image-01'],
    defaultModelId: 'other/image-99',
  });
  expect(result.source).toBe('none');
  expect(result.selection).toBeUndefined();
});

test('显式模型用裸名也能匹配到限定名', () => {
  const result = resolveEffectiveMediaSelection({
    tool: MediaGenerationTool.Image,
    boundSelection: undefined,
    explicitModel: 'image-01',
    availableModelIds: ['minimax/image-01'],
  });
  expect(result.source).toBe('tool');
  expect(result.selection?.modelId).toBe('image-01');
});

test('显式模型不在清单里仍然 fail closed（不回退到默认模型）', () => {
  const result = resolveEffectiveMediaSelection({
    tool: MediaGenerationTool.Image,
    boundSelection: undefined,
    explicitModel: 'minimax/image-99',
    availableModelIds: ['minimax/image-01'],
    defaultModelId: 'minimax/image-01',
  });
  expect(result.source).toBe('none');
  expect(result.unavailableModel).toBe('minimax/image-99');
  expect(result.selection).toBeUndefined();
});
```

Extend `src/main/media/mediaModelAvailability.test.ts`:

```ts
test('缓存的条目带上默认模型', async () => {
  const cache = createMediaModelAvailabilityCache({
    now: () => 1_000,
    fetchModels: async () => [
      { modelId: 'minimax/image-01', defaultModel: 'minimax/image-01' },
      { modelId: 'minimax/image-02', defaultModel: 'minimax/image-01' },
    ],
  });
  const entries = await cache.get('image', 'owner-a');
  expect(entries[0].defaultModel).toBe('minimax/image-01');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/shared/mediaModelAliases.test.ts src/main/media/mediaSelectionFallback.test.ts src/main/media/mediaModelAvailability.test.ts`
Expected: FAIL — `bareMediaModelId` is not exported, the selection has no `defaultModelId` input, and the entry type has no `defaultModel`.

- [ ] **Step 3: Implement the alias helpers**

In `src/shared/mediaModelAliases.ts`:

```ts
/** The prefix is the part before the FIRST `/`; a model name may contain `/`. */
export function bareMediaModelId(modelId: string | null | undefined): string {
  const normalized = typeof modelId === 'string' ? modelId.trim() : '';
  const slash = normalized.indexOf('/');
  return slash < 0 ? normalized : normalized.slice(slash + 1);
}

export function canonicalizeMediaModelId(modelId: string | null | undefined): string {
  const normalized = typeof modelId === 'string' ? modelId.trim() : '';
  const slash = normalized.indexOf('/');
  if (slash < 0) {
    return MEDIA_MODEL_ID_ALIASES[normalized] ?? normalized;
  }
  const prefix = normalized.slice(0, slash);
  const bare = normalized.slice(slash + 1);
  return `${prefix}/${MEDIA_MODEL_ID_ALIASES[bare] ?? bare}`;
}
```

- [ ] **Step 4: Implement the selection fallback**

In `src/main/media/mediaSelectionFallback.ts`:

```ts
export type MediaSelectionResolutionSource = 'bound' | 'tool' | 'default' | 'none';
```

and inside `resolveEffectiveMediaSelection`:

```ts
  const modelId = input.explicitModel?.trim() || '';

  if (!modelId) {
    // The LLM named no model. The server's default for this kind is the
    // answer — but only when the account actually has it configured.
    const defaultModelId = input.defaultModelId?.trim() || '';
    if (defaultModelId && input.availableModelIds.some(
      (available) => available === defaultModelId
        || bareMediaModelId(available) === bareMediaModelId(defaultModelId),
    )) {
      const selection: MediaSelectionState = {
        mode,
        modelId: defaultModelId,
        ...(mode === MediaSelectionMode.Image
          ? { imageModelId: defaultModelId }
          : { videoModelId: defaultModelId }),
      };
      return { selection, source: 'default' };
    }
    if (input.availableModelIds.length === 0) {
      return { selection: undefined, source: 'none', noModelsConfigured: true };
    }
    return { selection: undefined, source: 'none' };
  }

  if (input.availableModelIds.length === 0) {
    return { selection: undefined, source: 'none', noModelsConfigured: true };
  }

  // The server addresses media models as `<prefix>/<model>`. A client may
  // name the bare model (the server resolves it) — so compare the bare
  // forms, not the raw strings.
  const wantedBare = bareMediaModelId(modelId);
  const available = input.availableModelIds.some(
    (candidate) => candidate === modelId || bareMediaModelId(candidate) === wantedBare,
  );
  if (!available) {
    return { selection: undefined, source: 'none', unavailableModel: modelId };
  }
```

The rest of the function (building the selection) is unchanged.

- [ ] **Step 5: Implement the availability entry**

In `src/main/media/mediaModelAvailability.ts`, add `defaultModel?: string` to `MediaModelAvailabilityEntry`. The cache itself needs no change — it stores and returns whatever the fetch produced.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/shared/mediaModelAliases.test.ts src/main/media/mediaSelectionFallback.test.ts src/main/media/mediaModelAvailability.test.ts`
Expected: PASS — all green.

- [ ] **Step 7: Commit**

```bash
git add src/shared/mediaModelAliases.ts src/main/media/mediaSelectionFallback.ts src/main/media/mediaModelAvailability.ts src/shared/mediaModelAliases.test.ts src/main/media/mediaSelectionFallback.test.ts src/main/media/mediaModelAvailability.test.ts
git commit -m "feat(media): let the desktop resolve qualified media model ids"
```

---

### Task P2-6: The desktop asks for the default model and reports the reason

**Files:**
- Modify: `src/main/main.ts`
- Test: `src/main/main.ts` has no unit test for the tool handler; the coverage lives in `src/main/media/mediaSelectionFallback.test.ts` (Task P2-5). This task changes wiring only.

**Interfaces:**
- Consumes: the `defaultModel` field of `GET /api/media/:kind/models` (Task P2-2) and `MediaModelAvailabilityEntry.defaultModel` (Task P2-5).
- Produces: the desktop's media tool handler passes the default model into the selection and shows the server's selection reason.

- [ ] **Step 1: Wire the default model into the availability cache**

In `src/main/main.ts`, in the `createMediaModelAvailabilityCache` `fetchModels` callback (around line 4992), read `body.defaultModel` as well as `body.data`:

```ts
const body = await resp.json() as { code: number; data?: unknown[]; defaultModel?: string | null };
if (body.code !== 0) return [];
const defaultModel = body.defaultModel ?? undefined;
return (body.data || []).map((model) => {
  const mediaModel = model as { modelId?: string; displayName?: string };
  return {
    modelId: canonicalizeMediaModelId(mediaModel.modelId),
    displayName: mediaModelDisplayName(
      canonicalizeMediaModelId(mediaModel.modelId),
      mediaModel.displayName,
    ),
    ...(defaultModel ? { defaultModel: canonicalizeMediaModelId(defaultModel) } : {}),
  };
});
```

- [ ] **Step 2: Pass the default model into the selection**

In the media tool handler (around line 5185), the availability list is fetched into `availability`. Add:

```ts
const defaultModelId = availability.length > 0 ? availability[0].defaultModel : undefined;
```

and pass it into the resolution:

```ts
const resolution = resolveEffectiveMediaSelection({
  tool,
  boundSelection: selection,
  explicitModel,
  availableModelIds: availability.map((model) => model.modelId),
  defaultModelId,
});
```

- [ ] **Step 3: Show the default model in the list output**

In the `action === 'list'` branch (around line 5296), the server response now carries `defaultModel`. Read it and append a line to the markdown:

```ts
const body = await resp.json() as { code: number; data?: unknown[]; defaultModel?: string | null; message?: string };
```

and after building `text`:

```ts
if (body.defaultModel) {
  text += `\n\n---\n**Default model:** "${body.defaultModel}" — use it when the user does not name a model.`;
}
```

- [ ] **Step 4: Compile and lint**

Run: `npm run compile:electron`
Expected: PASS — no TypeScript errors.

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/main.ts src/main/media/mediaSelectionFallback.ts src/main/media/mediaModelAvailability.ts src/shared/mediaModelAliases.ts`
Expected: PASS — no errors, no warnings.

- [ ] **Step 5: Run the desktop tests**

Run: `npx vitest run src/shared/mediaModelAliases.test.ts src/main/media/`
Expected: PASS — all green.

- [ ] **Step 6: Commit**

```bash
git add src/main/main.ts
git commit -m "feat(media): use the server's default media model when the LLM names none"
```

---

### Task P2-7: Whole-suite verification

**Files:** none.

- [ ] **Step 1: Run the server suite**

Run: `cd enterprise_server && npm test`
Expected: PASS. If a failure appears, check it against the branch base before treating it as yours.

- [ ] **Step 2: Run the desktop suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Verify the end-to-end behavior against the dev database**

The dev database has one MiniMax card with four sections. After the P0 migrations:

```bash
docker exec -e PGPASSWORD=mixwork mixwork-pg psql -U mixwork -d mixwork \
  -c "SELECT c.id, c.provider, c.label, count(k.id) AS sections
        FROM provider_cards c LEFT JOIN provider_keys k ON k.card_id = c.id
       GROUP BY c.id, c.provider, c.label ORDER BY c.provider;"
```

Expected: 9 cards; the MiniMax card has 4 sections.

```bash
docker exec -e PGPASSWORD=mixwork mixwork-pg psql -U mixwork -d mixwork \
  -c "SELECT m.model, m.types FROM model_catalog m WHERE m.types && ARRAY['image-gen','video-gen','asr']::text[] ORDER BY m.types, m.model;"
```

Expected: `image-01`, `image-01-live` (image-gen), `MiniMax-H3`, `MiniMax-H3-Highspeed`, `MiniMax-H3-Lite`, `MiniMax-H3-Max` (video-gen), `asr-1.0` (asr).

```bash
docker exec -e PGPASSWORD=mixwork mixwork-pg psql -U mixwork -d mixwork \
  -c "SELECT type, model_id FROM model_type_defaults;"
```

Expected: one row, `asr` → the `asr-1.0` row.

- [ ] **Step 4: Manual check of the routing fix**

With the dev server running and the MiniMax image-gen key enabled, a generate request for `minimax/image-01` must land on the image-gen key:

```bash
curl -s -X POST "$ENTERPRISE_SERVER/api/media/images/generate" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"model":"minimax/image-01","type":"image","prompt":"a cat"}'
```

Then:

```sql
SELECT model, provider, provider_key_id FROM media_tasks ORDER BY created_at DESC LIMIT 1;
```

Expected: `model` = `minimax/image-01`, `provider_key_id` = the image-gen key's id (NOT the built-in `openai` key's id).

- [ ] **Step 5: Commit any verification-only fixes**

If a step needed a code fix, commit it with a message that names the fix. Otherwise there is nothing to commit.

---

## Done criteria

- `cd enterprise_server && npm test` is green and `npm test` (desktop) is green.
- `POST /api/media/:kind/generate` routes by the requested model: a request for `kimi/kimi-image-01` lands on the Kimi key even when MiniMax's key was created first.
- `GET /api/media/:kind/models` returns qualified ids, a `provider` field and a `defaultModel`.
- `GET /api/asr/models` exists and returns the same shape.
- A generate request with no model uses the type's default and reports `modelSelectionReason: 'default'`.
- A generate request naming an unknown model falls back and reports `not_found_fallback` — it never 500s.
- The desktop uses the server's default model when the LLM names none, and still fails closed when the LLM names a model the account does not have.
- The console was not touched in this phase.
