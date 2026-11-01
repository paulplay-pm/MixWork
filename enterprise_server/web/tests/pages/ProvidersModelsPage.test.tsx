import { beforeEach, describe, expect, test, vi } from 'vitest';

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import type { ProviderCardSectionView, ProviderCardView } from '../../src/api/providerCards';
import { useAuthStore } from '../../src/auth/store';
import { useToastStore } from '../../src/components/toastStore';
import { ProvidersModelsPage } from '../../src/pages/ProvidersModelsPage';

function renderPage(initialEntries: string[] = ['/']): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>
        <ProvidersModelsPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/**
 * Order-independent fetch mock keyed on the route prefix. Reads answer from
 * the fixtures; writes answer with a plausible body so the page's follow-up
 * (`create` reads `.id`) does not blow up.
 */
function mockFetchData(
  cards: ProviderCardView[],
  models: unknown[] = [],
  defaults: unknown[] = []
): void {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('/admin/provider-cards')) {
      if (method === 'POST') return Promise.resolve(new Response(JSON.stringify({ id: 'cnew' }), { status: 200 }));
      if (method !== 'GET') return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify(cards), { status: 200 }));
    }
    if (url.startsWith('/admin/model-type-defaults')) {
      return Promise.resolve(new Response(JSON.stringify(defaults), { status: 200 }));
    }
    if (url.startsWith('/admin/provider-keys')) {
      if (method === 'POST') return Promise.resolve(new Response(JSON.stringify({ id: 'pknew' }), { status: 200 }));
      if (method !== 'GET') return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    }
    if (url.startsWith('/admin/models')) {
      if (method === 'POST') return Promise.resolve(new Response(JSON.stringify({ id: 'mnew' }), { status: 200 }));
      if (method !== 'GET') return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify(models), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
}

const section = (
  over: Partial<ProviderCardSectionView> = {}
): ProviderCardSectionView => ({
  providerKeyId: 'pk1',
  protocol: 'openai',
  label: null,
  endpoint: 'https://api.openai.com/v1',
  enabled: true,
  isBuiltin: false,
  codingPlan: false,
  apiKeyMasked: 'sk-…abcd',
  modelCount: 0,
  ...over,
});

const card = (over: Partial<ProviderCardView> = {}): ProviderCardView => ({
  id: 'c1',
  provider: 'openai',
  label: 'prod-openai',
  createdAt: '2026-08-26T00:00:00Z',
  isBuiltin: false,
  enabled: true,
  sections: [section()],
  ...over,
});

const model = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'm1',
  provider: 'openai',
  provider_key_id: 'pk1',
  model: 'gpt-5',
  display_name: 'GPT-5',
  types: ['chat'],
  context_window: 128000,
  enabled: true,
  disabled_by_admin: false,
  ...over,
});

/** The body of the first request matching `path` (prefix) and `method`. */
function requestBody(
  pathStart: string,
  method: string
): Record<string, unknown> | undefined {
  const call = fetchMock.mock.calls.find(
    (c) =>
      String(c[0]).startsWith(pathStart) &&
      ((c[1] as RequestInit | undefined)?.method ?? 'GET') === method
  );
  if (!call) return undefined;
  const body = (call[1] as RequestInit | undefined)?.body;
  return typeof body === 'string' ? (JSON.parse(body) as Record<string, unknown>) : {};
}

function calledWith(pathStart: string, method: string): boolean {
  return fetchMock.mock.calls.some(
    (c) =>
      String(c[0]).startsWith(pathStart) &&
      ((c[1] as RequestInit | undefined)?.method ?? 'GET') === method
  );
}

