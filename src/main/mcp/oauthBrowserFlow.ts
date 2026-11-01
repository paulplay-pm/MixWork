import { BrowserWindow, session } from 'electron';

/**
 * Stable partition name for all IdP-backed SSO BrowserWindows.
 *
 * Why named instead of `persist:...`: a `persist:` prefix would write cookies
 * to disk in `userData/Partitions/<name>/` and survive app restarts — we do
 * NOT want a fresh launch to inherit the prior user's Feishu / Okta session.
 * A bare name creates an in-memory partition (per Electron's Session API) that
 * dies on app exit, so every launch re-authorizes the IdP.
 *
 * Why stable instead of per-attempt `oauth-${crypto.randomUUID()}`: with
 * `--no-sandbox --disable-gpu` switches active in main.ts, Chromium's process
 * model collapses the network process into the main process's address space.
 * A per-attempt partition spins up a brand-new network process for every SSO
 * login; under load with a prior cancelled attempt, the new process's TLS
 * retry faults the shared address space and the whole app SIGSEGVs. One
 * stable partition → one network process → deterministic lifecycle.
 */
export const SSO_OAUTH_PARTITION = 'mixcwork-sso-oauth';

/**
 * Compute the IdP allowlist for the SSO BrowserWindow's request filter.
 *
 * Returns the registrable domain (eTLD+1) of the IdP's authorizeUrl plus
 * a list of host strings under it. The webRequest listener (installed in
 * openOauthFlow) uses this to cancel requests to third-party hosts — the
 * SSO BrowserWindow is a single-purpose identity surface and must never
 * load Google Analytics, DoubleClick, Bytedance captcha, etc.
 *
 * v1 ships a hardcoded lookup for the 5 v1 IdPs. Custom OIDC / SAML
 * (where the admin provides their own authorizeUrl) falls back to
 * "last two labels" — the admin already knows the IdP's domain and the
 * fallback matches the typical two-label shape (sso.example.com).
 *
 * Always allows `localhost` and `127.0.0.1` for the loopback OAuth callback.
 *
 * On a malformed URL, returns a safe allowlist of just loopback so the
 * request filter cancels everything else with a console.warn.
 */
