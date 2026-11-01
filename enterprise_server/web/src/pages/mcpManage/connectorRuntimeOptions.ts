/**
 * Per-connector runtime options.
 *
 * Only one of them survives: how long a single MCP call may take. It is
 * optional on purpose — an empty value means "use the runtime's own default"
 * (OpenClaw: 30s to connect, 60s per request), which is what most connectors
 * want. A stored value travels to the desktop and lands in OpenClaw's
 * `mcp.servers.<key>.timeout`.
 *
 * There is deliberately no retry count: retrying a tool call is the agent
 * runtime's decision (which errors are retryable, what the backoff is,
 * whether the tool is even idempotent), not a property of the connector, and
 * no field here would have anywhere to go.
 */

export const TIMEOUT_MIN = 5;
export const TIMEOUT_MAX = 300;

/** Normalize the console's input into a value worth storing, or undefined. */
export function normalizeTimeoutSeconds(
  value: number | '' | null | undefined,
): number | undefined {
  if (value === '' || value === null || value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(TIMEOUT_MAX, Math.max(TIMEOUT_MIN, Math.round(n)));
}

/**
 * The timeout's entry in `authConfig`.
 *
 * `null` is the explicit "not set" signal. The server deletes a stored field
 * whose incoming value is null, so an admin who empties the field really
 * returns the connector to the runtime default — omitting the key instead
 * would leave the old number in place.
 */
export function timeoutAuthConfigEntry(value: number | '' | null | undefined): number | null {
  return normalizeTimeoutSeconds(value) ?? null;
}

/** Read a stored timeout back into the form field (empty = not set). */
export function readTimeoutSeconds(authConfig: Record<string, unknown>): number | '' {
  const n = authConfig.timeoutSeconds;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '';
  return Math.min(TIMEOUT_MAX, Math.max(TIMEOUT_MIN, Math.round(n)));
}
