import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { t } from '../../../src/i18n';
import { ConnectorAuthFields } from '../../../src/pages/mcpManage/ConnectorAuthFields';
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
  authMode: 'none',
  scope: { allCompany: true, deptIds: [], userIds: [] },
  toolToggles: {},
  toolManifestText: '',
  apiKey: '',
  clientId: '',
  clientSecret: '',
  tokenUrl: '',
  authorizeUrl: '',
  scopes: [],
  apiKeyHeaderName: '',
  timeoutSeconds: '',
  ...o,
});

const noSecret = { apiKey: false, clientSecret: false };

function renderFields(
  authMode: ConnectorFormState['authMode'],
  oauthRedirectUri?: string,
): void {
  render(
    <ConnectorAuthFields
      mode="create"
      authMode={authMode}
      state={state({ authMode })}
      onChange={() => {}}
      hasSecret={noSecret}
      secretMeta={null}
      oauthRedirectUri={oauthRedirectUri}
    />
  );
}

describe('ConnectorAuthFields — user-level auth never collects an org secret', () => {
  test('user-oauth collects endpoints and client id, and no client secret', () => {
    renderFields('user-oauth');
    expect(screen.getByLabelText(t('mcpDrawer.auth.authorizeUrl'))).toBeInTheDocument();
    expect(screen.getByLabelText(t('mcpDrawer.auth.tokenUrl'))).toBeInTheDocument();
    expect(screen.getByLabelText(t('mcpDrawer.auth.clientId'))).toBeInTheDocument();
    // The desktop drives a PKCE public client, so a secret here would never be used.
    expect(screen.queryByLabelText(t('mcpDrawer.auth.clientSecret'))).toBeNull();
  });

  test('the drawer says the three fields are optional overrides — discovery fills them', () => {
    // The whole point of discovery: an MCP-native provider (only an MCP URL)
    // must be configurable without the admin knowing its IdP.
    renderFields('user-oauth');
    expect(screen.getByText(t('mcpDrawer.auth.discovery.notice'))).toBeInTheDocument();
  });

  test('a legacy sso record shows the user-oauth fields it was migrated to', () => {
    // `sso` is folded into `user-oauth`; there is one set of endpoints, one
    // client id, and still no secret.
    renderFields('sso');
    expect(screen.getByLabelText(t('mcpDrawer.auth.authorizeUrl'))).toBeInTheDocument();
    expect(screen.getByLabelText(t('mcpDrawer.auth.tokenUrl'))).toBeInTheDocument();
    expect(screen.getByLabelText(t('mcpDrawer.auth.clientId'))).toBeInTheDocument();
    expect(screen.queryByLabelText(t('mcpDrawer.auth.clientSecret'))).toBeNull();
  });
});

describe('ConnectorAuthFields — client-creds is the only reserved org-credential mode', () => {
  // shared-key used to carry the same notice; it is a live mode now that the
  // enterprise gateway injects the key (see the block at the end of this file).
  test('shared-key no longer announces itself as reserved', () => {
    renderFields('shared-key');
    expect(screen.queryByText(t('mcpDrawer.auth.orgManaged.reserve'))).toBeNull();
    expect(screen.getByLabelText(t('mcpDrawer.auth.orgApiKey'))).toBeInTheDocument();
  });

  test('client-creds shows the reserved notice and its own secret field', () => {
    renderFields('client-creds');
    expect(screen.getByText(t('mcpDrawer.auth.orgManaged.reserve'))).toBeInTheDocument();
    expect(screen.getByLabelText(t('mcpDrawer.auth.clientSecret'))).toBeInTheDocument();
  });

  test('user-key needs no notice — the member brings their own key', () => {
    renderFields('user-key');
    expect(screen.queryByText(t('mcpDrawer.auth.orgManaged.reserve'))).toBeNull();
  });
});

