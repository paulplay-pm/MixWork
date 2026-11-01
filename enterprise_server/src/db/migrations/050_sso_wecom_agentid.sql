-- enterprise_server/src/db/migrations/050_sso_wecom_agentid.sql
-- Migration 050: WeCom (企业微信) support — agentid column + field corrections.
--
-- Why this migration exists:
--   WeCom's `connect/oauth2/authorize` rejected every login with
--   「AppID 参数错误」 because two independent problems stacked:
--
--   (a) The authorize URL needs `appid=<CorpID>`, not the OIDC-standard
--       `client_id`. Verified by direct probe: sending `client_id=`
--       yields the GBK-encoded error page 「AppID 参数错误」, while
--       `appid=wwFAKE…` gets past parameter validation (the response
--       changes to 「请在企业微信客户端打开链接」 — i.e. the parameter
--       name was accepted and only the value was bogus).
--
--   (b) WeCom needs BOTH a CorpID and an AgentId for 企业内部自建应用
--       ("自建应用" — scope snsapi_base/userinfo requires `agentid` in
--       the authorize URL). MixWork's `sso_connections` only had a
--       `client_id` column, so admins pasted their AgentId there (the
--       dev row held `1000017`, a 7-digit AgentId, not a CorpID —
--       CorpIDs look like `ww` + 16 alphanumerics). There was nowhere
--       to put the CorpID.
--
--   This migration adds `agentid` so `client_id` can hold the real
--   CorpID (matching every other provider's semantics) and `agentid`
--   holds the AgentId. It also corrects the scope and identity-field
--   spellings:
--     * `scopes`: `snsapi_private_info` → `snsapi_base`.
--       WeCom's spelling has NO underscore between "private" and
--       "info" (`snsapi_privateinfo`), and more importantly
--       `privateinfo` requires manual user consent plus the
--       「成员敏感信息」 permission for phone/email — none of which
--       SSO login needs. `snsapi_base` is the silent scope that
--       returns the identity id.
--     * `identity_id_field`: the response casing differs between
--       WeCom's two endpoints (`user/getuserinfo` returns `UserId`,
--       `auth/getuserinfo` returns `userid`); `oauth.ts` accepts both
--       spellings, so the stored value is the canonical `UserId` from
--       the `user/` endpoint and either works.
--     * `login_name_field`: was empty. WeCom's identity response has
--       no display name (only an id), so this stays empty — display
--       names come from the contacts API, not from SSO login. Leaving
--       it blank means `finishCallback` records `loginName = null`,
--       which the strict-mode / JIT paths both tolerate.
--
-- WeCom's token flow is also two-step, not the single RFC-6749 code
-- exchange: `cgi-bin/gettoken` mints an app-level access_token from
-- `corpid`+`corpsecret`, and `cgi-bin/auth/getuserinfo` then trades the
-- OAuth code for the user identity. `oauth.ts` grew a
-- `provider_type === 'wecom'` branch implementing that sequence; this
-- migration only fixes the stored column values.

ALTER TABLE sso_connections
  ADD COLUMN IF NOT EXISTS agentid TEXT;

-- Scope: `snsapi_base` (silent) instead of `snsapi_private_info`
-- (manual consent + contacts-sensitivity permission, and misspelled —
-- WeCom spells it `snsapi_privateinfo` with no separator).
UPDATE sso_connections
   SET scopes = 'snsapi_base',
       updated_at = now()
 WHERE provider_type = 'wecom'
   AND scopes IS DISTINCT FROM 'snsapi_base';

-- Identity id field: canonical `UserId` spelling. `oauth.ts` accepts
-- both `UserId` and `userid` so either endpoint's casing resolves.
UPDATE sso_connections
   SET identity_id_field = 'UserId',
       updated_at = now()
 WHERE provider_type = 'wecom'
   AND identity_id_field IS DISTINCT FROM 'UserId';

-- Login-name field: WeCom's identity payload carries no display name.
-- Leave explicitly NULL rather than leaving a stale value that would
-- resolve to nothing on every login.
UPDATE sso_connections
   SET login_name_field = NULL,
       updated_at = now()
 WHERE provider_type = 'wecom'
   AND login_name_field IS NOT NULL;
