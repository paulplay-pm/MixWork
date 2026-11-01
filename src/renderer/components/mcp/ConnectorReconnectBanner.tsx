import { ExclamationTriangleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { i18nService } from '../../services/i18n';
import { mcpService } from '../../services/mcp';
import { RootState } from '../../store';
import { openMcpAuthModal } from '../../store/slices/mcpAuthSlice';
import { setMcpServers } from '../../store/slices/mcpSlice';
import type { McpServerConfig, McpToolListOutcome } from '../../types/mcp';

/**
 * The connectors whose credential the endpoint just refused, among the
 * enabled ones.
 *
 * Only enabled connectors are worth reporting: a switched-off connector is
 * not in the model's tool list, so a dead credential on it breaks nothing.
 */
export function expiredConnectors(
  servers: McpServerConfig[],
  outcomes: Record<string, McpToolListOutcome>,
): McpServerConfig[] {
  return servers.filter(
    (server) => server.enabled && outcomes[server.id]?.status === 'unauthorized',
  );
}

/**
 * "Connector needs reconnecting" — sits above the prompt input.
 *
 * A connector whose authorization expired stops being loaded into the
 * runtime, so the model simply has no tools for it. Without this the user
 * only finds out when a task quietly comes back without the data it asked
 * for. The picker can repair a connector, but nobody opens the picker when
 * they think everything is on.
 */
const ConnectorReconnectBanner: React.FC = () => {
  const dispatch = useDispatch();
  const servers = useSelector((state: RootState) => state.mcp.servers);
  const [outcomes, setOutcomes] = useState<Record<string, McpToolListOutcome>>({});
  const [dismissedIds, setDismissedIds] = useState<string[]>([]);

  // Nothing else loads the server list on a cold start — the management page
  // and the picker each load it when they open — so the banner would have
  // nothing to probe if it waited for one of them.
  useEffect(() => {
    if (servers.length > 0) return;
    let cancelled = false;
    void mcpService.loadServers().then((loaded) => {
      if (!cancelled) dispatch(setMcpServers(loaded));
    });
    return () => {
      cancelled = true;
    };
  }, [dispatch, servers.length]);

  // Re-probe whenever the server list is refreshed — including right after a
  // credential was saved, so the banner clears itself when the repair worked.
  useEffect(() => {
    const enabled = servers.filter((server) => server.enabled);
    if (enabled.length === 0) {
      setOutcomes({});
      return;
    }
    let cancelled = false;
    void Promise.all(
      enabled.map(async (server) => [server.id, await mcpService.listTools(server.id)] as const),
    ).then((results) => {
      if (!cancelled) setOutcomes(Object.fromEntries(results));
    });
    return () => {
      cancelled = true;
    };
  }, [servers]);

  const expired = expiredConnectors(servers, outcomes)
    .filter((server) => !dismissedIds.includes(server.id));

  if (expired.length === 0) return null;

  return (
    <div className="mb-2 space-y-1.5 px-1">
      {expired.map((server) => (
        <div
          key={server.id}
          className="flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2"
        >
          <ExclamationTriangleIcon className="h-4 w-4 shrink-0 text-amber-500" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12px] font-medium text-foreground">
              {i18nService.t('mcpConnectorReconnect')}
            </p>
            <p className="truncate text-[11px] leading-4 text-secondary">
              {server.name} — {i18nService.t('mcpConnectorAuthExpired')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => dispatch(openMcpAuthModal({ mode: 'reauthorize', serverId: server.id }))}
            className="shrink-0 rounded-lg bg-primary px-2.5 py-1 text-[12px] font-medium text-white transition-colors hover:bg-primary/90"
          >
            {i18nService.t('mcpConnectorReconnectAction')}
          </button>
          <button
            type="button"
            onClick={() => setDismissedIds((ids) => [...ids, server.id])}
            className="shrink-0 rounded-md p-1 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
            aria-label={i18nService.t('close')}
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
};

export default ConnectorReconnectBanner;
