import { beforeEach, describe, expect, test, vi } from 'vitest';

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { t } from '../../../src/i18n';
import { ConnectorBasicInfo } from '../../../src/pages/mcpManage/ConnectorBasicInfo';
import type { ConnectorFormState } from '../../../src/pages/mcpManage/ConnectorDrawer';

const state = (o: Partial<ConnectorFormState> = {}): ConnectorFormState => ({
  serverKey: 'crm',
  url: 'https://crm.example.com/mcp',
  nameEn: 'CRM',
  nameZh: '客户',
  version: '1.0.0',
  categoryId: '',
  description: '',
  transport: 'http',
  authMode: 'user-oauth',
  scope: { allCompany: true, deptIds: [], userIds: [] },
  toolToggles: {},
  toolManifestText: '',
  apiKey: '',
  clientId: 'cid',
  clientSecret: '',
  tokenUrl: 'https://idp/token',
  authorizeUrl: 'https://idp/authorize',
  scopes: [],
  apiKeyHeaderName: '',
  timeoutSeconds: '',
  ...o,
});

/** The result is rendered as a mark plus the message in one span, so the
 *  message is matched as a substring of the element's own text. */
const hasText = (needle: string) => (content: string): boolean => content.includes(needle);

function renderInfo(s: ConnectorFormState = state()): void {
  render(
    <ConnectorBasicInfo
      mode="edit"
      connectorId="c1"
      state={s}
      onChange={() => {}}
      categories={[]}
    />,
  );
}

describe('ConnectorBasicInfo — the test connection result', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  test('a 401 in a member-credential mode is a warning, not a failure', async () => {
    // The server holds no credential for this connector: it could not run
    // the handshake, but the endpoint did answer.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: 'needs-user-auth', error: 'unauthorized', needsUserAuth: true }), {
        status: 200,
      }),
    );
    renderInfo();
    await userEvent.click(screen.getByRole('button', { name: t('mcp.test') }));
    await waitFor(() => {
      expect(screen.getByText(hasText(t('mcpDrawer.test.needsUserAuth')))).toBeInTheDocument();
    });
    // A warning is neither the green success mark nor the red failure mark.
    expect(screen.queryByText(hasText(t('mcpDrawer.test.reasonUnauthorized')))).toBeNull();
  });

  test('a real failure still reads as a failure', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: 'failed', error: 'unauthorized' }), { status: 200 }),
    );
    renderInfo(state({ authMode: 'shared-key' }));
    await userEvent.click(screen.getByRole('button', { name: t('mcp.test') }));
    await waitFor(() => {
      expect(screen.getByText(hasText(t('mcpDrawer.test.reasonUnauthorized')))).toBeInTheDocument();
    });
    expect(screen.queryByText(hasText(t('mcpDrawer.test.needsUserAuth')))).toBeNull();
  });
});

describe('a shared-key connector must not send the org key in the clear', () => {
  test('a plaintext, non-loopback url is a hard error', () => {
    renderInfo(state({ authMode: 'shared-key', url: 'http://example.com/mcp' }));
    expect(screen.getByText(t('mcpDrawer.url.errorPlaintextOrgKey'))).toBeInTheDocument();
  });

  test('a loopback http url is allowed — the key never leaves the machine', () => {
    renderInfo(state({ authMode: 'shared-key', url: 'http://127.0.0.1:8931/mcp' }));
    expect(screen.queryByText(t('mcpDrawer.url.errorPlaintextOrgKey'))).toBeNull();
  });

  test('the test-connection note says the probe uses the org key', () => {
    renderInfo(state({ authMode: 'shared-key' }));
    expect(screen.getByText(t('mcpDrawer.test.orgKeyHint'))).toBeInTheDocument();
  });
});
