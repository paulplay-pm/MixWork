import type { ToolEntry } from '../../api/connectors';

/**
 * The tool list an admin writes by hand.
 *
 * The enterprise server can only list a connector's tools when it holds the
 * connector's credential: `none` needs no credential and `shared-key` has
 * the org's key. When the credential belongs to the member (`user-key` /
 * `user-oauth`), the org has nothing to authenticate with, so the tool list
 * has to be declared by hand — and a declared list becomes the whitelist the
 * desktop enforces (the server turns it into OpenClaw's per-server tool
 * filter, so the upstream's unnamed tools never reach the agent).
 */

/**
 * Read the admin's declaration: one tool name per line, or a pasted JSON
 * array (of names, or of the upstream's `{ name, ... }` tool entries).
 * Blank entries and duplicates are dropped.
 */
export function parseToolNames(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const names: string[] = [];
  const push = (raw: string): void => {
    const name = raw.trim();
    if (name && !names.includes(name)) names.push(name);
  };

  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === 'string') push(item);
          else if (item && typeof item === 'object') {
            const name = (item as { name?: unknown }).name;
            if (typeof name === 'string') push(name);
          }
        }
        return names;
      }
    } catch {
      // Not JSON after all — fall through to the line reading.
    }
  }

  for (const line of trimmed.split(/[\n,]/)) push(line);
  return names;
}

/**
 * The stored tools the admin declared by hand — the ones the server never
 * stamped with a `syncedAt` (it stamps the tools it listed itself).
 */
export function declaredToolNames(tools: ToolEntry[]): string[] {
  return tools.filter((tool) => !tool.syncedAt).map((tool) => tool.name);
}

/**
 * The tool rows the drawer shows and publishes: what the server discovered
 * plus what the admin declared, with the form's per-tool toggles applied.
 *
 * The toggles win over the stored `enabled` flag; a declared name the server
 * never listed joins the list enabled unless the admin turned it off.
 */
export function mergeToolEntries(
  discovered: ToolEntry[],
  declared: string[],
  toggles: Record<string, boolean>,
): ToolEntry[] {
  const rows: ToolEntry[] = discovered.map((tool) => ({
    ...tool,
    enabled: toggles[tool.name] ?? tool.enabled,
  }));
  for (const name of declared) {
    if (rows.some((row) => row.name === name)) continue;
    rows.push({ name, enabled: toggles[name] ?? true });
  }
  return rows;
}
