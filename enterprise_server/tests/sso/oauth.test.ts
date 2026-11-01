// enterprise_server/tests/sso/oauth.test.ts
import '../helpers/setupEnv';

import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { buildAuthorizeUrl, exchangeCode, fetchUserInfo, verifyIdToken } from '../../src/sso/oauth';
import type { SsoConnectionRow } from '../../src/sso/types';

function baseConn(overrides: Partial<SsoConnectionRow> = {}): SsoConnectionRow {
  return {
    id: 'c1', org_id: 'o1', name: 'Acme',
    provider_type: 'generic-oidc', protocol: 'oidc',
    authorize_url: 'https://idp.example/authorize', token_url: 'https://idp.example/token',
    userinfo_url: 'https://idp.example/userinfo',
    client_id: 'cid', client_secret_encrypted: null, client_secret_masked: null,
    scopes: 'openid email', identity_id_field: 'sub', login_name_field: 'preferred_username',
    email_field: 'email', email_domain_whitelist: [], require_prebinding: false,
    agentid: null,
    logo_url: null,
    enabled: true, sort_order: 0,
    created_by: null, created_at: new Date(), updated_at: new Date(),
    ...overrides,
  };
}

describe('sso/oauth', () => {
  test('buildAuthorizeUrl attaches PKCE params + state + scopes', () => {
    const url = buildAuthorizeUrl(baseConn(), 'state-xyz', 'challenge-abc');
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://idp.example/authorize');
    expect(u.searchParams.get('client_id')).toBe('cid');
    expect(u.searchParams.get('redirect_uri')).toBeTruthy();
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('state')).toBe('state-xyz');
    expect(u.searchParams.get('code_challenge')).toBe('challenge-abc');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('scope')).toBe('openid email');
  });

  test('verifyIdToken parses a signed JWS payload (HS256 with client_secret)', async () => {
    const secret = new TextEncoder().encode('a-shared-secret-of-sufficient-length');
    const tok = await new SignJWT({ sub: 'id-1', email: 'a@x.com', preferred_username: 'a' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(secret);
    const claims = await verifyIdToken(baseConn({ client_secret_encrypted: 'whatever' }), tok, 'a-shared-secret-of-sufficient-length');
    expect(claims.sub).toBe('id-1');
    expect(claims.email).toBe('a@x.com');
  });
});

