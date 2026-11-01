import type {
  McpEnterpriseMarketServer,
  McpServerConfig,
  McpTransportType,
} from '../../types/mcp';

export interface EnterpriseUpdatePrefill {
  description: string;
  transportType: McpTransportType;
  url: string;
  headers: Record<string, string>;
  apiKeyHeaderName: string;
}

/**
 * What 更新配置 puts in the form for an installed enterprise connector.
 *
 * The org owns the endpoint, the description and the transport, so those come
 * from the catalog's current entry — that is the whole point of the action: a
 * connector whose admin moved it to a new URL or header gets fixed without the
 * member reinstalling and re-authorizing.
 *
 * The member owns the credential. It is carried over verbatim; the form never
 * asks for it again, and a member who has not authorized yet is still asked by
 * the normal Connect path afterwards, not by this form.
 */
export function enterpriseUpdatePrefill(
  server: McpServerConfig,
  entry: McpEnterpriseMarketServer,
): EnterpriseUpdatePrefill {
  return {
    description: entry.description || server.description,
    transportType: entry.transport || server.transportType,
    url: entry.url || server.url || '',
    headers: { ...(server.headers ?? {}) },
    apiKeyHeaderName:
      server.apiKeyHeaderName?.trim() || entry.apiKeyHeaderName?.trim() || 'X-Api-Key',
  };
}
