import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import type { ProviderCardView } from '../../../src/api/providerCards';
import { ProviderRail } from '../../../src/pages/providersModels/ProviderRail';

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
      endpoint: null,
      enabled: true,
      isBuiltin: true,
      codingPlan: false,
      apiKeyMasked: null,
      modelCount: 9,
    },
  ],
  ...over,
});

const cards = [
  card(),
  card({ id: 'c2', provider: 'vllm', label: 'vllm', isBuiltin: false, sections: [] }),
];

const renderRail = (props: Partial<Parameters<typeof ProviderRail>[0]> = {}) =>
  render(
    <ProviderRail
      cards={cards}
      modelCounts={{ c1: 9 }}
      selectedId={null}
      onSelect={() => {}}
      canManage={true}
      onDeleteCard={vi.fn()}
      onToggleCard={vi.fn()}
      {...props}
    />,
  );

describe('pages/providersModels/ProviderRail', () => {
  test('renders both sections and one row per card', () => {
    renderRail();
    expect(screen.getByPlaceholderText(/Search/i)).toBeInTheDocument();
    expect(screen.getByText(/Built-in/)).toBeInTheDocument();
    expect(screen.getByText('MiniMax')).toBeInTheDocument();
    expect(screen.getByText('vllm')).toBeInTheDocument();
  });

  test('a card shows its model count', () => {
    renderRail();
    expect(screen.getByText('9')).toBeInTheDocument();
  });

  test('the rail row does not tag the vendor with its model types', () => {
    // The tags crowded the vendor name out of the row; the model type is
    // shown where it belongs — on the card's own tabs.
    renderRail({
      cards: [
        card({
          sections: [
            card().sections[0],
            {
              providerKeyId: 'k2',
              protocol: 'image-gen',
              label: null,
              endpoint: null,
              enabled: true,
              isBuiltin: false,
              codingPlan: false,
              apiKeyMasked: null,
              modelCount: 2,
            },
          ],
        }),
      ],
    });
    expect(screen.queryByText('LLM')).toBeNull();
    expect(screen.queryByText('Image')).toBeNull();
    // The count badge and the enable switch stay.
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.getByRole('switch')).toBeInTheDocument();
  });

  test('filters by search text', () => {
    renderRail();
    fireEvent.change(screen.getByPlaceholderText(/Search/i), { target: { value: 'vll' } });
    expect(screen.queryByText('MiniMax')).not.toBeInTheDocument();
  });

  test('a card with a built-in section has no delete button', () => {
    renderRail();
    const builtinRow = screen.getByText('MiniMax').closest('[role="button"]')!;
    expect(builtinRow.querySelector('[aria-label="delete-provider"]')).toBeNull();
  });

  test('a fully custom card has a delete button', () => {
    renderRail();
    const customRow = screen.getByText('vllm').closest('[role="button"]')!;
    expect(customRow.querySelector('[aria-label="delete-provider"]')).not.toBeNull();
  });

  test('deleting asks the caller with the card', () => {
    const onDeleteCard = vi.fn();
    renderRail({ onDeleteCard });
    fireEvent.click(screen.getByLabelText('delete-provider'));
    expect(onDeleteCard).toHaveBeenCalledWith(expect.objectContaining({ id: 'c2' }));
  });

  test('the enable switch reports the new state', () => {
    const onToggleCard = vi.fn();
    renderRail({ onToggleCard });
    fireEvent.click(screen.getAllByRole('switch')[0]);
    expect(onToggleCard).toHaveBeenCalledWith('c1', false);
  });

  test('selecting a row reports the card id', () => {
    const onSelect = vi.fn();
    renderRail({ onSelect });
    fireEvent.click(screen.getByText('vllm'));
    expect(onSelect).toHaveBeenCalledWith('c2');
  });
});
