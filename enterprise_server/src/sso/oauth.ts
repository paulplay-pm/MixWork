// enterprise_server/src/sso/oauth.ts
//
// v1 implementation notes — wire-format compatibility for named providers:
//
// The generic OIDC/OAuth2 paths (buildAuthorizeUrl + exchangeCode +
// fetchUserInfo + verifyIdToken) cover the v1 contract for `generic-oidc`,
// `generic-oauth2`, and `azure-ad` (Azure AD is plain OIDC). Named
// Chinese IdPs each have their own wire format that diverges from RFC
// 6749 — they fail silently with HTTP 200 + a `{code:N,...}` error body,
// which the generic code mis-reads as a successful empty token. The
// catch-all mapping (audit trail reason → http-level symptom → user-visible
// on /login) is:
//
//   redirect_uri mismatch / state used  →  sso_state_invalid
//   wire-format reject from IdP          →  token_exchange_no_access_token
//                                          (LoginPage.tsx maps this to
//                                          sso.error.stateInvalid, which
//                                          is the "登录会话已过期或无效,
//                                          请重试" string the user sees)
//
// Per-provider status:
//
//   * feishu  — implemented. Branches on `c.provider_type === 'feishu'`
//               in `buildAuthorizeUrl` (sends `app_id`, drops PKCE) and
//               in `exchangeCode` (JSON body with `app_id`/`app_secret`,
//               unwraps the `data` envelope). `fetchUserInfo` already had
//               the `data` unwrap for Feishu userinfo.
//
//   * dingtalk — implemented (modern OAuth2 flow).
//                authorize:  https://login.dingtalk.com/oauth2/auth
//                            emits `client_id=`, scope `openid
//                            Contact.User.Read`
//                token:      POST https://api.dingtalk.com/v1.0/oauth2/userAccessToken
//                            JSON body, camelCase (`clientId`/
//                            `clientSecret`/`grantType`/`code`),
//                            reads `accessToken` (camelCase)
//                userinfo:   GET  https://api.dingtalk.com/v1.0/contact/users/me
//                            via header `x-acs-dingtalk-access-token`
//                            (NOT `Authorization: Bearer`), flat JSON
//                            `{nick, unionId, openId}` response
//                Gives users the QR-scan challenge page
//                (`/oauth2/challenge.htm`) instead of the legacy
//                form-style login page.
//
//                This flow requires the `Contact.User.Read` permission
//                approved at corp level; without it the userinfo call
//                returns 403 and the audit reason is
//                `userinfo_failed:403:code=Forbidden.AccessDenied.
//                 AccessTokenPermissionDenied:message=…`.
//                There is NO server-side fallback to the legacy
//                `oapi.dingtalk.com` flow: its login page is
//                form-style (username/password) rather than QR-scan
//                when the browser has no DingTalk cookie, which is a
//                worse end-user experience. An org that cannot obtain
//                corp-level approval should not advertise this provider
//                on its login page.
//
//   * wecom — implemented. Three divergences from RFC 6749, all verified
//            by direct probe against the real endpoints:
//            * authorize URL: WeCom ships two. The in-app one
//              (`open.weixin.qq.com/connect/oauth2/authorize`) rejects
//              any non-WeCom User-Agent with 「请在企业微信客户端打开链接」,
//              which makes it unreachable from a browser tab or the
//              desktop client's Chromium window. `buildAuthorizeUrl`
//              therefore uses `open.work.weixin.qq.com/wwopen/sso/qrConnect`
//              — WeCom's PC scan-code page, which renders a QR code for
//              any browser. Both need `appid=<CorpID>` (sending
//              `client_id=` yields 「AppID 参数错误」) and a mandatory
//              `agentid`; `qrConnect` additionally ignores `scope`
//              (the identity set is id-only regardless).
//            * `agentid` is mandatory in the authorize URL for a
//              企业内部自建应用 (corp-internal self-built app), so the
//              connection carries its own `agentid` column (migration
//              050); `client_id` holds the CorpID (`ww` + 16 chars).
//            * code exchange is TWO hops, not one: `cgi-bin/gettoken`
//              mints an APP-LEVEL token from corpid+corpsecret (it
//              never sees the OAuth code — probing it with a bogus
//              corpid returns `errcode:40013 invalid corpid`), then
//              `cgi-bin/auth/getuserinfo?access_token&code` trades the
//              code for the identity. `exchangeCode`'s wecom branch
//              makes both calls and returns the identity inline under
//              `raw`, so `finishCallback.ts` reads it from there
//              instead of issuing a redundant userinfo fetch.
//            WeCom's two endpoints disagree on response casing
//            (`user/` returns `UserId`, `auth/` returns `userid`), so
//            the branch mirrors both spellings onto one object and
//            `identity_id_field` matches either.
//
//   * azure-ad — works as-is. Standard OIDC.
//
// Any time a named provider's preset URLs or wire shape change, run
// `enterprise_server/tests/sso/oauth.test.ts` to confirm `generic-oidc`
// behaviour hasn't regressed; each named provider has its own describe
// block next to it.
//
// (See docs/superpowers/specs/2026-09-27-enterprise-sso-member-login-federation-design.md
//  for the v1 IdP contract.)
import { TextEncoder } from 'node:util';