export function deriveIdpAllowlist(authorizeUrl: string): {
  etld1: string;
  allowHosts: string[];
  resourceEtld1s: string[];
} {
  // Hardcoded eTLD+1 lookup for v1 IdPs. The key is the rightmost label
  // (or two labels) of the IdP's host; the value is the registrable
  // domain. Match the longest suffix so future sub-brands (e.g.
  // `intra.feishu.cn` -> `feishu.cn`) keep working.
  //
  // `extraHosts` lists common subdomains under the primary eTLD+1 that
  // the helper documents in `allowHosts` for tests and the public
  // contract; the actual production filter still matches by suffix
  // against `etld1`, not against this list.
  //
  // `resourceEtld1s` lists additional eTLD+1s the IdP serves its own
  // first-party assets from (static JS, fonts, images hosted on the
  // IdP's CDN). The SSO BrowserWindow must allow these so the IdP
  // page can actually render — without them, the page sticks on its
  // loading illustration because its JS bundle never arrives.
  // Third-party tracking domains (Google Analytics, DoubleClick,
  // Bytedance captcha, etc.) are deliberately NOT listed here; they
  // stay blocked.
  const IDP_ETLD1: Record<string, {
    etld1: string;
    extraHosts: string[];
    resourceEtld1s: string[];
  }> = {
    'feishu.cn': {
      etld1: 'feishu.cn',
      extraHosts: ['accounts.feishu.cn', 'passport.feishu.cn'],
      // feishucdn.com is Feishu's own static asset CDN (serves the JS
      // bundle, fonts, and images the authorize page needs to render).
      resourceEtld1s: ['feishucdn.com'],
    },
    'microsoftonline.com': {
      etld1: 'microsoftonline.com',
      extraHosts: [],
      // Microsoft's auth pages pull from msecnd.net (CDN) and
      // msauth.net / msftauth.net (auth assets). Allow these; the
      // first-party app domain alone is not enough.
      resourceEtld1s: ['msecnd.net', 'msauth.net', 'msftauth.net'],
    },
    'dingtalk.com': {
      etld1: 'dingtalk.com',
      extraHosts: [],
      // DingTalk's login page serves its JS bundle from Alibaba's shared
      // CDN (`g.alicdn.com` → eTLD+1 `alicdn.com`), not from a
      // DingTalk-owned host. Without `alicdn.com` here the desktop SSO
      // BrowserWindow's webRequest filter cancels the bundle request and
      // the page sticks on "Page Failed to Load" — the web console has
      // no such filter, which is why only the desktop client breaks.
      // `dingtalkstatic.com` is DingTalk's own older asset host and is
      // kept for older authorize pages that still reference it.
      resourceEtld1s: ['alicdn.com', 'dingtalkstatic.com'],
    },
    'weixin.qq.com': {
      etld1: 'weixin.qq.com',
      extraHosts: [],
      resourceEtld1s: ['qq.com', 'qpic.cn', 'qlogo.cn'],
    },
    'okta.com': {
      etld1: 'okta.com',
      extraHosts: [],
      resourceEtld1s: ['oktacdn.com'],
    },
  };

  let host: string;
  try {
    host = new URL(authorizeUrl).hostname.toLowerCase();
  } catch {
    return { etld1: '', allowHosts: ['localhost', '127.0.0.1'], resourceEtld1s: [] };
  }
  if (host.startsWith('www.')) host = host.slice(4);

  // Hardcoded eTLD+1 lookup. Match the longest suffix of `host` against
  // the keys (e.g. `open.feishu.cn` -> suffix `feishu.cn` -> `feishu.cn`).
  let etld1 = '';
  let extraHosts: string[] = [];
  let resourceEtld1s: string[] = [];
  for (const suffix of Object.keys(IDP_ETLD1).sort((a, b) => b.length - a.length)) {
    if (host === suffix || host.endsWith('.' + suffix)) {
      etld1 = IDP_ETLD1[suffix]!.etld1;
      extraHosts = IDP_ETLD1[suffix]!.extraHosts;
      resourceEtld1s = IDP_ETLD1[suffix]!.resourceEtld1s;
      break;
    }
  }

  // Fallback for custom OIDC: last two labels. e.g.
  // `sso.acme.example.com` -> `example.com`. We deliberately do NOT try
  // to be clever about co.uk / com.au here — those IdPs ship with a
  // custom admin-typed authorizeUrl and the admin knows the domain.
  if (!etld1) {
    const labels = host.split('.');
    etld1 = labels.length >= 2 ? labels.slice(-2).join('.') : host;
  }

  // Build the explicit allowlist: the eTLD+1 itself, the authorizeUrl's
  // host (in case it differs from etld1), the per-IdP extra subdomains,
  // and the loopback OAuth-callback hosts. The actual production
  // matching is done by suffix comparison in the listener, not by
  // equality against this array — this array is for the helper's
  // public contract and for the snapshot test in Step 5.
  const allowHosts = [etld1, host, ...extraHosts, 'localhost', '127.0.0.1'];
  return { etld1, allowHosts, resourceEtld1s };
}

