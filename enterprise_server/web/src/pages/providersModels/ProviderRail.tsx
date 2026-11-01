import { Trash2 } from 'lucide-react';
import type { JSX } from 'react';
import { useMemo, useState } from 'react';

import type { ProviderCardView } from '../../api/providerCards';
import { Switch } from '../../components/Switch';
import { brandColor, providerDisplayName } from '../../data/providerCatalog';
import { t } from '../../i18n';

interface Props {
  /** The cards, split into the built-in and custom sections by `isBuiltin`. */
  cards: ProviderCardView[];
  /** The model count per card, keyed by card id. */
  modelCounts: Record<string, number>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  canManage: boolean;
  onAddProvider?: () => void;
  /** Delete-confirm flow. Only offered for cards whose sections are all
   * custom — a card with a built-in credential cannot be deleted. */
  onDeleteCard?: (card: ProviderCardView) => void;
  onToggleCard?: (id: string, enabled: boolean) => void;
}

/** A card can be deleted only when none of its sections is a built-in
 * credential row. A card with no sections at all is custom. */
function isDeletable(card: ProviderCardView): boolean {
  return card.sections.every((s) => !s.isBuiltin);
}

/**
 * Left rail listing every vendor card in one flat list, grouped into 内置服务商
 * (`isBuiltin`) and 自定义服务商 sections. Each row shows the brand square,
 * display name, model-count badge, and an enable switch;
 * a fully custom card adds a delete icon. The search box filters both
 * sections.
 */
export function ProviderRail({
  cards,
  modelCounts,
  selectedId,
  onSelect,
  canManage,
  onAddProvider,
  onDeleteCard,
  onToggleCard,
}: Props): JSX.Element {
  const [search, setSearch] = useState('');

  const builtins = useMemo(() => cards.filter((c) => c.isBuiltin), [cards]);
  const customs = useMemo(() => cards.filter((c) => !c.isBuiltin), [cards]);

  const visibleBuiltins = useMemo(() => filterCards(builtins, search), [builtins, search]);
  const visibleCustoms = useMemo(() => filterCards(customs, search), [customs, search]);

  const row = (card: ProviderCardView, deletable: boolean): JSX.Element => (
    <Row
      key={card.id}
      card={card}
      count={modelCounts[card.id] ?? 0}
      selected={selectedId === card.id}
      canManage={canManage}
      deletable={deletable}
      onSelect={() => onSelect(card.id)}
      onToggle={(next) => onToggleCard?.(card.id, next)}
      onDelete={() => onDeleteCard?.(card)}
    />
  );

  return (
    <div className="flex h-full w-full flex-col gap-3 border-r border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3">
      <input
        type="search"
        placeholder={t('providersModels.rail.search')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-2 py-1.5 text-sm focus:outline-none focus:bg-[var(--bg-secondary)] focus:border-[var(--accent-primary)] focus:ring-2 focus:ring-[var(--accent-primary)]/10"
      />

      <Section title={`${t('providersModels.rail.builtin')} (${visibleBuiltins.length})`}>
        {visibleBuiltins.map((c) => row(c, false))}
      </Section>

      <Section title={`${t('providersModels.rail.custom')} (${visibleCustoms.length})`}>
        {visibleCustoms.map((c) => row(c, isDeletable(c)))}
        {canManage && (
          <button
            type="button"
            onClick={onAddProvider}
            className="flex w-full items-center justify-center rounded-[var(--radius-sm)] border border-dashed border-[var(--border-default)] px-2 py-1.5 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
          >
            + {t('providersModels.rail.addProvider')}
          </button>
        )}
      </Section>
    </div>
  );
}

function filterCards(list: ProviderCardView[], search: string): ProviderCardView[] {
  const s = search.trim().toLowerCase();
  if (!s) return list;
  return list.filter(
    (c) =>
      (c.label ?? providerDisplayName(c.provider)).toLowerCase().includes(s) ||
      c.provider.toLowerCase().includes(s)
  );
}

function Row({
  card,
  count,
  selected,
  canManage,
  deletable,
  onSelect,
  onToggle,
  onDelete,
}: {
  card: ProviderCardView;
  count: number;
  selected: boolean;
  canManage: boolean;
  deletable: boolean;
  onSelect: () => void;
  onToggle: (next: boolean) => void;
  onDelete: () => void;
}): JSX.Element {
  // Display name: an explicit label wins; otherwise the vendor's display name
  // (slug, except where the slug is an abbreviation, e.g. volc → Volcengine).
  const name = card.label ?? providerDisplayName(card.provider);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        // Only select when the key is pressed on the row itself — Enter/Space
        // on the inner Switch or delete button bubbles up and must not also
        // select the row (it should only toggle / delete).
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`group flex w-full cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]/30 ${
        selected
          ? 'bg-[var(--accent-light)] text-[var(--accent-primary)]'
          : 'hover:bg-[var(--bg-hover)]'
      }`}
    >
      <span
        aria-hidden
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] text-[10px] font-semibold uppercase text-white"
        style={{ backgroundColor: brandColor(card.provider) }}
      >
        {name.charAt(0)}
      </span>
      <span className="min-w-0 truncate font-medium">{name}</span>
      <span className="ml-auto inline-flex shrink-0 items-center rounded-full bg-[var(--bg-tertiary)] px-2 text-[11px] text-[var(--text-secondary)]">
        {count}
      </span>
      <span className="shrink-0" onClick={(e) => e.stopPropagation()}>
        <Switch
          checked={card.enabled}
          disabled={!canManage}
          onChange={onToggle}
          label={
            card.enabled
              ? t('providersModels.header.enabled')
              : t('providersModels.header.disabled')
          }
        />
      </span>
      {deletable && canManage && (
        <span
          className="shrink-0 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            aria-label="delete-provider"
            title={t('providersModels.header.delete')}
            onClick={onDelete}
            className="flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)] border-0 bg-transparent text-[var(--text-tertiary)] transition-colors hover:bg-[var(--danger-light)] hover:text-[var(--danger-primary)]"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </span>
      )}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="px-2 text-xs font-medium uppercase text-[var(--text-tertiary)]">
        {title}
      </h3>
      {children}
    </div>
  );
}
