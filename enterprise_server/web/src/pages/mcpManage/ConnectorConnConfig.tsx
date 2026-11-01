import type { JSX } from 'react';
import type { AuthMode6, Transport2 } from '../../api/connectors';
import { t } from '../../i18n';
import { ConnectorAuthFields } from './ConnectorAuthFields';
import { isSelectableAuthMode, SELECTABLE_AUTH_MODES } from './connectorAuthModeOptions';
import type { ConnectorFormState } from './ConnectorDrawer';

/** Suffix for a value that still exists on records but is no longer offered. */
const LEGACY_MODE_SUFFIX: Partial<Record<AuthMode6, string>> = {
  'client-creds': 'mcp.authMode.retired',
  sso: 'mcp.authMode.merged',
};

/** i18n key for each mode's short label (reused by the select and the
 * destructive auth-mode-switch confirm). */
export const AUTH_MODE_LABEL: Record<AuthMode6, string> = {
  'none': 'mcp.auth.none',
  'shared-key': 'mcp.auth.sharedKey',
  'user-key': 'mcp.auth.userKey',
  'user-oauth': 'mcp.auth.userOAuth',
  'client-creds': 'mcp.auth.clientCreds',
  'sso': 'mcp.auth.sso',
};

const AUTH_HINT_KEY: Record<AuthMode6, string> = {
  'none': 'mcp.authHint.none',
  'shared-key': 'mcp.authHint.sharedKey',
  'user-key': 'mcp.authHint.userKey',
  'user-oauth': 'mcp.authHint.userOAuth',
  'client-creds': 'mcp.authHint.clientCreds',
  'sso': 'mcp.authHint.sso',
};

/** Modes SSE transport cannot carry (the backend 400s on these combos).
 *  `shared-key` is here because the gateway refuses an SSE connector outright
 *  (`unsupported_transport`) — SSE cannot express the org-key handshake. */
export const SSE_INCOMPATIBLE_AUTH_MODES: AuthMode6[] = [
  'user-oauth',
  'client-creds',
  'sso',
  'shared-key',
];

interface Props {
  mode: 'create' | 'edit';
  state: ConnectorFormState;
  onChange: (patch: Partial<ConnectorFormState>) => void;
  /** Pre-formatted "configured by / at" metadata (null in create mode). */
  secretMeta: { by: string; time: string } | null;
  /** Which stored secrets exist (drives the masked placeholders). */
  hasSecret: { apiKey: boolean; clientSecret: boolean };
  /** The server-issued loopback redirect URI for a `user-oauth` connector. */
  oauthRedirectUri?: string;
}

/** 连接配置 section: transport + auth mode (with SSE coupling) + the
 * mode-specific auth fields + timeout/retry. */
export function ConnectorConnConfig(p: Props): JSX.Element {
  const inputCls =
    'w-full rounded-[6px] border border-[var(--border-default)] px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--accent-primary)]';
  const labelCls = 'flex flex-col gap-1 text-[12px] font-medium text-[var(--text-secondary)]';
  const req = <span className="text-[var(--danger-primary)]">*</span>;

  /** SSE coupling: picking `sse` resets an incompatible auth mode to `none`. */
  const onTransportChange = (v: Transport2): void => {
    if (v === 'sse' && SSE_INCOMPATIBLE_AUTH_MODES.includes(p.state.authMode)) {
      p.onChange({ transport: v, authMode: 'none' });
    } else {
      p.onChange({ transport: v });
    }
  };

  return (
    <section className="mt-5 border-t border-dashed border-[var(--border-default)] pt-4">
      <h4 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
        {t('mcpDrawer.connConfig')}
      </h4>
      <div className="grid grid-cols-2 gap-3.5">
        <label className={`col-span-2 ${labelCls}`}>
          {t('mcp.transport')} {req}
          <select
            className={inputCls}
            aria-label={t('mcp.transport')}
            value={p.state.transport}
            onChange={(e) => onTransportChange(e.target.value as Transport2)}
          >
            <option value="http">{t('mcpDrawer.transport.http')}</option>
            <option value="sse">{t('mcpDrawer.transport.sse')}</option>
          </select>
          <span className="text-xs text-[var(--text-tertiary)]">
            {p.state.transport === 'sse'
              ? t('mcpDrawer.transportHint.sse')
              : t('mcpDrawer.transportHint.http')}
          </span>
          {/* A record stored before this rule can still be on the pair; the
              picker disables it, but the admin needs to know why it must move. */}
          {p.state.transport === 'sse' && p.state.authMode === 'shared-key' && (
            <span className="text-xs text-[#B45309]">{t('mcpDrawer.connConfig.sharedKeySse')}</span>
          )}
        </label>

        <label className={`col-span-2 ${labelCls}`}>
          {t('mcp.auth')} {req}
          <select
            className={inputCls}
            aria-label={t('mcp.auth')}
            value={p.state.authMode}
            onChange={(e) => p.onChange({ authMode: e.target.value as AuthMode6 })}
          >
            {SELECTABLE_AUTH_MODES.map((m) => (
              <option
                key={m}
                value={m}
                disabled={p.state.transport === 'sse' && SSE_INCOMPATIBLE_AUTH_MODES.includes(m)}
              >
                {t(AUTH_MODE_LABEL[m])}
              </option>
            ))}
            {/* A stored record may still sit on a value the picker no longer
                offers. It shows as itself, disabled, so the admin sees what
                they have and can move off it — never re-select it. */}
            {!isSelectableAuthMode(p.state.authMode) && (
              <option value={p.state.authMode} disabled>
                {t(AUTH_MODE_LABEL[p.state.authMode])}
                {t(LEGACY_MODE_SUFFIX[p.state.authMode] ?? 'mcp.authMode.retired')}
              </option>
            )}
          </select>
          <span className="text-xs text-[var(--text-tertiary)]">{t(AUTH_HINT_KEY[p.state.authMode])}</span>
        </label>

        <div className="col-span-2">
          <ConnectorAuthFields
            mode={p.mode}
            authMode={p.state.authMode}
            state={p.state}
            onChange={p.onChange}
            hasSecret={p.hasSecret}
            secretMeta={p.secretMeta}
            oauthRedirectUri={p.oauthRedirectUri}
          />
        </div>

        <label className={labelCls}>
          {t('mcp.timeout')}
          <input
            className={inputCls}
            aria-label={t('mcp.timeout')}
            type="number"
            min={5}
            max={300}
            placeholder={t('mcpDrawer.timeout.default')}
            value={p.state.timeoutSeconds}
            onChange={(e) => {
              const raw = e.target.value;
              p.onChange({ timeoutSeconds: raw === '' ? '' : Number(raw) });
            }}
          />
          <span className="text-xs text-[var(--text-tertiary)]">{t('mcpDrawer.timeout.hint')}</span>
        </label>
      </div>
    </section>
  );
}
