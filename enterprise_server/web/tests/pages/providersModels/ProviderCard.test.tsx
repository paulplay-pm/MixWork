import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import type { ModelView } from '../../../src/api/models';
import type { ProviderCardSectionView, ProviderCardView } from '../../../src/api/providerCards';
import { ProviderCard } from '../../../src/pages/providersModels/ProviderCard';

const llmSection: ProviderCardSectionView = {
  providerKeyId: 'k-llm',
  protocol: 'openai',
  label: null,
  endpoint: 'https://api.minimaxi.com/v1',
  enabled: true,
  isBuiltin: true,
  codingPlan: false,
  apiKeyMasked: 'sk-…abcd',
  modelCount: 9,
};

const imageSection: ProviderCardSectionView = {
  providerKeyId: 'k-img',
  protocol: 'image-gen',
  label: 'MiniMax 图像生成',
  endpoint: 'https://api.minimaxi.com',
  enabled: true,
  isBuiltin: false,
  codingPlan: false,
  apiKeyMasked: 'sk-…abcd',
  modelCount: 2,
};

const card = (over: Partial<ProviderCardView> = {}): ProviderCardView => ({
  id: 'c1',
  provider: 'minimax',
  label: 'MiniMax',
  createdAt: '2026-01-01T00:00:00Z',
  isBuiltin: true,
  enabled: true,
  sections: [llmSection, imageSection],
  ...over,
});

const model = (over: Partial<ModelView> = {}): ModelView => ({
  id: 'm1',
  provider: 'minimax',
  provider_key_id: 'k-llm',
  model: 'abab-6.5',
  display_name: 'abab-6.5',
  type: 'chat',
  types: ['chat'],
  quota_per_user_per_day: null,
  enabled: true,
  disabled_by_admin: false,
  supports_image: false,
  supports_video: false,
  supports_thinking: false,
  context_window: 200000,
  max_tokens: null,
  temperature: null,
  top_p: null,
  max_output_tokens: null,
  ...over,
});

const baseProps = () => ({
  card: card(),
  canManage: true,
  busy: false,
  modelsBySection: {},
  defaultTypesByModel: {},
  onDraftChange: vi.fn(),
  onTest: vi.fn(),
  onSave: vi.fn(),
  onToggleEnabled: vi.fn(),
  onToggleSectionEnabled: vi.fn(),
  onProtocolChange: vi.fn(),
  onRefreshModels: vi.fn(),
  onAddModel: vi.fn(),
  onEditModel: vi.fn(),
  onDeleteModel: vi.fn(),
  onToggleModel: vi.fn(),
});

function renderCard(over: Partial<Parameters<typeof ProviderCard>[0]> = {}) {
  const props = { ...baseProps(), ...over };
  const utils = render(<ProviderCard {...props} />);
  const rerenderWith = (next: ProviderCardView) =>
    utils.rerender(<ProviderCard {...props} card={next} />);
  return { ...utils, rerenderWith, props };
}