describe('pages/ProvidersModelsPage', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    useToastStore.setState({ toasts: [] });
    useAuthStore.setState({
      token: 'jwt',
      claims: { sub: 'u1', orgId: 'o1', roles: ['model_admin'] },
    });
  });

  test('shows loading indicator while queries are in flight', () => {
    fetchMock.mockReturnValue(new Promise(() => {})); // never resolves
    renderPage();
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
  });

  test('shows page header and rail sections when loaded', async () => {
    mockFetchData([]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('Model management')).toBeInTheDocument()
    );
    expect(screen.getByPlaceholderText(/Search/i)).toBeInTheDocument();
    // Empty-state CTA in the detail pane.
    expect(screen.getByText(/Select a provider on the left/i)).toBeInTheDocument();
  });

  test('the page lists cards, not credential rows', async () => {
    mockFetchData([card()]);
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText('prod-openai').length).toBeGreaterThan(0)
    );
    // The card's model types come from the section's protocol: every type
    // has a tab, and the one with a section is the one that is open.
    expect(screen.getByRole('tab', { name: 'LLM (VLM)' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Image generation' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    // No credential-row query: the card list is the only source.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).startsWith('/admin/provider-keys'))).toBe(false);
  });

  test('the rail counts only the models that are enabled', async () => {
    mockFetchData(
      [card()],
      [
        model(),
        model({ id: 'm2', model: 'gpt-5-mini', display_name: 'GPT-5 mini' }),
        model({ id: 'm3', model: 'gpt-4o', display_name: 'GPT-4o', enabled: false }),
        model({ id: 'm4', model: 'o3', display_name: 'o3', disabled_by_admin: true }),
      ]
    );
    renderPage();
    const row = await screen.findByRole('button', { name: /prod-openai/ });
    // Four models belong to the key; two are switched off, so the rail's
    // count is the number that can actually be routed to.
    await waitFor(() => expect(within(row).getByText('2')).toBeInTheDocument());
  });

  test('defaults to the first built-in card on entry without a click', async () => {
    const custom = card({ id: 'cc', provider: 'deepseek', label: 'my deepseek', isBuiltin: false });
    const builtin = card({ id: 'cb', provider: 'deepseek', label: 'DeepSeek', isBuiltin: true });
    mockFetchData([custom, builtin]);
    renderPage();
    // The built-in rides the rail's built-in section and is the default
    // selection, so its name fills the card's name field.
    await waitFor(() => expect(screen.getByDisplayValue('DeepSeek')).toBeInTheDocument());
    expect(screen.queryByDisplayValue('my deepseek')).toBeNull();
  });

  test('opening an unconfigured model type shows its empty form and creates nothing', async () => {
    mockFetchData([card()]);
    renderPage();
    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Video generation' })).toBeInTheDocument()
    );
    await user.click(screen.getByRole('tab', { name: 'Video generation' }));
    await waitFor(() =>
      expect(screen.getByText('This model type is not configured yet')).toBeInTheDocument()
    );
    // The credential row is created when the card is saved, not by looking at
    // the tab.
    expect(calledWith('/admin/provider-keys', 'POST')).toBe(false);
  });

  test('a model type is disabled, never removed', async () => {
    mockFetchData(
      [
        card({
          sections: [
            section(),
            section({ providerKeyId: 'pk-img', protocol: 'image-gen', endpoint: 'https://api.minimaxi.com' }),
          ],
        }),
      ],
      [
        model({ id: 'im1', provider_key_id: 'pk-img', model: 'image-01', display_name: 'image-01', types: ['image-gen'] }),
        model({ id: 'im2', provider_key_id: 'pk-img', model: 'image-02', display_name: 'image-02', types: ['image-gen'] }),
      ]
    );
    renderPage();
    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Enable this model type' })).toBeInTheDocument()
    );
    await user.click(screen.getByRole('switch', { name: 'Enable this model type' }));
    await waitFor(() => expect(calledWith('/admin/provider-keys/pk1/disable', 'POST')).toBe(true));
    // Disabling takes the model type out of calls; it never deletes its
    // models, so there is no confirm dialog and no DELETE.
    expect(screen.queryByRole('heading', { level: 2, name: 'Remove capability' })).toBeNull();
    expect(calledWith('/admin/provider-keys/pk1', 'DELETE')).toBe(false);
  });

  test('switching the protocol submits the protocol and the new Base URL in one PATCH', async () => {
    mockFetchData([card()], [model()]);
    renderPage();
    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Anthropic compatible' })).toBeInTheDocument()
    );
    await user.click(screen.getByRole('radio', { name: 'Anthropic compatible' }));
    // No confirm dialog: the switch is not destructive any more — the model
    // list survives it, so there is nothing to warn about.
    expect(screen.queryByRole('heading', { level: 2, name: 'Switch protocol' })).toBeNull();
    await waitFor(() =>
      expect(requestBody('/admin/provider-keys/pk1', 'PATCH')).toMatchObject({
        protocol: 'anthropic',
        // The 'openai' slug has no anthropic endpoint in the catalog, so the
        // global protocol default is used.
        baseUrl: 'https://api.anthropic.com',
        // Coding Plan is an OpenAI-wire feature and must not survive the
        // switch.
        codingPlan: false,
      })
    );
    // The switch never deletes anything.
    expect(calledWith('/admin/provider-keys/pk1', 'DELETE')).toBe(false);
  });

  test('a save in the window right after a protocol switch never resends the old Base URL', async () => {
    // The refetch is what finally reseeds the section and its draft. Until it
    // lands the card still shows the pre-switch row, so a save here would
    // write the OLD address onto the row the server has already re-pointed.
    mockFetchData([card()], [model()]);
    renderPage();
    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Anthropic compatible' })).toBeInTheDocument()
    );
    await user.click(screen.getByRole('radio', { name: 'Anthropic compatible' }));
    const sectionPatches = () =>
      fetchMock.mock.calls
        .filter(
          (c) =>
            String(c[0]).startsWith('/admin/provider-keys/pk1')
            && (((c[1] as RequestInit | undefined)?.method) ?? 'GET') === 'PATCH'
        )
        .map((c) => JSON.parse(String((c[1] as RequestInit).body)) as Record<string, unknown>);
    await waitFor(() => expect(sectionPatches()).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(sectionPatches()).toHaveLength(2));
    expect(sectionPatches().at(-1)).toMatchObject({
      baseUrl: 'https://api.anthropic.com',
      codingPlan: false,
    });
  });

  test('a model type filled in with only an API key is created on save', async () => {
    mockFetchData([card()]);
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Video generation' }));
    await user.type(screen.getByLabelText('API Key'), 'sk-video');
    await user.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(calledWith('/admin/provider-keys', 'POST')).toBe(true));
    expect(requestBody('/admin/provider-keys', 'POST')).toMatchObject({
      orgId: 'o1',
      cardId: 'c1',
      provider: 'openai',
      protocol: 'video-gen',
      apiKey: 'sk-video',
    });
  });

  test('an untouched model type is not created on save', async () => {
    mockFetchData([card()]);
    renderPage();
    const user = userEvent.setup();
    // Opening the tab is not filling it in.
    await user.click(await screen.findByRole('tab', { name: 'Video generation' }));
    await user.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(calledWith('/admin/provider-cards/c1', 'PATCH')).toBe(true));
    expect(calledWith('/admin/provider-keys', 'POST')).toBe(false);
  });

  test('the model table shows the default badge', async () => {
    mockFetchData(
      [card()],
      [model({ types: ['chat', 'vision'] })],
      [{ type: 'vision', modelId: 'm1' }]
    );
    renderPage();
    await waitFor(() => expect(screen.getAllByText('Default').length).toBeGreaterThan(0));
  });

  test('saving a section sends the Base URL and the typed key', async () => {
    mockFetchData([card()]);
    renderPage();
    const user = userEvent.setup();
    const baseUrl = await screen.findByLabelText('Base URL');
    await user.clear(baseUrl);
    await user.type(baseUrl, 'https://proxy.example/v1');
    await user.type(screen.getByLabelText('API Key'), 'sk-new');
    await user.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() =>
      expect(requestBody('/admin/provider-keys/pk1', 'PATCH')).toMatchObject({
        baseUrl: 'https://proxy.example/v1',
        apiKey: 'sk-new',
        codingPlan: false,
      })
    );
    // The card's name travels to the card row, not the section.
    expect(requestBody('/admin/provider-cards/c1', 'PATCH')).toMatchObject({ label: 'prod-openai' });
  });

  test('the card enable switch toggles the card', async () => {
    mockFetchData([card()]);
    renderPage();
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getAllByRole('switch').length).toBeGreaterThan(1));
    // The rail row renders first, the header last; both drive the card. The
    // model type's own switch is named differently and drives the section.
    const switches = screen.getAllByRole('switch', { name: 'Enabled' });
    await user.click(switches[switches.length - 1]!);
    await waitFor(() =>
      expect(requestBody('/admin/provider-cards/c1', 'PATCH')).toMatchObject({ enabled: false })
    );
  });

  test('a media section still shows its model table', async () => {
    mockFetchData(
      [card({ sections: [section({ providerKeyId: 'pk-img', protocol: 'image-gen', endpoint: 'https://api.minimaxi.com' })] })],
      [model({ id: 'im1', provider_key_id: 'pk-img', model: 'image-01', display_name: 'image-01', types: ['image-gen'] })]
    );
    renderPage();
    await waitFor(() => expect(screen.getAllByText('image-01').length).toBeGreaterThan(0));
    // The table is the same as an LLM section's — only fetch-models is off.
    expect(screen.getByText('Model capability')).toBeInTheDocument();
    expect(screen.getByText('Context window')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Fetch models/i })).toBeDisabled();
  });

  test('saving a new card creates it', async () => {
    mockFetchData([]);
    renderPage();
    const user = userEvent.setup();
    await screen.findByRole('button', { name: /Add provider/i });
    await user.click(screen.getByRole('button', { name: /Add provider/i }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: /New custom provider/i })).toBeInTheDocument()
    );
    // A card that does not exist yet has no credential to probe.
    expect(screen.queryByRole('button', { name: /Test connection/i })).toBeNull();
    // Every model type is there, waiting to be filled in.
    expect(screen.getByRole('tab', { name: 'Video generation' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(calledWith('/admin/provider-cards', 'POST')).toBe(true));
    expect(requestBody('/admin/provider-cards', 'POST')).toMatchObject({
      orgId: 'o1',
      provider: 'new-custom-provider',
    });
  });

  test('naming a new card after a vendor does not turn an untouched model type into a configuration', async () => {
    // The card mounts every tab under the placeholder name, then the admin
    // renames it. The tabs' Base URLs must follow the new vendor: if they kept
    // the placeholder's default, each one would count as "filled in" and save
    // a credential row pointing at the wrong vendor.
    mockFetchData([]);
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Add provider/i }));
    const name = await screen.findByLabelText('Provider name');
    await user.clear(name);
    await user.type(name, 'MiniMax');
    await user.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(calledWith('/admin/provider-cards', 'POST')).toBe(true));
    expect(requestBody('/admin/provider-cards', 'POST')).toMatchObject({ provider: 'minimax' });
    expect(calledWith('/admin/provider-keys', 'POST')).toBe(false);
  });

  test('saving a new card creates one key per filled-in model type', async () => {
    mockFetchData([]);
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Add provider/i }));
    // The LLM model type is open by default; the key is all it takes.
    await user.type(screen.getByLabelText('API Key'), 'sk-llm');
    await user.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(calledWith('/admin/provider-cards', 'POST')).toBe(true));
    await waitFor(() => expect(calledWith('/admin/provider-keys', 'POST')).toBe(true));
    expect(requestBody('/admin/provider-keys', 'POST')).toMatchObject({
      cardId: 'cnew',
      protocol: 'openai',
      apiKey: 'sk-llm',
    });
  });

  test('a draft card offers no connection test until saved', async () => {
    mockFetchData([]);
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Add provider/i }));
    // The chat section is only a placeholder: its id is synthetic, so probing
    // it would hit /admin/provider-keys/draft-llm/test and 404.
    expect(screen.queryByRole('button', { name: /Test connection/i })).toBeNull();
  });

  test('add model opens the drawer and saves via POST /admin/models', async () => {
    mockFetchData([card()]);
    renderPage();
    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Add model/i })).toBeInTheDocument()
    );
    await user.click(screen.getByRole('button', { name: /Add model/i }));
    const nameInput = screen.getByPlaceholderText('e.g. DeepSeek Chat');
    const idInput = screen.getByPlaceholderText('e.g. deepseek-chat');
    await user.type(nameInput, 'My Model');
    await user.type(idInput, 'my-model');
    // Two "Save" buttons exist (header, drawer footer); the drawer's is
    // rendered last in the DOM.
    const saveButtons = screen.getAllByRole('button', { name: /^Save$/ });
    await user.click(saveButtons[saveButtons.length - 1]!);
    await waitFor(() => expect(calledWith('/admin/models', 'POST')).toBe(true));
    const body = requestBody('/admin/models', 'POST');
    expect(body).toMatchObject({
      orgId: 'o1',
      providerKeyId: 'pk1',
      provider: 'openai',
      model: 'my-model',
      displayName: 'My Model',
    });
    expect(body?.types).toContain('chat');
    // On success the drawer closes.
    await waitFor(() => expect(screen.queryByPlaceholderText('e.g. deepseek-chat')).toBeNull());
  });

  test('delete model opens a styled confirm dialog and deletes on confirm', async () => {
    mockFetchData([card()], [model()]);
    renderPage();
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText('GPT-5')).toBeInTheDocument());
    // The rail's delete-provider button and the row's trash share the word;
    // the row's is the one named exactly "Delete".
    await user.click(screen.getByRole('button', { name: /^Delete$/ }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: 'Delete model' })).toBeInTheDocument()
    );
    expect(screen.getByText(/Delete model "GPT-5"/)).toBeInTheDocument();
    const deleteButtons = screen.getAllByRole('button', { name: /^Delete$/ });
    await user.click(deleteButtons[deleteButtons.length - 1]!);
    await waitFor(() => expect(calledWith('/admin/models/m1', 'DELETE')).toBe(true));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { level: 2, name: 'Delete model' })).toBeNull()
    );
  });

  test('hides the mutations when canManage is false', async () => {
    useAuthStore.setState({
      token: 'jwt',
      claims: { sub: 'u1', orgId: 'o1', roles: ['user'] },
    });
    mockFetchData([card()]);
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText('prod-openai').length).toBeGreaterThan(0)
    );
    await waitFor(() => expect(screen.getByDisplayValue('prod-openai')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Add model/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Fetch models/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Save$/ })).toBeNull();
    expect(screen.getByLabelText('Base URL')).toBeDisabled();
  });

  test('never renders the encrypted api key', async () => {
    const secret = 'sk-DO-NOT-LEAK-1234567890';
    const leaky = {
      ...card(),
      sections: [
        {
          ...section(),
          // Simulating a (buggy) server leaking the secret.
          api_key_encrypted: secret,
        },
      ],
    };
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/admin/provider-cards')) {
        return Promise.resolve(new Response(JSON.stringify([leaky]), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText('prod-openai').length).toBeGreaterThan(0)
    );
    expect(screen.queryByText(secret)).toBeNull();
    expect(screen.queryByText(/DO-NOT-LEAK/)).toBeNull();
  });

  test('the rail asks before deleting a card', async () => {
    mockFetchData([card({ id: 'cc', provider: 'minimax', label: 'my minimax' })]);
    renderPage();
    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'delete-provider' })).toBeInTheDocument()
    );
    await user.click(screen.getByRole('button', { name: 'delete-provider' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: 'Delete provider' })).toBeInTheDocument()
    );
    expect(screen.getByText(/Delete provider "my minimax"/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Delete$/ }));
    await waitFor(() => expect(calledWith('/admin/provider-cards/cc', 'DELETE')).toBe(true));
  });
});

// Keep `fireEvent` referenced: a few assertions below type into controlled
// inputs directly and jsdom needs the synthetic event path.
void fireEvent;
