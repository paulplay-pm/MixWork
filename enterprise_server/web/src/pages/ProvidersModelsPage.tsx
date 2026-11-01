import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { JSX } from 'react';
import { useEffect, useMemo, useState } from 'react';

import {
  countEnabledModels,
  modelsApi,
  modelTypeDefaultsApi,
  type ModelTypeValue,
  type ModelView,
} from '../api/models';
import {
  providerCardsApi,
  type ProviderCardSectionView,
  type ProviderCardView,
} from '../api/providerCards';
import {
  isChatProtocol,
  type ProviderProtocol,
  providersApi,
} from '../api/providers';
import { useAuth } from '../auth/useAuth';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useToast } from '../components/toastStore';
import { providerDisplayName } from '../data/providerCatalog';
import { t } from '../i18n';
import { ModelDrawer, type ModelSavePayload } from './providersModels/ModelDrawer';
import type { SectionDraft } from './providersModels/ModelTypeSection';
import {
  defaultBaseUrlFor,
  draftKeyForTab,
  MODEL_TYPE_TABS,
  modelTypesForProtocol,
  sectionForTab,
} from './providersModels/modelTypeTabs';
import { type CardDraft, ProviderCard } from './providersModels/ProviderCard';
import { ProviderRail } from './providersModels/ProviderRail';
import { useProviderCardDrafts } from './providersModels/useProviderCardDrafts';

/** The id prefix the rail's "+ Add provider" gives a local draft card. */
const CUSTOM_ID_PREFIX = 'custom-';

/** `New custom provider` → `new-custom-provider`; '' when nothing usable is
 * left (a name written entirely in non-ASCII). */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * A model type counts as configured when the admin put something into it: a
 * key, or a Base URL that is not the tab's default. An untouched tab must not
 * create a credential row — the admin only looked at it.
 */
function isTabConfigured(draft: SectionDraft | undefined, provider: string): boolean {
  if (!draft) return false;
  if (draft.apiKey.trim() !== '') return true;
  const base = draft.baseUrl.trim();
  return base !== '' && base !== defaultBaseUrlFor(provider, draft.protocol);
}

/**
 * Providers & models: one vendor card per provider, each holding one
 * model type section per API protocol it offers (LLM(VLM) / speech
 * recognition / image generation / video generation). A section is a
 * `provider_keys` row with its own Base URL, API key, and model table; the
 * card is the unit the admin configures.
 */
