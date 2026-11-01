import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import type { AuthMode6 } from '../../api/connectors';
import { t } from '../../i18n';
import type { ConnectorFormState } from './ConnectorDrawer';
import { fill } from './types';

interface Props {
  mode: 'create' | 'edit';
  authMode: AuthMode6;
  state: ConnectorFormState;
  onChange: (patch: Partial<ConnectorFormState>) => void;
  hasSecret: { apiKey: boolean; clientSecret: boolean };
  /** Pre-formatted secret metadata (null in create mode). */
  secretMeta: { by: string; time: string } | null;
  /** The server-issued loopback redirect URI for a `user-oauth` connector —
   *  the value the admin registers at the upstream IdP. */
  oauthRedirectUri?: string;
}

/** Mode-specific auth fields rendered under the auth-mode select. Secrets are
 * blank inputs with a masked placeholder; a blank secret on submit means "keep
 * the stored value" (backend encrypt-at-write). */
export function ConnectorAuthFields(p: Props): JSX.Element {
  const [customScope, setCustomScope] = useState('');
  const [copied, setCopied] = useState(false);

  // Reset transient state when the mode (and thus the block) changes.
  useEffect(() => {
    setCustomScope('');
    setCopied(false);
  }, [p.authMode]);

  const inputCls =
    'w-full rounded-[6px] border border-[var(--border-default)] px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--accent-primary)]';
  const labelCls = 'flex flex-col gap-1 text-[12px] font-medium text-[var(--text-secondary)]';
  const req = <span className="text-[var(--danger-primary)]">*</span>;

  /** Org-credential modes are reserved: the org key is meant to be injected by
   *  an enterprise-side gateway that does not exist yet, so the desktop client
   *  cannot use these connectors today. Say it here rather than let an admin
   *  believe a connector is working when nothing can call it. */
  const reserveNotice = (
    <p className="col-span-2 rounded-[7px] border border-[var(--warning-primary)]/40 bg-[var(--warning-light)] px-3 py-2 text-[12.5px] leading-relaxed text-[#92400E]">
      {t('mcpDrawer.auth.orgManaged.reserve')}
    </p>
  );

  const metaLine = (visible: boolean): JSX.Element | null =>
    visible && p.secretMeta ? (
      <div className="mt-1.5 rounded-[6px] bg-[var(--bg-tertiary)] px-2.5 py-1.5 text-[12px] leading-relaxed text-[var(--text-secondary)]">
        {fill(t('mcpDrawer.secret.meta'), { by: p.secretMeta.by, time: p.secretMeta.time })}
      </div>
    ) : null;

  const toggleScope = (name: string): void => {
    p.onChange({
      scopes: p.state.scopes.includes(name)
        ? p.state.scopes.filter((s) => s !== name)
        : [...p.state.scopes, name],
    });
  };

  /** Add the typed scope. Silent on an empty input: it is also the blur
   *  handler, so a stray click into and out of the field must not raise a
   *  toast the admin never asked for a scope. */
  const addCustomScope = (): void => {
    const v = customScope.trim();
    if (!v) return;
    if (!p.state.scopes.includes(v)) p.onChange({ scopes: [...p.state.scopes, v] });
    setCustomScope('');
  };

  const copyCallback = (): void => {
    if (!navigator.clipboard) return;
    void navigator.clipboard
      .writeText(p.oauthRedirectUri ?? '')
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };

  if (p.authMode === 'none') {
    return (
      <div className="rounded-[7px] border border-[var(--warning-primary)]/40 bg-[var(--warning-light)] px-3 py-2.5 text-[13px] leading-relaxed text-[#92400E]">
        {t('mcpDrawer.auth.none.warn')}
      </div>
    );
  }

  if (p.authMode === 'shared-key') {
    return (
      <div className="grid grid-cols-2 gap-3.5">
        <p className="col-span-2 rounded-[7px] border border-[var(--accent-primary)]/30 bg-[var(--accent-light)] px-3 py-2 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
          {t('mcpDrawer.auth.sharedKey.gateway')}
        </p>
        <label className={`col-span-2 ${labelCls}`}>
          {t('mcpDrawer.auth.orgApiKey')} {req}
          <input
            type="password"
            className={`${inputCls} font-mono`}
            aria-label={t('mcpDrawer.auth.orgApiKey')}
            placeholder={
              p.mode === 'edit' && p.hasSecret.apiKey
                ? t('mcpDrawer.secret.keepPlaceholder')
                : t('mcpDrawer.auth.orgApiKey.placeholder')
            }
            value={p.state.apiKey}
            onChange={(e) => p.onChange({ apiKey: e.target.value })}
          />
        </label>
        {metaLine(p.hasSecret.apiKey)}
        <label className={`col-span-2 ${labelCls}`}>
          {t('mcpDrawer.auth.orgApiKeyHeaderName')}
          <input
            className={`${inputCls} font-mono`}
            aria-label={t('mcpDrawer.auth.orgApiKeyHeaderName')}
            placeholder={t('mcpDrawer.auth.orgApiKeyHeaderName.placeholder')}
            value={p.state.apiKeyHeaderName}
            onChange={(e) => p.onChange({ apiKeyHeaderName: e.target.value })}
          />
          <span className="text-xs text-[var(--text-tertiary)]">
            {t('mcpDrawer.auth.orgApiKeyHeaderName.hint')}
          </span>
        </label>
        <p className={`col-span-2 text-xs text-[var(--text-tertiary)]`}>
          {t('mcpDrawer.auth.orgApiKey.hint')}
        </p>
      </div>
    );
  }

  if (p.authMode === 'user-key') {
    return (
      <div className="grid grid-cols-2 gap-3.5">
        <label className={`col-span-2 ${labelCls}`}>
          {t('mcpDrawer.auth.userKeyHeaderName')}
          <input
            className={inputCls}
            aria-label={t('mcpDrawer.auth.userKeyHeaderName')}
            placeholder={t('mcpDrawer.auth.userKeyHeaderName.placeholder')}
            value={p.state.apiKeyHeaderName}
            onChange={(e) => p.onChange({ apiKeyHeaderName: e.target.value })}
          />
          <span className="text-xs text-[var(--text-tertiary)]">{t('mcpDrawer.auth.userKeyHeaderName.hint')}</span>
        </label>
        <p className={`col-span-2 text-xs text-[var(--text-tertiary)]`}>{t('mcpDrawer.auth.userKey.note')}</p>
      </div>
    );
  }

  if (p.authMode === 'client-creds') {
    return (
      <div className="grid grid-cols-2 gap-3.5">
        {reserveNotice}
        <label className={`col-span-2 ${labelCls}`}>
          {t('mcpDrawer.auth.tokenUrl')} {req}
          <input
            className={`${inputCls} font-mono`}
            aria-label={t('mcpDrawer.auth.tokenUrl')}
            placeholder={t('mcpDrawer.auth.tokenUrl.placeholder')}
            value={p.state.tokenUrl}
            onChange={(e) => p.onChange({ tokenUrl: e.target.value })}
          />
        </label>
        <label className={labelCls}>
          {t('mcpDrawer.auth.clientId')} {req}
          <input
            className={inputCls}
            aria-label={t('mcpDrawer.auth.clientId')}
            placeholder={t('mcpDrawer.auth.clientId.placeholder')}
            value={p.state.clientId}
            onChange={(e) => p.onChange({ clientId: e.target.value })}
          />
        </label>
        <label className={labelCls}>
          {t('mcpDrawer.auth.clientSecret')} {req}
          <input
            type="password"
            className={`${inputCls} font-mono`}
            aria-label={t('mcpDrawer.auth.clientSecret')}
            placeholder={
              p.mode === 'edit' && p.hasSecret.clientSecret
                ? t('mcpDrawer.secret.keepPlaceholder')
                : t('mcpDrawer.auth.clientSecret.placeholder')
            }
            value={p.state.clientSecret}
            onChange={(e) => p.onChange({ clientSecret: e.target.value })}
          />
        </label>
        {metaLine(p.hasSecret.clientSecret)}
      </div>
    );
  }

  // user-oauth
  return (
    <div className="grid grid-cols-2 gap-3.5">
      <p className="col-span-2 rounded-[7px] border border-[var(--accent-primary)]/30 bg-[var(--accent-light)] px-3 py-2 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
        {t('mcpDrawer.auth.discovery.notice')}
      </p>
      <label className={`col-span-2 ${labelCls}`}>
        {t('mcpDrawer.auth.callbackUrl')}
        <div className="flex gap-2">
          <input
            className={`${inputCls} min-w-0 flex-1 bg-[var(--success-light)] font-mono text-[#047857]`}
            aria-label={t('mcpDrawer.auth.callbackUrl')}
            value={p.oauthRedirectUri ?? ''}
            readOnly
          />
          <button
            type="button"
            onClick={copyCallback}
            className="shrink-0 rounded-[6px] border border-[var(--border-default)] px-2.5 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
          >
            {copied ? t('mcpDrawer.auth.copied') : t('mcpDrawer.auth.copy')}
          </button>
        </div>
        <span className="text-xs text-[var(--text-tertiary)]">{t('mcpDrawer.auth.callbackUrl.hint')}</span>
      </label>

      <label className={labelCls}>
        {t('mcpDrawer.auth.authorizeUrl')}
        <input
          className={`${inputCls} font-mono`}
          aria-label={t('mcpDrawer.auth.authorizeUrl')}
          placeholder={t('mcpDrawer.auth.authorizeUrl.placeholder')}
          value={p.state.authorizeUrl}
          onChange={(e) => p.onChange({ authorizeUrl: e.target.value })}
        />
      </label>
      <label className={labelCls}>
        {t('mcpDrawer.auth.tokenUrl')}
        <input
          className={`${inputCls} font-mono`}
          aria-label={t('mcpDrawer.auth.tokenUrl')}
          placeholder={t('mcpDrawer.auth.tokenUrl.placeholder')}
          value={p.state.tokenUrl}
          onChange={(e) => p.onChange({ tokenUrl: e.target.value })}
        />
      </label>

      <label className={labelCls}>
        {t('mcpDrawer.auth.clientId')}
        <input
          className={inputCls}
          aria-label={t('mcpDrawer.auth.clientId')}
          placeholder={t('mcpDrawer.auth.clientId.placeholder')}
          value={p.state.clientId}
          onChange={(e) => p.onChange({ clientId: e.target.value })}
        />
      </label>
      <div className={`col-span-2 ${labelCls}`}>
        {t('mcpDrawer.auth.scopes')}
        <div className="flex min-h-[42px] flex-wrap items-center gap-1.5 rounded-[7px] border border-[var(--border-default)] bg-[var(--bg-secondary)] p-2">
          {p.state.scopes.map((s) => (
            <span
              key={s}
              className="inline-flex items-center gap-1 rounded-[5px] bg-[var(--accent-light)] px-2 py-0.5 font-mono text-[12px] text-[var(--accent-primary)]"
            >
              {s}
              <button
                type="button"
                aria-label={`${s} ×`}
                onClick={() => toggleScope(s)}
                className="cursor-pointer border-none bg-transparent p-0 opacity-60 hover:opacity-100"
              >
                ×
              </button>
            </span>
          ))}
          <input
            className="min-w-[180px] flex-1 border-none bg-transparent px-1 py-0.5 font-mono text-[12.5px] outline-none"
            placeholder={t('mcpDrawer.auth.scope.customPlaceholder')}
            aria-label={t('mcpDrawer.auth.scope.customPlaceholder')}
            value={customScope}
            onChange={(e) => setCustomScope(e.target.value)}
            onBlur={addCustomScope}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addCustomScope();
              }
            }}
          />
        </div>
        <span className="text-xs text-[var(--text-tertiary)]">{t('mcpDrawer.auth.scopes.hint')}</span>
      </div>
    </div>
  );
}
