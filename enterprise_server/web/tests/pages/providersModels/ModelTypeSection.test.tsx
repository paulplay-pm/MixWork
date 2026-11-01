import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { ModelTypeSection } from '../../../src/pages/providersModels/ModelTypeSection';
import { MODEL_TYPE_TABS, ModelTypeTabId } from '../../../src/pages/providersModels/modelTypeTabs';

const llm = MODEL_TYPE_TABS.find((c) => c.id === ModelTypeTabId.Llm)!;
const image = MODEL_TYPE_TABS.find((c) => c.id === ModelTypeTabId.Image)!;

type SectionProps = Parameters<typeof ModelTypeSection>[0];

function sectionProps(over: Partial<SectionProps> = {}): SectionProps {
  return {
    tab: llm,
    providerKeyId: 'k1',
    protocol: 'openai',
    providerSlug: 'minimax',
    endpoint: 'https://api.minimaxi.com/v1',
    codingPlan: false,
    apiKeyMasked: 'sk-…abcd',
    isBuiltin: false,
    canManage: true,
    busy: false,
    models: [],
    defaultTypesByModel: {},
    onDraftChange: vi.fn(),
    onProtocolChange: vi.fn(),
    onRefreshModels: () => {},
    onAddModel: () => {},
    onEditModel: () => {},
    onDeleteModel: () => {},
    onToggleModel: () => {},
    ...over,
  };
}

function renderSection(over: Partial<SectionProps> = {}) {
  const props = sectionProps(over);
  const utils = render(<ModelTypeSection {...props} />);
  return {
    onDraftChange: props.onDraftChange,
    onProtocolChange: props.onProtocolChange,
    rerender: (next: Partial<SectionProps>) =>
      utils.rerender(<ModelTypeSection {...sectionProps({ ...over, ...next })} />),
  };
}

