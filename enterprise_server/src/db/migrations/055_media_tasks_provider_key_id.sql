-- Migration 055: media_tasks.provider_key_id.
--
-- The media worker has to find the provider ROW, not the vendor slug:
-- `provider` is a display name and several rows can share it, so resolving
-- by it picked a wrong or nonexistent key and failed every async task. The
-- row id is what the task actually needs.
--
-- This DDL used to live at the end of 054, which was a mistake: 054 had
-- already been applied (and recorded in the `_migrations` ledger) by every
-- deployed database, and the runner skips a file whose NAME is in the
-- ledger. Editing an applied file therefore changes nothing on an existing
-- database — the column never appears, and both the generate route and the
-- worker's claim query fail with
-- `column "provider_key_id" does not exist`. A schema change that is not in
-- a NEW file has not happened anywhere.
--
-- Re-run safe: IF NOT EXISTS throughout, so a database that already got the
-- column from the old 054 is a no-op here.

ALTER TABLE media_tasks ADD COLUMN IF NOT EXISTS provider_key_id TEXT;

CREATE INDEX IF NOT EXISTS media_tasks_provider_key_idx
  ON media_tasks (provider_key_id)
  WHERE provider_key_id IS NOT NULL;
