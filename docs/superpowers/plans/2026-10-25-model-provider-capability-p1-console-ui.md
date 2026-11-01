# Console vendor-card UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the console's "one credential row per rail entry" model with a vendor card: one card per vendor, capability chips under the vendor name (LLM(VLM) / speech recognition / image generation / video generation), one independent Base URL + API Key + model list per capability, and one unified model table (model / type / context window / enabled / actions) for every capability.

**Architecture:** The server already stores a card (`provider_cards`) with one `provider_keys` row per capability section, and every model in `model_catalog` (P0), routed by model id with a per-type default (P2). This phase replaces the console's data source: the rail lists cards, the detail pane renders one `CapabilitySection` per section, and every capability's models are read from `model_catalog` instead of the legacy `provider_keys.config.models` text field — which is deleted together with the P0-7 write bridge.

**Tech Stack:** React 18 + TypeScript + Tailwind, react-query, vitest + @testing-library/react (console); Hono + Postgres (server).

**Spec:** `docs/superpowers/specs/2026-10-25-model-provider-capability-design.md` — this plan implements §4 (interface), §5.3 (type vocabulary), §7 (default model), §8.2 (qualified names) and §12 (console test list) of that document, on top of the data model from `2026-10-25-model-provider-capability-p0-data-model.md` and the routing from `2026-10-25-model-provider-capability-p2-server-routing.md`.

## Global Constraints

- **This phase runs after P0 and P2.** The card API (`GET /admin/provider-cards`), the per-type default API (`GET /admin/model-type-defaults`), `PATCH /admin/models/:id { defaultForType }` and `POST /admin/provider-keys { cardId }` all exist by then. If any is missing, stop and run the earlier phase first.
- **No hardcoded user-visible strings.** Every new label goes through `t('key')` from `enterprise_server/web/src/i18n.ts`, with BOTH `zh` and `en` entries. The existing `providersModels.*` namespace is the home; new keys use the `providersModels.card.*` / `providersModels.model.*` / `providersModels.drawer.*` prefixes.
- **Protocol names are constants.** `openai` / `anthropic` / `realtime-asr` / `image-gen` / `video-gen` come from `PROVIDER_PROTOCOLS` in `web/src/api/providers.ts`. Never write a protocol literal in a component. The same applies to the model types (`ModelTypes` in `web/src/api/models.ts`).
- **The console never talks to a vendor.** It only calls the Enterprise server's admin API. The desktop's media/ASR call chain is unchanged.
- **The qualified model name is `厂商/模型`** where 厂商 = `COALESCE(card.label, card.provider)`. The console displays the bare model name in the table and never builds a qualified name itself — the server owns that.
- **Do not reintroduce `provider_keys.config.models` as a write path.** The legacy field is deleted in Task P1-11 together with the P0-7 bridge; the console must not send it after Task P1-10.
- **Keep the change scoped.** `ProvidersModelsPage.tsx` is already 593 lines; the rewiring in Task P1-10 must not turn it into a 900-line file. The card-draft state lives in a new `useProviderCardDrafts` hook, not in the page component.
- **Migrations are immutable.** This phase adds no migration. If a schema change turns out to be necessary, it needs a NEW numbered file (`060_…`), never an edit to an applied one.

## Review Focus

The spec is a vision document: it says what the software must do, not everything it will meet. These are the input classes the spec implies but no task's tests exercise, most likely to bite first. Each line names the task that owns the code and the test that pins it.

1. **Renaming a card changes the qualified model name.** `厂商/模型` is derived from the card's display name, so renaming a vendor from "MiniMax" to "MM" turns `minimax/image-01` into `MM/image-01`. A desktop that cached the old list for up to 60 s will send the old name and get a fallback instead of its model. (P1-10 — the card name field shows a hint saying so; P2 already makes an unmatched explicit model fall back rather than 500.)
2. **A card may hold two sections for the same capability** (e.g. an `openai` and an `anthropic` credential for the same vendor, which the 058 backfill puts on one card). The LLM capability then has two sections and the protocol radio of one would collide with the other. (P1-1 — the server rejects a second section with the same protocol on one card; P1-3/P1-6 — the console renders every section of the capability, not just the first.)
3. **Adding a model to a media section must not make it a chat model.** The legacy `type` column is a single value derived from `types[0]`; `video-gen` was missing from that map and fell back to `chat`. (P1-1 — `legacyTypeFor` learns `video-gen` → `image`, with a test.)
4. **Removing a capability must not orphan its models.** The delete removes the section's `model_catalog` rows; a model that was the type default must lose the default too. (P1-1 — the server's key delete already cascades `model_catalog`; the default row cascades with it; P1-11's test asserts the catalog row is gone.)
5. **A card whose sections are all disabled must not report itself as enabled**, and turning the card off then on must not resurrect a section the admin had deliberately disabled. (P1-1/P1-10 — the card's `enabled` is "at least one section is enabled"; the re-enable rule is documented on the server route and asserted in P1-1's test.)
6. **The model table must not vanish when the admin picks a non-chat protocol.** Today the whole table is hidden by a page-level `isChatProtocol(draft.protocol) && …` gate keyed on the UNSAVED draft protocol — switching the radio hides the table before anything is saved. With one table per section, the gate has to go: the table is always rendered, and only the "fetch models" button is disabled. (P1-10 — the gate is removed and the media section's table is asserted to be present.)
7. **A media model's parameter spec must stay editable.** The legacy textarea was the only way to set `parameterSpec`; deleting it without a replacement makes the value read-only, and the desktop prints it to the LLM as "Supported parameters". (P1-9 — the drawer gains a parameter-spec field; P1-11 — the legacy field's removal no longer removes the capability.)

---

## File Structure

| File | Responsibility |
|---|---|
| `enterprise_server/src/routes/admin/providerKeys.ts` | P1-1: clear a section's models on a protocol switch; reject a duplicate section on a card. P1-11: stop accepting `config.models`. |
| `enterprise_server/src/org/builtinProviders.ts` | P1-1: `legacyTypeFor` learns `video-gen`. |
| `enterprise_server/src/models/legacyMediaModels.ts` | P1-11: **deleted** (the P0-7 bridge). |
| `enterprise_server/src/vault/providerKeyVault.ts` | P1-11: drop the bridge calls from `add`/`patch`. |
| `web/src/api/providerCards.ts` | **new** — the card admin API client + the card/section view types. |
| `web/src/api/providers.ts` | P1-2: `add` accepts `cardId`. |
| `web/src/api/models.ts` | P1-2: `ModelTypes.VideoGen`; `patch` accepts `defaultForType`; new `modelTypeDefaultsApi`. |
| `web/src/pages/providersModels/capabilities.ts` | **new** — the capability vocabulary: which capability owns which protocol, which model types it allows, the protocol labels and the per-protocol default Base URL. |
| `web/src/pages/providersModels/ProviderCard.tsx` | **new** — the card shell: name, capability chips, the sections, the card's enable switch. |
| `web/src/pages/providersModels/CapabilitySection.tsx` | **new** — one section: protocol radio, Base URL, Coding Plan, API Key, and its model table. |
| `web/src/pages/providersModels/ProviderInfoCard.tsx` | **deleted** — its fields move into `CapabilitySection`; its media-model textarea is deleted. |
| `web/src/pages/providersModels/ProviderHeaderBar.tsx` | P1-7: takes a card instead of a credential row. |
| `web/src/pages/providersModels/ProviderRail.tsx` | P1-8: lists cards. |
| `web/src/pages/providersModels/ModelList.tsx` | P1-5: the default badge; the refresh button is disabled (not hidden) on a non-chat section. |
| `web/src/pages/providersModels/ModelTableRow.tsx` | P1-5: passes the default types to the badges. |
| `web/src/pages/providersModels/ModelDrawer.tsx` | P1-9: the type grid is locked to the section; a per-type "set as default" toggle. |
| `web/src/pages/providersModels/modelType.tsx` | P1-4: `video-gen` label + color; the badges take the default types. |
| `web/src/pages/providersModels/useProviderCardDrafts.ts` | **new** — the page's card/section draft state (one hook, not 200 lines of `useState`). |
| `web/src/pages/ProvidersModelsPage.tsx` | P1-10: the data source becomes cards; the mutations are re-pointed. |
| `web/src/i18n.ts` | P1-2…P1-9: the new copy, `zh` + `en`. |

---

### Task P1-1: The server's section invariants

Three server behaviors the console's card UI depends on. None of them exists yet.

**Files:**
- Modify: `enterprise_server/src/routes/admin/providerKeys.ts`
- Modify: `enterprise_server/src/org/builtinProviders.ts` (the `LEGACY_TYPE` map)
- Test: `enterprise_server/tests/routes/providerKeysV2.test.ts` (extend — read it first and follow its setup)
- Test: `enterprise_server/tests/org/builtinProviders.test.ts` (extend)

**Interfaces:**
- Consumes: `provider_cards` + `provider_keys.card_id` (P0-1), `model_catalog` (P0-2), `modelTypeDefaults` (P0-4).
- Produces:
  - `PATCH /admin/provider-keys/:id` with a **changed** `protocol` → the key's `model_catalog` rows are deleted, and the response gains `clearedModels: number` (the count that was deleted). The response stays `{ ok: true }` plus that field.
  - `POST /admin/provider-keys` with a `cardId` whose card already has a section with the same `protocol` → `409 { error: 'duplicate_section' }`.
  - `legacyTypeFor(['video-gen'])` → `'image'`.

- [ ] **Step 1: Write the failing tests**