describe('ConnectorAuthFields — the OAuth callback URL', () => {
  test('it shows the redirect URI the enterprise server issued', () => {
    renderFields('user-oauth', 'http://127.0.0.1:53232/callback');
    const field = screen.getByLabelText(t('mcpDrawer.auth.callbackUrl')) as HTMLInputElement;
    expect(field.value).toBe('http://127.0.0.1:53232/callback');
    // The admin registers it at the IdP; they do not type it.
    expect(field.readOnly).toBe(true);
  });

  test('it is empty when the server sent none — never a stale hardcoded URL', () => {
    renderFields('user-oauth');
    const field = screen.getByLabelText(t('mcpDrawer.auth.callbackUrl')) as HTMLInputElement;
    expect(field.value).toBe('');
  });

  test('it is not shown in a mode that has no OAuth flow', () => {
    renderFields('user-key');
    expect(screen.queryByLabelText(t('mcpDrawer.auth.callbackUrl'))).toBeNull();
  });
});

describe('ConnectorAuthFields — OAuth scope is free text, not a vendor preset list', () => {
  test('offers no hardcoded vendor scopes and adds what the admin types', () => {
    const onChange = vi.fn();
    render(
      <ConnectorAuthFields
        mode="create"
        authMode="user-oauth"
        state={state({ authMode: 'user-oauth', scopes: [] })}
        onChange={onChange}
        hasSecret={noSecret}
        secretMeta={null}
      />
    );
    // The old picker listed Gmail/Graph/Slack/Jira scopes that have nothing to
    // do with an arbitrary connector.
    expect(screen.queryByText('gmail.readonly')).toBeNull();
    expect(screen.queryByText('repo')).toBeNull();

    const input = screen.getByLabelText(t('mcpDrawer.auth.scope.customPlaceholder'));
    fireEvent.change(input, { target: { value: 'offline_access' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith({ scopes: ['offline_access'] });
  });

  test('a stray focus/blur on the empty input adds nothing', () => {
    const onChange = vi.fn();
    render(
      <ConnectorAuthFields
        mode="create"
        authMode="user-oauth"
        state={state({ authMode: 'user-oauth', scopes: [] })}
        onChange={onChange}
        hasSecret={noSecret}
        secretMeta={null}
      />
    );
    fireEvent.blur(screen.getByLabelText(t('mcpDrawer.auth.scope.customPlaceholder')));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('ConnectorAuthFields — shared-key is a live mode now', () => {
  test('asks for an optional header name and says the key stays server-side', () => {
    renderFields('shared-key');
    // The reserve notice belonged to the pre-gateway release.
    expect(screen.queryByText(t('mcpDrawer.auth.orgManaged.reserve'))).toBeNull();
    // The org key input is still the only secret this mode collects.
    expect(screen.getByLabelText(t('mcpDrawer.auth.orgApiKey'))).toBeInTheDocument();
    // The header name is optional: blank means `Authorization: Bearer <key>`.
    expect(screen.getByLabelText(t('mcpDrawer.auth.orgApiKeyHeaderName'))).toBeInTheDocument();
    // And the admin is told the desktop never holds the key.
    expect(screen.getByText(t('mcpDrawer.auth.sharedKey.gateway'))).toBeInTheDocument();
  });

  test('the header name round-trips into the form state', () => {
    const onChange = vi.fn();
    render(
      <ConnectorAuthFields
        mode="create"
        authMode="shared-key"
        state={state({ authMode: 'shared-key' })}
        onChange={onChange}
        hasSecret={noSecret}
        secretMeta={null}
      />
    );
    fireEvent.change(screen.getByLabelText(t('mcpDrawer.auth.orgApiKeyHeaderName')), {
      target: { value: 'X-Api-Key' },
    });
    expect(onChange).toHaveBeenCalledWith({ apiKeyHeaderName: 'X-Api-Key' });
  });

  test('client-creds keeps its reserve notice', () => {
    renderFields('client-creds');
    expect(screen.getByText(t('mcpDrawer.auth.orgManaged.reserve'))).toBeInTheDocument();
  });
});