describe('pages/providersModels/ModelTypeSection', () => {
  test('the LLM section offers the openai and anthropic protocols', () => {
    renderSection();
    expect(screen.getByRole('radio', { name: /OpenAI compatible/i })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Anthropic compatible/i })).not.toBeChecked();
  });

  test('switching the protocol asks the card instead of editing the row', () => {
    const { onProtocolChange } = renderSection();
    fireEvent.click(screen.getByRole('radio', { name: /Anthropic compatible/i }));
    expect(onProtocolChange).toHaveBeenCalledWith('anthropic');
  });

  test('the protocol radio is disabled while the card is busy', () => {
    // A switch in flight must not be clickable again, or the admin can fire
    // two switches at once.
    renderSection({ busy: true });
    expect(screen.getByRole('radio', { name: /OpenAI compatible/i })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /Anthropic compatible/i })).toBeDisabled();
  });

  test('a media section has no protocol radio', () => {
    renderSection({ tab: image, protocol: 'image-gen' });
    expect(screen.queryByRole('radio', { name: /OpenAI compatible/i })).toBeNull();
  });

  test('pushes the field values up to the card on mount', async () => {
    const { onDraftChange } = renderSection();
    await waitFor(() =>
      expect(onDraftChange).toHaveBeenLastCalledWith({
        baseUrl: 'https://api.minimaxi.com/v1',
        codingPlan: false,
        apiKey: '',
        protocol: 'openai',
      }),
    );
  });

  test('a typed key lands in the draft', async () => {
    const { onDraftChange } = renderSection();
    fireEvent.change(screen.getByLabelText(/API Key/i), { target: { value: 'sk-new' } });
    await waitFor(() =>
      expect(onDraftChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ apiKey: 'sk-new' }),
      ),
    );
  });

  test('a tab that is not configured yet keeps the protocol choice local', async () => {
    // There is no row to switch, so the choice lives in the draft until the
    // card is saved — and the Base URL follows it.
    const { onDraftChange } = renderSection({ providerKeyId: null, protocol: 'openai' });
    fireEvent.click(screen.getByRole('radio', { name: /Anthropic compatible/i }));
    expect(screen.getByRole('radio', { name: /Anthropic compatible/i })).toBeChecked();
    expect(screen.getByDisplayValue('https://api.minimaxi.com/anthropic')).toBeInTheDocument();
    await waitFor(() =>
      expect(onDraftChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ protocol: 'anthropic' }),
      ),
    );
  });

  test('a tab that is not configured yet follows the vendor its card names', () => {
    // The card pushes the seeded default back down as the draft, exactly as
    // ProviderCard does — the field must still follow the vendor, because the
    // admin never typed this address.
    const { rerender } = renderSection({
      providerKeyId: null,
      providerSlug: 'new-provider',
      endpoint: null,
      apiKeyMasked: null,
      draft: {
        baseUrl: 'https://api.openai.com/v1',
        codingPlan: false,
        apiKey: '',
        protocol: 'openai',
      },
    });
    expect(screen.getByDisplayValue('https://api.openai.com/v1')).toBeInTheDocument();
    rerender({ providerSlug: 'minimax' });
    expect(screen.getByDisplayValue('https://api.minimaxi.com/v1')).toBeInTheDocument();
  });

  test('a Base URL the admin typed does not follow the vendor', () => {
    const draftOf = (baseUrl: string) => ({
      baseUrl,
      codingPlan: false,
      apiKey: '',
      protocol: 'openai' as const,
    });
    const { rerender } = renderSection({
      providerKeyId: null,
      providerSlug: 'new-provider',
      endpoint: null,
      apiKeyMasked: null,
      draft: draftOf('https://proxy.internal.example/v1'),
    });
    fireEvent.change(screen.getByDisplayValue('https://proxy.internal.example/v1'), {
      target: { value: 'https://proxy.internal.example/v2' },
    });
    // The card pushes the typed value back down, as it does in the app.
    rerender({ providerSlug: 'minimax', draft: draftOf('https://proxy.internal.example/v2') });
    expect(screen.getByDisplayValue('https://proxy.internal.example/v2')).toBeInTheDocument();
  });

  test('a tab that is not configured yet keeps its protocol choice when it is re-mounted', () => {
    // The admin switches the protocol, looks at another model type, and comes
    // back: the choice and the Base URL that follows it must survive.
    renderSection({
      providerKeyId: null,
      protocol: 'openai',
      draft: {
        baseUrl: 'https://api.minimaxi.com/anthropic',
        codingPlan: false,
        apiKey: '',
        protocol: 'anthropic',
      },
    });
    expect(screen.getByRole('radio', { name: /Anthropic compatible/i })).toBeChecked();
    expect(screen.getByDisplayValue('https://api.minimaxi.com/anthropic')).toBeInTheDocument();
  });

  test('a tab that is not configured yet has no enable switch', () => {
    // There is no row to enable.
    renderSection({ providerKeyId: null });
    expect(screen.queryByRole('switch', { name: /Enable this model type/i })).toBeNull();
  });

  test('the enable switch reports the section\'s new state', () => {
    const onToggleEnabled = vi.fn();
    renderSection({ enabled: true, onToggleEnabled });
    fireEvent.click(screen.getByRole('switch', { name: /Enable this model type/i }));
    expect(onToggleEnabled).toHaveBeenCalledWith(false);
  });

  test('a tab that is not configured yet cannot edit its model list', () => {
    // Its models have no row to live in yet.
    renderSection({ providerKeyId: null });
    expect(screen.queryByRole('button', { name: /Add model/i })).toBeNull();
  });

  test('the masked key hint is shown', () => {
    renderSection();
    expect(screen.getAllByText(/sk-…abcd/).length).toBeGreaterThan(0);
  });

  test('a media section disables the fetch-models button', () => {
    renderSection({ tab: image, protocol: 'image-gen' });
    expect(screen.getByRole('button', { name: /Fetch models/i })).toBeDisabled();
  });

  test('the section has no save button of its own', () => {
    // Saving is consolidated on the card header: one button submits every
    // section's draft plus the card name.
    renderSection();
    expect(screen.queryByRole('button', { name: /^Save$/i })).toBeNull();
  });

  test('the inputs are disabled without manage rights', () => {
    renderSection({ canManage: false });
    expect(screen.getByDisplayValue('https://api.minimaxi.com/v1')).toBeDisabled();
    expect(screen.getByLabelText(/API Key/i)).toBeDisabled();
  });
});
