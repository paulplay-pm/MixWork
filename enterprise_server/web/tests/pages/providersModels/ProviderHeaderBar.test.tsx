import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import type { ProviderCardView } from '../../../src/api/providerCards';
import { ProviderHeaderBar } from '../../../src/pages/providersModels/ProviderHeaderBar';

const card = (over: Partial<ProviderCardView> = {}): ProviderCardView => ({
  id: 'c1',
  provider: 'minimax',
  label: 'MiniMax',
  createdAt: '2026-01-01T00:00:00Z',
  isBuiltin: true,
  enabled: true,
  sections: [
    {
      providerKeyId: 'k1',
      protocol: 'openai',
      label: null,
      endpoint: 'https://api.minimaxi.com/v1',
      enabled: true,
      isBuiltin: true,
      codingPlan: false,
      apiKeyMasked: 'sk-…abcd',
      modelCount: 9,
    },
  ],
  ...over,
});

function renderBar(over: Partial<Parameters<typeof ProviderHeaderBar>[0]> = {}) {
  const onTest = vi.fn();
  const onSave = vi.fn();
  const onToggleEnabled = vi.fn();
  render(
    <ProviderHeaderBar
      card={card()}
      canManage={true}
      busy={false}
      canTest={true}
      onTest={onTest}
      onSave={onSave}
      onToggleEnabled={onToggleEnabled}
      {...over}
    />,
  );
  return { onTest, onSave, onToggleEnabled };
}

describe('pages/providersModels/ProviderHeaderBar', () => {
  test('shows the display name, the vendor slug and the built-in tag', () => {
    renderBar();
    expect(screen.getByText('MiniMax')).toBeInTheDocument();
    expect(screen.getByText('minimax')).toBeInTheDocument();
    expect(screen.getByText('Built-in')).toBeInTheDocument();
  });

  test('shows the custom tag for a card with no built-in section', () => {
    renderBar({ card: card({ isBuiltin: false, label: 'vllm' }) });
    expect(screen.getByText('Custom')).toBeInTheDocument();
  });

  test('the name falls back to the vendor slug when no label is stored', () => {
    renderBar({ card: card({ label: null }) });
    // `providerDisplayName` only renames abbreviation slugs (volc → Volcengine).
    expect(screen.getAllByText('minimax').length).toBeGreaterThan(0);
  });

  test('invokes onTest when the test button is clicked', () => {
    const { onTest } = renderBar();
    fireEvent.click(screen.getByRole('button', { name: /Test connection/i }));
    expect(onTest).toHaveBeenCalledTimes(1);
  });

  test('invokes onSave when the save button is clicked', () => {
    const { onSave } = renderBar();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  test('the enable switch reports the new state', () => {
    const { onToggleEnabled } = renderBar();
    fireEvent.click(screen.getByRole('switch'));
    expect(onToggleEnabled).toHaveBeenCalledWith(false);
  });

  test('hides save when canManage is false and never renders a delete button', () => {
    renderBar({ canManage: false });
    expect(screen.queryByRole('button', { name: /^Save$/i })).toBeNull();
    expect(screen.queryByLabelText(/Delete/i)).toBeNull();
  });

  test('disables the buttons while busy', () => {
    renderBar({ busy: true });
    expect(screen.getByRole('button', { name: /Test connection/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeDisabled();
  });

  test('canTest=false hides the test button but keeps save', () => {
    renderBar({ canTest: false });
    expect(screen.queryByRole('button', { name: /Test connection/i })).toBeNull();
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeInTheDocument();
  });
});
