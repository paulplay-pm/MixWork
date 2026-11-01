import { createSlice, PayloadAction } from '@reduxjs/toolkit';

/** Which mode the auth modal opens in. */
export type McpAuthModalMode = 'connect' | 'reauthorize';

export interface McpAuthTarget {
  mode: McpAuthModalMode;
  serverId: string;
}

/**
 * Which server the MCP auth modal is open for.
 *
 * Held in Redux rather than in one component's state because two surfaces
 * open the modal: the MCP management page and the chat input's connector
 * picker. A shared slice lets either ask for the modal, and lets a single
 * host component own both the modal and the `mcp:authFlowRequested`
 * subscription — otherwise the main process's push would open a dialog in
 * whichever surface happened to be listening, and in neither when the chat
 * view was the one that needed it.
 */
interface McpAuthState {
  target: McpAuthTarget | null;
}

const initialState: McpAuthState = {
  target: null,
};

const mcpAuthSlice = createSlice({
  name: 'mcpAuth',
  initialState,
  reducers: {
    openMcpAuthModal: (state, action: PayloadAction<McpAuthTarget>) => {
      state.target = action.payload;
    },
    closeMcpAuthModal: (state) => {
      state.target = null;
    },
  },
});

export const { openMcpAuthModal, closeMcpAuthModal } = mcpAuthSlice.actions;

export default mcpAuthSlice.reducer;
