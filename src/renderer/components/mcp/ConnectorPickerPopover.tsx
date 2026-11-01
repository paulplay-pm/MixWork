import { Cog6ToothIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { builtinConnectorIcon } from '../../data/brandIcons';
import { i18nService } from '../../services/i18n';
import { mcpService } from '../../services/mcp';
import { RootState } from '../../store';
import { openMcpAuthModal } from '../../store/slices/mcpAuthSlice';
import { setMcpServers } from '../../store/slices/mcpSlice';
import type { McpServerConfig, McpToolListOutcome } from '../../types/mcp';
import CardToggle from '../common/CardToggle';
import SearchIcon from '../icons/SearchIcon';
import { catalogIconsByServerKey, resolveConnectorIcon } from './connectorIcon';
import { connectorRowState, connectorStatusLabelKey } from './connectorPickerState';
import { McpIconTile } from './McpCard';

/** Below this many connectors the list is short enough to read without a
 *  search box — the same threshold the kit picker uses. */
const MIN_SEARCHABLE_CONNECTOR_COUNT = 3;

/**
 * The org's catalog logos, fetched at most once per app run.
 *
 * Two picker instances exist — the toolbar button and the `+` menu item — so
 * the request is shared rather than fired twice.
 */
let catalogIconsPromise: Promise<Record<string, string>> | null = null;

function loadCatalogIcons(): Promise<Record<string, string>> {
  if (!catalogIconsPromise) {
    catalogIconsPromise = mcpService
      .fetchEnterpriseMarketplace()
      .then((data) => catalogIconsByServerKey(data?.servers ?? []))
      .catch(() => ({}));
  }
  return catalogIconsPromise;
}

/**
 * How long a row says the gateway is restarting to load the connector.
 *
 * Switching a connector on rewrites `mcp.servers`, and OpenClaw only picks
 * that up on a gateway restart. Without a word about it the user sends the
 * next message and the connector's tools are simply not there yet.
 */
const RESTART_HINT_MS = 6000;

interface ConnectorPickerPopoverProps {
  isOpen: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement>;
  onManageConnectors: () => void;
  /** Opens to the right of its anchor, as a submenu of the `+` menu. Without
   *  it the popover opens upwards, like the kit picker it sits beside. */
  asSubmenu?: boolean;
}

/**
 * Where the connector list lives.
 *
 * Two entry points, one list: the `+` menu (a submenu beside the item) and a
 * toolbar button next to the kit picker (a popover above it). It is where a
 * user turns a connector on and where they find out that one needs to be
 * authorized again, so it is both the picker and the repair surface: a row
 * can be switched on, and a row whose credential has expired can be
 * authorized again without leaving the conversation.
 */
const ConnectorPickerPopover: React.FC<ConnectorPickerPopoverProps> = ({
  isOpen,
  onClose,
  anchorRef,
  onManageConnectors,
  asSubmenu = false,
}) => {
  const dispatch = useDispatch();
  const servers = useSelector((state: RootState) => state.mcp.servers);
  const [searchQuery, setSearchQuery] = useState('');
  const [maxListHeight, setMaxListHeight] = useState(300);
  const [probes, setProbes] = useState<Record<string, McpToolListOutcome>>({});
  const [restartingIds, setRestartingIds] = useState<string[]>([]);
  const [catalogIcons, setCatalogIcons] = useState<Record<string, string>>({});
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const shouldShowSearch = servers.length >= MIN_SEARCHABLE_CONNECTOR_COUNT;

  // The management page keeps the server list in Redux, but the chat view
  // does not — so load it the first time the picker opens.
  useEffect(() => {
    if (!isOpen || servers.length > 0) return;
    let cancelled = false;
    void mcpService.loadServers().then((loaded) => {
      if (!cancelled) dispatch(setMcpServers(loaded));
    });
    return () => {
      cancelled = true;
    };
  }, [dispatch, isOpen, servers.length]);

  // The org's catalog, for the connectors whose logo the local record does
  // not carry. One fetch for the whole app: a connector installed before the
  // desktop started storing icons still shows its logo, without asking the
  // member to reinstall it.
  useEffect(() => {
    let cancelled = false;
    void loadCatalogIcons().then((icons) => {
      if (!cancelled) setCatalogIcons(icons);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Ask every enabled connector whether it still answers. A stored
  // `authStatus` only records the last probe, which may be hours old, and a
  // connector whose authorization expired in the meantime looks perfectly
  // healthy until it is called.
  useEffect(() => {
    if (!isOpen) return;
    const enabled = servers.filter((server) => server.enabled);
    if (enabled.length === 0) return;
    let cancelled = false;
    void Promise.all(
      enabled.map(async (server) => {
        const outcome = await mcpService.listTools(server.id);
        return [server.id, outcome] as const;
      }),
    ).then((results) => {
      if (cancelled) return;
      setProbes(Object.fromEntries(results));
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, servers]);

  useEffect(() => {
    if (!isOpen) return;
    if (anchorRef.current) {
      const anchorRect = anchorRef.current.getBoundingClientRect();
      // Beside the `+` menu the list can use the room below the item; above
      // a toolbar button it has to fit between the button and the toolbar.
      const availableHeight = asSubmenu
        ? anchorRect.bottom - 72
        : anchorRect.top - 120 - 104;
      setMaxListHeight(Math.max(120, Math.min(300, availableHeight)));
    }
    if (shouldShowSearch && searchInputRef.current) {
      setTimeout(() => searchInputRef.current?.focus(), 0);
    }
  }, [anchorRef, asSubmenu, isOpen, shouldShowSearch]);

  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
      setProbes({});
      setRestartingIds([]);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const isInsidePopover = popoverRef.current?.contains(target);
      const isInsideAnchor = anchorRef.current?.contains(target);
      if (!isInsidePopover && !isInsideAnchor) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [anchorRef, isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  const filteredServers = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return servers;
    return servers.filter(
      (server) =>
        server.name.toLowerCase().includes(query) ||
        (server.description ?? '').toLowerCase().includes(query),
    );
  }, [searchQuery, servers]);

  const handleToggle = async (server: McpServerConfig, enabled: boolean) => {
    try {
      const updated = await mcpService.setServerEnabled(server.id, enabled);
      dispatch(setMcpServers(updated));
      if (enabled) {
        // The connector's tools only exist after the gateway picks up the new
        // `mcp.servers`, so say so rather than let the next message fail
        // silently.
        setRestartingIds((ids) => [...ids, server.id]);
        setTimeout(() => {
          setRestartingIds((ids) => ids.filter((id) => id !== server.id));
        }, RESTART_HINT_MS);
      }
    } catch (error) {
      console.error('[MCP] failed to toggle connector:', error);
    }
  };

  const handleConnect = (server: McpServerConfig, mode: 'connect' | 'reauthorize') => {
    dispatch(openMcpAuthModal({ mode, serverId: server.id }));
  };

  if (!isOpen) return null;

  const renderRow = (server: McpServerConfig) => {
    const state = connectorRowState(server, probes[server.id]);
    const statusKey = connectorStatusLabelKey(state);
    const isRestarting = restartingIds.includes(server.id);

    return (
      <div
        key={server.id}
        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-surface-raised"
      >
        <McpIconTile
          className="h-7 w-7 rounded-lg"
          iconClassName="h-3.5 w-3.5"
          icon={
            resolveConnectorIcon(server, catalogIcons)
            ?? builtinConnectorIcon(server.registryId ?? '')
          }
          seed={server.id}
          label={server.name}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate text-[13px] font-semibold leading-5 text-foreground">
              {server.name}
            </span>
            {statusKey && (
              <span
                className={`shrink-0 text-[11px] leading-4 ${
                  state.status === 'auth-expired' ? 'text-red-500' : 'text-secondary'
                }`}
              >
                {i18nService.t(statusKey)}
              </span>
            )}
          </div>
          {isRestarting && (
            <p className="mt-0.5 truncate text-[11px] leading-4 text-secondary">
              {i18nService.t('mcpConnectorRestarting')}
            </p>
          )}
        </div>
        {state.canConnect && (
          <button
            type="button"
            onClick={() => handleConnect(server, state.connectMode)}
            className="shrink-0 text-[12px] font-medium text-primary transition-colors hover:underline"
          >
            {i18nService.t('mcpAuthConnect')}
          </button>
        )}
        {state.canToggle && (
          <CardToggle
            isOn={server.enabled}
            label={`${server.name} — ${
              server.enabled ? i18nService.t('mcpConnectorDisable') : i18nService.t('mcpConnectorEnable')
            }`}
            onToggle={() => void handleToggle(server, !server.enabled)}
          />
        )}
      </div>
    );
  };

  return (
    <div
      ref={popoverRef}
      className={
        asSubmenu
          ? 'absolute bottom-0 left-[calc(100%-1px)] z-[60] w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-surface shadow-popover'
          : 'absolute bottom-full left-0 z-50 mb-1 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-surface shadow-popover'
      }
      role="menu"
    >
      {shouldShowSearch && (
        <div className="border-b border-border px-3 py-2">
          <div className="relative">
            <SearchIcon className="absolute left-1.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-secondary" />
            <input
              ref={searchInputRef}
              type="text"
              placeholder={i18nService.t('mcpConnectorSearchPlaceholder')}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              className="w-full rounded-md bg-transparent py-1.5 pl-8 pr-2 text-[13px] leading-5 text-foreground placeholder-secondary focus:bg-surface-raised/70 focus:outline-none"
            />
          </div>
        </div>
      )}

      <div
        className="overflow-y-auto px-2 py-1.5"
        style={{ height: `${maxListHeight}px` }}
      >
        {servers.length === 0 ? (
          <div className="px-3 py-5 text-center text-[13px] text-secondary">
            {i18nService.t('mcpConnectorEmpty')}
          </div>
        ) : filteredServers.length === 0 ? (
          <div className="px-3 py-5 text-center text-[13px] text-secondary">
            {i18nService.t('mcpConnectorSearchNoResults')}
          </div>
        ) : (
          filteredServers.map(renderRow)
        )}
      </div>

      <div className="border-t border-border p-1.5">
        <button
          type="button"
          onClick={() => {
            onClose();
            onManageConnectors();
          }}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
        >
          <Cog6ToothIcon className="h-4 w-4" />
          {i18nService.t('mcpManageConnectors')}
        </button>
      </div>
    </div>
  );
};

export default ConnectorPickerPopover;
