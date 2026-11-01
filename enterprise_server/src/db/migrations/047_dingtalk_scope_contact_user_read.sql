-- enterprise_server/src/db/migrations/047_dingtalk_scope_contact_user_read.sql
-- Migration 047: DingTalk scope → include Contact.User.Read.
--
-- Why this migration exists:
--   DingTalk's `GET /v1.0/contact/users/me` userinfo endpoint is
--   permission-gated. Without `Contact.User.Read` in both:
--     1. the scope passed to `/oauth2/auth`, and
--     2. the corp admin-approved permission on the DingTalk backend
--   …the endpoint returns
--     `Forbidden.AccessDenied.AccessTokenPermissionDenied` (HTTP 403,
--     `requiredScopes: ["Contact.User.Read"]`). Observed in production
--   on 2026-10-19 right after migration 046 landed: token exchange
--   succeeded (got an `accessToken`), then `/contact/users/me` 403'd →
--   audit reason `userinfo_failed:403`, which LoginPage renders as
--   the generic "登录会话已过期或无效" string.
--
--   The fix is two-sided:
--     * DingTalk 后台 → 权限管理 → 申请 → 通讯录权限 → 成员信息读权限
--       (corp admin auto-approves for self-built apps in dev mode;
--       production rollout needs corp admin manual approval).
--     * MixCWork side — this migration adds `Contact.User.Read` to
--       `scopes` for every DingTalk row. The OAuth2 scope parameter
--       takes space-separated values, so the column stores
--       `openid Contact.User.Read` verbatim. URLSearchParams handles
--       the encoding when `buildAuthorizeUrl` emits it.
--
-- Idempotency:
--   `IS DISTINCT FROM` guard; already-updated rows are no-op.
--   Admin-customised scopes (e.g. `openid profile email`) are
--   preserved verbatim — only the bare `openid` value from the v046
--   preset gets upgraded.

UPDATE sso_connections
   SET scopes     = 'openid Contact.User.Read',
       updated_at = now()
 WHERE provider_type = 'dingtalk'
   AND scopes = 'openid';
