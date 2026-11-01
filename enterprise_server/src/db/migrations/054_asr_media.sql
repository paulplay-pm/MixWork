-- Migration 054: ASR + media support on the enterprise server.
--
-- 1. provider_keys gains `config` (JSONB) and its `protocol` CHECK widens.
--    `protocol` is the ADAPTER REGISTRY KEY, not a vendor: `openai` /
--    `anthropic` stay for chat, and `realtime-asr` / `image-gen` / `video-gen`
--    are the non-LLM adapters. Keeping them in one table is the whole point —
--    an ASR or image provider is just another upstream credential in the
--    console's existing 模型管理, not a new config surface.
-- 2. asr_daily_usage meters the server's authoritative daily seconds. `day` is
--    a calendar date the caller resolves in the USER's zone first (see
--    `org/timezone.quotaWindowDate`), so the reset boundary matches the rest
--    of the product.
-- 3. media_tasks tracks generation jobs. `idempotency_key` is UNIQUE per org
--    because the desktop sends `Idempotency-Key` on generate and a DB-level
--    guarantee is the only one that survives a restart or a second replica.
--    `status` spells `cancelled` with two l's to match the desktop's terminal
--    set — a one-l spelling there makes the client poll forever.
--
-- Re-run safe: IF NOT EXISTS / DROP IF EXISTS throughout, so pglite's replay
-- and a re-applied deploy are both fine.

-- --- 1. provider_keys: config column + widened protocol domain ---

ALTER TABLE provider_keys ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}'::jsonb;

-- The 031 CHECK was added inline on ADD COLUMN, so Postgres auto-named it.
ALTER TABLE provider_keys DROP CONSTRAINT IF EXISTS provider_keys_protocol_check;
ALTER TABLE provider_keys DROP CONSTRAINT IF EXISTS provider_keys_protocol_check1;

ALTER TABLE provider_keys
  ADD CONSTRAINT provider_keys_protocol_check
  CHECK (protocol IN ('openai', 'anthropic', 'realtime-asr', 'image-gen', 'video-gen'));

-- --- 2. ASR daily usage ---

CREATE TABLE IF NOT EXISTS asr_daily_usage (
  org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day          DATE NOT NULL,
  used_seconds INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, user_id, day)
);

-- --- 3. Media tasks ---

CREATE TABLE IF NOT EXISTS media_tasks (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  model            TEXT NOT NULL,
  prompt           JSONB NOT NULL DEFAULT '{}'::jsonb,
  status           TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  provider         TEXT,
  upstream_task_id TEXT,
  result           JSONB,
  error            JSONB,
  idempotency_key  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Claim path for the worker: "next queued job in this org", ordered by age.
CREATE INDEX IF NOT EXISTS media_tasks_claim_idx
  ON media_tasks (status, created_at)
  WHERE status = 'queued';

-- Per-org task lookup. NOT unique on id (that is the primary key) — this
-- exists so a status poll never scans the whole table.
CREATE INDEX IF NOT EXISTS media_tasks_org_created_idx
  ON media_tasks (org_id, created_at DESC);

-- Idempotency: NULL keys must not collide with each other, and Postgres
-- treats NULLs as distinct in a unique index, so partial-unique is the
-- correct shape here — one task per (org, key) when a key was sent.
CREATE UNIQUE INDEX IF NOT EXISTS media_tasks_idempotency_idx
  ON media_tasks (org_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- `video-gen` joins the model-type vocabulary (model_catalog.types has no
-- CHECK; the closed set lives in src/models/modelCatalog.ts).