Extend `enterprise_server/tests/routes/providerKeysV2.test.ts` with three tests (follow the file's existing setup — a seeded org, a token, and the pglite pool mock):

```ts
test('切换协议会清空该分区的模型', async () => {
  // A key with two chat models.
  // PATCH /admin/provider-keys/:id { protocol: 'anthropic' }
  // → 200, body.clearedModels === 2
  // → SELECT count(*) FROM model_catalog WHERE provider_key_id = <id> is 0
});

test('同一张卡片下不能有两个同协议的分区', async () => {
  // A card with one 'openai' section.
  // POST /admin/provider-keys { orgId, cardId, provider, protocol: 'openai' }
  // → 409, body.error === 'duplicate_section'
});

test('切换协议不影响别的分区的模型', async () => {
  // Two keys, one openai (2 models), one image-gen (1 model).
  // PATCH the openai key's protocol → clearedModels === 2 and the image-gen
  // key still has its 1 model.
});
```

Extend `enterprise_server/tests/org/builtinProviders.test.ts`:

```ts
test('video-gen 模型的旧类型列是 image', () => {
  expect(legacyTypeFor(['video-gen'])).toBe('image');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd enterprise_server && npx vitest run tests/routes/providerKeysV2.test.ts tests/org/builtinProviders.test.ts`
Expected: FAIL — the protocol switch does not clear the models (the response has no `clearedModels`), the duplicate section is accepted (200, not 409), and `legacyTypeFor(['video-gen'])` returns `'chat'`.

- [ ] **Step 3: Clear the models on a protocol switch**

In `enterprise_server/src/routes/admin/providerKeys.ts`, in the `PATCH /admin/provider-keys/:id` handler:

- Read the stored protocol before the update: extend the existing `exists` query to `SELECT id, org_id, protocol FROM provider_keys WHERE id = $1`.
- When `body.protocol` is present, is a valid protocol, and **differs** from the stored one: after `providerKeyVault.patch(id, fields)`, call `modelCatalog.deleteByProviderKey(orgId, id)` (the existing helper — confirm its exact name and signature in `enterprise_server/src/models/modelCatalog.ts`; if it takes only the key id, use that) and set `clearedModels` to the number of rows it reported.
- Return `{ ok: true, clearedModels }` (0 when the protocol did not change).

The deletion is deliberate: the spec (§4.2.3, decision D11) says switching a section's protocol invalidates its model list, and the console confirms this with the admin before calling the route.

- [ ] **Step 4: Reject a duplicate section on a card**

In the same file, in the `POST /admin/provider-keys` handler, after the body is parsed and the org is verified:

```ts
if (body.cardId) {
  const dup = await pool.query<{ id: string }>(
    `SELECT id FROM provider_keys WHERE card_id = $1 AND org_id = $2 AND protocol = $3 LIMIT 1`,
    [body.cardId, body.orgId, body.protocol ?? 'openai'],
  );
  if (dup.rowCount && dup.rowCount > 0) {
    return c.json({ error: 'duplicate_section' }, 409);
  }
}
```

Place the check **before** the insert. A card may hold an `openai` and an `anthropic` section (the 058 backfill can produce that), but never two sections that speak the same protocol — the console's single LLM chip could not tell them apart.

- [ ] **Step 5: Teach `legacyTypeFor` about `video-gen`**

In `enterprise_server/src/org/builtinProviders.ts`, add one entry to the `LEGACY_TYPE` map:

```ts
'video-gen': 'image',
```

A video model must not be typed `chat` in the legacy single-value column — the console's chat pickers filter on `types`, but the legacy column is what the desktop's older contract reads.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd enterprise_server && npx vitest run tests/routes/providerKeysV2.test.ts tests/org/builtinProviders.test.ts`
Expected: PASS — all green.

- [ ] **Step 7: Commit**

```bash
git add enterprise_server/src/routes/admin/providerKeys.ts enterprise_server/src/org/builtinProviders.ts enterprise_server/tests/routes/providerKeysV2.test.ts enterprise_server/tests/org/builtinProviders.test.ts
git commit -m "feat(providers): clear a section's models on a protocol switch"
```

---

### Task P1-2: The console API layer

**Files:**
- Create: `web/src/api/providerCards.ts`
- Modify: `web/src/api/providers.ts`
- Modify: `web/src/api/models.ts`
- Test: `web/tests/api/providerCards.test.ts` (create)
- Modify: `web/tests/api/modelTypes.test.ts`

**Interfaces:**
- Consumes: `GET /admin/provider-cards`, `POST /admin/provider-cards`, `PATCH /admin/provider-cards/:id`, `DELETE /admin/provider-cards/:id`, `GET /admin/model-type-defaults` (all P0).
- Produces — `web/src/api/providerCards.ts`:

```ts
import { apiClient } from './client';
import type { ProviderProtocol } from './providers';

/**
 * One capability section of a vendor card — a single `provider_keys` row
 * (one credential, one wire protocol). Mirrors the server's
 * `ProviderCardSection` (enterprise_server/src/models/providerCards.ts).
 * The server sends camelCase here; do NOT "fix" it to snake_case — the rest
 * of the console's provider API is snake_case because the server's
 * `provider_keys` view is, and the two shapes genuinely differ.
 */
export interface ProviderCardSectionView {
  providerKeyId: string;
  protocol: ProviderProtocol;
  label: string | null;
  endpoint: string | null;
  enabled: boolean;
  /** A built-in credential row: it cannot be deleted, only disabled. */
  isBuiltin: boolean;
  codingPlan: boolean;
  apiKeyMasked: string | null;
  /** How many models this section's model table shows. */
  modelCount: number;
}

/** One vendor card: a vendor plus its capability sections. */
export interface ProviderCardView {
  id: string;
  /** The vendor slug ('minimax'). */
  provider: string;
  /** The card's display name; null → the console falls back to the slug. */
  label: string | null;
  createdAt: string;
  /** True when any section of the card is a built-in credential row. */
  isBuiltin: boolean;
  /** The card's master switch: on when at least one section is enabled. */
  enabled: boolean;
  sections: ProviderCardSectionView[];
}

export const providerCardsApi = {
  list: (orgId: string) =>
    apiClient.get<ProviderCardView[]>(
      `/admin/provider-cards?orgId=${encodeURIComponent(orgId)}`
    ),
  create: (input: { orgId: string; provider: string; label?: string }) =>
    apiClient.post<{ id: string }>('/admin/provider-cards', input),
  patch: (id: string, body: { label?: string | null; enabled?: boolean }) =>
    apiClient.patch<{ ok: true }>(`/admin/provider-cards/${id}`, body),
  remove: (id: string) =>
    apiClient.delete<{ ok: true; deletedKeys: number; deletedModels: number }>(
      `/admin/provider-cards/${id}`
    ),
};
```

- Produces — `web/src/api/models.ts`:
  - `ModelTypes` gains `VideoGen: 'video-gen'`.
  - `modelsApi.patch` gains `defaultForType?: { type: ModelTypeValue; isDefault: boolean }` in its body type.
  - A new export:

```ts
/** The per-type default model pointers: `[{ type, modelId }]`. The console
 * renders the "default" badge on the model's type chip, so it needs to know
 * which (model, type) pairs are defaults. */
export const modelTypeDefaultsApi = {
  list: (orgId: string) =>
    apiClient.get<Array<{ type: string; modelId: string }>>(
      `/admin/model-type-defaults?orgId=${encodeURIComponent(orgId)}`
    ),
};
```

- Produces — `web/src/api/providers.ts`: `providersApi.add` gains `cardId?: string` in its input type. The request body is spread into the POST, so `cardId` reaches the server with no other change.

- [ ] **Step 1: Write the failing test**

Create `web/tests/api/providerCards.test.ts`:

```ts
import { describe, expect, test } from 'vitest';

import { providerCardsApi } from '../../src/api/providerCards';

describe('api/providerCards', () => {
  test('the card view carries the sections the server sends', () => {
    // A type-level check: the console reads camelCase section fields.
    const section = {
      providerKeyId: 'k1',
      protocol: 'openai',
      label: null,
      endpoint: 'https://api.openai.com/v1',
      enabled: true,
      isBuiltin: false,
      codingPlan: false,
      apiKeyMasked: 'sk-…abcd',
      modelCount: 3,
    } as const;
    expect(section.providerKeyId).toBe('k1');
    expect(providerCardsApi.list('/admin/provider-cards?orgId=o1')).toBeInstanceOf(Function);
  });
});
```

That test is thin — it is a compile-time contract. The REAL coverage of the request shapes is in Task P1-10's page test, which asserts the URLs and bodies the page sends. Keep this test as the type guard, and add the real assertions there.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server/web && npx vitest run tests/api/providerCards.test.ts`
Expected: FAIL — `Cannot find module '../../src/api/providerCards'`.

- [ ] **Step 3: Implement the API modules**

Create `web/src/api/providerCards.ts` with the interface block above.

In `web/src/api/models.ts`:
- Add `VideoGen: 'video-gen',` to the `ModelTypes` object.
- Add `defaultForType?: { type: ModelTypeValue; isDefault: boolean };` to the `modelsApi.patch` body type.
- Add the `modelTypeDefaultsApi` export.

In `web/src/api/providers.ts`: add `cardId?: string;` to the `providersApi.add` input type.

- [ ] **Step 4: Update the model-type vocabulary test**

In `web/tests/api/modelTypes.test.ts`, the first test asserts "MODEL_TYPE_VALUES has exactly the 8 PRD values". The vocabulary now has 9 values. Change it to:

```ts
test('MODEL_TYPE_VALUES has exactly the 9 PRD values', () => {
  expect([...MODEL_TYPE_VALUES].sort()).toEqual(
    ['asr', 'chat', 'embedding', 'image-gen', 'reasoning', 'rerank', 'tts', 'video-gen', 'vision'].sort(),
  );
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd enterprise_server/web && npx vitest run tests/api/providerCards.test.ts tests/api/modelTypes.test.ts tests/api/providers.test.ts`
Expected: PASS — all green.

- [ ] **Step 6: Commit**

```bash
git add enterprise_server/web/src/api/providerCards.ts enterprise_server/web/src/api/providers.ts enterprise_server/web/src/api/models.ts enterprise_server/web/tests/api/providerCards.test.ts enterprise_server/web/tests/api/modelTypes.test.ts
git commit -m "feat(console): add the vendor card admin API client"
```

---

### Task P1-3: The capability vocabulary

The one place that knows which capability owns which protocol and which model types it allows. Every later task reads from it.

**Files:**
- Create: `web/src/pages/providersModels/capabilities.ts`
- Test: `web/tests/pages/providersModels/capabilities.test.ts` (create)

**Interfaces:**
- Consumes: `ModelTypes` / `ModelTypeValue` (`web/src/api/models.ts`), `ProviderProtocol` (`web/src/api/providers.ts`), `PROVIDER_ENDPOINTS` / `providerDisplayName` (`web/src/data/providerCatalog.ts`).
- Produces — `web/src/pages/providersModels/capabilities.ts`:

```ts
import { ModelTypes, type ModelTypeValue } from '../../api/models';
import type { ProviderProtocol } from '../../api/providers';
import { PROVIDER_ENDPOINTS, type ProviderEndpointSet } from '../../data/providerCatalog';

/** The capability types a vendor card can offer. */
export const CapabilityId = {
  Llm: 'llm',
  Asr: 'asr',
  Image: 'image',
  Video: 'video',
} as const;
export type CapabilityId = (typeof CapabilityId)[keyof typeof CapabilityId];

export interface CapabilityDef {
  id: CapabilityId;
  /** The i18n key of the chip label. */
  labelKey: string;
  /** The protocol a NEW section of this capability is created with. */
  protocol: ProviderProtocol;
  /** The protocols this capability's section may speak. The LLM section
   * speaks openai OR anthropic; the other three are fixed. */
  protocols: ProviderProtocol[];
  /** The model types a model in this section may carry. */
  modelTypes: ModelTypeValue[];
  /** Whether the section can fetch its model list from the vendor. Only the
   * chat protocols have a `/v1/models` endpoint. */
  canRefreshModels: boolean;
}

export const CAPABILITIES: CapabilityDef[] = [
  {
    id: CapabilityId.Llm,
    labelKey: 'providersModels.card.capabilityLlm',
    protocol: 'openai',
    protocols: ['openai', 'anthropic'],
    modelTypes: [ModelTypes.Chat, ModelTypes.Vision, ModelTypes.Reasoning, ModelTypes.Embedding, ModelTypes.Rerank],
    canRefreshModels: true,
  },
  {
    id: CapabilityId.Asr,
    labelKey: 'providersModels.card.capabilityAsr',
    protocol: 'realtime-asr',
    protocols: ['realtime-asr'],
    modelTypes: [ModelTypes.Asr],
    canRefreshModels: false,
  },
  {
    id: CapabilityId.Image,
    labelKey: 'providersModels.card.capabilityImage',
    protocol: 'image-gen',
    protocols: ['image-gen'],
    modelTypes: [ModelTypes.ImageGen],
    canRefreshModels: false,
  },
  {
    id: CapabilityId.Video,
    labelKey: 'providersModels.card.capabilityVideo',
    protocol: 'video-gen',
    protocols: ['video-gen'],
    modelTypes: [ModelTypes.VideoGen],
    canRefreshModels: false,
  },
];

/** The capability that owns a protocol. */
export function capabilityForProtocol(protocol: ProviderProtocol): CapabilityDef | undefined {
  return CAPABILITIES.find((c) => c.protocols.includes(protocol));
}

/** The model types a section speaking this protocol may carry. */
export function modelTypesForProtocol(protocol: ProviderProtocol): ModelTypeValue[] {
  return capabilityForProtocol(protocol)?.modelTypes ?? [];
}

/** The i18n key of a protocol's radio label. */
export const PROTOCOL_LABEL_KEY: Record<ProviderProtocol, string> = {
  openai: 'providersModels.protocol.openai',
  anthropic: 'providersModels.protocol.anthropic',
  'realtime-asr': 'providersModels.protocol.realtimeAsr',
  'image-gen': 'providersModels.protocol.imageGen',
  'video-gen': 'providersModels.protocol.videoGen',
};

/** Every protocol, in the order a radio renders them. */
export const PROTOCOL_ORDER: ProviderProtocol[] = [
  'openai',
  'anthropic',
  'realtime-asr',
  'image-gen',
  'video-gen',
];

/** Canonical Base URL per protocol. Choosing a protocol auto-fills this into
 * the Base URL field (it always overwrites the current value). */
export const PROTOCOL_DEFAULT_BASE_URL: Record<ProviderProtocol, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  // The non-chat adapters take the API ROOT — they append the version path
  // themselves, so a `/v1` suffix here would double up.
  'realtime-asr': 'https://api.minimaxi.com',
  'image-gen': 'https://api.minimaxi.com',
  'video-gen': 'https://api.minimaxi.com',
};

/** Which entry of a provider's endpoint set serves a protocol. */
const PROTOCOL_ENDPOINT_KEY: Record<ProviderProtocol, keyof ProviderEndpointSet> = {
  openai: 'openai',
  anthropic: 'anthropic',
  'realtime-asr': 'realtimeAsr',
  'image-gen': 'imageGen',
  'video-gen': 'videoGen',
};

/** The provider-specific Base URL for a protocol, falling back to the global
 * protocol default for custom / unknown slugs. */
export function defaultBaseUrlFor(slug: string, protocol: ProviderProtocol): string {
  const set = PROVIDER_ENDPOINTS[slug];
  return set?.[PROTOCOL_ENDPOINT_KEY[protocol]] ?? PROTOCOL_DEFAULT_BASE_URL[protocol];
}
```

`PROTOCOL_DEFAULT_BASE_URL`, `defaultBaseUrlFor`, `PROTOCOL_LABEL_KEY` and `PROTOCOL_ORDER` are MOVED here from `web/src/pages/providersModels/ProviderInfoCard.tsx` (deleted in Task P1-7).

- [ ] **Step 1: Write the failing test**

Create `web/tests/pages/providersModels/capabilities.test.ts`:

```ts
import { describe, expect, test } from 'vitest';

import {
  CAPABILITIES,
  CapabilityId,
  capabilityForProtocol,
  defaultBaseUrlFor,
  modelTypesForProtocol,
} from '../../../src/pages/providersModels/capabilities';

describe('pages/providersModels/capabilities', () => {
  test('every protocol belongs to exactly one capability', () => {
    expect(capabilityForProtocol('openai')?.id).toBe(CapabilityId.Llm);
    expect(capabilityForProtocol('anthropic')?.id).toBe(CapabilityId.Llm);
    expect(capabilityForProtocol('realtime-asr')?.id).toBe(CapabilityId.Asr);
    expect(capabilityForProtocol('image-gen')?.id).toBe(CapabilityId.Image);
    expect(capabilityForProtocol('video-gen')?.id).toBe(CapabilityId.Video);
  });

  test('the LLM capability offers the openai and anthropic protocols', () => {
    const llm = CAPABILITIES.find((c) => c.id === CapabilityId.Llm)!;
    expect(llm.protocols).toEqual(['openai', 'anthropic']);
    expect(llm.canRefreshModels).toBe(true);
  });

  test('the media and speech capabilities cannot fetch models', () => {
    for (const id of [CapabilityId.Asr, CapabilityId.Image, CapabilityId.Video]) {
      const c = CAPABILITIES.find((x) => x.id === id)!;
      expect(c.canRefreshModels).toBe(false);
      expect(c.protocols).toHaveLength(1);
    }
  });

  test('each capability allows exactly the model types of its protocol', () => {
    expect(modelTypesForProtocol('openai')).toEqual(['chat', 'vision', 'reasoning', 'embedding', 'rerank']);
    expect(modelTypesForProtocol('realtime-asr')).toEqual(['asr']);
    expect(modelTypesForProtocol('image-gen')).toEqual(['image-gen']);
    expect(modelTypesForProtocol('video-gen')).toEqual(['video-gen']);
  });

  test('a non-chat protocol gets the API root, not a /v1 URL', () => {
    expect(defaultBaseUrlFor('minimax', 'image-gen')).toBe('https://api.minimaxi.com');
    expect(defaultBaseUrlFor('minimax', 'realtime-asr')).toBe('https://api.minimaxi.com');
    expect(defaultBaseUrlFor('openai', 'openai')).toBe('https://api.openai.com/v1');
    // An unknown slug falls back to the global protocol default.
    expect(defaultBaseUrlFor('vllm-custom', 'anthropic')).toBe('https://api.anthropic.com');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server/web && npx vitest run tests/pages/providersModels/capabilities.test.ts`
Expected: FAIL — `Cannot find module '../../../src/pages/providersModels/capabilities'`.

- [ ] **Step 3: Implement `capabilities.ts`**

Write the file exactly as the Interfaces block above.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd enterprise_server/web && npx vitest run tests/pages/providersModels/capabilities.test.ts`
Expected: PASS — 5/5.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/web/src/pages/providersModels/capabilities.ts enterprise_server/web/tests/pages/providersModels/capabilities.test.ts
git commit -m "feat(console): add the capability vocabulary"
```

---

### Task P1-4: The type chip vocabulary and the default badge

**Files:**
- Modify: `web/src/pages/providersModels/modelType.tsx`
- Test: `web/tests/pages/providersModels/modelType.test.tsx` (create)

**Interfaces:**
- Consumes: `ModelTypes` / `ModelTypeValue` (Task P1-2).
- Produces:
  - `TYPE_VALUE_LABEL_KEY` gains `[ModelTypes.VideoGen]: 'providersModels.model.typeVideoGen'`.
  - `TYPE_BG` gains `'video-gen': 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'` (same neutral tone as the other media types).
  - `ModelTypesBadges` gains a second prop:

```ts
export function ModelTypesBadges({
  types,
  defaultTypes = [],
}: {
  types: ModelTypeValue[];
  /** The types this model is the DEFAULT model for. Those chips carry the
   * "default" badge; the rest do not. */
  defaultTypes?: ModelTypeValue[];
}): JSX.Element
```

  The chip for a type in `defaultTypes` renders the type label plus a small `默认` / `Default` badge. The badge text comes from `t('providersModels.model.defaultBadge')` — do NOT hardcode it.

- [ ] **Step 1: Write the failing test**

Create `web/tests/pages/providersModels/modelType.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { ModelTypes } from '../../../src/api/models';
import { ModelTypesBadges, typeValueLabel } from '../../../src/pages/providersModels/modelType';

describe('pages/providersModels/modelType', () => {
  test('the video type has a label', () => {
    expect(typeValueLabel(ModelTypes.VideoGen)).toBe('Video Gen');
  });

  test('the default badge rides the type chip it belongs to', () => {
    render(<ModelTypesBadges types={['chat', 'vision']} defaultTypes={['vision']} />);
    // The vision chip carries the badge; the chat chip does not.
    expect(screen.getAllByText('Default')).toHaveLength(1);
    const visionChip = screen.getByText('Vision').parentElement!;
    expect(visionChip.textContent).toContain('Default');
    const chatChip = screen.getByText('Chat').parentElement!;
    expect(chatChip.textContent).not.toContain('Default');
  });

  test('no badge when the model is not a default', () => {
    render(<ModelTypesBadges types={['chat']} />);
    expect(screen.queryByText('Default')).toBeNull();
  });
});
```

The assertions are written against the **English** dictionary — the console's default locale in jsdom is `en-US`, and `setLang` is not called in this file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server/web && npx vitest run tests/pages/providersModels/modelType.test.tsx`
Expected: FAIL — `typeValueLabel(ModelTypes.VideoGen)` is undefined (`ModelTypes.VideoGen` does not exist yet in the type) and the badge is missing.

- [ ] **Step 3: Implement the vocabulary and the badge**

In `web/src/pages/providersModels/modelType.tsx`:

- Add the `video-gen` entries to `TYPE_VALUE_LABEL_KEY` and `TYPE_BG`.
- Change `ModelTypesBadges` to accept `defaultTypes` and render the badge:

```tsx
export function ModelTypesBadges({ types, defaultTypes = [] }: { types: ModelTypeValue[]; defaultTypes?: ModelTypeValue[] }): JSX.Element {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {types.map((v) => (
        <span key={v} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${TYPE_BG[v]}`}>
          {typeValueLabel(v)}
          {defaultTypes.includes(v) && (
            <span className="rounded-full bg-[var(--accent-primary)] px-1.5 text-[10px] font-medium text-white">
              {t('providersModels.model.defaultBadge')}
            </span>
          )}
        </span>
      ))}
    </span>
  );
}
```

- [ ] **Step 4: Add the i18n keys**

In `web/src/i18n.ts`, add to the `en` dictionary:

```ts
'providersModels.model.typeVideoGen': 'Video Gen',
'providersModels.model.defaultBadge': 'Default',
```

and to the `zh` dictionary:

```ts
'providersModels.model.typeVideoGen': '视频生成',
'providersModels.model.defaultBadge': '默认',
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd enterprise_server/web && npx vitest run tests/pages/providersModels/modelType.test.tsx`
Expected: PASS — 3/3.

- [ ] **Step 6: Commit**

```bash
git add enterprise_server/web/src/pages/providersModels/modelType.tsx enterprise_server/web/src/i18n.ts enterprise_server/web/tests/pages/providersModels/modelType.test.tsx
git commit -m "feat(console): add the video type and the default-model badge"
```

---

### Task P1-5: The model table carries the default badge

**Files:**
- Modify: `web/src/pages/providersModels/ModelList.tsx`
- Modify: `web/src/pages/providersModels/ModelTableRow.tsx`
- Test: `web/tests/pages/providersModels/ModelList.test.tsx` (modify)

**Interfaces:**
- Consumes: `ModelTypesBadges` with `defaultTypes` (Task P1-4).
- Produces:
  - `ModelList` gains a prop:

```ts
  /** The types each model is the default for, keyed by model id. The "default"
   * badge rides the matching type chip. */
  defaultTypesByModel?: Record<string, ModelTypeValue[]>;
