-- enterprise_server/src/db/migrations/049_drop_sso_legacy_auth_flow.sql
-- Migration 049: remove the `legacy_auth_flow` column added by 048.
--
-- Why this "un-migration" exists:
--   048 added a per-connection boolean to fall DingTalk back to the
--   legacy `oapi.dingtalk.com/connect/oauth2/sns_authorize` flow when
--   corp-level `Contact.User.Read` approval is unavailable. It shipped
--   to the dev database only (production never ran 048).
--
--   The fallback was then rejected: the legacy endpoint renders a
--   form-style username/password page when the browser holds no
--   DingTalk cookie, whereas the modern
--   `login.dingtalk.com/oauth2/auth` endpoint renders the QR-scan
--   challenge page. Degrading the login UX to recover from a
--   permissions problem is the wrong trade — an org that cannot obtain
--   corp-level approval should not advertise the provider instead.
--
--   Keeping 048 would leave a column no code reads and a migration
--   file describing an escape hatch we deliberately removed, which
--   invites someone to re-introduce it. So 048 is deleted and this
--   migration cleans up the dev database that already applied it.
--
-- Idempotency:
--   `DROP COLUMN IF EXISTS` — a no-op on any database that never ran
--   048 (production, fresh installs, pglite test fixtures).

ALTER TABLE sso_connections
  DROP COLUMN IF EXISTS legacy_auth_flow;
