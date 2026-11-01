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
-- `config->'models'` is NULL when the key has no `models` array, and
-- `jsonb_array_elements(NULL)` raises instead of returning zero rows, so
-- coalesce it first.
--
-- The parentheses around `(m->>'modelId')` are load-bearing: `||` and `->>`
-- are both "any other operator" in Postgres, so `a || m->>'x'` would parse
-- as `(a || m) ->> 'x'` and fail with "operator does not exist: text ->>".
INSERT INTO model_catalog (
  id, org_id, provider_key_id, provider, model, display_name,
  type, types, parameter_spec, enabled, created_at
)
SELECT
  'm:' || md5(k.org_id || ':' || k.id || ':' || (m->>'modelId')),
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