import { type JWTPayload,jwtVerify } from 'jose';

import type { SsoConnectionRow } from './types';

/**
 * WeCom's PC scan-code login endpoint. A protocol constant, not a
 * per-connection setting: `open.weixin.qq.com/connect/oauth2/authorize`
 * refuses non-WeCom User-Agents outright (「请在企业微信客户端打开链接」)
 * so a PC browser — which is where both the web console and the desktop
 * client's embedded BrowserWindow run — can never complete that flow.
 */
const WECOM_QR_CONNECT_URL =
  'https://open.work.weixin.qq.com/wwopen/sso/qrConnect';

export function buildAuthorizeUrl(
  c: SsoConnectionRow,
  state: string,
  codeChallenge?: string,
  redirectUri?: string,
): string {
  const u = new URL(c.authorize_url!);
  u.searchParams.set('response_type', 'code');
  // Feishu's `authen/v1/index` expects the app identifier as `app_id`,
  // not the OIDC-standard `client_id`. PKCE is not part of Feishu's
  // authen/v1 flow either (the server has its own anti-replay window on
  // the auth code). Sending `client_id` + PKCE params makes Feishu
  // ignore the canonical OAuth params and return `{code:20001, msg:
  // "invalid request"}` after the user authenticates — observed in
  // production before this branch landed.
  if (c.provider_type === 'feishu') {
    if (c.client_id) u.searchParams.set('app_id', c.client_id);
    if (redirectUri) u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('state', state);
    if (c.scopes) u.searchParams.set('scope', c.scopes);
    return u.toString();
  }
  // WeCom (企业微信) PC QR-code login.
  //
  // WeCom has TWO authorize endpoints and only one of them works in a
  // normal desktop browser:
  //   * `open.weixin.qq.com/connect/oauth2/authorize` — the in-app
  //     endpoint. It checks the User-Agent and REFUSES anything that
  //     isn't the WeChat / WeCom client, answering with the GBK-encoded
  //     page 「请在企业微信客户端打开链接」. Probed on 2026-10-21 with a
  //     desktop Chrome UA: HTTP 200 + that error page. Unusable for both
  //     the web console (a plain browser tab) and the desktop client
  //     (a Chromium BrowserWindow, which is likewise not WeCom).
  //   * `open.work.weixin.qq.com/wwopen/sso/qrConnect` — the PC scan-code
  //     endpoint. Renders the 「企业微信登录」 page with a QR code the
  //     user scans with the WeCom mobile app. Same probe: HTTP 200,
  //     `<title>企业微信登录</title>`.
  //
  // Both endpoints need the CorpID as `appid` (NOT `client_id` — sending
  // `client_id` yields 「AppID 参数错误」, also probed) plus a mandatory
  // `agentid` for a 企业内部自建应用. `qrConnect` additionally does NOT
  // accept `response_type` / `scope` (it always runs the code flow and
  // always returns the id-only identity set), and does not support PKCE.
  //
  // The URL is built from the pinned constant rather than the connection's
  // `authorize_url` for the same reason the DingTalk legacy path used
  // pinned endpoints: `qrConnect` is a protocol constant, and a row that
  // still points at the in-app endpoint (pre-migration-051) would keep
  // hitting the User-Agent wall.
  if (c.provider_type === 'wecom') {
    const qu = new URL(WECOM_QR_CONNECT_URL);
    if (c.client_id) qu.searchParams.set('appid', c.client_id);
    // Mandatory for a 自建应用; omitted when NULL so a 第三方应用
    // (which identifies by suite rather than agent) still works.
    if (c.agentid) qu.searchParams.set('agentid', c.agentid);
    if (redirectUri) qu.searchParams.set('redirect_uri', redirectUri);
    qu.searchParams.set('state', state);
    return qu.toString();
  }
  u.searchParams.set('client_id', c.client_id ?? '');
  u.searchParams.set('redirect_uri', redirectUri ?? 'http://localhost/callback');
  u.searchParams.set('state', state);
  if (c.scopes) u.searchParams.set('scope', c.scopes);
  if (codeChallenge) {
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
  }
  return u.toString();
}

