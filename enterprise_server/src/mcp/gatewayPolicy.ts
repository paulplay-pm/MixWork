import type { ToolEntry } from '../models/connectorView';

/**
 * May this caller invoke this tool through the gateway?
 *
 * Fail-closed by construction: a connector the admin never probed and never
 * declared (`tools: []`) allows **nothing**. The desktop's own tool filter is
 * the second line of defense; this is the first, and the only one a caller
 * cannot edit.
 *
 * Deliberately not built on `toolFilterFor`: that function returns
 * `undefined` for both "no policy" and "no restriction", and reading its
 * output here would turn "never probed" into "everything allowed" — the exact
 * inversion this function exists to prevent. The spec's five-row table
 * collapses to the two lines below once `removed` entries are dropped:
 * "all enabled" and "hand-declared whitelist" and "none enabled" are all just
 * "the tool is live and enabled".
 */
export function toolAllowedByPolicy(tools: ToolEntry[], toolName: string): boolean {
  const live = tools.filter((t) => !t.removed);
  if (live.length === 0) return false;
  return live.some((t) => t.name === toolName && t.enabled);
}
