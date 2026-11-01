-- Migration 060: remember a section's own state while its card is switched off.
--
-- The card's master switch used to disable every section and, on the way
-- back, re-enable every section that has an API key. That loses the admin's
-- per-section choice: a section deliberately switched off came back on, and
-- its catalog rows silently re-entered the model fallback candidate set.
--
-- `enabled_before_master` is NULL whenever the card is on. Switching the card
-- off stores the section's own `enabled` there and clears `enabled`; switching
-- the card back on restores exactly the stored value (and still requires a
-- key — a keyless section cannot authenticate).
ALTER TABLE provider_keys
  ADD COLUMN IF NOT EXISTS enabled_before_master BOOLEAN;
