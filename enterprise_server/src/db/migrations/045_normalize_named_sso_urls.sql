-- enterprise_server/src/db/migrations/045_normalize_named_sso_urls.sql
-- Migration 045: normalize URLs for named-provider SSO connections.
--
-- Why this migration exists:
--   Login via Feishu (and the other named Chinese providers) was failing
--   after a database restore/replace with "登录会话已过期或无效，请重试".
--   The login page maps many server error codes (`token_exchange_failed`,
--   `userinfo_failed:*`, `id_token_aud_mismatch`, `missing_external_id`,
--   etc.) to the generic `sso.error.stateInvalid` message, so the user
--   sees the same opaque "session expired" string regardless of which
--   of those errors actually fired. When `authorize_url` / `token_url` /
--   `userinfo_url` in `sso_connections` are wrong, the consumer
--   (`enterprise_server/src/sso/oauth.ts → exchangeCode / fetchUserInfo`)
--   fetches a non-IdP endpoint and returns one of those generic codes →
--   identical user-visible symptom, no clue in the message.
--
--   The canonical URLs live in `enterprise_server/src/sso/providerPresets.ts`
--   (and the web-side mirror `enterprise_server/web/src/pages/sso/presets.ts`,
--   which the SSO Connection Drawer pre-fills when an admin picks a named
--   provider type). They mirror the Feishu / DingTalk / WeCom public
--   documentation and are the same values the form would save today on a
--   fresh create. This migration brings existing rows in line with that
--   canonical source so a database swap/restore no longer costs a manual
--   SQL UPDATE per provider.
--
-- Scope:
--   * Named providers whose URLs are deterministic in the preset:
--       feishu / dingtalk / wecom — all three URLs are normalized.
--   * azure-ad — left alone. Its `authorize_url` and `token_url` are
--     per-tenant (`https://login.microsoftonline.com/{tenant}/...`); the
--     preset publishes the `{tenant}` placeholder, not a working URL,
--     so we cannot normalize an existing row without knowing the admin's
--     tenant. Admins on Azure who hit the same symptom must re-PATCH
--     their connection with the correct tenant URL.
--
-- Idempotency:
--   The `WHERE` clause only matches rows where the URL is NULL or differs
--   from the preset value, so re-running this migration against an already
--   normalized row is a no-op. `updated_at` is bumped to now() when an
--   actual change happens (so admin audit logs show the change).

-- feishu ---------------------------------------------------------------
UPDATE sso_connections
   SET authorize_url = 'https://open.feishu.cn/open-apis/authen/v1/index',
       token_url     = 'https://open.feishu.cn/open-apis/authen/v1/access_token',
       userinfo_url  = 'https://open.feishu.cn/open-apis/authen/v1/user_info',
       updated_at    = now()
 WHERE provider_type = 'feishu'
   AND (
       authorize_url IS DISTINCT FROM 'https://open.feishu.cn/open-apis/authen/v1/index'
    OR token_url     IS DISTINCT FROM 'https://open.feishu.cn/open-apis/authen/v1/access_token'
    OR userinfo_url  IS DISTINCT FROM 'https://open.feishu.cn/open-apis/authen/v1/user_info'
   );

-- dingtalk -------------------------------------------------------------
UPDATE sso_connections
   SET authorize_url = 'https://oapi.dingtalk.com/connect/oauth2/sns_authorize',
       token_url     = 'https://oapi.dingtalk.com/sns/getuserinfo_bycode',
       userinfo_url  = 'https://oapi.dingtalk.com/sns/getuserinfo_bycode',
       updated_at    = now()
 WHERE provider_type = 'dingtalk'
   AND (
       authorize_url IS DISTINCT FROM 'https://oapi.dingtalk.com/connect/oauth2/sns_authorize'
    OR token_url     IS DISTINCT FROM 'https://oapi.dingtalk.com/sns/getuserinfo_bycode'
    OR userinfo_url  IS DISTINCT FROM 'https://oapi.dingtalk.com/sns/getuserinfo_bycode'
   );

-- wecom ----------------------------------------------------------------
UPDATE sso_connections
   SET authorize_url = 'https://open.weixin.qq.com/connect/oauth2/authorize',
       token_url     = 'https://qyapi.weixin.qq.com/cgi-bin/gettoken',
       userinfo_url  = 'https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo',
       updated_at    = now()
 WHERE provider_type = 'wecom'
   AND (
       authorize_url IS DISTINCT FROM 'https://open.weixin.qq.com/connect/oauth2/authorize'
    OR token_url     IS DISTINCT FROM 'https://qyapi.weixin.qq.com/cgi-bin/gettoken'
    OR userinfo_url  IS DISTINCT FROM 'https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo'
   );
