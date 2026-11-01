import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import type { Submission } from '../../../src/api/connectors';
import { t } from '../../../src/i18n';
import { ReviewDetailDrawer } from '../../../src/pages/mcpManage/ReviewDetailDrawer';
import { fill } from '../../../src/pages/mcpManage/types';

const submission = (cfg: Record<string, unknown>): Submission => ({
  id: 's1',
  name: 'Vendor MCP',
  desc: null,
  authorId: 'u1',
  version: '1.0.0',
  submittedAt: '2026-10-28T10:00:00.000Z',
  status: 'pending',
  rejectReason: null,
  cfg,
  approvedConnectorId: null,
});

function renderDrawer(cfg: Record<string, unknown>): void {
  render(
    <ReviewDetailDrawer
      submission={submission(cfg)}
      members={[]}
      busy={false}
      onClose={() => {}}
      onApprove={() => {}}
      onRejectRequest={() => {}}
    />,
  );
}

describe('ReviewDetailDrawer — an approver sees where the org key will go', () => {
  test('a shared-key submission names the destination address', () => {
    const url = 'https://mcp.vendor.example/sse';
    renderDrawer({ authMode: 'shared-key', url });
    // Approving publishes the connector, which is the moment the org key
    // becomes spendable against this address.
    expect(screen.getByText(fill(t('mcp.review.detail.orgKeyTarget'), { url }))).toBeInTheDocument();
  });

  test('a user-key submission shows no such warning', () => {
    renderDrawer({ authMode: 'user-key', url: 'https://mcp.vendor.example/sse' });
    expect(screen.queryByText(/organization key will be sent/i)).toBeNull();
  });

  test('a shared-key submission with no url shows no warning', () => {
    renderDrawer({ authMode: 'shared-key' });
    expect(screen.queryByText(/organization key will be sent/i)).toBeNull();
  });
});
