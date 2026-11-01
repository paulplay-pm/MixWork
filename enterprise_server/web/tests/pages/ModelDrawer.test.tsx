import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { ModelView } from '../../src/api/models';
import { setLang } from '../../src/i18n';
import { ModelDrawer, type ModelSavePayload } from '../../src/pages/providersModels/ModelDrawer';

describe('ModelDrawer', () => {
  test('renders 9 type cards and calls onSave with selected types', async () => {
    // The assertions below use the zh labels; pin the locale so the test
    // does not depend on jsdom's navigator.language.
    setLang('zh');
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <ModelDrawer open providerId="p1" provider="openai" busy={false}
        model={{ id: 'm', provider: 'openai', model: 'gpt-4', display_name: 'GPT-4',
          types: ['chat'], type: 'chat', quota_per_user_per_day: null, enabled: true,
          disabled_by_admin: false, supports_image: false, supports_video: false, supports_thinking: false,
          context_window: 128000, max_tokens: null, temperature: 0.7, top_p: 0.9, max_output_tokens: null }}
        onSave={onSave} onClose={vi.fn()} />,
    );
    expect(screen.getByText('对话')).toBeInTheDocument();
    expect(screen.getByText('语音合成')).toBeInTheDocument(); // TTS card present
    // All 9 type cards render, one per `MODEL_TYPE_VALUES` entry.
    for (const label of ['对话', '视觉理解', '深度思考', '图像生成', 'Embedding', '重排序', '语音识别', '语音合成', '视频生成']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    await user.click(screen.getByText('深度思考')); // toggle reasoning on
    await user.click(screen.getByRole('button', { name: /保存/ }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].types).toContain('reasoning');
    expect(onSave.mock.calls[0][0].types).toContain('chat');
  });

  test('an untouched edit of an originally-null sampling field round-trips as null', async () => {
    setLang('zh');
    const user = userEvent.setup();
    const onSave = vi.fn();
    // Edit a model whose sampling fields are all null. The drawer must NOT
    // materialize them to the UI defaults (0.7 / 0.9 / 200000) on an
    // untouched save — the payload must carry null so the backend leaves
    // the columns as-is.
    render(
      <ModelDrawer open providerId="p1" provider="openai" busy={false}
        model={{ id: 'm-null', provider: 'openai', model: 'embed-1', display_name: 'Embed 1',
          types: ['embedding'], type: 'embedding', quota_per_user_per_day: null, enabled: true,
          disabled_by_admin: false, supports_image: false, supports_video: false, supports_thinking: false,
          context_window: null, max_tokens: null, temperature: null, top_p: null, max_output_tokens: null }}
        onSave={onSave} onClose={vi.fn()} />,
    );
    // Open the drawer, leave every sampling control untouched, and save.
    await user.click(screen.getByRole('button', { name: /保存/ }));
    expect(onSave).toHaveBeenCalledTimes(1);
    const payload = onSave.mock.calls[0][0];
    expect(payload.contextWindow).toBeNull();
    expect(payload.temperature).toBeNull();
    expect(payload.topP).toBeNull();
    // The non-sampling fields still round-trip so the save isn't a no-op.
    expect(payload.model).toBe('embed-1');
    expect(payload.types).toEqual(['embedding']);
  });
});

const mediaModel: ModelView = {
  id: 'm-img',
  provider: 'minimax',
  model: 'image-01',
  display_name: 'image-01',
  type: 'image',
  types: ['image-gen'],
  quota_per_user_per_day: null,
  enabled: true,
  disabled_by_admin: false,
  supports_image: false,
  supports_video: false,
  supports_thinking: false,
  context_window: null,
  max_tokens: null,
  temperature: null,
  top_p: null,
  max_output_tokens: null,
};

