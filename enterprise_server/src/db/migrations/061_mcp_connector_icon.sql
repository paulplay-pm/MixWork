-- Migration 061: give an MCP connector a brand icon.
--
-- The connector had no way to carry a logo, so every connector reached the
-- desktop as the same generic glyph — the catalog entry, the installed card
-- and the chat input's connector list all looked alike, and a member
-- scanning the list had to read the name to tell them apart.
--
-- The icon is a URL (the same shape the retired built-in marketplace used),
-- not an uploaded asset: the desktop renders it as an <img> and falls back
-- to the generic glyph when it cannot be loaded.
ALTER TABLE mcp_connectors
  ADD COLUMN IF NOT EXISTS icon TEXT;