/** Which hosts an OAuth window's requests may reach.
 *
 *  `idp` — the strict identity policy. The IdP is known ahead of time (SSO
 *  providers are vendored in `deriveIdpAllowlist`), so third-party hosts are
 *  cancelled: no analytics, no ad networks, no captcha vendors the IdP does
 *  not own.
 *
 *  `open` — the connector policy. A connector's authorization server is
 *  discovered at runtime (RFC 8414 / 9728), and IdP login pages routinely
 *  serve their own JS and CSS from a CDN on a different eTLD+1 — 纷享销客's
 *  pages load from `a9.fspage.com`, DingTalk's from `g.alicdn.com`. Those
 *  hosts cannot be vendored in advance, and cancelling them does not degrade
 *  gracefully: the login page renders blank and the user has no way forward.
 *  The window is still sandboxed (`sandbox: true`, no preload, no node), so
 *  it is no more privileged than a browser tab. Plaintext `http` to a host
 *  outside the allowlist stays blocked under both policies. */
export const OAuthNetworkPolicy = {
  Idp: 'idp',
  Open: 'open',
} as const;
export type OAuthNetworkPolicy =
  (typeof OAuthNetworkPolicy)[keyof typeof OAuthNetworkPolicy];

/** Mutable allowlist state the request filter consults. `openOauthFlow` grows
 *  it as the window follows 302s to the IdP's real host. */
export interface OauthRequestFilterState {
  etld1: string;
  extraHosts: ReadonlySet<string>;
  resourceEtld1s: ReadonlySet<string>;
}

export type OauthRequestDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: 'malformed' | 'insecure-http' | 'third-party' };

/** Decide whether the OAuth window may issue a request. Pure so the policy can
 *  be tested without constructing a BrowserWindow.
 *
 *  Order matters: the allowlist is consulted before the policy, so a
 *  plaintext IdP the admin configured keeps working under `open`. */
export function decideOauthRequest(
  url: string,
  policy: OAuthNetworkPolicy,
  state: OauthRequestFilterState
): OauthRequestDecision {
  // Pass through non-http(s) schemes (devtools://, chrome-extension://, etc.)
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return { kind: 'allow' };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'deny', reason: 'malformed' };
  }
  const reqHost = parsed.hostname.toLowerCase();
  // Loopback (any port) carries the OAuth callback.
  if (reqHost === 'localhost' || reqHost === '127.0.0.1') {
    return { kind: 'allow' };
  }
  const matchesResourceEtld1 = Array.from(state.resourceEtld1s).some(
    (resourceEtld1) => reqHost === resourceEtld1 || reqHost.endsWith('.' + resourceEtld1)
  );
  const isAllowed =
    (state.etld1 !== '' && (reqHost === state.etld1 || reqHost.endsWith('.' + state.etld1))) ||
    state.extraHosts.has(reqHost) ||
    matchesResourceEtld1 ||
    (state.etld1 !== '' &&
      reqHost.includes(state.etld1) &&
      !/^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/.test(reqHost));
  if (isAllowed) return { kind: 'allow' };
  // Never let the window fetch anything in the clear from a host the IdP
  // allowlist does not cover — that is where a credential would leak.
  if (parsed.protocol === 'http:') return { kind: 'deny', reason: 'insecure-http' };
  if (policy === OAuthNetworkPolicy.Open) return { kind: 'allow' };
  return { kind: 'deny', reason: 'third-party' };
}

/** The probe may call this to mark a forthcoming `win.close()` as a
 *  deliberate handoff (not a user/OS cancellation). The two-stage
 *  SSO bind flow uses it when handing the user off to the OS browser
 *  to complete a strict-mode bind — the loopback stays alive and a
 *  later probe settles the flow with the token, so the standard
 *  "closed before credential received" reject would otherwise abort
 *  the flow before that token arrives. */
export type MarkIntentionalClose = () => void;