// Feishu-specific branches. The generic OIDC path sends form-encoded
// client_id + Basic auth + PKCE, which Feishu's `authen/v1/*` endpoints
// silently reject (200 + `{code:20001,...}` envelope with no
// access_token). The tests below pin the correct Feishu wire format so
// any future regression that drops the `provider_type === 'feishu'`
// branch is caught here.
describe('sso/oauth — Feishu provider_type branches', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const feishu = baseConn({
    provider_type: 'feishu',
    protocol: 'oidc',  // not used by Feishu branches but matches the row shape
    authorize_url: 'https://open.feishu.cn/open-apis/authen/v1/index',
    token_url: 'https://open.feishu.cn/open-apis/authen/v1/access_token',
    userinfo_url: 'https://open.feishu.cn/open-apis/authen/v1/user_info',
    client_id: 'cli_app_id_xxx',
    scopes: 'contact:user.id:readonly',
    identity_id_field: 'union_id',
  });

  test('buildAuthorizeUrl sends app_id (not client_id) and skips PKCE', () => {
    const url = buildAuthorizeUrl(feishu, 'state-xyz', 'challenge-abc', 'http://localhost/cb');
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://open.feishu.cn/open-apis/authen/v1/index');
    expect(u.searchParams.get('app_id')).toBe('cli_app_id_xxx');
    // Defensive: client_id must NOT leak into the Feishu URL (it would
    // be ignored by Feishu but would confuse anyone diffing URLs).
    expect(u.searchParams.get('client_id')).toBeNull();
    expect(u.searchParams.get('redirect_uri')).toBe('http://localhost/cb');
    expect(u.searchParams.get('state')).toBe('state-xyz');
    expect(u.searchParams.get('scope')).toBe('contact:user.id:readonly');
    // PKCE params absent — Feishu's authen/v1 doesn't use PKCE.
    expect(u.searchParams.get('code_challenge')).toBeNull();
    expect(u.searchParams.get('code_challenge_method')).toBeNull();
    expect(u.searchParams.get('response_type')).toBe('code');
  });

  test('exchangeCode POSTs JSON body with app_id/app_secret (Feishu)', async () => {
    // Mock the Feishu success envelope: `{code:0, msg:"ok", data:{access_token,...}}`.
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ code: 0, msg: 'ok', data: { access_token: 'fat-1', refresh_token: 'frt-1', expires_in: 7199 } }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    ));

    const result = await exchangeCode(
      feishu, 'auth-code-1', undefined, 'app_secret_xxx', 'http://localhost/cb'
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0]!;
    expect(calledUrl).toBe('https://open.feishu.cn/open-apis/authen/v1/access_token');
    expect(calledInit!.method).toBe('POST');
    expect((calledInit!.headers as Record<string, string>)['content-type']).toBe('application/json');
    // Body is JSON — NOT form-encoded, NOT including `redirect_uri` or
    // a `code_verifier`. Form-encoded URLsSearchParams silently break
    // Feishu's parser (see the document banner in oauth.ts).
    expect(typeof calledInit!.body).toBe('string');
    const sent = JSON.parse(calledInit!.body as string) as Record<string, string>;
    expect(sent).toEqual({
      grant_type: 'authorization_code',
      code: 'auth-code-1',
      app_id: 'cli_app_id_xxx',
      app_secret: 'app_secret_xxx',
    });
    expect(result.accessToken).toBe('fat-1');
    expect(result.raw).toMatchObject({ code: 0, msg: 'ok' });
    expect(result.idToken).toBeUndefined();
  });

  test('exchangeCode surfaces Feishu API error code in the thrown reason', async () => {
    // Feishu returns `{code:20003, msg:"code is invalid"}` for a bogus
    // code; the generic path would surface this as the opaque
    // `token_exchange_no_access_token`. The Feishu branch keeps the
    // numeric API code so admin audit / debug logs are actionable.
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ code: 20003, msg: 'code is invalid' }),
      { status: 200 }
    ));
    await expect(
      exchangeCode(feishu, 'bogus', undefined, 'app_secret_xxx', 'http://localhost/cb')
    ).rejects.toThrow(/token_exchange_feishu_code:20003:code is invalid/);
  });

  test('exchangeCode treats Feishu HTTP 4xx the same as generic (token_exchange_failed:NNN)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
    await expect(
      exchangeCode(feishu, 'c', undefined, 's', 'http://localhost/cb')
    ).rejects.toThrow('token_exchange_failed:403');
  });

  test('exchangeCode still throws token_exchange_no_access_token when Feishu returns code=0 but empty data', async () => {
    // Defensive: a buggy Feishu response with success envelope but no
    // access_token (race condition during token rotation, etc.). The
    // legacy reason string is preserved so existing audit/Sentry
    // dashboards keep matching.
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ code: 0, msg: 'ok', data: {} }),
      { status: 200 }
    ));
    await expect(
      exchangeCode(feishu, 'c', undefined, 's', 'http://localhost/cb')
    ).rejects.toThrow('token_exchange_no_access_token');
  });
});

