-- enterprise_server/src/db/migrations/051_wecom_qrconnect_authorize_url.sql
-- Migration 051: point WeCom authorize at the PC scan-code endpoint.
--
-- Why this migration exists:
--   `open.weixin.qq.com/connect/oauth2/authorize` refuses any request
--   that isn't the WeChat / WeCom client, answering with the GBK-encoded
--   page 「请在企业微信客户端打开链接」. Probed on 2026-10-21 with a
--   desktop Chrome User-Agent: HTTP 200 + that error page. Neither the
--   web console (a normal browser tab) nor the desktop client (a
--   Chromium BrowserWindow, also not the WeCom client) can satisfy that
--   check, so the flow was unreachable for both surfaces.
--
--   `open.work.weixin.qq.com/wwopen/sso/qrConnect` is WeCom's PC
--   scan-code endpoint: it renders the 「企业微信登录」 page with a QR
--   code the user scans with the WeCom mobile app. Same probe: HTTP 200,
--   `<title>企业微信登录</title>`. Same `appid` + `agentid` +
--   `redirect_uri` + `state` contract, so nothing else about the
--   connection changes — `exchangeCode`'s two-hop WeCom branch consumes
--   the same `?code=…&state=…` callback either way.
--
--   `scope` is NOT sent to `qrConnect` (it does not accept it and always
--   returns the id-only identity set), which is why the
--   `identity_id_field` / `login_name_field` corrections from migration
--   050 remain the right ones.
--
-- Operator prerequisite (outside this migration): the corp must have
-- 「企业微信授权登录」 enabled and the 「授权回调域名」 must list the
-- server origin's host[:port] exactly (e.g. `127.0.0.1:8787` — port
-- included, no scheme).
--
-- Idempotency: only touches rows still pointing at the old in-app
-- endpoint, and the constant is pinned in `oauth.ts` too, so a row that
-- somehow keeps a custom URL still resolves to the QR flow.

UPDATE sso_connections
   SET authorize_url = 'https://open.work.weixin.qq.com/wwopen/sso/qrConnect',
       updated_at    = now()
 WHERE provider_type = 'wecom'
   AND authorize_url IS DISTINCT FROM 'https://open.work.weixin.qq.com/wwopen/sso/qrConnect';
