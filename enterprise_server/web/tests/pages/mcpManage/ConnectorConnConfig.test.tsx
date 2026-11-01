import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { t } from '../../../src/i18n';
import { ConnectorConnConfig } from '../../../src/pages/mcpManage/ConnectorConnConfig';
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

function renderConfig(authMode: ConnectorFormState['authMode']): HTMLSelectElement {
  render(
    <ConnectorConnConfig
      mode="edit"
      state={state({ authMode })}
      onChange={() => {}}
      secretMeta={null}
      hasSecret={noSecret}
    />
  );
  return screen.getByLabelText(t('mcp.auth')) as HTMLSelectElement;
}

describe('the auth-mode picker', () => {
  test('offers exactly the four live modes', () => {
    const select = renderConfig('none');
    expect([...select.options].map((o) => o.value)).toEqual([
      'none',
      'shared-key',
      'user-key',
      'user-oauth',
    ]);
  });

  test('client-creds and sso are not offered', () => {
    const select = renderConfig('none');
    expect([...select.options].map((o) => o.value)).not.toContain('client-creds');
    expect([...select.options].map((o) => o.value)).not.toContain('sso');
  });

  test('a record still on a retired mode shows it, disabled, and cannot be re-picked', () => {
    const select = renderConfig('client-creds');
    const option = [...select.options].find((o) => o.value === 'client-creds');
    expect(option).toBeDefined();
    expect(option?.disabled).toBe(true);
    // It is the only way to have it in the list, so it cannot be chosen from
    // any other mode.
    expect([...select.options].filter((o) => o.value === 'client-creds')).toHaveLength(1);
  });
});

describe('sse transport and the organization key', () => {
  const renderWith = (s: ConnectorFormState, onChange = () => {}): void => {
    render(
      <ConnectorConnConfig
        mode="edit"
        state={s}
        onChange={onChange}
        secretMeta={null}
        hasSecret={noSecret}
      />
    );
  };

  test('choosing sse while a shared-key mode is selected resets the mode to none', () => {
    const onChange = vi.fn();
    renderWith(state({ authMode: 'shared-key' }), onChange);
    fireEvent.change(screen.getByLabelText(t('mcp.transport')), { target: { value: 'sse' } });
    // SSE cannot carry the org credential, so the pair must not survive the change.
    expect(onChange).toHaveBeenCalledWith({ transport: 'sse', authMode: 'none' });
  });

  test('an existing shared-key + sse record says the pair will not work', () => {
    renderWith(state({ transport: 'sse', authMode: 'shared-key' }));
    expect(screen.getByText(t('mcpDrawer.connConfig.sharedKeySse'))).toBeInTheDocument();
  });

  test('a shared-key record over http transport shows no such warning', () => {
    renderWith(state({ transport: 'http', authMode: 'shared-key' }));
    expect(screen.queryByText(t('mcpDrawer.connConfig.sharedKeySse'))).toBeNull();
  });
});