export interface ExchangeResult {
  accessToken: string;
  idToken?: string;
  raw: Record<string, unknown>;
}

export async function exchangeCode(
  c: SsoConnectionRow,
  code: string,
  codeVerifier?: string,
  clientSecretDecrypted?: string,
  redirectUri?: string,
): Promise<ExchangeResult> {
  // Feishu's `authen/v1/access_token` endpoint uses its own wire format:
  //   * JSON request body — not form-encoded (Feishu silently strips form
  //     fields and returns `{code:20001, msg:"empty grant_type"}`,
  //     which this generic code path would otherwise mis-read as a
  //     successful response with no access_token).
  //   * `app_id` / `app_secret` fields — NOT `client_id` and NOT Basic
  //     auth on the `Authorization` header (Feishu ignores the auth
  //     header; sending it is harmless but useless).
  //   * PKCE `code_verifier` is not part of Feishu's flow; we omit it.
  //   * Successful response body is `{code:0, msg:"ok", data:{access_token,
  //     refresh_token, expires_in}}` — the top-level `access_token` the
  //     generic path expects is nested under `data`, which is why even
  //     a fix that switched to JSON-with-client_id would still 404.
  // The Feishu-only branch keeps the v1 generic-OAuth2 path untouched for
  // everything else (Azure AD / generic-oidc / generic-oauth2) and
  // returns the same ExchangeResult shape callers downstream already
  // expect.
  if (c.provider_type === 'feishu') {
    const body: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
    };
    if (c.client_id) body.app_id = c.client_id;
    if (clientSecretDecrypted) body.app_secret = clientSecretDecrypted;
    const r = await fetch(c.token_url!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`token_exchange_failed:${r.status}`);
    const json = (await r.json()) as {
      code?: number;
      msg?: string;
      data?: { access_token?: string; refresh_token?: string; expires_in?: number };
      access_token?: string;  // kept for forward-compat defensive parsing
    };
    // Feishu's `code` field is the API error code (NOT the OIDC
    // `authorization_code`). Non-zero means failure; record it as the
    // audit reason so an admin can see `token_exchange_feishu_code:20003:…`
    // instead of the opaque `token_exchange_no_access_token`.
    if (typeof json.code === 'number' && json.code !== 0) {
      throw new Error(
        `token_exchange_feishu_code:${json.code}:${json.msg ?? 'unknown'}`,
      );
    }
    const accessToken = String(json.data?.access_token ?? json.access_token ?? '');
    if (!accessToken) throw new Error('token_exchange_no_access_token');
    return { accessToken, raw: json as Record<string, unknown> };
  }

  // DingTalk (new OAuth2 flow documented at
  //   https://open.dingtalk.com/document/orgapp-server/use-dingtalk-account-to-log-on-to-third-party-websites).
  // The legacy HMAC-SHA256 + tmp_auth_code branch was removed when the
  // preset migrated to `api.dingtalk.com/v1.0/oauth2/userAccessToken`
  // because the new flow is plain OAuth2 — different body shape but
  // camelCase throughout. The three things that diverge from RFC 6749
  // are all here:
  //   * body is JSON (`application/json`), NOT `application/x-www-form-urlencoded`.
  //   * field names are camelCase: `clientId` / `clientSecret` / `grantType`
  //     — the snake_case variant returned `Missingbody` on direct probe.
  //   * success response carries `accessToken` (NOT `access_token`),
  //     alongside `refreshToken` / `expiresIn` / optional `corpId`.
  //
  // Scope: the preset ships `openid Contact.User.Read` (see migration
  // 047) — `Contact.User.Read` is required for `/v1.0/contact/users/me`
  // (the second `OAuth2 SSO` flow's userinfo call). Without it, that
  // endpoint returns `Forbidden.AccessDenied.AccessTokenPermissionDenied`
  // and the audit trail fills with `userinfo_failed:403`, which the
  // LoginPage renders as the generic "登录会话已过期或无效" string.
  //
  // Errors: HTTP 4xx → `dingtalk_token_exchange_failed:<status>`; non-zero
  // `code` field in body → `dingtalk_token_exchange_code:<code>:<message>`.
  // Both surface through the audit trail and LoginPage maps them to the
  // generic `sso.error.stateInvalid` for users.
  if (c.provider_type === 'dingtalk') {
    // Modern OAuth2 path (default for DingTalk connections). JSON
    // body, camelCase params (`clientId`/`clientSecret`/`grantType`),
    // response field `accessToken` (camelCase). Wire format is
    // verified by direct probe — see the file-header comment block
    // for `dingtalk` above.
    const body: Record<string, string> = {
      grantType: 'authorization_code',
      code,
    };
    if (c.client_id) body.clientId = c.client_id;
    if (clientSecretDecrypted) body.clientSecret = clientSecretDecrypted;
    const r = await fetch(c.token_url!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`dingtalk_token_exchange_failed:${r.status}`);
    const json = (await r.json()) as {
      accessToken?: string;
      refreshToken?: string;
      expiresIn?: number;
      corpId?: string;
      code?: string;
      message?: string;
    };
    if (typeof json.code === 'string' && json.code && json.code !== '0' && json.code !== 'OK') {
      throw new Error(`dingtalk_token_exchange_code:${json.code}:${json.message ?? 'unknown'}`);
    }
    if (!json.accessToken) throw new Error('dingtalk_token_exchange_no_access_token');
    return {
      accessToken: json.accessToken,
      raw: json as Record<string, unknown>,
    };
  }

  // WeCom's code exchange is TWO steps, neither of which is RFC 6749:
  //   1. `GET /cgi-bin/gettoken?corpid=<CorpID>&corpsecret=<Secret>`
  //      mints an APP-LEVEL `access_token` (this is NOT a code exchange —
  //      it ignores the OAuth code entirely; probing it with a bogus
  //      corpid returns `errcode:40013 invalid corpid`).
  //   2. `GET /cgi-bin/auth/getuserinfo?access_token=<at>&code=<code>`
  //      trades the OAuth code for the user identity, which comes back
  //      inline as `{errcode, errmsg, UserId, OpenId, …}`.
  //
  // We therefore return the identity under `raw` (mirroring what the
  // legacy-DingTalk path used to do) and hand `finishCallback.ts` a
  // placeholder `accessToken` so its generic `fetchUserInfo` branch is
  // bypassed — calling WeCom's userinfo endpoint a second time with a
  // placeholder token would 400.
  if (c.provider_type === 'wecom') {
    if (!clientSecretDecrypted) throw new Error('wecom_app_secret_required');
    const tk = new URL(c.token_url!);
    tk.searchParams.set('corpid', c.client_id ?? '');
    tk.searchParams.set('corpsecret', clientSecretDecrypted);
    const tkRes = await fetch(tk.toString(), { method: 'GET', headers: { accept: 'application/json' } });
    if (!tkRes.ok) throw new Error(`wecom_gettoken_failed:${tkRes.status}`);
    const tkJson = (await tkRes.json()) as {
      errcode?: number; errmsg?: string; access_token?: string;
    };
    if (typeof tkJson.errcode === 'number' && tkJson.errcode !== 0) {
      throw new Error(`wecom_gettoken_code:${tkJson.errcode}:${tkJson.errmsg ?? 'unknown'}`);
    }
    if (!tkJson.access_token) throw new Error('wecom_gettoken_no_access_token');

    const ui = new URL(c.userinfo_url!);
    ui.searchParams.set('access_token', tkJson.access_token);
    ui.searchParams.set('code', code);
    const uiRes = await fetch(ui.toString(), { method: 'GET', headers: { accept: 'application/json' } });
    if (!uiRes.ok) throw new Error(`wecom_getuserinfo_failed:${uiRes.status}`);
    const uiJson = (await uiRes.json()) as {
      errcode?: number; errmsg?: string;
      UserId?: string; userid?: string; OpenId?: string; openid?: string;
      externalUserId?: string;
    };
    if (typeof uiJson.errcode === 'number' && uiJson.errcode !== 0) {
      throw new Error(`wecom_getuserinfo_code:${uiJson.errcode}:${uiJson.errmsg ?? 'unknown'}`);
    }
    // WeCom is inconsistent about casing between its two endpoints:
    // `user/getuserinfo` returns `UserId` / `OpenId`, while
    // `auth/getuserinfo` returns `userid` / `openid`. Mirror both
    // spellings onto one normalized object so a connection's
    // `identity_id_field` resolves regardless of which endpoint the
    // admin pointed `userinfo_url` at (migration 050 stores the
    // canonical `UserId`).
    const uid = uiJson.UserId ?? uiJson.userid;
    const oid = uiJson.OpenId ?? uiJson.openid;
    if (!uid && !oid) throw new Error('wecom_getuserinfo_no_identity');
    return {
      accessToken: 'wecom-direct',
      raw: {
        ...uiJson,
        UserId: uid ?? '',
        userid: uid ?? '',
        OpenId: oid ?? '',
        openid: oid ?? '',
      } as Record<string, unknown>,
    };
  }

  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', code);
  body.set('redirect_uri', redirectUri ?? 'http://localhost/callback');
  if (c.client_id) body.set('client_id', c.client_id);
  if (codeVerifier) body.set('code_verifier', codeVerifier);

  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (clientSecretDecrypted) {
    headers.authorization = 'Basic ' + Buffer.from(`${c.client_id}:${clientSecretDecrypted}`).toString('base64');
  }

  const r = await fetch(c.token_url!, { method: 'POST', headers, body });
  if (!r.ok) throw new Error(`token_exchange_failed:${r.status}`);
  const json = (await r.json()) as Record<string, unknown>;
  const accessToken = String(json.access_token ?? '');
  if (!accessToken) throw new Error('token_exchange_no_access_token');
  return { accessToken, idToken: typeof json.id_token === 'string' ? json.id_token : undefined, raw: json };
}

