/** Where a locally installed MCP came from. */
export interface McpSourceRecord {
  /** Set only by an install/update from the enterprise marketplace. */
  serverKey?: string | null;
  /** Set by the built-in catalog's install path. */
  isBuiltIn?: boolean | null;
  registryId?: string | null;
}

/**
 * The i18n key for the detail dialog's source stat.
 *
 * The enterprise install is recognised by `serverKey`, not by `isBuiltIn`: an
 * enterprise connector is installed *through* the same built-in machinery, so
 * it carries both, and checking the built-in flag first would report every
 * org-managed connector as "built-in marketplace".
 */
export function sourceLabelKey(record: McpSourceRecord): string {
  if (record.serverKey) return 'mcpSourceEnterprise';
  if (record.isBuiltIn || record.registryId) return 'mcpSourceMarketplace';
  return 'mcpCustom';
}