```

  and passes `defaultTypesByModel?.[model.id] ?? []` to each `ModelTableRow`.
  - `ModelTableRow` gains the same prop (`defaultTypes?: ModelTypeValue[]`) and passes it to `ModelTypesBadges`.
  - `ModelList`'s refresh button: when `canRefresh` is false the button is still rendered but **disabled**, with `title={t('providersModels.model.refreshUnsupported')}`. The spec (§4.2.5) asks for a greyed-out button with an explanation, not a hidden one — a hidden button leaves the admin wondering whether the section has models at all.

- [ ] **Step 1: Write the failing tests**

In `web/tests/pages/providersModels/ModelList.test.tsx`:

- Add a test:

```tsx
test('the default model carries the badge on its type chip', () => {
  renderList({ defaultTypesByModel: { m1: ['vision'] } });
  const visionChip = screen.getByText('Vision').parentElement!;
  expect(visionChip.textContent).toContain('Default');
  const chatChip = screen.getByText('Chat').parentElement!;
  expect(chatChip.textContent).not.toContain('Default');
});
```

- Change the existing test `hides the refresh button when canRefresh is false` into:

```tsx
test('disables the refresh button when canRefresh is false', () => {
  // A non-chat provider has no model-list endpoint to fetch from, so the
  // button would always come back empty. It stays visible (greyed out) so
  // the admin knows the section has models, they just cannot be fetched.
  renderList({ canRefresh: false });
  const btn = screen.getByRole('button', { name: /Refresh/i });
  expect(btn).toBeDisabled();
  expect(btn).toHaveAttribute('title', expect.stringContaining('manually'));
  expect(screen.getByRole('button', { name: /Add model/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server/web && npx vitest run tests/pages/providersModels/ModelList.test.tsx`
Expected: FAIL — the badge is not rendered, and the refresh button is absent (not disabled) when `canRefresh` is false.

- [ ] **Step 3: Implement**

In `web/src/pages/providersModels/ModelList.tsx`:

- Import `ModelTypeValue` from `../../api/models`.
- Add the `defaultTypesByModel` prop (default `{}`).
- Change the refresh button to always render, with `disabled={busy || !canRefresh}` and `title={!canRefresh ? t('providersModels.model.refreshUnsupported') : undefined}`.

In `web/src/pages/providersModels/ModelTableRow.tsx`:

- Add the `defaultTypes?: ModelTypeValue[]` prop and pass it to `ModelTypesBadges`:
  `<ModelTypesBadges types={model.types} defaultTypes={defaultTypes} />`.

- [ ] **Step 4: Add the i18n key**

`en`: `'providersModels.model.refreshUnsupported': 'This protocol cannot fetch models automatically. Add them manually.',`
`zh`: `'providersModels.model.refreshUnsupported': '该协议不支持自动获取模型，请手动添加。',`

- [ ] **Step 4b: Delete the dead `unsupported_provider` branch**

`unsupported_provider` is produced nowhere in the server: the route that skips a
non-chat provider answers `not_a_chat_provider`
(`enterprise_server/src/routes/admin/providerKeys.ts`). The string survives
only in a stale doc comment and a console branch that can never be taken.

- In `enterprise_server/web/src/api/providers.ts`, remove the `unsupported_provider`
  member of the refresh result type and the branch that reads it.
- In `enterprise_server/web/src/pages/ProvidersModelsPage.tsx`, remove the
  branch that checks for it. (Task P1-10 rewrites most of that file; make the
  deletion there if the branch is already gone by then — but the API client's
  type must lose the member in this task.)

Run: `cd enterprise_server/web && npx vitest run tests/api/providers.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd enterprise_server/web && npx vitest run tests/pages/providersModels/ModelList.test.tsx`
Expected: PASS — all green.

- [ ] **Step 6: Commit**

```bash
git add enterprise_server/web/src/pages/providersModels/ModelList.tsx enterprise_server/web/src/pages/providersModels/ModelTableRow.tsx enterprise_server/web/src/i18n.ts enterprise_server/web/tests/pages/providersModels/ModelList.test.tsx
git commit -m "feat(console): show the default badge in the model table"
```

---

### Task P1-6: The capability section form

One section of a card: the protocol radio, the Base URL, the Coding Plan switch, the API Key, and the model table.

**Files:**
- Create: `web/src/pages/providersModels/CapabilitySection.tsx`
- Test: `web/tests/pages/providersModels/CapabilitySection.test.tsx` (create)

**Interfaces:**
- Consumes: `CapabilityDef` / `capabilityForProtocol` / `defaultBaseUrlFor` / `PROTOCOL_LABEL_KEY` / `PROTOCOL_ORDER` (Task P1-3), `ModelList` (Task P1-5), `ModelView` / `ModelTypeValue` (`web/src/api/models.ts`), `ProviderCardSectionView` (`web/src/api/providerCards.ts`).
- Produces — `web/src/pages/providersModels/CapabilitySection.tsx`:

```tsx
export interface SectionDraft {
  /** The Base URL the admin typed. */
  baseUrl: string;
  /** The "Coding Plan" switch. */
  codingPlan: boolean;
  /** The API Key exactly as typed: '' → keep the stored key. */
  apiKey: string;
}

interface Props {
  /** The capability this section configures. */
  capability: CapabilityDef;
  /** The section's provider key id. Null for a section that does not exist
   * yet (a new card's capability the admin just checked). */
  providerKeyId: string | null;
  /** The section's protocol. The LLM section may be openai or anthropic. */
  protocol: ProviderProtocol;
  /** The vendor slug the card belongs to (drives the default Base URL). */
  providerSlug: string;
  /** The stored values, used to seed the draft. */
  endpoint: string | null;
  codingPlan: boolean;
  apiKeyMasked: string | null;
  /** A built-in credential row: it cannot be removed, only disabled. */
  isBuiltin: boolean;
  canManage: boolean;
  busy: boolean;
  /** The section's models, read from `model_catalog` by `provider_key_id`. */
  models: ModelView[];
  /** The types each model is the default for, keyed by model id. */
  defaultTypesByModel: Record<string, ModelTypeValue[]>;
  /** Called with the section's field values on mount and after every change,
   * so the card's single "save" button can submit the in-progress edits. */
  onDraftChange: (draft: SectionDraft) => void;
  /** The admin asked to switch the section's protocol. The card owns the
   * confirm dialog (it knows the model count to warn about). */
  onProtocolChange: (next: ProviderProtocol) => void;
  onRefreshModels: () => void;
  onAddModel: () => void;
  onEditModel: (model: ModelView) => void;
  onDeleteModel: (id: string) => void;
  onToggleModel: (id: string, enabled: boolean) => void;
}
```

The component renders, top to bottom:

1. A header row: the capability's label, and — for the LLM capability only — a protocol radio group with `openai` and `anthropic` (from `capability.protocols`, labeled through `PROTOCOL_LABEL_KEY`).
2. The Base URL input, seeded from `endpoint` (or `defaultBaseUrlFor(providerSlug, protocol)` when the endpoint is empty). The placeholder is `defaultBaseUrlFor(providerSlug, protocol)`.
3. The Coding Plan switch — **only** when the protocol is `openai` AND the vendor has a coding endpoint (`PROVIDER_ENDPOINTS[providerSlug]?.codingPlan`). Toggling it swaps the Base URL between the coding endpoint and the protocol default, exactly as `ProviderInfoCard` did.
4. The API Key input (write-only, `type=password` with a show/hide eye) and the masked-key hint.
5. The model table — `ModelList` with `canRefresh={capability.canRefreshModels}`, the section's models, and the model's type lock coming from `capability.modelTypes`.

The draft is pushed up on mount and after every change, exactly like `ProviderInfoCard.onDraftChange` did:

```tsx
useEffect(() => {
  onDraftChangeRef.current({ baseUrl, codingPlan, apiKey });
}, [baseUrl, codingPlan, apiKey]);
```

The draft resets when the section's identity changes (`providerKeyId` + `protocol`), so switching sections does not leak one section's edits into the next.

- [ ] **Step 1: Write the failing test**

Create `web/tests/pages/providersModels/CapabilitySection.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { CAPABILITIES, CapabilityId } from '../../../src/pages/providersModels/capabilities';
import { CapabilitySection } from '../../../src/pages/providersModels/CapabilitySection';

const llm = CAPABILITIES.find((c) => c.id === CapabilityId.Llm)!;
const image = CAPABILITIES.find((c) => c.id === CapabilityId.Image)!;

function renderSection(over: Partial<Parameters<typeof CapabilitySection>[0]> = {}) {
  const onDraftChange = vi.fn();
  const onProtocolChange = vi.fn();
  render(
    <CapabilitySection
      capability={llm}
      providerKeyId="k1"
      protocol="openai"
      providerSlug="minimax"
      endpoint="https://api.minimaxi.com/v1"
      codingPlan={false}
      apiKeyMasked="sk-…abcd"
      isBuiltin={false}
      canManage={true}
      busy={false}
      models={[]}
      defaultTypesByModel={{}}
      onDraftChange={onDraftChange}
      onProtocolChange={onProtocolChange}
      onRefreshModels={() => {}}
      onAddModel={() => {}}
      onEditModel={() => {}}
      onDeleteModel={() => {}}
      onToggleModel={() => {}}
      {...over}
    />,
  );
  return { onDraftChange, onProtocolChange };
}

describe('pages/providersModels/CapabilitySection', () => {
  test('the LLM section offers the openai and anthropic protocols', () => {
    renderSection();
    expect(screen.getByRole('radio', { name: /OpenAI compatible/i })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Anthropic compatible/i })).not.toBeChecked();
  });

  test('switching the protocol asks the card instead of editing the row', () => {
    const { onProtocolChange } = renderSection();
    fireEvent.click(screen.getByRole('radio', { name: /Anthropic compatible/i }));
    expect(onProtocolChange).toHaveBeenCalledWith('anthropic');
  });

  test('a media section has no protocol radio', () => {
    renderSection({ capability: image, protocol: 'image-gen' });
    expect(screen.queryByRole('radio', { name: /OpenAI compatible/i })).toBeNull();
  });

  test('pushes the field values up to the card on mount', async () => {
    const { onDraftChange } = renderSection();
    await waitFor(() =>
      expect(onDraftChange).toHaveBeenLastCalledWith({
        baseUrl: 'https://api.minimaxi.com/v1',
        codingPlan: false,
        apiKey: '',
      }),
    );
  });

  test('a typed key lands in the draft', async () => {
    const { onDraftChange } = renderSection();
    fireEvent.change(screen.getByLabelText(/API Key/i), { target: { value: 'sk-new' } });
    await waitFor(() =>
      expect(onDraftChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ apiKey: 'sk-new' }),
      ),
    );
  });

  test('the masked key hint is shown', () => {
    renderSection();
    expect(screen.getAllByText(/sk-…abcd/).length).toBeGreaterThan(0);
  });

  test('a media section disables the fetch-models button', () => {
    renderSection({ capability: image, protocol: 'image-gen' });
    expect(screen.getByRole('button', { name: /Fetch models/i })).toBeDisabled();
  });

  test('the inputs are disabled without manage rights', () => {
    renderSection({ canManage: false });
    expect(screen.getByDisplayValue('https://api.minimaxi.com/v1')).toBeDisabled();
    expect(screen.getByLabelText(/API Key/i)).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server/web && npx vitest run tests/pages/providersModels/CapabilitySection.test.tsx`
Expected: FAIL — `Cannot find module '../../../src/pages/providersModels/CapabilitySection'`.

- [ ] **Step 3: Implement the component**

Write `web/src/pages/providersModels/CapabilitySection.tsx` per the Interfaces block. The Base URL / Coding Plan / API Key markup is lifted from `ProviderInfoCard.tsx` (the `Field` helper and the eye toggle) — copy that markup, drop the name field (the card owns the name), drop the protocol fieldset (the LLM section shows only the two chat protocols), and drop the media-model textarea (the model table replaces it).

The protocol radio for the LLM section:

```tsx
<fieldset>
  <legend>{t('providersModels.card.protocol')}</legend>
  {capability.protocols.map((value) => (
    <label key={value} className="flex cursor-pointer items-center gap-1.5 text-sm">
      <input
        type="radio"
        name={`section-protocol-${providerKeyId ?? 'draft'}`}
        value={value}
        checked={protocol === value}
        disabled={!canManage}
        onChange={() => onProtocolChange(value)}
      />
      {t(PROTOCOL_LABEL_KEY[value])}
    </label>
  ))}
</fieldset>
```

The radio name must be unique per section, otherwise two sections on the same card share one radio group and checking one unchecks the other.

- [ ] **Step 4: Add the i18n keys**

`en`:
```ts
'providersModels.card.protocol': 'Protocol',
```
`zh`:
```ts
'providersModels.card.protocol': '协议',
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd enterprise_server/web && npx vitest run tests/pages/providersModels/CapabilitySection.test.tsx`
Expected: PASS — 7/7.

- [ ] **Step 6: Commit**

```bash
git add enterprise_server/web/src/pages/providersModels/CapabilitySection.tsx enterprise_server/web/src/i18n.ts enterprise_server/web/tests/pages/providersModels/CapabilitySection.test.tsx
git commit -m "feat(console): add the capability section form"
```

---

### Task P1-7: The card shell

**Files:**
- Create: `web/src/pages/providersModels/ProviderCard.tsx`
- Modify: `web/src/pages/providersModels/ProviderHeaderBar.tsx` (takes a card, not a credential row)
- Delete: `web/src/pages/providersModels/ProviderInfoCard.tsx`
- Delete: `web/tests/pages/providersModels/ProviderInfoCard.test.tsx`
- Test: `web/tests/pages/providersModels/ProviderCard.test.tsx` (create)
- Modify: `web/tests/pages/providersModels/ProviderHeaderBar.test.tsx`

**Interfaces:**
- Consumes: `CapabilitySection` (Task P1-6), `ProviderCardView` / `ProviderCardSectionView` (Task P1-2), `CAPABILITIES` / `capabilityForProtocol` (Task P1-3), `ProviderHeaderBar` (modified below).
- Produces — `web/src/pages/providersModels/ProviderCard.tsx`:

```tsx
export interface CardDraft {
  /** The card's display name. */
  label: string;
  /** The per-section field values, keyed by the section's provider key id
   * (or, for a card that does not exist yet, by the capability id). */
  sections: Record<string, SectionDraft>;
}

interface Props {
  card: ProviderCardView;
  canManage: boolean;
  busy: boolean;
  /** True while the card is a draft the admin is still filling in. */
  isDraft?: boolean;
  /** The card's models, keyed by provider key id. */
  modelsBySection: Record<string, ModelView[]>;
  /** The types each model is the default for, keyed by model id. */
  defaultTypesByModel: Record<string, ModelTypeValue[]>;
  onDraftChange: (draft: CardDraft) => void;
  /** The admin ticked or unticked a capability chip. */
  onToggleCapability: (capability: CapabilityDef, on: boolean) => void;
  onProtocolChange: (section: ProviderCardSectionView, next: ProviderProtocol) => void;
  onRefreshModels: (section: ProviderCardSectionView) => void;
  onAddModel: (section: ProviderCardSectionView) => void;
  onEditModel: (section: ProviderCardSectionView, model: ModelView) => void;
  onDeleteModel: (section: ProviderCardSectionView, modelId: string) => void;
  onToggleModel: (section: ProviderCardSectionView, modelId: string, enabled: boolean) => void;
}
```

The component renders:

1. `ProviderHeaderBar` with the card (name, built-in/custom tag, the vendor slug, the enable switch, the test button, the save button).
2. The card's **name field** (the card's display name) with the hint that renaming changes the qualified model name.
3. The **capability chips**: one toggle per entry of `CAPABILITIES`, in order. A chip is ON when the card has a section for that capability. The chip's label is `t(capability.labelKey)`.
4. One `CapabilitySection` per section of the card, in `CAPABILITIES` order, so the LLM section is always first and the image section last. A section whose capability has no chip on (a card with an `openai` and an `anthropic` section) still renders — every section of the card must be reachable.

- Produces — `web/src/pages/providersModels/ProviderHeaderBar.tsx` (rewritten):

```tsx
interface Props {
  card: ProviderCardView;
  canManage: boolean;
  busy: boolean;
  /** Whether the connection test applies. Only a chat section has an
   * endpoint to probe; a card without one has nothing to test. */
  canTest?: boolean;
  onTest: () => void;
  onSave: () => void;
  onToggleEnabled: (enabled: boolean) => void;
}
```

It renders the brand square, the card's display name (`card.label ?? providerDisplayName(card.provider)`), the built-in / custom tag (`card.isBuiltin`), the vendor slug in mono, the enable `Switch`, the test button and the save button.

- [ ] **Step 1: Write the failing test**

Create `web/tests/pages/providersModels/ProviderCard.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import type { ProviderCardView } from '../../../src/api/providerCards';
import { ProviderCard } from '../../../src/pages/providersModels/ProviderCard';

const card = (over: Partial<ProviderCardView> = {}): ProviderCardView => ({
  id: 'c1',
  provider: 'minimax',
  label: 'MiniMax',
  createdAt: '2026-01-01T00:00:00Z',
  isBuiltin: true,
  enabled: true,
  sections: [
    {
      providerKeyId: 'k-llm',
      protocol: 'openai',
      label: null,
      endpoint: 'https://api.minimaxi.com/v1',
      enabled: true,
      isBuiltin: true,
      codingPlan: false,
      apiKeyMasked: 'sk-…abcd',
      modelCount: 9,
    },
    {
      providerKeyId: 'k-img',
      protocol: 'image-gen',
      label: 'MiniMax 图像生成',
      endpoint: 'https://api.minimaxi.com',
      enabled: true,
      isBuiltin: false,
      codingPlan: false,
      apiKeyMasked: 'sk-…abcd',
      modelCount: 2,
    },
  ],
  ...over,
});

function renderCard(over: Partial<Parameters<typeof ProviderCard>[0]> = {}) {
  const onToggleCapability = vi.fn();
  const onDraftChange = vi.fn();
  render(
    <ProviderCard
      card={card()}
      canManage={true}
      busy={false}
      modelsBySection={{}}
      defaultTypesByModel={{}}
      onDraftChange={onDraftChange}
      onToggleCapability={onToggleCapability}
      onProtocolChange={() => {}}
      onRefreshModels={() => {}}
      onAddModel={() => {}}
      onEditModel={() => {}}
      onDeleteModel={() => {}}
      onToggleModel={() => {}}
      {...over}
    />,
  );
  return { onToggleCapability, onDraftChange };
}

describe('pages/providersModels/ProviderCard', () => {
  test('renders the card name and the vendor slug', () => {
    renderCard();
    expect(screen.getByDisplayValue('MiniMax')).toBeInTheDocument();
    expect(screen.getByText('minimax')).toBeInTheDocument();
  });

  test('renders one chip per capability', () => {
    renderCard();
    expect(screen.getByRole('checkbox', { name: /LLM \(VLM\)/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Image generation/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Video generation/i })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Speech recognition/i })).not.toBeChecked();
  });

  test('ticking an absent capability asks the card to create it', () => {
    const { onToggleCapability } = renderCard();
    fireEvent.click(screen.getByRole('checkbox', { name: /Video generation/i }));
    expect(onToggleCapability).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'video' }),
      true,
    );
  });

  test('unticking a capability asks the card to remove it', () => {
    const { onToggleCapability } = renderCard();
    fireEvent.click(screen.getByRole('checkbox', { name: /Image generation/i }));
    expect(onToggleCapability).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'image' }),
      false,
    );
  });

  test('each section renders its own form', () => {
    renderCard();
    // The LLM section's Base URL and the image section's are both present.
    expect(screen.getByDisplayValue('https://api.minimaxi.com/v1')).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://api.minimaxi.com')).toBeInTheDocument();
  });
});
```

The chips are checkboxes with accessible names — use `role="checkbox"` with the capability label as the accessible name.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server/web && npx vitest run tests/pages/providersModels/ProviderCard.test.tsx`
Expected: FAIL — `Cannot find module '../../../src/pages/providersModels/ProviderCard'`.

