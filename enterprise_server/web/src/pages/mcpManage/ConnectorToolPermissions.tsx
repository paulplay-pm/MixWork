import type { JSX } from 'react';

import type { ToolEntry } from '../../api/connectors';
import { Switch } from '../../components/Switch';
import { t } from '../../i18n';
import { fill } from './types';

interface Props {
  mode: 'create' | 'edit';
  /** The tool rows: what the server discovered plus what the admin declared,
   * with the per-tool toggles applied. */
  tools: ToolEntry[];
  toolToggles: Record<string, boolean>;
  onToggle: (name: string, enabled: boolean) => void;
  /** The admin's hand-written tool list (one tool name per line). */
  declaredText: string;
  onDeclaredChange: (text: string) => void;
  /** Whether the enterprise server can list this connector's tools itself. */
  serverCanDiscover: boolean;
}

/** 工具权限 section. One row per tool — the ones the server discovered and
 * the ones the admin declared by hand (tagged 手工) — each with a Switch
 * bound to the form's `toolToggles`; `removed` tools (no longer listed by
 * the server) are grayed with a disabled switch.
 *
 * The declaration box is always here: when the org holds the connector's
 * credential the server fills the list in by itself, and a declaration is
 * the admin adding to it; when it does not, the declaration IS the list. */
export function ConnectorToolPermissions(p: Props): JSX.Element {
  const showRows = p.tools.length > 0;
  return (
    <section className="mt-5 border-t border-dashed border-[var(--border-default)] pt-4">
      <h4 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
        {p.mode === 'create' ? t('mcpDrawer.tools') : fill(t('mcpDrawer.tools.editTitle'), { n: p.tools.length })}
      </h4>
      {!p.serverCanDiscover && (
        // The server holds no credential for this connector, so it cannot run
        // the handshake that would list the tools. Saying so is the honest
        // answer to "why is the list empty".
        <div className="mb-3 rounded-[7px] border border-[#B45309]/30 bg-[var(--bg-tertiary)] px-3 py-2.5 text-[12.5px] leading-relaxed text-[#B45309]">
          {t('mcpDrawer.tools.serverCannotDiscover')}
        </div>
      )}
      {showRows ? (
        <div className="flex flex-col gap-1.5">
          {p.tools.map((tool) => (
            <div
              key={tool.name}
              className={`flex items-center gap-3 rounded-[7px] bg-[var(--bg-tertiary)] px-3 py-2 ${
                tool.removed ? 'opacity-55' : ''
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono text-[12.5px] text-[var(--text-primary)]">{tool.name}</span>
                  {!tool.syncedAt && (
                    <span className="shrink-0 rounded-[4px] border border-[var(--border-default)] px-1.5 py-0.5 text-[11px] text-[var(--text-tertiary)]">
                      {t('mcpDrawer.tools.declaredTag')}
                    </span>
                  )}
                  {tool.removed && (
                    <span className="shrink-0 text-[11px] text-[var(--text-tertiary)]">
                      {t('mcpDrawer.tools.removedHint')}
                    </span>
                  )}
                </div>
                {tool.desc && (
                  <div className="truncate text-[12px] text-[var(--text-tertiary)]">{tool.desc}</div>
                )}
              </div>
              <Switch
                checked={p.toolToggles[tool.name] ?? tool.enabled}
                onChange={(v) => p.onToggle(tool.name, v)}
                disabled={!!tool.removed}
                label={tool.name}
              />
            </div>
          ))}
        </div>
      ) : (
        p.serverCanDiscover && (
          <div className="rounded-[7px] bg-[var(--bg-tertiary)] px-3 py-2.5 text-[13px] leading-relaxed text-[var(--text-secondary)]">
            {t('mcpDrawer.tools.createNote')}
          </div>
        )
      )}
      <label className="mt-3 flex flex-col gap-1 text-[12px] font-medium text-[var(--text-secondary)]">
        {t('mcpDrawer.tools.declareTitle')}
        <textarea
          className="w-full resize-y rounded-[6px] border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-2.5 py-1.5 font-mono text-[12.5px] text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]"
          aria-label={t('mcpDrawer.tools.declareTitle')}
          placeholder={t('mcpDrawer.tools.declarePlaceholder')}
          rows={3}
          value={p.declaredText}
          onChange={(e) => p.onDeclaredChange(e.target.value)}
        />
        <span className="text-[11.5px] font-normal leading-relaxed text-[var(--text-tertiary)]">
          {t('mcpDrawer.tools.declareHint')}
        </span>
      </label>
      {showRows && (
        // The toggle reaches the desktop as OpenClaw's per-server tool filter,
        // which is written when the desktop installs or updates the connector —
        // not live. Saying so keeps a policy change from looking broken.
        <p className="mt-2.5 text-[12px] text-[var(--text-tertiary)]">{t('mcpDrawer.tools.applyNote')}</p>
      )}
    </section>
  );
}
