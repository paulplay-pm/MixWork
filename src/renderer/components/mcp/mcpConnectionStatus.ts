import type { McpToolListOutcome } from '../../types/mcp';

/** What the detail dialog knows about the open server's live connection. */
export type McpToolListState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; outcome: McpToolListOutcome };

/**
 * The i18n key for the detail dialog's connection stat.
 *
 * The status is read from a LIVE `tools/list` round-trip rather than from the
 * stored `authStatus`: the stored value only records the last probe, which may
 * be hours old and says nothing about a server that has since started
 * demanding a fresh token. "Connected" therefore means "it answered us just
 * now", and "authorization expired" means it answered 401/403 just now.
 */
export function connectionLabelKey(enabled: boolean, state: McpToolListState): string {
  if (!enabled) return 'mcpDetailConnectionDisabled';
  switch (state.kind) {
    case 'loading':
      return 'mcpDetailConnectionChecking';
    case 'done':
      if (state.outcome.ok) return 'mcpDetailConnectionOk';
      return state.outcome.status === 'unauthorized'
        ? 'mcpDetailConnectionUnauthorized'
        : 'mcpDetailConnectionFailed';
    default:
      return 'mcpDetailConnectionUnknown';
  }
}

/** The tools to show, once the server has actually answered. `null` while the
 *  check is running or when it failed (the caller renders the reason from the
 *  outcome itself). */
export function connectedTools(state: McpToolListState): McpToolListOutcome['tools'] | null {
  if (state.kind !== 'done' || !state.outcome.ok) return null;
  return state.outcome.tools;
}
