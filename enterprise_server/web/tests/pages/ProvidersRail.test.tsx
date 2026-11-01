import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';

import type { ProviderCardView } from '../../src/api/providerCards';
import { setLang } from '../../src/i18n';
import { ProviderRail } from '../../src/pages/providersModels/ProviderRail';

const mk = (over: Partial<ProviderCardView> = {}): ProviderCardView => ({
  id: 'id',
  provider: 'openai',
  label: 'OpenAI',
  createdAt: '',
  isBuiltin: true,
  enabled: true,
  sections: [
    {
      providerKeyId: 'k1',
      protocol: 'openai',
      label: null,
      endpoint: 'https://api.openai.com/v1',
      enabled: true,
      isBuiltin: true,
      codingPlan: false,
      apiKeyMasked: 'sk-••••••••a93f',
      modelCount: 3,
    },
  ],
  ...over,
});

describe('ProviderRail', () => {
  test('groups builtins and customs with counts; delete only on customs', async () => {
    // The section-header assertions below use the zh strings; pin the locale
    // so the test does not depend on jsdom's navigator.language.
    setLang('zh');
    const user = userEvent.setup();
    const onDeleteCard = vi.fn();
    render(
      <ProviderRail
        cards={[
          mk({ id: 'b', provider: 'openai' }),
          mk({ id: 'c', provider: 'vllm', label: 'vllm-test', isBuiltin: false, sections: [] }),
        ]}
        modelCounts={{ b: 3, c: 1 }}
        selectedId="b"
        onSelect={vi.fn()}
        canManage
        onAddProvider={vi.fn()}
        onDeleteCard={onDeleteCard}
        onToggleCard={vi.fn()}
      />,
    );
    expect(screen.getByText(/内置服务商 \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/自定义服务商 \(1\)/)).toBeInTheDocument();
    // Delete icon present for the custom row only.
    expect(screen.getAllByLabelText('delete-provider').length).toBe(1);
    await user.click(screen.getByLabelText('delete-provider'));
    expect(onDeleteCard).toHaveBeenCalledTimes(1);
    expect(onDeleteCard.mock.calls[0][0].id).toBe('c');
  });

  test('enable switch calls onToggleCard with the next state', async () => {
    setLang('en');
    const user = userEvent.setup();
    const onToggleCard = vi.fn();
    render(
      <ProviderRail
        cards={[mk({ id: 'b', provider: 'openai', enabled: true })]}
        modelCounts={{}}
        selectedId={null}
        onSelect={vi.fn()}
        canManage
        onAddProvider={vi.fn()}
        onDeleteCard={vi.fn()}
        onToggleCard={onToggleCard}
      />,
    );
    const sw = screen.getByRole('switch');
    expect(sw).toHaveAttribute('aria-checked', 'true');
    await user.click(sw);
    expect(onToggleCard).toHaveBeenCalledWith('b', false);
  });
});