export async function fetchUserInfo(
  c: SsoConnectionRow,
  accessToken: string,
): Promise<Record<string, unknown>> {
  // DingTalk's new `/v1.0/contact/users/me` endpoint does NOT accept
  // the standard `Authorization: Bearer <token>` header — it expects
  // the bearer under a custom header name `x-acs-dingtalk-access-token`
  // (DingTalk uses this across its newer OpenAPIs). Sending the
  // standard header puts DingTalk's auth check first — it then
  // surfaces as `InvalidAuthentication` in the body, which the audit
  // trail would file as `dingtalk_token_exchange_code:…:…` while the
  // real cause is the header name. Body shape is otherwise flat JSON
  // (no envelope to unwrap), with field names `nick` / `openId` /
  // `unionId` (capital I) — caller resolves via `identity_id_field`.
  const headers = c.provider_type === 'dingtalk'
    ? { 'x-acs-dingtalk-access-token': accessToken }
    : { authorization: `Bearer ${accessToken}` };
  const r = await fetch(c.userinfo_url!, { headers });
  if (!r.ok) {
    // Surface DingTalk's actual JSON error body into the audit reason
    // so an admin reading `audit_events.payload->>'reason'` doesn't see
    // a generic `userinfo_failed:403` but the upstream code/message —
    // typically `Forbidden.AccessDenied.AccessTokenPermissionDenied`
    // with `requiredScopes:["Contact.User.Read"]`. Without surfacing
    // the body, every 403 looks identical and the admin would have to
    // re-attach a debugger. The body is `<= 1 KiB` so the cost of
    // embedding it in a parameter is trivial.
    let detail = `${r.status}`;
    try {
      const body = (await r.json()) as { code?: string; message?: string };
      const parts: string[] = [];
      if (body.code) parts.push(`code=${body.code}`);
      if (body.message) parts.push(`message=${body.message}`);
      if (parts.length) detail = `${r.status}:${parts.join(':')}`;
    } catch {
      // Non-JSON body (or read failure) — keep the status-only fallback
      // rather than masking the original 4xx/5xx with a parse error.
    }
    throw new Error(`userinfo_failed:${detail}`);
  }
  const body = (await r.json()) as Record<string, unknown>;
  // Feishu v2 userinfo wraps the user fields inside a `data`
  // envelope (with `code`/`msg` siblings), not the flat OIDC shape
  // every other IdP returns. Unwrap for Feishu so the caller's
  // `identity[identity_id_field]` lookup lands on the same key
  // the admin set (e.g. `open_id`, `union_id`). The `code === 0`
  // check is what Feishu uses to mean "success" — a non-zero code
  // surfaces as userinfo_failed so the audit trail records it.
  if (c.provider_type === 'feishu') {
    if (body.code !== 0) throw new Error(`userinfo_feishu_code:${body.code ?? 'unknown'}:${body.msg ?? ''}`);
    return (body.data ?? {}) as Record<string, unknown>;
  }
  return body;
}

// Verifies an OIDC ID token. v1 supports HS256 with the IdP-shared `client_secret`
// (rotate to JWKS/RS256 when an IdP requires it). The connection's
// `client_secret_encrypted` is the source for symmetric verification; pass the
// already-decrypted secret as `clientSecretDecrypted`.
export async function verifyIdToken(
  c: SsoConnectionRow,
  idToken: string,
  clientSecretDecrypted?: string,
): Promise<JWTPayload> {
  if (!clientSecretDecrypted) throw new Error('id_token_requires_client_secret_or_jwks');
  const secret = new TextEncoder().encode(clientSecretDecrypted);
  const { payload } = await jwtVerify(idToken, secret, { algorithms: ['HS256'] });
  return payload;
}