export interface OAuthFlowOptions {
  parentWindow?: BrowserWindow | null;
  title: string;
  authorizeUrl: string;
  /** Called repeatedly (after page load, and on a polling interval). Return the
   * credential string when the provider has it (e.g. after the user completed
   * consent). Returning null means "not yet, keep waiting". The second
   * argument is a one-shot helper the probe can call right before
   * intentionally closing the auth window (e.g. to hand the user off to
   * the OS browser); see MarkIntentionalClose. */
  probe: (win: BrowserWindow, markIntentionalClose: MarkIntentionalClose) => Promise<string | null>;
  /** Called once when the window has finished loading the authorize URL. Use
   * this to do an immediate first probe; the flow will also keep polling. */
  onLoaded?: (win: BrowserWindow) => void;
  /** Polling interval in ms (default 2000). */
  pollIntervalMs?: number;
  /** Total timeout in ms (default 5 minutes). */
  timeoutMs?: number;
  /** Window dimensions (defaults 1120x860). */
  width?: number;
  height?: number;
  /** Which hosts the window may reach. Defaults to `idp` (the strict SSO
   *  policy). Connector OAuth windows pass `open`; see OAuthNetworkPolicy. */
  networkPolicy?: OAuthNetworkPolicy;
  /** Deadline for the IdP authorize page to load, in ms.
   *  Settles the flow with `sso_authorize_timeout` if `did-finish-load`
   *  does not fire in time. Cleared on `did-finish-load` so this is the
   *  "page failed to load" deadline, NOT the "user took too long" deadline —
   *  once the IdP page renders, the outer `timeoutMs` (default 5 minutes)
   *  is the only bound. Default 20 000 ms; override per call. */
  loadTimeoutMs?: number;
}

