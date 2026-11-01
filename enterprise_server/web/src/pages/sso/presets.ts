// web/src/pages/sso/presets.ts
// Preset endpoints + default field mappings for the 7 v1 provider types.
// Inlined copy of enterprise_server/src/sso/providerPresets.ts (the web build
// does not read enterprise_server/src paths). Named providers ship with the
// documented defaults which the create form pre-fills; the admin can override
// before saving. Generic OIDC/OAuth2 are open-ended (blank endpoints).

import type { ProviderType, SsoProtocol } from './types';

export interface ProviderPreset {
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scopes: string;
  identityIdField: string;
  loginNameField: string;
  emailField: string;
}

export const PRESETS: Record<ProviderType, ProviderPreset> = {
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
    // New OAuth2 flow — same wire as enterprise_server/src/sso/providerPresets.ts
    // (keep both files in lockstep). `Contact.User.Read` is required for
    // /v1.0/contact/users/me to return unionId/openId/nick; the
    // permission must be applied-for on the DingTalk backend AND in this
    // scope.
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
  'saml2': {
    authorizeUrl: '', tokenUrl: '', userinfoUrl: '',
    scopes: '', identityIdField: 'nameID', loginNameField: '', emailField: 'email',
  },
};

/** The wire protocol for a provider type. Only generic-oauth2 speaks plain
 * OAuth2; saml2 rows are stored-but-disabled in v1; everything else is OIDC. */
export function protocolFor(p: ProviderType): SsoProtocol {
  switch (p) {
    case 'generic-oauth2':
      return 'oauth2';
    case 'saml2':
      return 'saml2';
    default:
      return 'oidc';
  }
}
