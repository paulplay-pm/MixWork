import React, { useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { mcpService } from '../../services/mcp';
import { RootState } from '../../store';
import { closeMcpAuthModal, openMcpAuthModal } from '../../store/slices/mcpAuthSlice';
import { setMcpServers } from '../../store/slices/mcpSlice';
import McpAuthModal from './McpAuthModal';

/**
 * The one place the MCP auth modal lives.
 *
 * The modal is needed wherever a connector can be connected — the management
 * page and the chat input's connector picker — and the main process also
 * pushes `mcp:authFlowRequested` when a call hits a server that needs
 * (re-)authorization. Owning all of that here means the push opens the
 * dialog no matter which surface is on screen.
 */
const McpAuthHost: React.FC = () => {
  const dispatch = useDispatch();
  const target = useSelector((state: RootState) => state.mcpAuth.target);
  const servers = useSelector((state: RootState) => state.mcp.servers);

  useEffect(() => {
    const unsubscribe = window.electron.mcp.onAuthFlowRequested((options) => {
      dispatch(openMcpAuthModal({ mode: 'connect', serverId: options.id }));
    });
    return unsubscribe;
  }, [dispatch]);

  const server = target ? servers.find((item) => item.id === target.serverId) : undefined;

  // The management page keeps the server list in Redux, but the chat input
  // does not — so the modal may be asked for a server nobody has loaded yet.
  useEffect(() => {
    if (!target || server) return;
    let cancelled = false;
    void mcpService.loadServers().then((loaded) => {
      if (!cancelled) dispatch(setMcpServers(loaded));
    });
    return () => {
      cancelled = true;
    };
  }, [dispatch, server, target]);

  if (!target || !server) return null;

  return (
    <McpAuthModal
      server={server}
      mode={target.mode}
      onClose={() => dispatch(closeMcpAuthModal())}
      onSuccess={async () => {
        dispatch(closeMcpAuthModal());
        const reloaded = await mcpService.loadServers();
        dispatch(setMcpServers(reloaded));
      }}
    />
  );
};

export default McpAuthHost;