describe('ModelDrawer — the section rules', () => {
  // These assertions read the English dictionary; the tests above pin `zh`.
  beforeEach(() => setLang('en'));

  test('the type grid is locked to the section the model belongs to', () => {
    render(
      <ModelDrawer open model={null} providerId="k1" provider="minimax" busy={false}
        allowedTypes={['image-gen']} onSave={() => {}} onClose={() => {}} />,
    );
    // Only the image type is offered, and it is locked on.
    expect(screen.getByText('Image Gen')).toBeInTheDocument();
    expect(screen.queryByText('Chat')).toBeNull();
    expect(screen.getByRole('checkbox')).toBeChecked();
    expect(screen.getByRole('checkbox')).toBeDisabled();
  });

  test('the default toggle rides the type chip', async () => {
    let saved: ModelSavePayload | null = null;
    render(
      <ModelDrawer open model={null} providerId="k1" provider="minimax" busy={false}
        allowedTypes={['image-gen']} onSave={(p) => { saved = p; }} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Set as default/i }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'image-01' } });
    fireEvent.change(screen.getByLabelText(/Model ID/i), { target: { value: 'image-01' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() =>
      expect((saved as ModelSavePayload | null)?.defaultChanges).toEqual([
        { type: 'image-gen', isDefault: true },
      ]),
    );
  });

  test('a model that is already the default offers to unset it', () => {
    render(
      <ModelDrawer open model={mediaModel} providerId="k1" provider="minimax" busy={false}
        defaultTypes={['image-gen']} onSave={() => {}} onClose={() => {}} />,
    );
    expect(screen.getByRole('button', { name: /Unset default/i })).toBeInTheDocument();
  });

  test('an untouched default produces no default change', async () => {
    let saved: ModelSavePayload | null = null;
    render(
      <ModelDrawer open model={mediaModel} providerId="k1" provider="minimax" busy={false}
        defaultTypes={['image-gen']} onSave={(p) => { saved = p; }} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saved).not.toBeNull());
    expect((saved as ModelSavePayload | null)?.defaultChanges).toEqual([]);
  });

  test('a media model can carry a parameter spec', async () => {
    let saved: ModelSavePayload | null = null;
    render(
      <ModelDrawer open model={null} providerId="k1" provider="minimax" busy={false}
        allowedTypes={['image-gen']} onSave={(p) => { saved = p; }} onClose={() => {}} />,
    );
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'image-01' } });
    fireEvent.change(screen.getByLabelText(/Model ID/i), { target: { value: 'image-01' } });
    fireEvent.change(screen.getByLabelText(/Parameter spec/i), {
      target: { value: '{"size":"1024x1024"}' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() =>
      expect((saved as ModelSavePayload | null)?.parameterSpec).toEqual({ size: '1024x1024' }),
    );
  });

  test('a malformed parameter spec blocks the save', () => {
    let saved: ModelSavePayload | null = null;
    render(
      <ModelDrawer open model={null} providerId="k1" provider="minimax" busy={false}
        allowedTypes={['image-gen']} onSave={(p) => { saved = p; }} onClose={() => {}} />,
    );
    // The required fields must be filled first, or the save would be blocked
    // by the empty-name check instead of the spec check.
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'image-01' } });
    fireEvent.change(screen.getByLabelText(/Model ID/i), { target: { value: 'image-01' } });
    fireEvent.change(screen.getByLabelText(/Parameter spec/i), { target: { value: '{oops' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(saved).toBeNull();
    expect(screen.getByText(/not valid json/i)).toBeInTheDocument();
  });

  test('a new image model starts from the type\'s own parameter defaults', async () => {
    let saved: ModelSavePayload | null = null;
    render(
      <ModelDrawer open model={null} providerId="k1" provider="minimax" busy={false}
        allowedTypes={['image-gen']} onSave={(p) => { saved = p; }} onClose={() => {}} />,
    );
    // The box is pre-filled with the parameters the image pipeline actually
    // reads, so an admin who does not know the vendor's names still gets a
    // spec the model can be called with.
    const box = screen.getByLabelText(/Parameter spec/i) as HTMLTextAreaElement;
    expect(JSON.parse(box.value)).toEqual({ size: '1024x1024', n: 1 });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'image-01' } });
    fireEvent.change(screen.getByLabelText(/Model ID/i), { target: { value: 'image-01' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saved).not.toBeNull());
    // Saving an untouched default persists it — that is the point of seeding.
    expect((saved as ModelSavePayload | null)?.parameterSpec).toEqual({
      size: '1024x1024',
      n: 1,
    });
  });

  test('a new video model starts from the video defaults', () => {
    render(
      <ModelDrawer open model={null} providerId="k1" provider="minimax" busy={false}
        allowedTypes={['video-gen']} onSave={() => {}} onClose={() => {}} />,
    );
    const box = screen.getByLabelText(/Parameter spec/i) as HTMLTextAreaElement;
    expect(JSON.parse(box.value)).toEqual({
      durationSeconds: 5,
      resolution: '768P',
      aspectRatio: '16:9',
    });
  });

  test('a new speech model starts from the ASR defaults', () => {
    render(
      <ModelDrawer open model={null} providerId="k1" provider="minimax" busy={false}
        allowedTypes={['asr']} onSave={() => {}} onClose={() => {}} />,
    );
    const box = screen.getByLabelText(/Parameter spec/i) as HTMLTextAreaElement;
    expect(JSON.parse(box.value)).toEqual({ langType: 'zh-CHS', sampleRate: 16000 });
  });

  test('ticking a media type fills in its defaults', async () => {
    const user = userEvent.setup();
    render(
      <ModelDrawer open model={null} providerId="k1" provider="minimax" busy={false}
        onSave={() => {}} onClose={() => {}} />,
    );
    // The drawer opens on a chat model, which has no spec field at all.
    expect(screen.queryByLabelText(/Parameter spec/i)).toBeNull();
    await user.click(screen.getByText('Video Gen'));
    const box = screen.getByLabelText(/Parameter spec/i) as HTMLTextAreaElement;
    expect(JSON.parse(box.value)).toEqual({
      durationSeconds: 5,
      resolution: '768P',
      aspectRatio: '16:9',
    });
  });

  test('a parameter spec the admin typed survives a type change', async () => {
    const user = userEvent.setup();
    render(
      <ModelDrawer open model={null} providerId="k1" provider="minimax" busy={false}
        onSave={() => {}} onClose={() => {}} />,
    );
    await user.click(screen.getByText('Image Gen'));
    const box = screen.getByLabelText(/Parameter spec/i) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '{"size":"512x512"}' } });
    // Adding another media type must not replace the admin's own text.
    await user.click(screen.getByText('Video Gen'));
    expect(box.value).toBe('{"size":"512x512"}');
  });

  test('editing a model with no stored spec leaves the box empty', () => {
    // A save must not invent a spec the admin never saw: an existing row that
    // carries none stays that way until someone types one.
    render(
      <ModelDrawer open model={mediaModel} providerId="k1" provider="minimax" busy={false}
        allowedTypes={['image-gen']} onSave={() => {}} onClose={() => {}} />,
    );
    const box = screen.getByLabelText(/Parameter spec/i) as HTMLTextAreaElement;
    expect(box.value).toBe('');
  });

  test('a chat model has no parameter spec field', () => {
    render(
      <ModelDrawer open model={null} providerId="k1" provider="minimax" busy={false}
        allowedTypes={['chat', 'vision']} onSave={() => {}} onClose={() => {}} />,
    );
    expect(screen.queryByLabelText(/Parameter spec/i)).toBeNull();
  });
});
