import { beforeEach, describe, expect, test, vi } from 'vitest';
const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

import { agentMarketplaceApi } from '../../src/api/agentMarketplace';
import { apiClient } from '../../src/api/client';

beforeEach(() => {
  fetchMock.mockReset();
  apiClient.setBaseUrl('http://server');
  apiClient.setTokenProvider(() => 'tok');
});

describe('agentMarketplaceApi', () => {
  test('listPublic hits the scope-filtered catalog route', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ agents: [] }), { status: 200 }));
    await agentMarketplaceApi.listPublic();
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://server/api/agent-marketplace');
  });

  test('createAgent posts the body with the required scope', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ agent_id: 'agent_1' }), { status: 200 }));
    const scope = { allCompany: false, deptIds: ['d1'], userIds: [] };
    const out = await agentMarketplaceApi.createAgent({ name: 'X', scope });
    expect(out.agent_id).toBe('agent_1');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ name: 'X', scope });
  });

  test('getReferences returns the affected agents', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ids: ['b'], names: ['B'] }), { status: 200 }));
    const out = await agentMarketplaceApi.getReferences('a');
    expect(out.ids).toEqual(['b']);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://server/api/admin/agent-marketplace/agents/a/references');
  });
});