export async function openOauthFlow(opts: OAuthFlowOptions): Promise<string> {
  const {
    parentWindow,
    title,
    authorizeUrl,
    probe,
    onLoaded,
    pollIntervalMs = 2_000,
    timeoutMs = 5 * 60 * 1000,
    width = 1120,
    height = 860,
    loadTimeoutMs = 20_000,
    networkPolicy = OAuthNetworkPolicy.Idp,
  } = opts;

  let authWindow: BrowserWindow | null = null;
  let timeout: NodeJS.Timeout | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  // Set by the probe via onBeforeIntentionalClose to tell the `closed`
  // handler that the upcoming close is a deliberate handoff (e.g. the
  // SSO two-stage flow handing the user off to the OS browser) and
  // must NOT reject the OAuth promise. The flag is read on the next
  // macrotask, after `closed` has fired.
  let intentionalClose = false;

  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    // `loadDeadlineTimer` is the per-`loadURL` deadline. If the IdP
    // authorize page does not render within `loadTimeoutMs`, settle
    // with `sso_authorize_timeout` and close the window. The 5-minute
    // `timeoutMs` is still the bound for the whole flow (covers slow
    // user interaction at the IdP); this deadline is strictly the
    // "TLS handshake / first paint hung" catch.
    //
    // Cleared on `did-finish-load` (page rendered, user can now
    // interact) and on every settle path (no leak).
    //
    // Declared BEFORE `settle` so `clearLoadDeadline` is in scope for
    // the `settle` closure that every code path eventually calls.
    let loadDeadlineTimer: NodeJS.Timeout | null = null;
    const clearLoadDeadline = (): void => {
      if (loadDeadlineTimer) {
        clearTimeout(loadDeadlineTimer);
        loadDeadlineTimer = null;
      }
    };
    // Declared BEFORE `settle` so the settle-time removal of the SSO
    // partition's webRequest filter (Decision 5) can read it via
    // closure. Assigned later in the executor, after we know the
    // BrowserWindow is up.
    let partitionSession: ReturnType<typeof session.fromPartition> | null = null;
    const settle = (error: Error | null, credential?: string) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (pollTimer) clearInterval(pollTimer);
      clearLoadDeadline();
      // Decision 5: remove the SSO partition's webRequest filters so we
      // don't leak listeners across calls on the long-lived partition.
      try {
        partitionSession?.webRequest.onBeforeRequest(null);
        partitionSession?.webRequest.onBeforeRedirect(null);
      } catch (error_) {
        console.warn(
          `[OAuthFlow] failed to remove webRequest filter for "${title}":`,
          error_
        );
      }
      if (authWindow && !authWindow.isDestroyed()) authWindow.close();
      if (error) reject(error);
      else resolve(credential || '');
    };

    authWindow = new BrowserWindow({
      width,
      height,
      parent: parentWindow || undefined,
      modal: false,
      title,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: SSO_OAUTH_PARTITION,
      },
    });

    // Decision 5: install a webRequest filter on the SSO partition that
    // blocks all third-party requests. The SSO BrowserWindow is a
    // single-purpose identity surface — it must never load Google
    // Analytics, DoubleClick, Bytedance captcha, etc. The IdP's
    // authorize page can still load its own resources (under the IdP's
    // eTLD+1) and the loopback callback still works.
    //
    // Why we also install an `onBeforeRedirect` listener: the initial
    // `authorizeUrl` is often the enterprise server (e.g. the desktop
    // SSO flow builds `https://<enterprise>/auth/sso/.../authorize`
    // and the server 302s to `https://accounts.feishu.cn/...`). The
    // IdP's real host only appears as the redirect target, so we
    // discover it from the 302 `Location` header and grow the
    // allowlist before the redirect is followed.
    const {
      etld1: initialEtld1,
      allowHosts: initialAllowHosts,
      resourceEtld1s: initialResourceEtld1s,
    } = deriveIdpAllowlist(authorizeUrl);
    // Mutable in closure so the `onBeforeRedirect` listener can grow
    // the allowlist when a redirect lands on a new IdP host.
    let allowedEtld1 = initialEtld1;
    let allowedExtraHosts: ReadonlySet<string> = new Set(
      initialAllowHosts.filter((h) => h !== initialEtld1)
    );
    // The IdP's documented first-party asset CDNs (e.g. feishucdn.com
    // for Feishu). A request to any subdomain of one of these is
    // allowed — without this, the IdP's authorize page sticks on its
    // loading illustration because its JS bundle never arrives.
    // Third-party tracking (Google Analytics, DoubleClick, etc.) is
    // NOT included here and stays blocked.
    let allowedResourceEtld1s: ReadonlySet<string> = new Set(initialResourceEtld1s);
    console.log(
      `[OAuthFlow] filter installed for "${title}" ` +
      `policy=${networkPolicy} ` +
      `etld1=${JSON.stringify(initialEtld1)} ` +
      `resourceEtld1s=${JSON.stringify(initialResourceEtld1s)} ` +
      `allowHosts=${JSON.stringify(initialAllowHosts)} ` +
      `authorizeHost=${new URL(authorizeUrl).hostname}`
    );
    partitionSession = session.fromPartition(SSO_OAUTH_PARTITION);
    // Helper: when a redirect lands on a host not yet in the
    // allowlist, derive the new eTLD+1 and add it. This is the only
    // way the filter sees the real IdP host when the desktop hits the
    // enterprise server first.
    //
    // We also merge in any `resourceEtld1s` documented for the
    // redirected host. Without this, the IdP's static-asset CDN (e.g.
    // feishucdn.com for Feishu) is still blocked after the redirect,
    // because the initial `authorizeUrl` is the enterprise server —
    // the `IDP_ETLD1` lookup at install time sees `127.0.0.1`, matches
    // no suffix, and returns `resourceEtld1s=[]`. The redirect-grow
    // step is the only place that knows the IdP's real host, so it
    // must also carry over the resource eTLD+1s.
    const growAllowlistFromUrl = (urlString: string): void => {
      try {
        let host = new URL(urlString).hostname.toLowerCase();
        if (host.startsWith('www.')) host = host.slice(4);
        // Already allowed (loopback / previously-redirected).
        if (host === 'localhost' || host === '127.0.0.1') return;
        if (host === allowedEtld1) return;
        if (host.endsWith('.' + allowedEtld1)) return;
        if (allowedExtraHosts.has(host)) return;
        const { etld1: newEtld1, resourceEtld1s: newResourceEtld1s } =
          deriveIdpAllowlist(urlString);
        if (newEtld1 && newEtld1 !== allowedEtld1) {
          console.log(
            `[OAuthFlow] filter grew for "${title}": ` +
            `redirect added etld1=${JSON.stringify(newEtld1)} ` +
            `+ resourceEtld1s=${JSON.stringify(newResourceEtld1s)} (from ${host})`
          );
          allowedEtld1 = newEtld1;
        } else if (!newEtld1) {
          // Custom OIDC where the IdP host's last-two-labels doesn't
          // appear in the hardcoded table — add the host as a
          // top-level exception.
          console.log(
            `[OAuthFlow] filter grew for "${title}": ` +
            `redirect added host=${JSON.stringify(host)}`
          );
          allowedExtraHosts = new Set([...allowedExtraHosts, host]);
        }
        // Merge any newly-discovered resource eTLD+1s (e.g. the IdP's
        // CDN) into the listener's set, even if the primary etld1
        // didn't change. Idempotent — Set deduplication handles the
        // "already present" case.
        if (newResourceEtld1s.length > 0) {
          allowedResourceEtld1s = new Set([
            ...allowedResourceEtld1s,
            ...newResourceEtld1s,
          ]);
        }
      } catch {
        // Malformed redirect Location — ignore; the request will be
        // caught by the `onBeforeRequest` listener's own URL parse.
      }
    };
    const redirectListener = (details: {
      url?: string;
      statusCode?: number;
      redirectURL?: string;
    }): void => {
      // Electron populates `redirectURL` on 3xx responses. See
      // https://www.electronjs.org/docs/latest/api/web-request#event-onbeforeredirect-1
      if (details.statusCode && details.statusCode >= 300 && details.statusCode < 400) {
        const target = details.redirectURL ?? '';
        if (target) growAllowlistFromUrl(target);
      }
    };
    const webRequestListener = (
      details: { url?: string },
      callback: (response: { cancel: boolean }) => void
    ) => {
      const url = details.url ?? '';
      const decision = decideOauthRequest(url, networkPolicy, {
        etld1: allowedEtld1,
        extraHosts: allowedExtraHosts,
        resourceEtld1s: allowedResourceEtld1s,
      });
      switch (decision.kind) {
        case 'allow':
          callback({ cancel: false });
          return;
        case 'deny':
          break;
      }
      switch (decision.reason) {
        case 'malformed':
          // Malformed URL: cancel defensively. This is a request to a
          // junk URL; the user never sees it and there's nothing to do
          // but deny.
          console.warn(`[OAuthFlow] blocked malformed request ${url} in ${title}`);
          break;
        case 'insecure-http':
          console.warn(`[OAuthFlow] blocked plaintext http request to ${url} in ${title}`);
          break;
        case 'third-party':
          console.warn(
            `[OAuthFlow] blocked non-IdP request to ${new URL(url).hostname} in ${title} ` +
            `(etld1=${JSON.stringify(allowedEtld1)})`
          );
          break;
      }
      callback({ cancel: true });
    };
    partitionSession.webRequest.onBeforeRequest(webRequestListener);
    // The redirect-grow logic only matters for the strict policy: under
    // `open`, no host needs to be learned before its requests pass.
    if (networkPolicy === OAuthNetworkPolicy.Idp) {
      partitionSession.webRequest.onBeforeRedirect(redirectListener);
    }

    authWindow.on('closed', () => {
      authWindow = null;
      // Defer the reject to the next macrotask so an in-flight probe
      // that has just received the credential gets a chance to settle
      // first. The probe's `settle(null, credential)` flips
      // `settled=true` synchronously; this delayed reject then becomes
      // a no-op (`if (settled) return`). Without this deferral, the
      // common race is: the IdP has hit /callback, the OAuth window
      // has rendered the "you may close this window" HTML, the user
      // clicks the OS close button, `closed` fires synchronously and
      // rejects — all before the next `did-finish-load` microtask
      // even has a chance to run `runProbe()` and read the token.
      // The deferral does NOT save us if the IdP is genuinely still
      // in flight; that case still rejects, which is correct.
      //
      // Two-stage flows (pendingBind → OS browser → token) close the
      // window intentionally before the credential arrives. The probe
      // signals intent via the `markIntentionalClose` helper passed
      // as its second argument; we check the flag here and skip the
      // reject — the loopback is still alive, polling continues, and
      // the eventual `?token=…` arrival settles the flow normally.
      setTimeout(() => {
        if (intentionalClose) return;
        settle(new Error(`${title} window was closed before the credential was received.`));
      }, 0);
    });

    // The OAuth window can fail to load the authorize URL for
    // reasons Chromium surfaces only via `did-fail-load` (network
    // outages, DNS failure, the IdP returning 5xx, etc.). Without
    // this handler the auth window just sits at Chromium's
    // `neterror` page, the probe polls every 2s for 5 minutes
    // (timeoutMs) before finally rejecting, and the user has no
    // actionable signal in the UI. A worse failure mode: the zombie
    // auth window stays open across the user's retry of the
    // login — the new startSsoMemberLogin spawns a fresh window
    // while the old one is still polling its loopback, and a
    // network-restored auto-retry on the dead window can hit a
    // SIGSEGV in Chromium's renderer IPC. Settle on did-fail-load
    // so the user gets a fast, descriptive error and the loopback
    // closes promptly. The error code is propagated to the UI
    // through the SSO login IPC handler.
    //
    // Filter noise before settling: sub-frame failures (favicons,
    // third-party scripts) are not what we care about; `ERR_ABORTED`
    // fires when a navigation is interrupted by a subsequent load
    // (e.g. the user clicks a link, or we intentionally call
    // `loadURL` again); and the initial `about:blank` load produces
    // a benign failure. Only settle on main-frame failures with a
    // non-aborted error code.
    authWindow.webContents.on(
      'did-fail-load',
      (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) return;  // ignore sub-frame / favicon failures
        if (errorCode === -3 /* ERR_ABORTED */) return;  // superseded by a newer load
        console.warn(
          `[OAuthFlow] "${title}" failed to load ${validatedURL}: ` +
          `code=${errorCode} ${errorDescription}`
        );
        settle(new Error(
          `${title} failed to load (${errorCode} ${errorDescription})`
        ));
      }
    );

    const runProbe = async () => {
      try {
        if (!authWindow || authWindow.isDestroyed()) return;
        const result = await probe(authWindow, () => { intentionalClose = true; });
        if (result) settle(null, result);
      } catch (error) {
        console.debug(`[OAuthFlow] probe failed for "${title}"`, error);
      }
    };

    // Start the loadURL deadline after the BrowserWindow is constructed
    // and the listeners are attached. The BrowserWindow is created
    // synchronously, but `authWindow` is assigned before the `loadURL`
    // call, so we can reference it here.
    if (loadTimeoutMs > 0) {
      loadDeadlineTimer = setTimeout(() => {
        loadDeadlineTimer = null;
        console.warn(`[OAuthFlow] "${title}" loadURL deadline exceeded after ${loadTimeoutMs}ms`);
        settle(new Error('sso_authorize_timeout'));
      }, loadTimeoutMs);
    }

    authWindow.webContents.on('did-finish-load', () => {
      clearLoadDeadline();
      if (onLoaded) onLoaded(authWindow!);
      void runProbe();
    });
    pollTimer = setInterval(() => { void runProbe(); }, pollIntervalMs);
    timeout = setTimeout(() => {
      settle(new Error(`${title} timed out.`));
    }, timeoutMs);

    authWindow.loadURL(authorizeUrl).catch((error) => settle(error));
  });
}