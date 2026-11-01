// enterprise_server/src/sso/providerPresets.ts
// Preset endpoints + default field mappings for the 5 v1 providers.
// Generic OIDC/OAuth2 are open-ended (the admin fills them in); named
// providers ship with the documented defaults which the form pre-fills
// (admin can override before saving).

export interface ProviderPreset {
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scopes: string;
  identityIdField: string;
  loginNameField: string;
  emailField: string;
}

export const PRESETS: Record<string, ProviderPreset> = {
  'generic-oidc': {
    authorizeUrl: '', tokenUrl: '', userinfoUrl: '',
    scopes: 'openid profile email',
    identityIdField: 'sub', loginNameField: 'preferred_username', emailField: 'email',
  },
  'generic-oauth2': {
    authorizeUrl: '', tokenUrl: '', userinfoUrl: '',
    scopes: '',
    identityIdField: 'sub', loginNameField: '', emailField: 'email',
  },
  'azure-ad': {
    authorizeUrl: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token',
    userinfoUrl: 'https://graph.microsoft.com/oidc/userinfo',
    scopes: 'openid profile email User.Read',
    identityIdField: 'sub', loginNameField: 'preferred_username', emailField: 'email',
  },
  'feishu': {
    authorizeUrl: 'https://open.feishu.cn/open-apis/authen/v1/index',
    tokenUrl: 'https://open.feishu.cn/open-apis/authen/v1/access_token',
    userinfoUrl: 'https://open.feishu.cn/open-apis/authen/v1/user_info',
    scopes: 'contact:user.id:readonly',
    identityIdField: 'union_id', loginNameField: 'name', emailField: 'email',
  },
  'dingtalk': {
    // New OAuth2 flow documented at
    //   https://open.dingtalk.com/document/orgapp-server/use-dingtalk-account-to-log-on-to-third-party-websites
    // Migrated from the legacy `sns_authorize` + `/sns/getuserinfo_bycode`
    // (HMAC + tmp_auth_code) flow, which produced an ugly form-style
    // landing page when the browser had no DingTalk cookies and
    // silently rejected `client_id=` in favour of `appid=`. The new
    // `login.dingtalk.com/oauth2/auth` endpoint renders the QR scan
    // challenge page (`/oauth2/challenge.htm`) on the same browser
    // conditions.
    //
    // All three URLs and every field name below are camelCase at the
    // wire — verified by direct probe (JSON body with `clientId` /
    // `clientSecret` / `grantType` reached DingTalk's auth check; the
    // snake_case variant returned `Missingbody`). The userinfo
    // response uses `openId` / `unionId` (capital I) which is why
    // `identityIdField` is `unionId` rather than `unionid`.
    //
    // The userinfo endpoint `/v1.0/contact/users/me` is permission-
    // gated and returns `Forbidden.AccessDenied.AccessTokenPermissionDenied`
    // (HTTP 403, `requiredScopes:["Contact.User.Read"]`) without
    // `Contact.User.Read` in scope AND applied-for on the DingTalk app
    // console. Internal-corp apps typically auto-grant this in dev
    // mode; production rollout needs the corp admin to approve the
    // permission in 「权限管理 → 申请」.
    authorizeUrl: 'https://login.dingtalk.com/oauth2/auth',
    tokenUrl: 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken',
    userinfoUrl: 'https://api.dingtalk.com/v1.0/contact/users/me',
    scopes: 'openid Contact.User.Read',
    identityIdField: 'unionId', loginNameField: 'nick', emailField: 'email',
  },
  'wecom': {
    // WeCom is not RFC 6749 and diverges in three ways:
    //  * authorize URL needs `appid=<CorpID>` (NOT `client_id`) plus a
    //    mandatory `agentid` for 企业内部自建应用 — see the `wecom`
    //    branch in `buildAuthorizeUrl`.
    //  * `tokenUrl` (`cgi-bin/gettoken`) is an APP-LEVEL token endpoint
    //    keyed on corpid+corpsecret; it does NOT consume the OAuth code.
    //    The real code→identity step is `userinfoUrl`
    //    (`cgi-bin/auth/getuserinfo?access_token&code`) — a second hop,
    //    so the wecom `exchangeCode` branch makes two calls.
    //  * `snsapi_base` (silent) is the right scope for login. The
    //    original `snsapi_private_info` was doubly wrong: WeCom spells
    //    it `snsapi_privateinfo` (no underscore) and it requires
    //    manual user consent plus the 成员敏感信息 permission just to
    //    read phone/email, which SSO login never needs.
    //
    // The identity payload carries only ids (`UserId` / `OpenId`), no
    // display name or email, so `loginNameField` is empty and the
    // `emailField` lookup resolves to null on every login.
    // PC scan-code endpoint (migration 051). The older
    // `open.weixin.qq.com/connect/oauth2/authorize` refuses non-WeCom
    // User-Agents outright, so it was unreachable from a browser tab or
    // the desktop client's Chromium window. `qrConnect` renders the
    // 「企业微信登录」 QR page for any PC browser. It does NOT accept
    // `scope`, which is fine — the identity set is id-only either way.
    authorizeUrl: 'https://open.work.weixin.qq.com/wwopen/sso/qrConnect',
    tokenUrl: 'https://qyapi.weixin.qq.com/cgi-bin/gettoken',
    userinfoUrl: 'https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo',
    scopes: 'snsapi_base',
    identityIdField: 'UserId', loginNameField: '', emailField: 'email',
  },
  saml2: {
    authorizeUrl: '', tokenUrl: '', userinfoUrl: '',
    scopes: '', identityIdField: 'nameID', loginNameField: '', emailField: 'email',
  },
};
