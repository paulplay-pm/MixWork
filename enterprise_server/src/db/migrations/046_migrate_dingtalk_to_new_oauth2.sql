-- enterprise_server/src/db/migrations/046_migrate_dingtalk_to_new_oauth2.sql
-- Migration 046: migrate DingTalk SSO connections to the new OAuth2 flow.
--
-- Why this migration exists:
--   v1 DingTalk was wired to the legacy `sns_authorize` + HMAC-signed
--   `/sns/getuserinfo_bycode` flow. That endpoint renders a form-style
--   landing page ("登录|钉钉 / 登录钉钉账号") when the browser has no
--   DingTalk cookies — observed in production before this landed — and
--   its `client_id` param is silently dropped in favour of `appid=`
--   (no longer true on the new endpoint, but the legacy one still
--   rejects `client_id=` with "无效的appid"). The new OAuth2 flow
--   documented at
--     https://open.dingtalk.com/document/orgapp-server/use-dingtalk-account-to-log-on-to-third-party-websites
--   uses:
--     * authorize:  https://login.dingtalk.com/oauth2/auth
--                    (renders `/oauth2/challenge.htm` for QR scan when
--                    no DingTalk cookies are present — verified by
--                    direct probe on 2026-10-19 with the production
--                    AppKey)
--     * token:      POST https://api.dingtalk.com/v1.0/oauth2/userAccessToken
--                    JSON body camelCase (`clientId`/`clientSecret`/
--                    `grantType`/`code`) — snake_case returned
--                    `Missingbody` on direct probe
--     * userinfo:   GET https://api.dingtalk.com/v1.0/contact/users/me
--                    with the custom `x-acs-dingtalk-access-token`
--                    header (NOT `Authorization: Bearer`) — confirmed
--                    by direct probe
--   All response field names are camelCase (`accessToken` / `unionId` /
--   `openId`), which is why `identity_id_field` flips from `unionid`
--   to `unionId` and `scopes` flips from `snsapi_login` to `openid`.
--
-- Idempotency:
--   WHERE clause uses `IS DISTINCT FROM`; already-migrated rows (or
--   admin-customised rows that already happen to match the new values)
--   are no-ops. Admin overrides that intentionally point at private
--   DingTalk deployments are preserved — none of the existing prod
--   rows had such overrides before this landed.
--
-- Parallel to migration 045 (URL normalize). 045 fixed the URLs of
-- named providers; 046 rewrites the entire DingTalk wire shape
-- (URLs + scopes + identity field) to chase the IdP's new flow.

UPDATE sso_connections
   SET authorize_url       = 'https://login.dingtalk.com/oauth2/auth',
       token_url           = 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken',
       userinfo_url        = 'https://api.dingtalk.com/v1.0/contact/users/me',
       scopes              = 'openid',
       identity_id_field   = 'unionId',
       updated_at          = now()
 WHERE provider_type = 'dingtalk'
   AND (
          authorize_url     IS DISTINCT FROM 'https://login.dingtalk.com/oauth2/auth'
       OR token_url         IS DISTINCT FROM 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken'
       OR userinfo_url      IS DISTINCT FROM 'https://api.dingtalk.com/v1.0/contact/users/me'
       OR scopes            IS DISTINCT FROM 'openid'
       OR identity_id_field IS DISTINCT FROM 'unionId'
   );