export function ProvidersModelsPage(): JSX.Element {
  const { claims, hasCapability } = useAuth();
  const canManage = hasCapability('model_admin');
  const orgId = claims?.orgId ?? 'default-org';
  const qc = useQueryClient();
  const toast = useToast();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The section whose model drawer is open (`model: null` = adding).
  const [drawer, setDrawer] = useState<{
    section: ProviderCardSectionView;
    model: ModelView | null;
  } | null>(null);
  const [pendingModelDelete, setPendingModelDelete] = useState<ModelView | null>(null);
  const [pendingCardDelete, setPendingCardDelete] = useState<ProviderCardView | null>(null);

  const { drafts, patchSectionDraft, reset, setLabel, setSectionDraft, setSlug } =
    useProviderCardDrafts();

  const cardsQ = useQuery({
    queryKey: ['provider-cards', orgId],
    queryFn: () => providerCardsApi.list(orgId),
  });
  const modelsQ = useQuery({
    queryKey: ['models', orgId],
    queryFn: () => modelsApi.list(orgId),
  });
  const defaultsQ = useQuery({
    queryKey: ['model-type-defaults', orgId],
    queryFn: () => modelTypeDefaultsApi.list(orgId),
  });

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['provider-cards', orgId] });
    void qc.invalidateQueries({ queryKey: ['models', orgId] });
    void qc.invalidateQueries({ queryKey: ['model-type-defaults', orgId] });
  };

  // --- derived data -------------------------------------------------------

  const cards = useMemo<ProviderCardView[]>(() => cardsQ.data ?? [], [cardsQ.data]);
  const models = useMemo<ModelView[]>(() => modelsQ.data ?? [], [modelsQ.data]);

  const modelsBySection = useMemo(() => {
    const out: Record<string, ModelView[]> = {};
    for (const m of models) {
      const key = m.provider_key_id ?? m.provider;
      if (!key) continue;
      (out[key] ??= []).push(m);
    }
    return out;
  }, [models]);

  const defaultTypesByModel = useMemo(() => {
    const out: Record<string, ModelTypeValue[]> = {};
    for (const d of defaultsQ.data ?? []) {
      if (!d.modelId) continue;
      (out[d.modelId] ??= []).push(d.type as ModelTypeValue);
    }
    return out;
  }, [defaultsQ.data]);

  const modelCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const c of cards) {
      // Enabled models only: the rail's number is the size of the vendor's
      // usable catalogue, matching the per-type badge on the card's tabs.
      out[c.id] = c.sections.reduce(
        (n, s) => n + countEnabledModels(modelsBySection[s.providerKeyId] ?? []),
        0
      );
    }
    return out;
  }, [cards, modelsBySection]);

  const isDraftSelection = selectedId !== null && selectedId.startsWith(CUSTOM_ID_PREFIX);
  const storedCard = cards.find((c) => c.id === selectedId) ?? null;
  /** The vendor id: the admin's explicit value, else the slugified name, else
   * the neutral fallback. Drives the brand color and the default Base URL. */
  const slug = drafts.slug.trim() || slugify(drafts.label) || 'custom';

  // A card that only exists in this page until 保存: it has no credential row
  // yet, so every model type shows its empty form until the admin fills one
  // in.
  const draftCard = useMemo<ProviderCardView>(
    () => ({
      id: selectedId ?? '',
      provider: slug,
      label: drafts.label.trim() ? drafts.label : null,
      createdAt: new Date(0).toISOString(),
      isBuiltin: false,
      enabled: false,
      sections: [],
    }),
    [selectedId, slug, drafts.label]
  );

  const activeCard = isDraftSelection ? draftCard : storedCard;

  // --- mutations ----------------------------------------------------------

  const testMut = useMutation({
    mutationFn: (id: string) => providersApi.test(id),
    onSuccess: (r) => {
      // The /test route resolves 200 with status 'connected'|'failed'; only a
      // missing endpoint 400s (handled in onError).
      if (r.status === 'connected') {
        toast.success(
          t('providersModels.test.success').replace('{ms}', String(r.latencyMs ?? 0))
        );
      } else if (r.status === 'unknown') {
        toast.info(t('providersModels.test.notChatProvider'));
      } else {
        toast.error(t('providersModels.test.failed'));
      }
    },
    onError: (e: Error) => {
      const detail =
        (e as { body?: { error?: string } }).body?.error === 'no_endpoint'
          ? t('providersModels.test.noEndpoint')
          : e.message;
      toast.error(detail);
    },
  });

  /** The card header's 保存 on a persisted card: the name goes to the card
   * row, each section's edited fields go to its own provider key, and a model
   * type the admin filled in but has not saved yet becomes a new row. */
  const saveCardMut = useMutation({
    mutationFn: async (target: ProviderCardView) => {
      await providerCardsApi.patch(target.id, { label: drafts.label.trim() || null });
      for (const section of target.sections) {
        const draft = drafts.sections[section.providerKeyId];
        if (!draft) continue;
        await providersApi.patch(section.providerKeyId, {
          baseUrl: draft.baseUrl.trim() || null,
          codingPlan: draft.codingPlan,
          // Omit the key entirely when nothing was typed (keep the stored one).
          ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
        });
      }
      for (const tab of MODEL_TYPE_TABS) {
        // A model type that already has a row was patched above.
        if (sectionForTab(target.sections, tab.id)) continue;
        const draft = drafts.sections[draftKeyForTab(tab.id)];
        if (!isTabConfigured(draft, target.provider)) continue;
        await providersApi.add({
          orgId,
          cardId: target.id,
          provider: target.provider,
          protocol: draft.protocol,
          endpoint:
            draft.baseUrl.trim() || defaultBaseUrlFor(target.provider, draft.protocol),
          codingPlan: draft.codingPlan,
          ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
        });
      }
    },
    onSuccess: () => {
      invalidate();
      toast.success(t('providersModels.toast.saved'));
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /** 保存 on a draft card: create the card, then one provider key per model
   * type the admin filled in. */
  const createCardMut = useMutation({
    mutationFn: async (): Promise<string> => {
      const provider = slug;
      const { id } = await providerCardsApi.create({
        orgId,
        provider,
        label: drafts.label.trim() || undefined,
      });
      for (const tab of MODEL_TYPE_TABS) {
        const draft = drafts.sections[draftKeyForTab(tab.id)];
        if (!isTabConfigured(draft, provider)) continue;
        await providersApi.add({
          orgId,
          cardId: id,
          provider,
          protocol: draft.protocol,
          endpoint:
            draft.baseUrl.trim() || defaultBaseUrlFor(provider, draft.protocol),
          codingPlan: draft.codingPlan,
          ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
        });
      }
      return id;
    },
    onSuccess: (id) => {
      invalidate();
      toast.success(t('providersModels.toast.saved'));
      reset({});
      setSelectedId(id);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /** Enable / disable one model type's credential. A model type is never
   * removed: disabling keeps its models, it only takes them out of calls. */
  const setSectionEnabledMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      providersApi.setEnabled(id, enabled),
    onSuccess: (_r, { enabled }) => {
      invalidate();
      toast.success(
        t(enabled ? 'providersModels.enable.titleOn' : 'providersModels.enable.titleOff')
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const switchProtocolMut = useMutation({
    mutationFn: ({
      id,
      protocol,
      baseUrl,
      codingPlan,
    }: {
      id: string;
      protocol: ProviderProtocol;
      baseUrl: string;
      codingPlan?: boolean;
    }) =>
      providersApi.patch(id, {
        protocol,
        baseUrl,
        ...(codingPlan === undefined ? {} : { codingPlan }),
      }),
    onSuccess: (_r, { id, protocol, baseUrl, codingPlan }) => {
      // `invalidate()` only FIRES the refetch; the card keeps showing the
      // pre-switch row (and the pre-switch draft) until it lands. A 保存 in
      // that window would write the old address back onto the row the server
      // has already re-pointed, so carry the switch into the draft now.
      patchSectionDraft(id, {
        baseUrl,
        protocol,
        ...(codingPlan === undefined ? {} : { codingPlan }),
      });
      invalidate();
      toast.success(t('providersModels.toast.saved'));
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleCardMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      providerCardsApi.patch(id, { enabled }),
    onSuccess: (_r, { enabled }) => {
      invalidate();
      toast.success(
        t(enabled ? 'providersModels.enable.titleOn' : 'providersModels.enable.titleOff')
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteCardMut = useMutation({
    mutationFn: (id: string) => providerCardsApi.remove(id),
    onSuccess: (r) => {
      invalidate();
      toast.success(t('providersModels.toast.deleted').replace('{n}', String(r.deletedModels)));
      reset({});
      setSelectedId(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // 获取模型 — the backend uses the stored key + protocol; errors map to a
  // specific, actionable message.
  const refreshMut = useMutation({
    mutationFn: async (providerKeyId: string): Promise<void> => {
      try {
        const r = await providersApi.refreshModels(providerKeyId);
        if (r.error === 'invalid_api_key') {
          toast.error(t('providersModels.catalog.refreshInvalidKey'));
        } else if (r.error === 'upstream_timeout') {
          toast.error(t('providersModels.catalog.refreshTimeout'));
        } else if (r.error === 'upstream_error') {
          toast.error(
            t('providersModels.catalog.refreshUpstream').replace(
              '{detail}',
              r.detail ?? 'upstream error'
            )
          );
        } else if (r.error === 'empty_endpoint') {
          toast.error(t('providersModels.test.noEndpoint'));
        } else if (r.error === 'not_a_chat_provider') {
          toast.info(t('providersModels.test.notChatProvider'));
        } else {
          toast.success(t('providersModels.catalog.refreshed').replace('{n}', String(r.added)));
        }
      } catch (e) {
        const err = e as { body?: { error?: string } };
        if (err.body?.error === 'provider_disabled') {
          toast.error(t('providersModels.catalog.refreshDisabled'));
        } else {
          toast.info(t('providersModels.catalog.refreshFailed'));
        }
        console.warn('[ProvidersModelsPage] model refresh failed:', e);
      }
    },
    onSettled: invalidate,
  });

  /** The single model editor: add (no id) or patch, then the default-model
   * changes the drawer collected (a new model has no id until it is saved). */
  const saveModelMut = useMutation({
    mutationFn: async (payload: ModelSavePayload): Promise<void> => {
      const capabilities = {
        contextWindow: payload.contextWindow,
        temperature: payload.temperature,
        topP: payload.topP,
      };
      const spec = payload.parameterSpec ? { parameterSpec: payload.parameterSpec } : {};
      let modelId = payload.id;
      if (modelId) {
        await modelsApi.patch(
          modelId,
          {
            displayName: payload.name,
            types: payload.types,
            capabilities,
            ...spec,
          },
          orgId
        );
      } else {
        const created = await modelsApi.add({
          orgId,
          providerKeyId: drawer?.section.providerKeyId ?? '',
          provider: activeCard?.provider ?? '',
          model: payload.model,
          displayName: payload.name,
          types: payload.types,
          capabilities,
          ...spec,
        });
        modelId = created.id;
      }
      for (const change of payload.defaultChanges) {
        await modelsApi.patch(modelId, { defaultForType: change }, orgId);
      }
    },
    onSuccess: () => {
      invalidate();
      setDrawer(null);
      toast.success(t('providersModels.toast.saved'));
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteModelMut = useMutation({
    mutationFn: (id: string) => modelsApi.remove(id, orgId),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleModelMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      modelsApi.patch(id, { enabled }, orgId),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });

  // --- handlers -----------------------------------------------------------

  function handleCardDraft(draft: CardDraft): void {
    if (draft.label !== drafts.label) setLabel(draft.label);
    for (const [key, value] of Object.entries(draft.sections)) setSectionDraft(key, value);
  }

  function selectCard(id: string): void {
    // Clear the previous card's in-progress edits — the newly selected card
    // pushes its own on mount. Re-selecting the same card keeps them.
    if (id !== selectedId) {
      reset({});
    }
    setDrawer(null);
    setSelectedId(id);
  }

  function addProvider(): void {
    reset({ label: t('providersModels.create.newName') });
    setDrawer(null);
    setSelectedId(`${CUSTOM_ID_PREFIX}${Date.now()}`);
  }

  function handleToggleSectionEnabled(
    section: ProviderCardSectionView,
    enabled: boolean
  ): void {
    setSectionEnabledMut.mutate({ id: section.providerKeyId, enabled });
  }

  function handleProtocolChange(
    section: ProviderCardSectionView,
    next: ProviderProtocol
  ): void {
    if (next === section.protocol) return;
    const provider = activeCard?.provider ?? '';
    switchProtocolMut.mutate({
      id: section.providerKeyId,
      protocol: next,
      // The Base URL travels WITH the protocol: the stored endpoint speaks
      // the old wire, and a switch must never leave "new protocol, old
      // address" behind. Coding Plan is an OpenAI-wire feature, so it is
      // cleared when the section leaves the OpenAI wire.
      baseUrl: defaultBaseUrlFor(provider, next),
      ...(next === 'openai' ? {} : { codingPlan: false }),
    });
  }

  function handleTest(target: ProviderCardView): void {
    const section = target.sections.find((s) => isChatProtocol(s.protocol));
    if (section) testMut.mutate(section.providerKeyId);
  }

  function handleSave(target: ProviderCardView): void {
    if (isDraftSelection) createCardMut.mutate();
    else saveCardMut.mutate(target);
  }

  // Default to the first built-in card on entry so the detail pane isn't
  // empty; only when nothing is selected yet (a one-shot).
  const cardsReady = !cardsQ.isLoading && !cardsQ.isPending;
  useEffect(() => {
    if (selectedId !== null || !cardsReady || cards.length === 0) return;
    const first = cards.find((c) => c.isBuiltin) ?? cards[0];
    if (first) setSelectedId(first.id);
  }, [selectedId, cardsReady, cards]);

  if (cardsQ.isLoading || modelsQ.isLoading || defaultsQ.isLoading) {
    return <div className="p-8 text-[var(--text-secondary)]">{t('providersModels.loading')}</div>;
  }

  const busy =
    testMut.isPending ||
    saveCardMut.isPending ||
    createCardMut.isPending ||
    setSectionEnabledMut.isPending ||
    switchProtocolMut.isPending ||
    toggleCardMut.isPending ||
    deleteCardMut.isPending ||
    refreshMut.isPending ||
    saveModelMut.isPending ||
    deleteModelMut.isPending ||
    toggleModelMut.isPending;

  const headerContext: {
    breadcrumbName: string | null;
    h1: string;
    subtitle: string | null;
  } = activeCard
    ? {
        breadcrumbName: activeCard.label ?? providerDisplayName(activeCard.provider),
        h1: activeCard.label ?? providerDisplayName(activeCard.provider),
        subtitle: isDraftSelection ? t('providersModels.create.hint') : null,
      }
    : {
        breadcrumbName: null,
        h1: t('providersModels.title'),
        subtitle: t('providersModels.subtitle'),
      };

  return (
    <div className="flex h-full flex-col bg-[var(--bg-primary)]">
      <div className="border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-6 py-3">
        <div className="text-[12.5px] text-[var(--text-tertiary)]">
          {t('providersModels.breadcrumb.root')}
          <span className="mx-1.5">/</span>
          {t('providersModels.breadcrumb.section')}
          {headerContext.breadcrumbName && (
            <>
              <span className="mx-1.5">/</span>
              <span className="text-[var(--text-primary)]">{headerContext.breadcrumbName}</span>
            </>
          )}
        </div>
        <h1 className="mt-1 text-base font-semibold text-[var(--text-primary)]">
          {headerContext.h1}
        </h1>
        {headerContext.subtitle && (
          <p className="mt-0.5 text-xs text-[var(--text-secondary)]">{headerContext.subtitle}</p>
        )}
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="w-72 shrink-0">
          <ProviderRail
            cards={cards}
            modelCounts={modelCounts}
            selectedId={selectedId}
            onSelect={selectCard}
            canManage={canManage}
            onAddProvider={addProvider}
            onDeleteCard={setPendingCardDelete}
            onToggleCard={(id, enabled) => toggleCardMut.mutate({ id, enabled })}
          />
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {activeCard ? (
            <ProviderCard
              key={activeCard.id}
              card={activeCard}
              canManage={canManage}
              busy={busy}
              isDraft={isDraftSelection}
              modelsBySection={modelsBySection}
              defaultTypesByModel={defaultTypesByModel}
              onDraftChange={handleCardDraft}
              onTest={() => handleTest(activeCard)}
              onSave={() => handleSave(activeCard)}
              onToggleEnabled={(enabled) => toggleCardMut.mutate({ id: activeCard.id, enabled })}
              onToggleSectionEnabled={handleToggleSectionEnabled}
              onProtocolChange={handleProtocolChange}
              onRefreshModels={(section) => refreshMut.mutate(section.providerKeyId)}
              onAddModel={(section) => setDrawer({ section, model: null })}
              onEditModel={(section, model) => setDrawer({ section, model })}
              onDeleteModel={(_section, id) =>
                setPendingModelDelete(models.find((m) => m.id === id) ?? null)
              }
              onToggleModel={(_section, id, enabled) =>
                toggleModelMut.mutate({ id, enabled })
              }
              slugField={
                isDraftSelection ? (
                  <div className="mt-3">
                    <label
                      htmlFor="card-slug"
                      className="mb-1 block text-xs font-medium text-[var(--text-secondary)]"
                    >
                      {t('providersModels.card.slug')}
                    </label>
                    <input
                      id="card-slug"
                      type="text"
                      value={slug}
                      onChange={(e) => setSlug(e.target.value)}
                      disabled={!canManage || busy}
                      className="w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 py-2 font-mono text-sm focus:border-[var(--accent-primary)] focus:bg-[var(--bg-secondary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]/10 disabled:opacity-50"
                    />
                    <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                      {t('providersModels.card.slugHint')}
                    </p>
                  </div>
                ) : null
              }
            />
          ) : (
            <div className="flex h-full items-center justify-center text-[var(--text-secondary)]">
              {t('providersModels.empty.selectProvider')}
            </div>
          )}
        </div>
      </div>

      {drawer && activeCard && (
        <ModelDrawer
          open
          model={drawer.model}
          providerId={drawer.section.providerKeyId}
          provider={activeCard.provider}
          busy={saveModelMut.isPending}
          allowedTypes={modelTypesForProtocol(drawer.section.protocol)}
          defaultTypes={drawer.model ? (defaultTypesByModel[drawer.model.id] ?? []) : []}
          onSave={(payload) => saveModelMut.mutate(payload)}
          onClose={() => setDrawer(null)}
        />
      )}

      <ConfirmDialog
        open={pendingModelDelete !== null}
        destructive
        title={t('providersModels.confirm.deleteModelTitle')}
        message={t('providersModels.confirm.deleteModel').replace(
          '{name}',
          pendingModelDelete
            ? (pendingModelDelete.display_name ?? pendingModelDelete.model)
            : ''
        )}
        cancelLabel={t('common.cancel')}
        confirmLabel={t('common.delete')}
        onConfirm={() => {
          if (pendingModelDelete) deleteModelMut.mutate(pendingModelDelete.id);
          setPendingModelDelete(null);
        }}
        onCancel={() => setPendingModelDelete(null)}
      />

      <ConfirmDialog
        open={pendingCardDelete !== null}
        destructive
        title={t('providersModels.card.deleteCardTitle')}
        message={t('providersModels.confirm.deleteProvider')
          .replace(
            '{name}',
            pendingCardDelete
              ? (pendingCardDelete.label ?? providerDisplayName(pendingCardDelete.provider))
              : ''
          )
          .replace('{n}', String(pendingCardDelete ? (modelCounts[pendingCardDelete.id] ?? 0) : 0))}
        cancelLabel={t('common.cancel')}
        confirmLabel={t('common.delete')}
        onConfirm={() => {
          if (pendingCardDelete) deleteCardMut.mutate(pendingCardDelete.id);
          setPendingCardDelete(null);
        }}
        onCancel={() => setPendingCardDelete(null)}
      />
    </div>
  );
}
