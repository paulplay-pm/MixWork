import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { IconUploadField } from '../../src/components/IconUploadField';

function pickFile(container: HTMLElement, name = 'icon.png'): void {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });
  fireEvent.change(input, { target: { files: [file] } });
}

// jsdom has no object URLs. The methods are added to the existing URL rather
// than replacing the global: replacing it leaves the cleanup effect calling a
// `revokeObjectURL` that a later `unstubAllGlobals` has already removed.
URL.createObjectURL = () => 'blob:preview';
URL.revokeObjectURL = () => {};

describe('components/IconUploadField — create mode (deferred)', () => {
  test('picking a file is offered before the item exists, and holds it', () => {
    const onPick = vi.fn();
    const { container } = render(
      <IconUploadField label="Icon" icon={null} onPick={onPick} />,
    );
    // The point of the deferred mode: a create form can take an icon now
    // instead of telling the admin to save first and come back.
    expect(screen.getByText('Upload icon')).toBeInTheDocument();
    expect(screen.queryByText(/Save first/)).toBeNull();

    pickFile(container);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect((onPick.mock.calls[0]![0] as File).name).toBe('icon.png');
  });

  test('the held file is the preview, and clearing drops it', () => {
    const onClearPick = vi.fn();
    const file = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' });
    const { container } = render(
      <IconUploadField
        label="Icon"
        icon={null}
        pendingFile={file}
        onPick={() => {}}
        onClearPick={onClearPick}
      />,
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:preview');
    fireEvent.click(screen.getByText('Clear'));
    expect(onClearPick).toHaveBeenCalledTimes(1);
  });
});

describe('components/IconUploadField — edit mode (immediate)', () => {
  test('picking a file uploads it and reports the stored path', async () => {
    const onUpload = vi.fn().mockResolvedValue({ icon: '/kit-icons/uploads/x.png' });
    const onChanged = vi.fn();
    const { container } = render(
      <IconUploadField label="Icon" icon={null} onUpload={onUpload} onChanged={onChanged} />,
    );
    pickFile(container);
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledWith('/kit-icons/uploads/x.png'));
    expect(onUpload).toHaveBeenCalledTimes(1);
  });

  test('an existing icon offers Replace rather than Upload', () => {
    render(
      <IconUploadField label="Icon" icon="/kit-icons/uploads/x.png" onUpload={vi.fn()} />,
    );
    expect(screen.getByText('Replace icon')).toBeInTheDocument();
    expect(screen.getByText('Clear')).toBeInTheDocument();
  });
});