- [ ] **Step 3: Implement `ProviderCard.tsx` and rewrite `ProviderHeaderBar.tsx`**

`ProviderCard.tsx`:

- The name field is a controlled input seeded from `card.label ?? providerDisplayName(card.provider)`. It pushes `CardDraft` up on mount and after every change, and it keeps a per-section map of drafts (each `CapabilitySection` pushes its own `SectionDraft` up through the card's `onDraftChange`).
- The capability chips are `<input type="checkbox">` elements inside `<label>`s, so the accessible name is the capability label.
- A chip is ON when `card.sections.some((s) => capabilityForProtocol(s.protocol)?.id === capability.id)`.
- The sections render in `CAPABILITIES` order; a card with two sections for the same capability renders both.

`ProviderHeaderBar.tsx`: rewrite per the Interfaces block. `onTest` and `onSave` no longer take an id (the card is the subject). The enable switch calls `onToggleEnabled`.

- [ ] **Step 4: Delete `ProviderInfoCard.tsx` and its test**

```bash
git rm enterprise_server/web/src/pages/providersModels/ProviderInfoCard.tsx enterprise_server/web/tests/pages/providersModels/ProviderInfoCard.test.tsx
```

Every assertion the deleted test made that still applies moves into the new tests:

| Deleted assertion | New home |
|---|---|
| the name / Base URL render with initial values | `ProviderCard.test.tsx` ("renders the card name and the vendor slug") |
| the masked-key hint and the keep-current hint | `CapabilitySection.test.tsx` ("the masked key hint is shown") |
| the draft is pushed up on mount / on typing | `CapabilitySection.test.tsx` ("pushes the field values up to the card on mount", "a typed key lands in the draft") |
| there is no save button on the form | `CapabilitySection.test.tsx` — add `expect(screen.queryByRole('button', { name: /^Save$/i })).toBeNull();` |
| choosing a protocol auto-fills the Base URL | `CapabilitySection.test.tsx` — the section asks the card instead (`onProtocolChange`), and the CARD applies the new default Base URL; add a test in `ProviderCard.test.tsx` that a protocol switch resets the section's Base URL draft to `defaultBaseUrlFor(slug, next)` |
| the name defaults to the slug when no label is stored | `ProviderCard.test.tsx` |
| the inputs are disabled without manage rights | `CapabilitySection.test.tsx` ("the inputs are disabled without manage rights") |
| the API-key eye toggle | `CapabilitySection.test.tsx` |
| every protocol is offered and the row's one is checked | `CapabilitySection.test.tsx` — the LLM section offers openai + anthropic; the media sections offer none |
| a non-chat protocol keeps its Base URL untouched | `CapabilitySection.test.tsx` — the media section renders the stored endpoint |
| a non-chat protocol gets the API root | `capabilities.test.ts` ("a non-chat protocol gets the API root, not a /v1 URL") |
| the media model editor and its parsing | **deleted with the feature** — the model table replaces it (Task P1-11 removes the legacy field) |

- [ ] **Step 5: Update `ProviderHeaderBar.test.tsx`**

Read the existing test and rewrite it for the card props: it renders the card's display name, the built-in tag for a built-in card, the enable switch, the test button only when `canTest`, and the save button only when `canManage`.

- [ ] **Step 6: Add the i18n keys**

`en`:
```ts
'providersModels.card.capabilities': 'Capability types',
'providersModels.card.capabilityLlm': 'LLM (VLM)',
'providersModels.card.capabilityAsr': 'Speech recognition',
'providersModels.card.capabilityImage': 'Image generation',
'providersModels.card.capabilityVideo': 'Video generation',
'providersModels.card.name': 'Provider name',
'providersModels.card.nameHint': 'The name is the prefix of the qualified model id (vendor/model). Renaming it changes that id.',
```
`zh`:
```ts
'providersModels.card.capabilities': '能力类型',
'providersModels.card.capabilityLlm': 'LLM(VLM)',
'providersModels.card.capabilityAsr': '语音识别',
'providersModels.card.capabilityImage': '图像生成',
'providersModels.card.capabilityVideo': '视频生成',
'providersModels.card.name': '服务商名称',
'providersModels.card.nameHint': '名称会作为模型限定名的前缀（厂商/模型），改名会改变限定名。',
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd enterprise_server/web && npx vitest run tests/pages/providersModels/ProviderCard.test.tsx tests/pages/providersModels/ProviderHeaderBar.test.tsx tests/pages/providersModels/CapabilitySection.test.tsx`
Expected: PASS — all green.

- [ ] **Step 8: Commit**

```bash
git add enterprise_server/web/src/pages/providersModels/ProviderCard.tsx enterprise_server/web/src/pages/providersModels/ProviderHeaderBar.tsx enterprise_server/web/src/i18n.ts enterprise_server/web/tests/pages/providersModels/ProviderCard.test.tsx enterprise_server/web/tests/pages/providersModels/ProviderHeaderBar.test.tsx
git commit -m "feat(console): add the vendor card shell"
```

---

### Task P1-8: The rail lists cards

**Files:**
- Modify: `web/src/pages/providersModels/ProviderRail.tsx`
- Modify: `web/tests/pages/providersModels/ProviderRail.test.tsx` (rewrite)

**Interfaces:**
- Consumes: `ProviderCardView` (Task P1-2), `capabilityForProtocol` (Task P1-3), `providerDisplayName` / `brandColor` (`web/src/data/providerCatalog.ts`).
- Produces — `web/src/pages/providersModels/ProviderRail.tsx`:

```tsx
interface Props {
  /** The cards, split into the built-in and custom sections by `isBuiltin`. */
  cards: ProviderCardView[];
  /** The model count per card, keyed by card id. */
  modelCounts: Record<string, number>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  canManage: boolean;
  onAddProvider?: () => void;
  /** Delete-confirm flow. Only offered for cards whose sections are all
   * custom — a card with a built-in credential cannot be deleted. */
  onDeleteCard?: (card: ProviderCardView) => void;
  onToggleCard?: (id: string, enabled: boolean) => void;
}
```

Each row shows: the brand square, the card's display name, the capability tags (`LLM · 图像 · 视频` — one small tag per capability the card has), the model-count badge, the enable switch, and — for a card with no built-in section — a delete icon.

The capability tags use a SHORT label per capability. Add a second i18n key per capability for the rail tag:

`en`: `'providersModels.card.tagLlm': 'LLM', 'providersModels.card.tagAsr': 'ASR', 'providersModels.card.tagImage': 'Image', 'providersModels.card.tagVideo': 'Video'`
`zh`: `'providersModels.card.tagLlm': 'LLM', 'providersModels.card.tagAsr': '语音', 'providersModels.card.tagImage': '图像', 'providersModels.card.tagVideo': '视频'`

Add a `tagLabelKey` to `CapabilityDef` in `capabilities.ts` (Task P1-3's file) so the rail does not hardcode a mapping:

```ts
  /** The i18n key of the SHORT label the rail tag uses. */
  tagLabelKey: string;
```

with `tagLlm` / `tagAsr` / `tagImage` / `tagVideo` respectively.

- [ ] **Step 1: Write the failing test**

Rewrite `web/tests/pages/providersModels/ProviderRail.test.tsx` against the card props:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import type { ProviderCardView } from '../../../src/api/providerCards';
import { ProviderRail } from '../../../src/pages/providersModels/ProviderRail';

const card = (over: Partial<ProviderCardView> = {}): ProviderCardView => ({
  id: 'c1',
  provider: 'minimax',
  label: 'MiniMax',
  createdAt: '2026-01-01T00:00:00Z',
  isBuiltin: true,
  enabled: true,
  sections: [
    { providerKeyId: 'k1', protocol: 'openai', label: null, endpoint: null, enabled: true, isBuiltin: true, codingPlan: false, apiKeyMasked: null, modelCount: 9 },
  ],
  ...over,
});

const cards = [
  card(),
  card({ id: 'c2', provider: 'vllm', label: 'vllm', isBuiltin: false, sections: [] }),
];

const renderRail = (props: Partial<Parameters<typeof ProviderRail>[0]> = {}) =>
  render(
    <ProviderRail
      cards={cards}
      modelCounts={{ c1: 9 }}
      selectedId={null}
      onSelect={() => {}}
      canManage={true}
      onDeleteCard={vi.fn()}
      onToggleCard={vi.fn()}
      {...props}
    />,
  );

describe('pages/providersModels/ProviderRail', () => {
  test('renders both sections and one row per card', () => {
    renderRail();
    expect(screen.getByPlaceholderText(/Search/i)).toBeInTheDocument();
    expect(screen.getByText(/Built-in/)).toBeInTheDocument();
    expect(screen.getByText('MiniMax')).toBeInTheDocument();
    expect(screen.getByText('vllm')).toBeInTheDocument();
  });

  test('a card shows its capability tags and model count', () => {
    renderRail();
    expect(screen.getByText('LLM')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
  });

  test('filters by search text', () => {
    renderRail();
    fireEvent.change(screen.getByPlaceholderText(/Search/i), { target: { value: 'vll' } });
    expect(screen.queryByText('MiniMax')).not.toBeInTheDocument();
  });

  test('a card with a built-in section has no delete button', () => {
    renderRail();
    const builtinRow = screen.getByText('MiniMax').closest('[role="button"]')!;
    expect(builtinRow.querySelector('[aria-label="delete-provider"]')).toBeNull();
  });

  test('a fully custom card has a delete button', () => {
    renderRail();
    const customRow = screen.getByText('vllm').closest('[role="button"]')!;
    expect(customRow.querySelector('[aria-label="delete-provider"]')).not.toBeNull();
  });

  test('the enable switch reports the new state', () => {
    const onToggleCard = vi.fn();
    renderRail({ onToggleCard });
    fireEvent.click(screen.getAllByRole('switch')[0]);
    expect(onToggleCard).toHaveBeenCalledWith('c1', false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server/web && npx vitest run tests/pages/providersModels/ProviderRail.test.tsx`
Expected: FAIL — the rail still takes `providers`, not `cards`.

- [ ] **Step 3: Implement the rail**

Rewrite `ProviderRail.tsx` against the card props. The row markup is the existing one with three changes: the name comes from `card.label ?? providerDisplayName(card.provider)`, the capability tags are inserted before the count badge, and the delete button appears only when `card.sections.every((s) => !s.isBuiltin)` (a card with no sections at all is custom and deletable).

- [ ] **Step 4: Add the `tagLabelKey` and the i18n keys**

Add `tagLabelKey` to `CapabilityDef` in `capabilities.ts` and the four tag keys to both dictionaries (en + zh, as listed above).

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd enterprise_server/web && npx vitest run tests/pages/providersModels/ProviderRail.test.tsx tests/pages/providersModels/capabilities.test.ts`
Expected: PASS — all green.

- [ ] **Step 6: Commit**

```bash
git add enterprise_server/web/src/pages/providersModels/ProviderRail.tsx enterprise_server/web/src/pages/providersModels/capabilities.ts enterprise_server/web/src/i18n.ts enterprise_server/web/tests/pages/providersModels/ProviderRail.test.tsx
git commit -m "feat(console): list vendor cards in the rail"
```

---

### Task P1-9: The model drawer locks the types and sets the defaults

**Files:**
- Modify: `web/src/pages/providersModels/ModelDrawer.tsx`
- Modify: `web/tests/pages/ModelDrawer.test.tsx` (extend)

**Interfaces:**
- Consumes: `ModelTypes` / `ModelTypeValue` (Task P1-2), `typeValueLabel` (Task P1-4).
- Produces:
  - `ModelDrawer` gains three props:

```ts
  /** The model types this section allows. When provided, the type grid shows
   * only these; a single-type section locks its one type on. */
  allowedTypes?: ModelTypeValue[];
  /** The types this model is currently the default for. */
  defaultTypes?: ModelTypeValue[];
```

  - `ModelSavePayload` gains:

```ts
  /** The default-model changes the admin made in the drawer. The page applies
   * them AFTER the model is saved (a new model has no id until then). */
  defaultChanges: Array<{ type: ModelTypeValue; isDefault: boolean }>;
  /** The model's parameter spec (a free-form object the vendor documents).
   * `undefined` leaves it alone. */
  parameterSpec?: Record<string, unknown>;
```

  - The drawer gains a **parameter spec** field, shown only for the media /
    speech types (`image-gen`, `video-gen`, `asr`): a `<textarea>` holding JSON,
    validated on blur (a non-object or malformed JSON shows an inline error
    and is not saved). The console's `ModelDrawer` has no JSON editor today,
    and the legacy `mediaModels` textarea it replaces was the only place a
    parameter spec could be set — deleting that field without this one makes
    the value read-only, and the desktop prints it to the LLM as "Supported
    parameters".

  - The type grid: when `allowedTypes` is provided, only those types render. A type that is in `allowedTypes` AND the model already carries it renders **locked** (the checkbox is checked and disabled) — the model cannot leave the capability it was created in.
  - Each SELECTED type carries a "set as default" / "unset default" toggle button. Its state is local: `defaultChanges` is seeded from `defaultTypes` and updated by the toggle.
  - The parameter spec textarea is seeded from `model?.parameter_spec` and
    parsed on save. A malformed value keeps the drawer open with an inline
    error — the admin's other edits are not lost.

- [ ] **Step 1: Write the failing tests**

Extend `web/tests/pages/ModelDrawer.test.tsx` (read it first; it already has a render helper):

```tsx
test('the type grid is locked to the section the model belongs to', () => {
  render(<ModelDrawer open model={null} providerId="k1" provider="minimax" busy={false}
    allowedTypes={['image-gen']} onSave={() => {}} onClose={() => {}} />);
  // Only the image type is offered, and it is locked on.
  expect(screen.getByText('Image Gen')).toBeInTheDocument();
  expect(screen.queryByText('Chat')).toBeNull();
  expect(screen.getByRole('checkbox')).toBeChecked();
  expect(screen.getByRole('checkbox')).toBeDisabled();
});

test('the default toggle rides the type chip', async () => {
  let saved: ModelSavePayload | null = null;
  render(<ModelDrawer open model={null} providerId="k1" provider="minimax" busy={false}
    allowedTypes={['image-gen']} onSave={(p) => { saved = p; }} onClose={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: /Set as default/i }));
  fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'image-01' } });
  fireEvent.change(screen.getByLabelText(/Model ID/i), { target: { value: 'image-01' } });
  fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
  await waitFor(() => expect((saved as ModelSavePayload).defaultChanges).toEqual([{ type: 'image-gen', isDefault: true }]));
});

test('a model that is already the default offers to unset it', () => {
  render(<ModelDrawer open model={someModel} providerId="k1" provider="minimax" busy={false}
    defaultTypes={['image-gen']} onSave={() => {}} onClose={() => {}} />);
  expect(screen.getByRole('button', { name: /Unset default/i })).toBeInTheDocument();
});

test('a media model can carry a parameter spec', async () => {
  let saved: ModelSavePayload | null = null;
  render(<ModelDrawer open model={null} providerId="k1" provider="minimax" busy={false}
    allowedTypes={['image-gen']} onSave={(p) => { saved = p; }} onClose={() => {}} />);
  fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'image-01' } });
  fireEvent.change(screen.getByLabelText(/Model ID/i), { target: { value: 'image-01' } });
  fireEvent.change(screen.getByLabelText(/Parameter spec/i), {
    target: { value: '{"size":"1024x1024"}' },
  });
  fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
  await waitFor(() =>
    expect((saved as ModelSavePayload).parameterSpec).toEqual({ size: '1024x1024' }),
  );
});

test('a malformed parameter spec blocks the save', () => {
  let saved: ModelSavePayload | null = null;
  render(<ModelDrawer open model={null} providerId="k1" provider="minimax" busy={false}
    allowedTypes={['image-gen']} onSave={(p) => { saved = p; }} onClose={() => {}} />);
  fireEvent.change(screen.getByLabelText(/Parameter spec/i), { target: { value: '{oops' } });
  fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
  expect(saved).toBeNull();
  expect(screen.getByText(/not valid json/i)).toBeInTheDocument();
});
```

The exact label lookups follow the file's existing conventions — read `web/tests/pages/ModelDrawer.test.tsx` and reuse its queries for the name / model-id fields and the save button.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server/web && npx vitest run tests/pages/ModelDrawer.test.tsx`
Expected: FAIL — the drawer renders all 9 types, has no default toggle, and the payload has no `defaultChanges`.

- [ ] **Step 3: Implement the drawer changes**

In `web/src/pages/providersModels/ModelDrawer.tsx`:

- Add the `allowedTypes` / `defaultTypes` props and the `defaultChanges` payload field.
- The type grid renders `allowedTypes ?? MODEL_TYPE_VALUES`.
- The initial `types` state: `model ? model.types : (allowedTypes ?? ['chat'])`.
- A type is locked when `allowedTypes?.length === 1` and it is that type — the checkbox is `checked` and `disabled`.
- Each selected type renders a toggle button under its label: `t('providersModels.model.setDefault')` when it is not the default, `t('providersModels.model.unsetDefault')` when it is. The button is a real `<button type="button">` (not a checkbox) so its accessible name is the label.
- `defaultChanges` state: `Record<ModelTypeValue, boolean>` seeded from `defaultTypes` (true = default) and `allowedTypes`/the model's types. The payload carries only the entries the admin TOGGLED, so the page does not re-apply untouched defaults:

```ts
const defaultChanges = Object.entries(toggled)
  .filter(([type, changed]) => changed)
  .map(([type, isDefault]) => ({ type: type as ModelTypeValue, isDefault }));
```

  Track "toggled" separately from the seeded state so a model that was already the default and was never touched produces no change.

- [ ] **Step 4: Add the i18n keys**

`en`:
```ts
'providersModels.model.setDefault': 'Set as default',
'providersModels.model.unsetDefault': 'Unset default',
'providersModels.drawer.desc.video-gen': 'Generates videos from text or images.',
'providersModels.drawer.parameterSpec': 'Parameter spec',
'providersModels.drawer.parameterSpecHint': 'A JSON object of the parameters this model accepts, e.g. {"size":"1024x1024"}. The agent is told about them.',
'providersModels.drawer.parameterSpecInvalid': 'The parameter spec is not valid JSON.',
```
`zh`:
```ts
'providersModels.model.setDefault': '设为默认',
'providersModels.model.unsetDefault': '取消默认',
'providersModels.drawer.desc.video-gen': '根据文本或图像生成视频。',
'providersModels.drawer.parameterSpec': '参数规格',
'providersModels.drawer.parameterSpecHint': '该模型支持的参数，JSON 对象，例如 {"size":"1024x1024"}，会告知智能体。',
'providersModels.drawer.parameterSpecInvalid': '参数规格不是合法的 JSON。',
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd enterprise_server/web && npx vitest run tests/pages/ModelDrawer.test.tsx`
Expected: PASS — all green.

- [ ] **Step 6: Commit**

```bash
git add enterprise_server/web/src/pages/providersModels/ModelDrawer.tsx enterprise_server/web/src/i18n.ts enterprise_server/web/tests/pages/ModelDrawer.test.tsx
git commit -m "feat(console): lock model types per capability and set defaults"
```

---

### Task P1-10: The page reads cards

The rewiring. The page's data source becomes the card list, and every mutation is re-pointed at a card or a section.

**Files:**
- Create: `web/src/pages/providersModels/useProviderCardDrafts.ts`
- Modify: `web/src/pages/ProvidersModelsPage.tsx`
- Modify: `web/tests/pages/ProvidersModelsPage.test.tsx` (rewrite)

**Interfaces:**
- Consumes: everything from Tasks P1-2 … P1-9.
- Produces — `web/src/pages/providersModels/useProviderCardDrafts.ts`:

```ts
import { useCallback, useRef, useState } from 'react';

import type { ModelTypeValue } from '../../api/models';
import type { CapabilityId } from './capabilities';
import type { SectionDraft } from './CapabilitySection';

export interface ProviderCardDrafts {
  /** The card's display name. */
  label: string;
  /** The per-section drafts, keyed by the section's provider key id (or, for
   * a card that does not exist yet, by the capability id). */
  sections: Record<string, SectionDraft>;
  /** The types the admin toggled the default on / off, keyed by model id. */
  defaultToggles: Record<string, Record<ModelTypeValue, boolean>>;
}

export interface UseProviderCardDrafts {
  drafts: ProviderCardDrafts;
  /** Replace the whole draft (used when the selection changes). */
  reset: (draft: ProviderCardDrafts) => void;
  setLabel: (label: string) => void;
  setSectionDraft: (key: string, draft: SectionDraft) => void;
  toggleDefault: (modelId: string, type: ModelTypeValue, isDefault: boolean) => void;
  clearDefaultToggles: () => void;
}

export function useProviderCardDrafts(initial?: Partial<ProviderCardDrafts>): UseProviderCardDrafts;
```

The hook holds the draft state for ONE selected card. `reset` is called when the selection changes. `setSectionDraft` merges one section's draft. `toggleDefault` records a default change for the page to apply after a save.

- Produces — `web/src/pages/ProvidersModelsPage.tsx` (rewritten):

**Queries**

```ts
const cardsQ = useQuery({ queryKey: ['provider-cards', orgId], queryFn: () => providerCardsApi.list(orgId) });
const modelsQ = useQuery({ queryKey: ['models', orgId], queryFn: () => modelsApi.list(orgId) });
const defaultsQ = useQuery({ queryKey: ['model-type-defaults', orgId], queryFn: () => modelTypeDefaultsApi.list(orgId) });
```

`invalidate()` invalidates all three.

**Derived data**

- `cards` = `cardsQ.data ?? []`.
- `defaultTypesByModel`: from `defaultsQ.data` → `{ [modelId]: ModelTypeValue[] }` (a model can be the default for several types).
- `modelsBySection`: `{ [providerKeyId]: ModelView[] }` — group `models` by `m.provider_key_id`.
- `modelCounts`: `{ [cardId]: number }` — the sum of the card's sections' model counts (from `modelsBySection`).
- The selected card: `cards.find((c) => c.id === selectedId)`, or a **draft card** when `selectedId` starts with `custom-`:

```ts
const draftCard: ProviderCardView = {
  id: selectedId,
  provider: drafts.slug,
  label: drafts.label,
  createdAt: new Date(0).toISOString(),
  isBuiltin: false,
  enabled: false,
  sections: [],
};
```

**Mutations** (each invalidates and toasts)

| Mutation | Call | When |
|---|---|---|
| `saveCardMut` | `providerCardsApi.patch(card.id, { label })` then, for each section with a draft, `providersApi.patch(section.providerKeyId, { baseUrl, codingPlan, ...(apiKey ? { apiKey } : {}) })` | The card's 保存 button |
| `createCardMut` | `providerCardsApi.create({ orgId, provider: slug, label })` → then one `providersApi.add({ orgId, cardId, provider: slug, protocol, endpoint, ...(apiKey ? { apiKey } : {}), codingPlan })` per checked capability | 保存 on a draft card |
| `addSectionMut` | `providersApi.add({ orgId, cardId, provider: card.provider, protocol: capability.protocol, endpoint: defaultBaseUrlFor(card.provider, capability.protocol) })` | A capability chip is ticked |
| `removeSectionMut` | `providersApi.remove(section.providerKeyId)` | A capability chip is unticked (after the confirm) |
| `switchProtocolMut` | `providersApi.patch(section.providerKeyId, { protocol })` | The protocol radio (after the confirm) |
| `toggleCardMut` | `providerCardsApi.patch(card.id, { enabled })` | The card's enable switch |
| `deleteCardMut` | `providerCardsApi.remove(card.id)` | The rail's delete button (after the confirm) |
| `setDefaultMut` | `modelsApi.patch(modelId, { defaultForType: { type, isDefault } }, orgId)` | The drawer's default toggle, applied after the model save |
| `refreshMut` | `providersApi.refreshModels(section.providerKeyId)` | A section's 获取模型 |
| `saveModelMut` | `modelsApi.add(...)` / `modelsApi.patch(...)`, then one `setDefaultMut` per `defaultChanges` entry | The model drawer's save |

**The confirms** (the styled `ConfirmDialog`, not `window.confirm`):

- Untick a capability → title `providersModels.card.removeTitle`, message `providersModels.card.removeMessage` with `{name}` = the capability label and `{n}` = the section's model count. Confirm → `removeSectionMut`.
- Untick a **built-in** capability → NO dialog. Show a toast with `providersModels.card.builtinLocked` and instead call `providersApi.setEnabled(section.providerKeyId, false)` (disable it). The built-in credential cannot be deleted.
- Switch a protocol → title `providersModels.card.switchProtocolTitle`, message `providersModels.card.switchProtocolMessage` with `{n}` = the section's model count. Confirm → `switchProtocolMut`.

**The new-card flow**: the rail's "+ Add provider" creates a local draft (`custom-<ts>`). The draft card shows a **slug** field next to the name (the slug is the vendor identifier: it picks the brand color and the default Base URL; it defaults to a slugified name, and to `custom` when the name has no ASCII). The slug is part of the draft state, so `ProviderCardDrafts` gains `slug: string`.

- [ ] **Step 1: Write the failing test**

Rewrite `web/tests/pages/ProvidersModelsPage.test.tsx`. The fetch mock keys on the route prefix, so the new endpoints are mocked the same way:

```tsx
function mockFetchData(cards: ProviderCardView[], models: unknown[] = [], defaults: unknown[] = []) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/admin/provider-cards')) {
      return Promise.resolve(new Response(JSON.stringify(cards), { status: 200 }));
    }
    if (url.startsWith('/admin/model-type-defaults')) {
      return Promise.resolve(new Response(JSON.stringify(defaults), { status: 200 }));
    }
    if (url.startsWith('/admin/provider-keys')) {
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    }
    if (url.startsWith('/admin/models')) {
      return Promise.resolve(new Response(JSON.stringify(models), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
}
```

The tests:

1. **the page lists cards, not credential rows** — one card in the mock → the rail shows the card's name, and the detail pane shows the card's capability chips.
2. **ticking a capability creates the section** — click the "Video generation" chip → the mock records a `POST /admin/provider-keys` whose body has `cardId: 'c1'` and `protocol: 'video-gen'`.
3. **unticking a custom capability asks first, then deletes** — click the "Image generation" chip → a confirm dialog appears mentioning the model count → confirm → `DELETE /admin/provider-keys/<id>`.
4. **unticking a built-in capability does not delete** — the built-in LLM chip → NO delete request; a toast says the capability cannot be removed; the section is disabled instead (`POST /admin/provider-keys/<id>/disable`).
5. **switching the protocol asks first** — click the "Anthropic compatible" radio → a confirm dialog mentioning the model count → confirm → `PATCH /admin/provider-keys/<id>` with `{ protocol: 'anthropic' }`.
6. **the model table shows the default badge** — a model in the mock with `defaultTypesByModel` → the badge is in the DOM.
7. **saving a section sends the Base URL and the typed key** — type into the section's Base URL and API Key, click 保存 → `PATCH /admin/provider-keys/<id>` with `{ baseUrl, apiKey }`.
8. **the card's enable switch toggles the card** — click the switch → `PATCH /admin/provider-cards/<id>` with `{ enabled: false }`.
9. **a media section still shows its model table** — the image section's table header ("Model" / "Type" / "Context window") is in the DOM, and its "fetch models" button is disabled rather than the table being hidden.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server/web && npx vitest run tests/pages/ProvidersModelsPage.test.tsx`
Expected: FAIL — the page still queries `/admin/provider-keys` and renders the old rail.

- [ ] **Step 3: Implement the hook**

Create `web/src/pages/providersModels/useProviderCardDrafts.ts` per the Interfaces block. `setSectionDraft` must merge, not replace:

```ts
const setSectionDraft = useCallback((key: string, draft: SectionDraft) => {
  setState((prev) => ({ ...prev, sections: { ...prev.sections, [key]: draft } }));
}, []);
```

- [ ] **Step 4: Rewrite the page**

Apply the design above. Keep the page's existing structure (header, rail, detail pane, drawer, confirm dialog) and its existing toasts; replace the data source and the mutations.

**Remove the page-level chat-protocol gate.** The old page renders the model
table only when `isChatProtocol(draft.protocol)` — a condition on the UNSAVED
draft protocol that hides the WHOLE table for every media section, and that
flickers the table away the moment the admin touches the protocol radio. The
model table now lives inside each section, so the gate has no meaning: the
section always renders its table, and only the "fetch models" button is
disabled for a non-chat protocol (Task P1-5). Delete the `isChatProtocol(...) &&`
wrapper and the `isChatProtocol` import if nothing else uses it.

The page must keep working for a read-only admin (`canManage === false`): the chips, the radios and the inputs are disabled, and the mutations are not reachable.

The page's `busy` flag covers every mutation, so a save in flight disables the whole card.

**Do not delete the `MediaDrawer`/model-drawer wiring**: the drawer is now opened PER SECTION. The page holds:

```ts
const [drawerSection, setDrawerSection] = useState<{
  providerKeyId: string;
  protocol: ProviderProtocol;
  allowedTypes: ModelTypeValue[];
} | null>(null);
```

and passes `allowedTypes` to the drawer, plus `defaultTypes` from `defaultTypesByModel[model.id]`.

- [ ] **Step 5: Add the i18n keys**

`en`:
```ts
'providersModels.card.removeTitle': 'Remove capability',
'providersModels.card.removeMessage': 'Removing "{name}" deletes its {n} models. This cannot be undone.',
'providersModels.card.builtinLocked': 'Built-in capabilities cannot be removed — disable them instead.',
'providersModels.card.switchProtocolTitle': 'Switch protocol',
'providersModels.card.switchProtocolMessage': 'Switching the protocol clears the {n} models in this capability. Fetch them again afterwards.',
'providersModels.card.slug': 'Vendor id',
'providersModels.card.slugHint': 'The vendor id picks the default Base URL. It is part of the qualified model id.',
'providersModels.card.newTitle': 'Add a provider',
```
`zh`:
```ts
'providersModels.card.removeTitle': '移除能力',
'providersModels.card.removeMessage': '移除「{name}」会删除其 {n} 个模型，此操作不可撤销。',
'providersModels.card.builtinLocked': '内置能力不可移除，请改为停用该分区。',
'providersModels.card.switchProtocolTitle': '切换协议',
'providersModels.card.switchProtocolMessage': '切换协议会清空该分区的 {n} 个模型，需要重新获取模型。',
'providersModels.card.slug': '服务商标识',
'providersModels.card.slugHint': '标识决定默认 Base URL，也是模型限定名的一部分。',
'providersModels.card.newTitle': '添加服务商',
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd enterprise_server/web && npx vitest run tests/pages/ProvidersModelsPage.test.tsx`
Expected: PASS — all green.

- [ ] **Step 7: Run the whole console suite**

Run: `cd enterprise_server/web && npx vitest run`
Expected: PASS — no failures. Any test that still asserts the old rail / info card / media-model textarea is updated in place (the deleted `ProviderInfoCard.test.tsx` is already gone).

- [ ] **Step 8: Commit**

```bash
git add enterprise_server/web/src/pages/ProvidersModelsPage.tsx enterprise_server/web/src/pages/providersModels/useProviderCardDrafts.ts enterprise_server/web/src/i18n.ts enterprise_server/web/tests/pages/ProvidersModelsPage.test.tsx
git commit -m "feat(console): configure a vendor through one card"
```

---

### Task P1-11: The legacy media-model field and the P0-7 bridge are gone

**Files:**
- Delete: `enterprise_server/src/models/legacyMediaModels.ts`
- Delete: `enterprise_server/tests/models/legacyMediaModels.test.ts`
- Modify: `enterprise_server/src/vault/providerKeyVault.ts` (drop the bridge calls)
- Modify: `enterprise_server/src/routes/admin/providerKeys.ts` (the POST and PATCH routes ignore `config.models`)
- Test: `enterprise_server/tests/routes/providerKeysV2.test.ts` (extend)

**Interfaces:**
- Consumes: `model_catalog` (P0-2), the console's model table (Task P1-10).
- Produces: `provider_keys.config.models` is no longer written and no longer mirrored. The media model list lives ONLY in `model_catalog`.

- [ ] **Step 1: Write the failing test**

Extend `enterprise_server/tests/routes/providerKeysV2.test.ts`:

```ts
test('写入 config.models 不会改动模型清单', async () => {
  // A key with one image-gen model in model_catalog.
  // PATCH /admin/provider-keys/:id { config: { models: [{ modelId: 'other' }] } }
  // → the catalog still has exactly its original row ('image-01'), not 'other'.
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/routes/providerKeysV2.test.ts`
Expected: FAIL — the P0-7 bridge mirrors `config.models` into the catalog, so the catalog gains `other`.

- [ ] **Step 3: Remove the bridge**

- Delete `enterprise_server/src/models/legacyMediaModels.ts` and its test.
- In `enterprise_server/src/vault/providerKeyVault.ts`, remove the `syncLegacyMediaModels` import and both call sites (the one in `add` and the one in `patch` — the `patch` one only fired when `config` was part of the patch).
- In `enterprise_server/src/routes/admin/providerKeys.ts`:
  - The `POST /admin/provider-keys` handler: strip `models` from the incoming `config` before it reaches the vault, so a legacy client cannot write the field. The ASR daily cap (`config.limitSecondsToday`) and any other key survives.
  - The `PATCH /admin/provider-keys/:id` handler: same — strip `models` from the incoming `config`.

  Stripping (rather than rejecting) keeps an old cached console bundle working: its save is accepted, and the model table simply does not change. The admin's next action in the new console re-adds the models properly.

  Only `models` is stripped. `config.limitSecondsToday` (the ASR daily quota,
  read by `enterprise_server/src/asr/quota.ts`), `config.sampleRate` (read by
  the ASR relay) and every other key survive the strip — they are not part of
  the model list and this phase does not move them.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd enterprise_server && npx vitest run tests/routes/providerKeysV2.test.ts`
Expected: PASS — all green.

- [ ] **Step 5: Remove the dead console copy**

- Delete the now-unused `providersModels.mediaModels.label` / `.placeholder` / `.hint` keys from both dictionaries in `web/src/i18n.ts`. Grep first:

```bash
cd enterprise_server/web && grep -rn "providersModels.mediaModels" src/ tests/
```

The grep must come back empty before the keys are removed.

- [ ] **Step 6: Commit**

```bash
git add -A enterprise_server/src/models enterprise_server/src/vault/providerKeyVault.ts enterprise_server/src/routes/admin/providerKeys.ts enterprise_server/tests enterprise_server/web/src/i18n.ts
git commit -m "feat(console): drop the legacy media model field"
```

---

### Task P1-12: Verification

**Files:** none — this task verifies the phase.

- [ ] **Step 1: Run the server suite**

Run: `cd enterprise_server && npx vitest run`
Expected: PASS. If the sandbox hits a file-descriptor limit (a known flake in this repo), run the suite per file and report which files were run.

- [ ] **Step 2: Run the console suite**

Run: `cd enterprise_server/web && npx vitest run`
Expected: PASS.

- [ ] **Step 3: Type-check the console**

Run: `cd enterprise_server/web && npx tsc --noEmit -p tsconfig.json`
Expected: no errors. The `Record<ModelTypeValue, string>` maps in `modelType.tsx` and `ModelDrawer.tsx` fail to compile if a type is missing — that is the point of the `video-gen` addition.

- [ ] **Step 3b: Type-check the server**

Run: `cd enterprise_server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Update the visual spec**

`enterprise_server/web/tests/visual/providers.spec.ts` is a Playwright visual spec against the running console. It still expects the old rail (one row per credential) and the old info card. Update it to the card layout:

- The rail shows one row per CARD (a vendor with 4 capabilities is ONE row, not four).
- The detail pane shows the card's capability chips and one section per capability.
- The image section's model table lists the media models with their type chips (the media models are no longer a textarea).

If the visual spec cannot run in this environment (it needs a live server and seeded data), say so in the report rather than skipping it silently — and still update the spec file so it matches the new UI.

- [ ] **Step 5: Manual check against the running console**

Start the console and confirm by hand:

1. A vendor with 4 capabilities (MiniMax) renders as ONE rail row with 4 chips.
2. Unchecking the image capability asks for a confirmation that names the model count, then removes the section AND its models.
3. The image section's model table shows the media models with the 图像生成 type chip.
4. Toggling 设为默认 on a media model puts the 默认 badge on that model's type chip, and the badge disappears from the other models of the same type.
5. Switching the LLM protocol asks for a confirmation that names the model count; confirming clears the section's models.

- [ ] **Step 6: Commit**

```bash
git add enterprise_server/web/tests/visual/providers.spec.ts
git commit -m "test(console): update the provider visual spec for the card layout"
```

---

## Done criteria

- The console's rail lists one row per VENDOR CARD, with the card's capabilities, its model count and its enable switch.
- A card offers exactly four capability chips (LLM(VLM) / speech recognition / image generation / video generation). Ticking one creates a section with its own Base URL, API Key and model table; unticking one deletes it (after a confirmation) — except a built-in section, which can only be disabled.
- The LLM section single-selects openai / anthropic; switching asks for a confirmation and clears the section's models.
- EVERY capability's models are read from `model_catalog` and rendered with the same table (model / type / context window / enabled / actions). The legacy one-id-per-line textarea is gone, and `provider_keys.config.models` is no longer written or read.
- The default model for a type carries a 默认 badge on its type chip in the table, and the model drawer can set and unset it.
- A media model added through the drawer carries its capability's type (image-gen / video-gen / asr) and never leaks into the chat model pickers.
- Both the `zh` and `en` dictionaries carry every new string, and no user-visible string is hardcoded in a component.
- The server suite, the console suite and both type-checks pass.
