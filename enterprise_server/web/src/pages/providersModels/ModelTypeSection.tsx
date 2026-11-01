import { Eye, EyeOff } from 'lucide-react';
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';

import type { ModelTypeValue, ModelView } from '../../api/models';
import type { ProviderProtocol } from '../../api/providers';
import { Switch } from '../../components/Switch';
import { PROVIDER_ENDPOINTS } from '../../data/providerCatalog';
import { t } from '../../i18n';
import { ModelList } from './ModelList';
import {
  defaultBaseUrlFor,
  type ModelTypeTabDef,
  PROTOCOL_LABEL_KEY,
} from './modelTypeTabs';

export interface SectionDraft {
  /** The Base URL the admin typed. */
  baseUrl: string;
  /** The "Coding Plan" switch. */
  codingPlan: boolean;
  /** The API Key exactly as typed: '' → keep the stored key. */
  apiKey: string;
  /** The protocol the section speaks. A stored section's protocol is switched
   * on the server; a tab that is not configured yet carries a local choice
   * until the card is saved. */
  protocol: ProviderProtocol;
}

interface Props {
  /** The model type this section configures. */
  tab: ModelTypeTabDef;
  /** The section's provider key id. Null for a tab that is not configured
   * yet — its form is a draft until the card is saved. */
  providerKeyId: string | null;
  /** The section's protocol. The LLM section may be openai or anthropic. */
  protocol: ProviderProtocol;
  /** The stored enable state. Undefined for a tab that is not configured yet:
   * there is no row to enable. */
  enabled?: boolean;
  /** Toggle the section's stored enable state. */
  onToggleEnabled?: (enabled: boolean) => void;
  /** The vendor slug the card belongs to (drives the default Base URL). */
  providerSlug: string;
  /** The stored values, used to seed the draft. */
  endpoint: string | null;
  codingPlan: boolean;
  apiKeyMasked: string | null;
  /** A built-in credential row: it is seeded per org and can be disabled. */
  isBuiltin: boolean;
  canManage: boolean;
  busy: boolean;
  /** The section's models, read from `model_catalog` by `provider_key_id`. */
  models: ModelView[];
  /** The types each model is the default for, keyed by model id. */
  defaultTypesByModel: Record<string, ModelTypeValue[]>;
  /** The draft the card holds for this section. A tab the admin filled in and
   * came back to keeps its values. */
  draft?: SectionDraft;
  /** Called with the section's field values on mount and after every change,
   * so the card's single "save" button can submit the in-progress edits. */
  onDraftChange: (draft: SectionDraft) => void;
  /** The admin asked to switch the section's protocol. The page submits the
   * switch (protocol + Base URL) in one request — there is no confirm dialog,
   * because the model list survives the switch. */
  onProtocolChange: (next: ProviderProtocol) => void;
  onRefreshModels: () => void;
  onAddModel: () => void;
  onEditModel: (model: ModelView) => void;
  onDeleteModel: (id: string) => void;
  onToggleModel: (id: string, enabled: boolean) => void;
}

/**
 * One model type's section of a vendor card: the protocol (LLM only), the
 * Base URL, the Coding Plan switch, the API key, and the section's model
 * table.
 *
 * A stored section IS a `provider_keys` row, so everything here edits that
 * one row. A tab that is not configured yet has no row: its form is a draft,
 * and the protocol choice is local until the card is saved.
 *
 * The values are pushed up through `onDraftChange`; the card's single save
 * button submits them.
 */
