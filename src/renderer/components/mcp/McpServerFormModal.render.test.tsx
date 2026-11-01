import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, test, vi } from 'vitest';

// The form renders through the shared Modal, which needs a DOM to portal
// into. The renderer test environment has none, so the modal renders its
// children inline — the markup under test is unchanged.
vi.mock('../common/Modal', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

import { McpAuthMethod, McpAuthStatus } from '../../../shared/mcp/constants';
import { i18nService } from '../../services/i18n';
import type { McpEnterpriseMarketServer, McpServerConfig } from '../../types/mcp';
import McpServerFormModal from './McpServerFormModal';

const SHARED_KEY_ENTRY: McpEnterpriseMarketServer = {
  id: 'entry-1',
  serverKey: 'crm',
  name: 'CRM',
  nameZh: '客户关系系统',
  description: '组织采购的 CRM 连接器',
  category: 'business',
  version: '1.0.0',
  connectorType: 'mcp',
  url: 'https://gateway.example.com/mcp/gateway/crm',
  transport: 'http',
  authMode: 'shared-key',
  authStatus: 'configured',
  scopeSummary: 'all',
  hasDraft: false,
  enabled: true,
  toolCount: 3,
  consumption: 'gateway',
  orgCredentialReady: true,
};

const INSTALLED_USER_KEY_RECORD: McpServerConfig = {
  id: 'server-1',
  name: 'CRM',
  description: '组织采购的 CRM 连接器',
  enabled: true,
  transportType: 'http',
  url: 'https://crm.example.com/mcp',
  isBuiltIn: true,
  authMethod: McpAuthMethod.ApiKey,
  authStatus: McpAuthStatus.NeedsAuth,
  serverKey: 'crm',
  enterpriseAuthMode: 'user-key',
  apiKeyHeaderName: 'X-Crm-Key',
  createdAt: 0,
  updatedAt: 0,
};

function renderForm(props: Partial<React.ComponentProps<typeof McpServerFormModal>>): string {
  return renderToStaticMarkup(
    React.createElement(McpServerFormModal, {
      isOpen: true,
      existingNames: [],
      onClose: () => undefined,
      onSave: () => undefined,
      ...props,
    }),
  );
}

describe('the enterprise auth method row in the form', () => {
  const originalLanguage = i18nService.getLanguage();

  afterAll(() => {
    i18nService.setLanguage(originalLanguage, { persist: false });
  });

  test('an enterprise connector offers no dropdown to change the method', () => {
    i18nService.setLanguage('zh', { persist: false });
    const html = renderForm({ enterpriseServer: SHARED_KEY_ENTRY });

    // The auth method is the only <select> in this form.
    expect(html).not.toContain('<select');
    expect(html).toContain('aria-readonly="true"');
  });

  test("the org's own mode is what the row shows", () => {
    i18nService.setLanguage('zh', { persist: false });
    const html = renderForm({ enterpriseServer: SHARED_KEY_ENTRY });
    expect(html).toContain('组织密钥（经企业网关注入）');
    expect(html).toContain('认证方式由企业统一配置，本机不可修改。');

    i18nService.setLanguage('en', { persist: false });
    const english = renderForm({ enterpriseServer: SHARED_KEY_ENTRY });
    expect(english).toContain('Organization key (injected by the enterprise gateway)');
    expect(english).toContain('The authentication method is set by your organization');
  });

  test('an installed enterprise connector keeps the org mode when edited', () => {
    i18nService.setLanguage('zh', { persist: false });
    // No catalog entry here — the plain edit path. The record still knows the
    // mode it was installed with.
    const html = renderForm({ server: INSTALLED_USER_KEY_RECORD });
    expect(html).not.toContain('<select');
    expect(html).toContain('成员密钥（填写管理员指定的请求头）');
  });

  test("a connector of the member's own keeps the editable dropdown", () => {
    i18nService.setLanguage('zh', { persist: false });
    const html = renderForm({});
    expect(html).toContain('<select');
    expect(html).not.toContain('认证方式由企业统一配置');
  });
});
