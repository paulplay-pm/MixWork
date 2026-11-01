import type { JSX, ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { countEnabledModels, type ModelTypeValue, type ModelView } from '../../api/models';
import type { ProviderCardSectionView, ProviderCardView } from '../../api/providerCards';
import type { ProviderProtocol } from '../../api/providers';
import { isChatProtocol } from '../../api/providers';
import { providerDisplayName } from '../../data/providerCatalog';
import { t } from '../../i18n';
import { ModelTypeSection, type SectionDraft } from './ModelTypeSection';
import {
  draftKeyForTab,
  MODEL_TYPE_TABS,
  type ModelTypeTabDef,
  ModelTypeTabId,
  sectionForTab,
} from './modelTypeTabs';
import { ProviderHeaderBar } from './ProviderHeaderBar';

export interface CardDraft {
  /** The card's display name. */
  label: string;
  /** The per-section field values, keyed by the section's provider key id
   * (or, for a tab that is not configured yet, by its draft key). */
  sections: Record<string, SectionDraft>;
}

interface Props {
  card: ProviderCardView;
  canManage: boolean;
  busy: boolean;
  /** True while the card is a draft the admin is still filling in. */
  isDraft?: boolean;
  /** Extra field rendered under the name input (the vendor id, which only a
   * card that does not exist yet can still choose). */
  slugField?: ReactNode;
  /** The card's models, keyed by provider key id. */
  modelsBySection: Record<string, ModelView[]>;
  /** The types each model is the default for, keyed by model id. */
  defaultTypesByModel: Record<string, ModelTypeValue[]>;
  onDraftChange: (draft: CardDraft) => void;
  /** The header's 测试连接 / 保存 / master switch. The card owns their state,
   * so it only forwards them. */
  onTest: () => void;
  onSave: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  /** The admin enabled or disabled one model type's credential. */
  onToggleSectionEnabled: (section: ProviderCardSectionView, enabled: boolean) => void;
  onProtocolChange: (section: ProviderCardSectionView, next: ProviderProtocol) => void;
  onRefreshModels: (section: ProviderCardSectionView) => void;
  onAddModel: (section: ProviderCardSectionView) => void;
  onEditModel: (section: ProviderCardSectionView, model: ModelView) => void;
  onDeleteModel: (section: ProviderCardSectionView, modelId: string) => void;
  onToggleModel: (section: ProviderCardSectionView, modelId: string, enabled: boolean) => void;
}

/**
 * The tab a card opens on: the first one that has a section, so the card
 * shows what the vendor actually offers. A card with no section yet opens on
 * the LLM tab.
 */
function firstTabWithSection(sections: ProviderCardSectionView[]): ModelTypeTabId {
  for (const tab of MODEL_TYPE_TABS) {
    if (sectionForTab(sections, tab.id)) return tab.id;
  }
  return ModelTypeTabId.Llm;
}

/**
 * One vendor card: the header, the name field, one tab per model type, and
 * the model type the admin is looking at.
 *
 * The card is the unit the admin configures: a vendor plus the model types it
 * offers. Each model type is a separate `provider_keys` row (its own Base
 * URL, API key, and model list).
 */
export function ProviderCard({
  card,
  canManage,
  busy,
  isDraft = false,
  slugField,
  modelsBySection,
  defaultTypesByModel,
  onDraftChange,
  onTest,
  onSave,
  onToggleEnabled,
  onToggleSectionEnabled,
  onProtocolChange,
  onRefreshModels,
  onAddModel,
  onEditModel,
  onDeleteModel,
  onToggleModel,
}: Props): JSX.Element {
  const fallbackName = card.label ?? providerDisplayName(card.provider);
  const [label, setLabel] = useState(fallbackName);
  const [sectionDrafts, setSectionDrafts] = useState<Record<string, SectionDraft>>({});
  const [activeTab, setActiveTab] = useState<ModelTypeTabId>(() =>
    firstTabWithSection(card.sections)
  );
  // Keep the latest callback without listing it as a dependency (an inline
  // parent callback changes identity every render, which would re-run the
  // push effect and re-render the parent — a pointless loop).
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;

  // Reset the name when a DIFFERENT card is selected — not when the label or
  // the slug prop changes: a draft card's label echoes what the admin types
  // back through the page, and reseeding on that echo would revert an empty
  // field to the provider's display name mid-edit.
  const identityRef = useRef(card.id);
  useEffect(() => {
    if (identityRef.current === card.id) return;
    identityRef.current = card.id;
    setLabel(card.label ?? providerDisplayName(card.provider));
    setSectionDrafts({});
    setActiveTab(firstTabWithSection(card.sections));
  }, [card.id, card.label, card.provider, card.sections]);

  useEffect(() => {
    onDraftChangeRef.current({ label, sections: sectionDrafts });
  }, [label, sectionDrafts]);

  function handleSectionDraft(key: string, draft: SectionDraft): void {
    setSectionDrafts((prev) => {
      const cur = prev[key];
      if (
        cur
        && cur.baseUrl === draft.baseUrl
        && cur.codingPlan === draft.codingPlan
        && cur.apiKey === draft.apiKey
        && cur.protocol === draft.protocol
      ) {
        return prev;
      }
      return { ...prev, [key]: draft };
    });
  }

  const activeTabDef: ModelTypeTabDef =
    MODEL_TYPE_TABS.find((tab) => tab.id === activeTab) ?? MODEL_TYPE_TABS[0]!;
  const activeSection = useMemo(
    () => sectionForTab(card.sections, activeTab),
    [card.sections, activeTab]
  );
  /** The key this tab's draft lives under: its provider key id, or the
   * placeholder key of a tab that is not configured yet. */
  const sectionKey = activeSection?.providerKeyId ?? draftKeyForTab(activeTab);

  // A card that does not exist yet has no credential row to probe: its
  // sections are placeholders whose synthetic ids the test endpoint would 404.
  const canTest = !isDraft && card.sections.some((s) => isChatProtocol(s.protocol));

  const sectionNode = (
    <ModelTypeSection
      key={sectionKey}
      tab={activeTabDef}
      providerKeyId={activeSection?.providerKeyId ?? null}
      protocol={activeSection?.protocol ?? activeTabDef.protocol}
      enabled={activeSection?.enabled}
      onToggleEnabled={
        activeSection
          ? (next: boolean) => onToggleSectionEnabled(activeSection, next)
          : undefined
      }
      providerSlug={card.provider}
      endpoint={activeSection?.endpoint ?? null}
      codingPlan={activeSection?.codingPlan ?? false}
      apiKeyMasked={activeSection?.apiKeyMasked ?? null}
      isBuiltin={activeSection?.isBuiltin ?? false}
      canManage={canManage}
      busy={busy}
      models={activeSection ? (modelsBySection[activeSection.providerKeyId] ?? []) : []}
      defaultTypesByModel={defaultTypesByModel}
      draft={sectionDrafts[sectionKey]}
      onDraftChange={(draft) => handleSectionDraft(sectionKey, draft)}
      onProtocolChange={(next) => {
        // A tab that is not configured yet has no row to switch: the choice
        // stays local until the card is saved.
        if (activeSection) onProtocolChange(activeSection, next);
      }}
      onRefreshModels={() => {
        if (activeSection) onRefreshModels(activeSection);
      }}
      onAddModel={() => {
        if (activeSection) onAddModel(activeSection);
      }}
      onEditModel={(model) => {
        if (activeSection) onEditModel(activeSection, model);
      }}
      onDeleteModel={(modelId) => {
        if (activeSection) onDeleteModel(activeSection, modelId);
      }}
      onToggleModel={(modelId, enabled) => {
        if (activeSection) onToggleModel(activeSection, modelId, enabled);
      }}
    />
  );

  return (
    <div>
      <ProviderHeaderBar
        card={card}
        canManage={canManage}
        busy={busy}
        canTest={canTest}
        /* A card the admin is still filling in has no row to enable yet. */
        canToggleEnabled={!isDraft}
        onTest={onTest}
        onSave={onSave}
        onToggleEnabled={onToggleEnabled}
      />

      <div className="mt-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-4">
        <label
          htmlFor={`card-name-${card.id}`}
          className="mb-1 block text-xs font-medium text-[var(--text-secondary)]"
        >
          {t('providersModels.card.name')}
        </label>
        <input
          id={`card-name-${card.id}`}
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          disabled={!canManage || busy}
          className="w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm focus:outline-none focus:bg-[var(--bg-secondary)] focus:border-[var(--accent-primary)] focus:ring-2 focus:ring-[var(--accent-primary)]/10 disabled:opacity-50 transition-colors"
        />
        <p className="mt-1 text-xs text-[var(--text-tertiary)]">
          {t('providersModels.card.nameHint')}
        </p>
        {slugField}
      </div>

      {/* The tabs are their own row: a group caption next to them repeated the
        * tab labels and crowded the card. The tab list still names itself for
        * assistive tech. */}
      <div className="mt-4">
        <div
          role="tablist"
          aria-label={t('providersModels.card.modelTypeTabs')}
          className="flex flex-wrap items-center gap-1 border-b border-[var(--border-subtle)]"
        >
          {MODEL_TYPE_TABS.map((tab) => {
            const section = sectionForTab(card.sections, tab.id);
            // Only the models that can actually be routed to: the admin reads
            // this badge as "how many models this type will serve".
            const count = section
              ? countEnabledModels(modelsBySection[section.providerKeyId] ?? [])
              : 0;
            const isActive = tab.id === activeTab;
            // A model type that is configured but disabled keeps its badge and
            // its models; only its label dims. A tab that is not configured yet
            // is never dimmed — it is the one the admin is about to fill in.
            const isOff = section !== null && !section.enabled;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`card-tab-${card.id}-${tab.id}`}
                aria-selected={isActive}
                aria-controls={`card-tabpanel-${card.id}-${tab.id}`}
                onClick={() => setActiveTab(tab.id)}
                className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? 'border-[var(--accent-primary)] text-[var(--accent-primary)]'
                    : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                } ${isOff ? 'opacity-60' : ''}`}
              >
                {t(tab.labelKey)}
                {count > 0 && (
                  <span className="rounded-full bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-secondary)]">
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div
        role="tabpanel"
        id={`card-tabpanel-${card.id}-${activeTab}`}
        aria-labelledby={`card-tab-${card.id}-${activeTab}`}
      >
        {activeSection ? (
          <>
            {!activeSection.enabled && (
              <p className="mt-3 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] px-3 py-2 text-xs text-[var(--text-secondary)]">
                {t('providersModels.card.sectionDisabled')}
              </p>
            )}
            {sectionNode}
          </>
        ) : (
          <>
            <p className="mt-3 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] px-3 py-2 text-xs text-[var(--text-secondary)]">
              {t('providersModels.card.sectionNotConfigured')}
            </p>
            {sectionNode}
          </>
        )}
      </div>
    </div>
  );
}