// DingTalk (new OAuth2 flow). The legacy `sns_authorize` + HMAC + tmp_auth_code
// branch was removed when the preset migrated to
// `api.dingtalk.com/v1.0/oauth2/userAccessToken` because the new flow is
// plain OAuth2 with a different (camelCase, JSON) wire shape. Tests pin the
// three quirks vs. RFC 6749: JSON body (not form), camelCase field names
// in both directions, and the custom `x-acs-dingtalk-access-token`
// userinfo header (NOT `Authorization: Bearer`).
describe('sso/oauth — DingTalk provider_type branches', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const dingtalk = baseConn({
    provider_type: 'dingtalk',
    protocol: 'oauth2',
    authorize_url: 'https://login.dingtalk.com/oauth2/auth',
    token_url: 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken',
    userinfo_url: 'https://api.dingtalk.com/v1.0/contact/users/me',
    client_id: 'AppKey_xxxxxxxxxxxxxxxx',
    scopes: 'openid Contact.User.Read',  // 047 bumped from `openid`
    identity_id_field: 'unionId',
    login_name_field: 'nick',
  });

  test('buildAuthorizeUrl sends client_id (new endpoint); PKCE passes through when provided', () => {
    // Without a PKCE challenge, the generic path emits no code_challenge
    // params — the new DingTalk endpoint accepts the OAuth2 core
    // (client_id/redirect_uri/state/scope/response_type) verbatim.
    const url = buildAuthorizeUrl(dingtalk, 'state-xyz', undefined, 'http://localhost/cb');
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://login.dingtalk.com/oauth2/auth');
    expect(u.searchParams.get('client_id')).toBe('AppKey_xxxxxxxxxxxxxxxx');
    expect(u.searchParams.get('appid')).toBeNull();
    expect(u.searchParams.get('app_id')).toBeNull();
    expect(u.searchParams.get('redirect_uri')).toBe('http://localhost/cb');
    expect(u.searchParams.get('state')).toBe('state-xyz');
    // URLSearchParams encodes the space between `openid` and
    // `Contact.User.Read` as `+` (RFC 3986 query-string form); both
    // `+` and `%20` are valid for DingTalk, but pinning the exact
    // shape lets a regression here be caught.
    expect(u.searchParams.get('scope')).toBe('openid Contact.User.Read');
    expect(u.searchParams.get('code_challenge')).toBeNull();
    expect(u.searchParams.get('code_challenge_method')).toBeNull();
    expect(u.searchParams.get('response_type')).toBe('code');
  });

  test('buildAuthorizeUrl forwards PKCE challenge when caller supplies one (DingTalk accepts)', () => {
    // The new DingTalk endpoint (login.dingtalk.com/oauth2/auth) is
    // standard OAuth2 and tolerates PKCE params — verify the generic
    // path's PKCE pass-through for DingTalk doesn't get accidentally
    // stripped in a future change.
    const url = buildAuthorizeUrl(dingtalk, 'state-xyz', 'challenge-abc', 'http://localhost/cb');
    const u = new URL(url);
    expect(u.searchParams.get('code_challenge')).toBe('challenge-abc');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  });

  test('exchangeCode POSTs JSON body with camelCase fields and reads accessToken (DingTalk)', async () => {
    // Success: {accessToken, refreshToken, expiresIn, corpId?} — all camelCase.
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 7199, corpId: 'corp-1' }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    ));

    const result = await exchangeCode(
      dingtalk, 'auth-code-1', undefined, 'app-secret', 'http://example.com/cb'
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0]!;
    expect(calledUrl).toBe('https://api.dingtalk.com/v1.0/oauth2/userAccessToken');
    expect(calledInit!.method).toBe('POST');
    // JSON body (NOT form-encoded — snake_case returned `Missingbody`
    // on direct probe; only JSON + camelCase reaches DingTalk's auth check).
    expect((calledInit!.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(typeof calledInit!.body).toBe('string');
    expect(JSON.parse(calledInit!.body as string)).toEqual({
      grantType: 'authorization_code',
      code: 'auth-code-1',
      clientId: 'AppKey_xxxxxxxxxxxxxxxx',
      clientSecret: 'app-secret',
    });
    // Response carries `accessToken` (camelCase) — verifying the path
    // that downstream consumer `finishCallback` relies on.
    expect(result.accessToken).toBe('at-1');
    expect(result.raw).toMatchObject({ accessToken: 'at-1', corpId: 'corp-1' });
  });

  test('exchangeCode surfaces DingTalk API error code in the thrown reason', async () => {
    // DingTalk new flow returns `{code:"invalidParameter.idOrSecret.notFound",
    // message:"clientId或者clientSecret错误"}` on bad credentials. The
    // branch keeps the API code so admin/audit can act on it instead
    // of seeing opaque `dingtalk_token_exchange_no_access_token`.
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ code: 'invalidParameter.idOrSecret.notFound', message: 'clientId或者clientSecret错误' }),
      { status: 400 }
    ));
    await expect(
      exchangeCode(dingtalk, 'bogus', undefined, 's', 'http://example.com/cb')
    ).rejects.toThrow('dingtalk_token_exchange_failed:400');
  });

  test('exchangeCode surfaces error code from 200 response body when code field is non-zero', async () => {
    // DingTalk also returns 200 with a `code: '4xxCode'` body on some failures;
    // the branch surfaces that into the audit reason too.
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ code: 'invalidCode', message: 'auth code expired' }),
      { status: 200 }
    ));
    await expect(
      exchangeCode(dingtalk, 'c', undefined, 's', 'http://example.com/cb')
    ).rejects.toThrow(/dingtalk_token_exchange_code:invalidCode:auth code expired/);
  });

  test('exchangeCode throws when DingTalk returns 200 but no accessToken', async () => {
    // Defensive: a 200 with an empty body still must not silently hand a
    // falsy token downstream; we throw so the audit trail records the
    // mismatch between "looks OK" and "no token" explicitly.
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ code: '0' }),
      { status: 200 }
    ));
    await expect(
      exchangeCode(dingtalk, 'c', undefined, 's', 'http://example.com/cb')
    ).rejects.toThrow('dingtalk_token_exchange_no_access_token');
  });
});

