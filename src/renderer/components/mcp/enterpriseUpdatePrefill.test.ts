import { describe, expect, test } from 'vitest';

import type { McpEnterpriseMarketServer, McpServerConfig } from '../../types/mcp';
import { enterpriseUpdatePrefill } from './enterpriseUpdatePrefill';

const entry = {
  id: 'ent-1',
  serverKey: 'crm',
  name: 'CRM',
  nameZh: null,
  description: 'Org CRM',
  category: 'ops',
  version: '2',
  connectorType: 'mcp',
  url: 'https://crm.example.com/mcp/v2',
  transport: 'http',
  authMode: 'user-key',
  authStatus: 'configured',
  scopeSummary: 'all',
  hasDraft: false,
  enabled: true,
  toolCount: 3,
  apiKeyHeaderName: 'X-Org-Key',
  toolFilter: { include: ['query'] },
} as unknown as McpEnterpriseMarketServer;

const installed = {
  id: 'srv-1',
  name: 'CRM',
  description: 'Org CRM (old copy)',
  enabled: true,
  transportType: 'sse',
  url: 'https://crm.example.com/mcp/v1',
  headers: { 'X-Personal-Key': 'sk-live-123' },
  isBuiltIn: true,
  registryId: 'ent-1',
  serverKey: 'crm',
  authMethod: 'api-key',
  authStatus: 'authenticated',
  apiKeyHeaderName: 'X-Personal-Key',
  createdAt: 1,
  updatedAt: 1,
} as unknown as McpServerConfig;

describe('enterpriseUpdatePrefill', () => {
  test('the org-owned fields refresh from the catalog', () => {
    const p = enterpriseUpdatePrefill(installed, entry);
    expect(p.url).toBe('https://crm.example.com/mcp/v2');
    expect(p.description).toBe('Org CRM');
    expect(p.transportType).toBe('http');
  });

  test("the member's stored credential is carried over untouched", () => {
    const p = enterpriseUpdatePrefill(installed, entry);
    expect(p.headers).toEqual({ 'X-Personal-Key': 'sk-live-123' });
  });

  test('the header name prefers the record, then the catalog, then the default', () => {
    expect(enterpriseUpdatePrefill(installed, entry).apiKeyHeaderName).toBe('X-Personal-Key');
    expect(
      enterpriseUpdatePrefill({ ...installed, apiKeyHeaderName: undefined }, entry).apiKeyHeaderName,
    ).toBe('X-Org-Key');
    expect(
      enterpriseUpdatePrefill({ ...installed, apiKeyHeaderName: undefined }, {
        ...entry,
        apiKeyHeaderName: undefined,
      }).apiKeyHeaderName,
    ).toBe('X-Api-Key');
  });
});