describe('pages/providersModels/ProviderCard', () => {
  test('renders the card name and the vendor slug', () => {
    renderCard();
    expect(screen.getByDisplayValue('MiniMax')).toBeInTheDocument();
    expect(screen.getByText('minimax')).toBeInTheDocument();
  });

  test('the name falls back to the vendor slug when no label is stored', () => {
    renderCard({ card: card({ label: null }) });
    expect(screen.getByDisplayValue('minimax')).toBeInTheDocument();
  });

  test('always renders the four model-type tabs', () => {
    renderCard();
    expect(screen.getByRole('tab', { name: /LLM \(VLM\)/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Speech recognition/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Image generation/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Video generation/i })).toBeInTheDocument();
  });

  test('the tabs stand alone, with no group caption', () => {
    renderCard();
    // An earlier revision captioned the row "Model types" — it repeated the
    // tab labels and crowded the card. The tab list still names itself for
    // assistive tech, where the caption is not visible to anyone.
    expect(screen.queryByText('Model types')).toBeNull();
    expect(screen.getByRole('tablist')).toHaveAttribute('aria-label', 'Model types');
  });

  test('the tab badge counts only the models that are enabled', () => {
    renderCard({
      modelsBySection: {
        'k-llm': [
          model(),
          model({ id: 'm2', model: 'off', display_name: 'off', enabled: false }),
          model({
            id: 'm3',
            model: 'banned',
            display_name: 'banned',
            disabled_by_admin: true,
          }),
        ],
      },
    });
    // Three models hang off the key; only one can actually be routed to, so
    // the badge reads the number the admin can use, not the number stored.
    expect(screen.getByRole('tab', { name: /LLM \(VLM\).*\b1\b/ })).toBeInTheDocument();
  });

  test('a configured tab shows a model-count badge', () => {
    renderCard({ modelsBySection: { 'k-llm': [model(), model({ id: 'm2' })] } });
    // The badge rides the tab label, so the tab's accessible name carries it.
    expect(screen.getByRole('tab', { name: /LLM \(VLM\).*2/ })).toBeInTheDocument();
  });

  test('only the active tab\'s section is rendered', () => {
    renderCard();
    // The LLM tab is the default: its Base URL is on screen, the image
    // section's is not.
    expect(screen.getByDisplayValue('https://api.minimaxi.com/v1')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('https://api.minimaxi.com')).toBeNull();
  });

  test('clicking a tab shows that model type\'s section', () => {
    renderCard();
    fireEvent.click(screen.getByRole('tab', { name: /Image generation/i }));
    expect(screen.getByDisplayValue('https://api.minimaxi.com')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('https://api.minimaxi.com/v1')).toBeNull();
  });

  test('an unconfigured tab opens an empty form instead of a section', () => {
    renderCard();
    fireEvent.click(screen.getByRole('tab', { name: /Video generation/i }));
    // The video section does not exist on this card: the tab shows the empty
    // form, with the vendor's default Base URL for the video protocol.
    expect(screen.getByDisplayValue('https://api.minimaxi.com')).toBeInTheDocument();
    expect(screen.getByText('This model type is not configured yet')).toBeInTheDocument();
    // No way to remove a model type — the tabs are permanent.
    expect(screen.queryByRole('button', { name: /^Remove$/ })).toBeNull();
  });

  test('a configured model type can be disabled without removing it', () => {
    const { props } = renderCard();
    fireEvent.click(screen.getByRole('switch', { name: 'Enable this model type' }));
    expect(props.onToggleSectionEnabled).toHaveBeenCalledWith(llmSection, false);
    // There is no way to remove a model type: the tabs are permanent.
    expect(screen.queryByRole('button', { name: /^Remove$/ })).toBeNull();
  });

  test('a disabled model type keeps its badge and its models', () => {
    renderCard({
      card: card({ sections: [{ ...llmSection, enabled: false }, imageSection] }),
      modelsBySection: {
        'k-llm': [
          model(),
          model({ id: 'm2', model: 'abab-6.5-turbo', display_name: 'abab-6.5-turbo' }),
        ],
      },
    });
    // The badge survives the disable.
    expect(screen.getByRole('tab', { name: /LLM \(VLM\).*2/ })).toBeInTheDocument();
    expect(screen.getByText(/This model type is disabled/)).toBeInTheDocument();
    // The models are still listed — disabling hides them from calls, it does
    // not delete them.
    expect(screen.getAllByText('abab-6.5-turbo').length).toBeGreaterThan(0);
  });

  test('pushes the card name and the section drafts up', () => {
    const { props } = renderCard();
    expect(props.onDraftChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        label: 'MiniMax',
        sections: expect.objectContaining({
          'k-llm': {
            baseUrl: 'https://api.minimaxi.com/v1',
            codingPlan: false,
            apiKey: '',
            protocol: 'openai',
          },
        }),
      }),
    );
  });

  test('a protocol switch resets the section to the new protocol default', () => {
    const { rerenderWith } = renderCard();
    expect(screen.getByDisplayValue('https://api.minimaxi.com/v1')).toBeInTheDocument();
    // The page switches the section's protocol and the card re-renders with
    // the new row; the old Base URL must not survive.
    rerenderWith(
      card({
        sections: [
          { ...llmSection, protocol: 'anthropic' },
          imageSection,
        ],
      }),
    );
    expect(screen.getByDisplayValue('https://api.minimaxi.com/anthropic')).toBeInTheDocument();
  });
});