export function ModelTypeSection({
  tab,
  providerKeyId,
  protocol,
  enabled,
  onToggleEnabled,
  providerSlug,
  endpoint,
  codingPlan,
  apiKeyMasked,
  isBuiltin,
  canManage,
  busy,
  models,
  defaultTypesByModel,
  draft,
  onDraftChange,
  onProtocolChange,
  onRefreshModels,
  onAddModel,
  onEditModel,
  onDeleteModel,
  onToggleModel,
}: Props): JSX.Element {
  /** A tab that is not configured yet has no row to save into. */
  const isDraft = providerKeyId === null;
  const codingPlanEndpoint = PROVIDER_ENDPOINTS[providerSlug]?.codingPlan;
  // The protocol of a tab that is not configured yet is a local choice: there
  // is no row to switch until the card is saved. A stored section's protocol
  // comes from the server, so a failed switch snaps the radio back.
  const [draftProtocol, setDraftProtocol] = useState<ProviderProtocol>(
    draft?.protocol ?? protocol
  );
  const activeProtocol = isDraft ? draftProtocol : protocol;
  const fallbackBaseUrl = defaultBaseUrlFor(providerSlug, activeProtocol);

  const [baseUrl, setBaseUrl] = useState(draft?.baseUrl ?? endpoint ?? fallbackBaseUrl);
  const [codingPlanOn, setCodingPlanOn] = useState(draft?.codingPlan ?? codingPlan);
  const [apiKey, setApiKey] = useState(draft?.apiKey ?? '');
  const [showKey, setShowKey] = useState(false);
  // Keep the latest callback without listing it as a dependency (an inline
  // parent callback changes identity every render, which would re-run the
  // push effect on every render — a pointless loop).
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;
  // The draft is read when the section is reseeded, not on every keystroke:
  // it changes with every character the admin types.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // Whether the admin has edited the Base URL themselves. Until they do, the
  // field follows the vendor: a card the admin is still naming shows the
  // endpoint of the vendor they finally picked, not the placeholder slug's.
  const baseUrlTouched = useRef(false);

  // Keep the previous identity so a protocol switch (same section, new wire)
  // can be told apart from a section switch (new row, its own Base URL) and
  // from the card being renamed (same row, new vendor).
  const identityRef = useRef({ providerKeyId, protocol, providerSlug });

  // Reseed the draft from the stored values, so switching sections never leaks
  // one section's edits into the next. A PROTOCOL switch is different: the
  // stored endpoint speaks the old wire, so the new protocol's canonical Base
  // URL is the right seed. The section's models survive the switch. So is a
  // VENDOR rename, as long as the admin has not typed an address of their own.
  useEffect(() => {
    const prev = identityRef.current;
    identityRef.current = { providerKeyId, protocol, providerSlug };
    const sameSection = prev.providerKeyId === providerKeyId;
    const protocolChanged = sameSection && prev.protocol !== protocol;
    if (!sameSection || protocolChanged) baseUrlTouched.current = false;
    const followsVendor =
      sameSection
      && !protocolChanged
      && prev.providerSlug !== providerSlug
      && !baseUrlTouched.current
      && !codingPlanOn;
    setBaseUrl(
      protocolChanged || followsVendor
        ? defaultBaseUrlFor(providerSlug, protocol)
        : (draftRef.current?.baseUrl ?? endpoint ?? defaultBaseUrlFor(providerSlug, protocol))
    );
    setCodingPlanOn(protocolChanged ? codingPlan : (draftRef.current?.codingPlan ?? codingPlan));
    setDraftProtocol(protocolChanged ? protocol : (draftRef.current?.protocol ?? protocol));
    setApiKey(draftRef.current?.apiKey ?? '');
    setShowKey(false);
    // `codingPlanOn` is read, not a trigger: flipping it already sets the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerKeyId, protocol, providerSlug, endpoint, codingPlan]);

  // Push the current field values up to the card so its single save button can
  // submit them. Fires on mount (initial values) and after every change.
  useEffect(() => {
    onDraftChangeRef.current({
      baseUrl,
      codingPlan: codingPlanOn,
      apiKey,
      protocol: activeProtocol,
    });
  }, [baseUrl, codingPlanOn, apiKey, activeProtocol]);

  // Toggling Coding Plan on swaps the Base URL to the coding endpoint; off
  // reverts to the current protocol's default (the "auto-switch" behavior).
  function changeCodingPlan(next: boolean): void {
    setCodingPlanOn(next);
    setBaseUrl(next ? codingPlanEndpoint! : fallbackBaseUrl);
  }

  function changeProtocol(next: ProviderProtocol): void {
    if (isDraft) {
      // No row to switch: the choice is local until the card is saved.
      setDraftProtocol(next);
      setBaseUrl(defaultBaseUrlFor(providerSlug, next));
    }
    onProtocolChange(next);
  }

  const apiKeyFieldId = `section-api-key-${providerKeyId ?? 'draft'}`;
  const maskedHint = apiKeyMasked
    ? t('providersModels.info.current').replace('{masked}', apiKeyMasked)
    : null;
  // Only the LLM model type offers a protocol choice; the media and speech
  // sections speak exactly one protocol each.
  const showsProtocolRadio = tab.protocols.length > 1;
  const showsCodingPlan = !!codingPlanEndpoint && activeProtocol === 'openai';

  return (
    <div
      className="mt-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-4"
      data-model-type={tab.id}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">
          {t(tab.labelKey)}
        </h3>
        <div className="flex flex-wrap items-center gap-4">
          {showsProtocolRadio && (
            <fieldset className="flex items-center gap-4">
              <legend className="sr-only">{t('providersModels.card.protocol')}</legend>
              {tab.protocols.map((value) => (
                <label
                  key={value}
                  className="flex cursor-pointer items-center gap-1.5 text-sm text-[var(--text-primary)]"
                >
                  <input
                    type="radio"
                    name={`section-protocol-${providerKeyId ?? 'draft'}`}
                    value={value}
                    checked={activeProtocol === value}
                    disabled={!canManage || busy}
                    onChange={() => changeProtocol(value)}
                    className="h-3.5 w-3.5 accent-[var(--accent-primary)]"
                  />
                  {t(PROTOCOL_LABEL_KEY[value])}
                </label>
              ))}
            </fieldset>
          )}
          {onToggleEnabled && (
            <Switch
              checked={enabled ?? false}
              disabled={!canManage || busy}
              onChange={onToggleEnabled}
              label={t('providersModels.card.sectionEnabled')}
            />
          )}
        </div>
      </div>

      <div>
        <label
          htmlFor={`section-base-url-${providerKeyId ?? 'draft'}`}
          className="mb-1 block text-xs font-medium text-[var(--text-secondary)]"
        >
          {t('providersModels.info.baseUrl')}
        </label>
        <input
          id={`section-base-url-${providerKeyId ?? 'draft'}`}
          type="text"
          value={baseUrl}
          onChange={(e) => {
            baseUrlTouched.current = true;
            setBaseUrl(e.target.value);
          }}
          disabled={!canManage}
          placeholder={fallbackBaseUrl}
          className="w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm focus:outline-none focus:bg-[var(--bg-secondary)] focus:border-[var(--accent-primary)] focus:ring-2 focus:ring-[var(--accent-primary)]/10 disabled:opacity-50 transition-colors"
        />
      </div>

      {showsCodingPlan && (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] px-3 py-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-sm font-medium text-[var(--text-primary)]">
              {t('providersModels.codingPlan.title')}
              <span className="rounded-[var(--radius-sm)] bg-[var(--accent-light)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent-primary)]">
                {t('providersModels.codingPlan.badge')}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
              {codingPlanOn
                ? t('providersModels.codingPlan.on').replace('{endpoint}', codingPlanEndpoint)
                : t('providersModels.codingPlan.off')}
            </p>
          </div>
          <Switch
            checked={codingPlanOn}
            disabled={!canManage}
            onChange={changeCodingPlan}
            label={t('providersModels.codingPlan.switch')}
          />
        </div>
      )}

      <div className="mt-3">
        <label
          htmlFor={apiKeyFieldId}
          className="mb-1 block text-xs font-medium text-[var(--text-secondary)]"
        >
          {t('providersModels.info.apiKey')}
        </label>
        <div className="relative">
          <input
            id={apiKeyFieldId}
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            disabled={!canManage}
            placeholder="sk-…"
            className="w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 py-2 pr-16 text-sm focus:outline-none focus:bg-[var(--bg-secondary)] focus:border-[var(--accent-primary)] focus:ring-2 focus:ring-[var(--accent-primary)]/10 disabled:opacity-50 transition-colors"
          />
          {canManage && (
            <button
              type="button"
              onClick={() => setShowKey(!showKey)}
              aria-label={showKey ? t('providersModels.info.hideKey') : t('providersModels.info.showKey')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-[var(--radius-sm)] px-1 py-1 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]"
            >
              {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          )}
        </div>
        {maskedHint && (
          <>
            <p className="mt-1 text-xs text-[var(--text-tertiary)]">{maskedHint}</p>
            <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
              {t('providersModels.form.apiKeyHint')}
            </p>
          </>
        )}
        {isBuiltin && (
          <p className="mt-1 text-xs text-[var(--text-tertiary)]">
            {t('providersModels.section.builtinHint')}
          </p>
        )}
      </div>

      <div className="mt-4">
        <ModelList
          models={models}
          /* A tab that is not configured yet has no row to attach a model
           * to, so its list is read-only until the card is saved. */
          canManage={canManage && !isDraft}
          busy={busy}
          canRefresh={tab.canRefreshModels}
          defaultTypesByModel={defaultTypesByModel}
          onRefresh={onRefreshModels}
          onAdd={onAddModel}
          onEdit={onEditModel}
          onDelete={onDeleteModel}
          onToggleEnabled={onToggleModel}
        />
      </div>
    </div>
  );
}