// WeCom (企业微信) — different from RFC 6749 in three ways at once
// (all verified by direct probe against the real endpoint):
//   1. authorize URL needs `appid=<CorpID>`, not `client_id`
//   2. authorize URL also needs `agentid=<AgentId>` for a 自建应用
//   3. code exchange is TWO steps: gettoken (corpid+corpsecret) →
//      auth/getuserinfo (access_token+code). Neither accepts the
//      standard OIDC POST+form+grant_type shape.
// The wecom branch in `exchangeCode` collapses both steps and stashes
// the identity at `exchanged.raw`; finishCallback.ts reads it from
// there rather than issuing a second userinfo call.
describe('sso/oauth — WeCom provider_type branches', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const wecom = baseConn({
    provider_type: 'wecom',
    protocol: 'oidc',
    authorize_url: 'https://open.work.weixin.qq.com/wwopen/sso/qrConnect',
    token_url: 'https://qyapi.weixin.qq.com/cgi-bin/gettoken',
    userinfo_url: 'https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo',
    client_id: 'wwFAKE_CORPID_XYZ',
    agentid: '1000002',
    scopes: 'snsapi_base',
    identity_id_field: 'UserId',
    login_name_field: '',
    email_field: 'email',
  });

  test('buildAuthorizeUrl targets the PC scan-code endpoint (qrConnect)', () => {
    // Regression guard for migration 051: the older
    // `open.weixin.qq.com/connect/oauth2/authorize` answers
    // 「请在企业微信客户端打开链接」 for any non-WeCom User-Agent
    // (probed with desktop Chrome), which makes it unreachable from both
    // the web console and the desktop client.
    const url = buildAuthorizeUrl(wecom, 'state-xyz', 'challenge-abc', 'http://localhost/cb');
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://open.work.weixin.qq.com/wwopen/sso/qrConnect');
    expect(u.searchParams.get('appid')).toBe('wwFAKE_CORPID_XYZ');
    // `client_id` would make WeCom answer 「AppID 参数错误」
    expect(u.searchParams.get('client_id')).toBeNull();
    expect(u.searchParams.get('agentid')).toBe('1000002');
    expect(u.searchParams.get('redirect_uri')).toBe('http://localhost/cb');
    expect(u.searchParams.get('state')).toBe('state-xyz');
    // qrConnect has no `scope` / `response_type` / PKCE parameters.
    expect(u.searchParams.has('scope')).toBe(false);
    expect(u.searchParams.has('response_type')).toBe(false);
    expect(u.searchParams.has('code_challenge')).toBe(false);
    expect(u.searchParams.has('code_challenge_method')).toBe(false);
  });

  test('buildAuthorizeUrl IGNORES the row authorize_url (pinned protocol constant)', () => {
    // A row that still points at the in-app endpoint (pre-migration-051)
    // must not resurrect the User-Agent wall: the endpoint is a
    // protocol constant, like the (now-removed) DingTalk legacy paths.
    const staleRow = baseConn({
      ...wecom,
      authorize_url: 'https://open.weixin.qq.com/connect/oauth2/authorize',
    });
    const u = new URL(buildAuthorizeUrl(staleRow, 's', undefined, 'http://cb'));
    expect(u.origin + u.pathname).toBe('https://open.work.weixin.qq.com/wwopen/sso/qrConnect');
  });

  test('buildAuthorizeUrl omits agentid when the column is null', () => {
    // A 第三方应用 identifies by suite rather than an in-corp agent.
    const url = buildAuthorizeUrl(baseConn({ ...wecom, agentid: null }), 's', undefined, 'http://cb');
    const u = new URL(url);
    expect(u.searchParams.get('appid')).toBe('wwFAKE_CORPID_XYZ');
    expect(u.searchParams.has('agentid')).toBe(false);
  });

  test('exchangeCode does gettoken then auth/getuserinfo (two-step), returns identity', async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ errcode: 0, errmsg: 'ok', access_token: 'corp-token-XYZ', expires_in: 7200 }),
      { status: 200 }
    ));
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ errcode: 0, errmsg: 'ok', userid: 'ZhangSan', openid: 'oid-zs' }),
      { status: 200 }
    ));

    const result = await exchangeCode(wecom, 'auth-code-1', undefined, 'corpsecret-XYZ', 'http://example.com/cb');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Step 1: gettoken carries corpid + corpsecret in the query string.
    const [tkUrl, tkInit] = fetchMock.mock.calls[0]!;
    const tu = new URL(tkUrl as string);
    expect(tu.origin + tu.pathname).toBe('https://qyapi.weixin.qq.com/cgi-bin/gettoken');
    expect(tu.searchParams.get('corpid')).toBe('wwFAKE_CORPID_XYZ');
    expect(tu.searchParams.get('corpsecret')).toBe('corpsecret-XYZ');
    expect(tkInit!.method).toBe('GET');

    // Step 2: getuserinfo carries the corp token + the OAuth code.
    const [uiUrl] = fetchMock.mock.calls[1]!;
    const uu = new URL(uiUrl as string);
    expect(uu.origin + uu.pathname).toBe('https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo');
    expect(uu.searchParams.get('access_token')).toBe('corp-token-XYZ');
    expect(uu.searchParams.get('code')).toBe('auth-code-1');

    // Identity normalized to BOTH casings — WeCom's `user/` endpoint
    // returns `UserId` while `auth/` returns `userid`, and we accept
    // either spelling for `identity_id_field`.
    expect(result.accessToken).toBe('wecom-direct');
    const r = result.raw as Record<string, unknown>;
    expect(r.userid).toBe('ZhangSan');
    expect(r.UserId).toBe('ZhangSan');
    expect(r.openid).toBe('oid-zs');
    expect(r.OpenId).toBe('oid-zs');
  });

  test('exchangeCode surfaces gettoken errcode in thrown reason', async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ errcode: 40013, errmsg: 'invalid corpid' }), { status: 200 }
    ));
    await expect(
      exchangeCode(wecom, 'c', undefined, 's', 'http://cb')
    ).rejects.toThrow(/wecom_gettoken_code:40013:invalid corpid/);
  });

  test('exchangeCode surfaces getuserinfo errcode in thrown reason', async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ errcode: 0, access_token: 'at' }), { status: 200 }
    ));
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ errcode: 40029, errmsg: 'invalid code' }), { status: 200 }
    ));
    await expect(
      exchangeCode(wecom, 'c', undefined, 's', 'http://cb')
    ).rejects.toThrow(/wecom_getuserinfo_code:40029:invalid code/);
  });

  test('exchangeCode requires AppSecret', async () => {
    await expect(
      exchangeCode(wecom, 'c', undefined, undefined, 'http://cb')
    ).rejects.toThrow('wecom_app_secret_required');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('sso/oauth — fetchUserInfo surfaces upstream error body', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Pinged during the 2026-10-19 DingTalk Contact.User.Read
  // investigation: the userinfo endpoint rejects with `403` +
  // `{code, message}` body when the scope/permission is missing.
  // Surfacing the body into the audit reason lets an admin see
  // `Forbidden.AccessDenied.AccessTokenPermissionDenied` instead of a
  // generic `userinfo_failed:403`.
  test('userinfo 4xx body is inlined into the thrown reason', async () => {
    const conn = baseConn({
      userinfo_url: 'https://api.dingtalk.com/v1.0/contact/users/me',
      provider_type: 'dingtalk',
    });
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ code: 'Forbidden.AccessDenied.AccessTokenPermissionDenied', message: '缺少权限' }),
      { status: 403, headers: { 'content-type': 'application/json' } }
    ));
    await expect(fetchUserInfo(conn, 'placeholder_token')).rejects.toThrow(
      /userinfo_failed:403:code=Forbidden\.AccessDenied\.AccessTokenPermissionDenied:message=缺少权限/
    );
  });

  test('userinfo 4xx with non-JSON body falls back to status-only', async () => {
    const conn = baseConn({
      userinfo_url: 'https://example.invalid/whoami',
      provider_type: 'feishu',
    });
    fetchMock.mockResolvedValueOnce(new Response('forbidden plain text', { status: 403 }));
    await expect(fetchUserInfo(conn, 'placeholder_token')).rejects.toThrow(
      /userinfo_failed:403/
    );
  });
});
