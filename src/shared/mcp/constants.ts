/**
 * The one built-in connector that drives a bespoke login page instead of the
 * MCP-native OAuth flow.
 *
 * Every other OAuth connector — enterprise or a hand-added local server —
 * discovers its provider's endpoints from the server's own URL (RFC 9728)
 * and registers a public client (RFC 7591). Sending one of those to the
 * qichacha page would authorize the wrong service.
 */
export const QICHACHA_REGISTRY_ID = 'qichacha';

export const McpIpcChannel = {
  List: 'mcp:list',
  Create: 'mcp:create',
  Update: 'mcp:update',
  Delete: 'mcp:delete',
  DeleteByRegistryId: 'mcp:deleteByRegistryId',
  SetEnabled: 'mcp:setEnabled',
  SetEnabledByRegistryId: 'mcp:setEnabledByRegistryId',
  RetryLaunchResolution: 'mcp:retryLaunchResolution',
  ConnectQichacha: 'mcp:qichachaConnect',
  Changed: 'mcp:changed',
  FetchEnterpriseMarketplace: 'mcp:fetchEnterpriseMarketplace',
  SubmitConnectorRequest: 'mcp:submitConnectorRequest',
  StartAuth: 'mcp:startAuth',
  SaveCredential: 'mcp:saveCredential',
  ProbeAuthorization: 'mcp:probeAuthorization',
  ListTools: 'mcp:listTools',
  AuthFlowRequested: 'mcp:authFlowRequested',
} as const;
export type McpIpcChannel = typeof McpIpcChannel[keyof typeof McpIpcChannel];

/**
 * The connector config a member submits to the org review queue
 * (enterprise_server `connectorCfgSchema` — the connector body WITHOUT
 * `orgId`; the org comes from the caller's token). Mirrors the zod schema in
 * `enterprise_server/src/routes/mcpConnectors.ts`. The server re-runs the
 * create guards on submit (sse+oauth → 400, per-mode required secret → 400
 * `missing_auth_field`, serverKey `^[a-z0-9-]+$`).
 */
export interface ConnectorSubmitRequest {
  serverKey: string;
  url: string;
  nameEn?: string;
  nameZh?: string;
  version?: string;
  categoryId?: string | null;
  description?: string;
  transport?: 'http' | 'sse';
  authMode?: 'none' | 'shared-key' | 'user-key' | 'user-oauth' | 'client-creds' | 'sso';
  authConfig?: Record<string, unknown>;
  scope?: { allCompany?: boolean; deptIds?: string[]; userIds?: string[] };
}

/** The enterprise connector's declared auth mode (enterprise_server
 *  `connectorView.ts` AUTH_MODES). The desktop keeps it on the local record so
 *  an org-managed connector can be recognised after the marketplace page is
 *  gone from memory. */
export const ConnectorAuthMode = {
  None: 'none',
  SharedKey: 'shared-key',
  UserKey: 'user-key',
  UserOauth: 'user-oauth',
  ClientCreds: 'client-creds',
  Sso: 'sso',
} as const;
export type ConnectorAuthMode = typeof ConnectorAuthMode[keyof typeof ConnectorAuthMode];

/** How a member reaches a connector: their own machine dials the upstream
 *  (`direct`), or the enterprise gateway injects the org credential
 *  (`gateway`). Mirrors enterprise_server `connectorView.ts`. */
export const ConnectorConsumption = {
  Direct: 'direct',
  Gateway: 'gateway',
} as const;
export type ConnectorConsumption = typeof ConnectorConsumption[keyof typeof ConnectorConsumption];

/**
 * The `error` strings the enterprise MCP gateway writes into its refusal body.
 *
 * Mirror of `enterprise_server/src/routes/mcpGateway.ts`. Each one becomes a
 * different sentence on the desktop, because each needs a different action
 * from the member: a dead org key is a call to an admin, a connector that
 * vanished is a refresh, an unsupported transport is "this connector cannot
 * work here". One generic "connection failed" makes all three look identical.
 */
export const McpGatewayError = {
  Unauthorized: 'unauthorized',
  NotMember: 'not_member',
  Forbidden: 'forbidden',
  NotFound: 'not_found',
  UnsupportedTransport: 'unsupported_transport',
  NotGatewayMode: 'not_gateway_mode',
  UpstreamUnauthorized: 'upstream_unauthorized',
  UpstreamInsecure: 'upstream_insecure',
  UpstreamFailed: 'upstream_failed',
} as const;
export type McpGatewayError = typeof McpGatewayError[keyof typeof McpGatewayError];

/** OpenClaw's per-MCP-server tool selection (`mcp.servers.*.toolFilter`). */
export interface McpToolFilter {
  include?: string[];
  exclude?: string[];
}

export const McpAuthMethod = {
  None: 'none',
  Bearer: 'bearer',
  ApiKey: 'api-key',
  OAuth: 'oauth',
} as const;
export type McpAuthMethod = typeof McpAuthMethod[keyof typeof McpAuthMethod];

export const McpAuthStatus = {
  Authenticated: 'authenticated',
  NeedsAuth: 'needs-auth',
  AuthError: 'auth-error',
} as const;
export type McpAuthStatus = typeof McpAuthStatus[keyof typeof McpAuthStatus];
