import { RefreshCw } from 'lucide-react';
import type { JSX } from 'react';

import type { ProviderCardView } from '../../api/providerCards';
import { Switch } from '../../components/Switch';
import { brandColor, providerDisplayName } from '../../data/providerCatalog';
import { t } from '../../i18n';

interface Props {
  card: ProviderCardView;
  canManage: boolean;
  /** Disable the actions while a mutation (test / save) is in flight. */
  busy: boolean;
  /** Whether the connection test applies. Only a chat section has an
   * endpoint to probe; a card without one has nothing to test. */
  canTest?: boolean;
  /** Whether the master switch applies. A card that only exists as a draft
   * has no row to enable yet. Defaults to true. */
  canToggleEnabled?: boolean;
  onTest: () => void;
  onSave: () => void;
  onToggleEnabled: (enabled: boolean) => void;
}

/**
 * Top-of-detail header for a vendor card: 48px brand square, the card's
 * display name, the 内置/自定义 tag, the vendor slug, and the card's master
 * enable switch. Right side holds 测试连接 (ghost) and 保存 (primary).
 * Deleting a card lives on the rail row.
 */
export function ProviderHeaderBar({
  card,
  canManage,
  busy,
  canTest = false,
  canToggleEnabled = true,
  onTest,
  onSave,
  onToggleEnabled,
}: Props): JSX.Element {
  const name = card.label ?? providerDisplayName(card.provider);
  return (
    <div className="flex items-center justify-between gap-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-xl font-semibold text-white"
          style={{ backgroundColor: brandColor(card.provider) }}
        >
          {name.charAt(0)}
        </span>
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-[var(--text-primary)]">
              {name}
            </span>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                card.isBuiltin
                  ? 'bg-[var(--accent-light)] text-[var(--accent-primary)]'
                  : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
              }`}
            >
              {card.isBuiltin
                ? t('providersModels.rail.builtin')
                : t('providersModels.rail.custom')}
            </span>
          </div>
          <span className="truncate font-mono text-xs text-[var(--text-tertiary)]">
            {card.provider}
          </span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <Switch
          checked={card.enabled}
          disabled={!canManage || busy || !canToggleEnabled}
          onChange={onToggleEnabled}
          label={t('providersModels.header.enabled')}
        />
        {canTest && (
          <button
            type="button"
            onClick={onTest}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-50 transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t('providersModels.header.test')}
          </button>
        )}
        {canManage && (
          <button
            type="button"
            onClick={onSave}
            disabled={busy}
            className="rounded-[var(--radius-sm)] bg-[var(--accent-primary)] px-2.5 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent-primary-hover)] disabled:opacity-50 transition-colors"
          >
            {t('providersModels.header.save')}
          </button>
        )}
      </div>
    </div>
  );
}
