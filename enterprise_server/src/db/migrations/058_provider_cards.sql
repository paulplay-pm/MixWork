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
