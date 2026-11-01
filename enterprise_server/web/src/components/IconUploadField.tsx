import { Image as ImageIcon } from 'lucide-react';
import { type ChangeEvent, type JSX, useEffect, useRef, useState } from 'react';

import { ApiError } from '../api/client';
import { t } from '../i18n';
import { useToast } from './toastStore';

interface Props {
  /** The field's label, translated by the caller. */
  label: string;
  /** The saved icon path, or null. */
  icon: string | null;
  /** Upload one file immediately — the item already exists. */
  onUpload?: (file: File) => Promise<{ icon: string }>;
  /** Hold the file until the item exists; it is uploaded with the save.
   *  This is what lets the create form offer an icon instead of asking the
   *  admin to save first and come back. */
  onPick?: (file: File) => void;
  /** Drop the held file. */
  onClearPick?: () => void;
  /** The held file, shown as a local preview until it is uploaded. */
  pendingFile?: File | null;
  /** Clear the saved icon. */
  onClear?: () => Promise<unknown>;
  /** Called with the new value after an immediate upload or a clear. */
  onChanged?: (icon: string | null) => void;
}

/** Upload errors the server can return, in words an admin can act on. */
function errorMessage(e: unknown): string {
  const code = e instanceof ApiError ? e.body?.error : undefined;
  if (code === 'too_large') return t('iconUpload.error.tooLarge');
  if (code === 'unsupported_mime') return t('iconUpload.error.unsupported');
  // `missing_file` means the request did not carry the file at all — saying
  // "only PNG / JPEG / WEBP / SVG" would send the admin off to re-encode an
  // image that was never the problem.
  return t('iconUpload.error.uploadFailed');
}

/**
 * The icon field shared by the connector, kit and skill drawers.
 *
 * An icon is a file the admin uploads, not a URL they host somewhere first.
 * When the item already exists the file goes up immediately; when it does not
 * (a create form) the file is held and the preview comes from a local object
 * URL, so the admin can pick the icon before saving.
 */
export function IconUploadField({
  label,
  icon,
  onUpload,
  onPick,
  onClearPick,
  pendingFile,
  onClear,
  onChanged,
}: Props): JSX.Element {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [pendingPreview, setPendingPreview] = useState<string | null>(null);
  const editable = Boolean(onUpload || onPick);

  // The picked file has no server path yet, so the preview is a local URL.
  useEffect(() => {
    if (!pendingFile) {
      setPendingPreview(null);
      return;
    }
    const url = URL.createObjectURL(pendingFile);
    setPendingPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingFile]);

  const preview = pendingPreview ?? icon;

  const onFileChange = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    // Reset the input's value so picking the same file twice still fires.
    e.target.value = '';
    if (!file || busy) return;

    if (!onUpload) {
      onPick?.(file);
      return;
    }
    setBusy(true);
    try {
      const { icon: next } = await onUpload(file);
      onChanged?.(next);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const onClearClick = async (): Promise<void> => {
    // A file that was never uploaded just says so — there is nothing on the
    // server to clear.
    if (pendingFile && onClearPick) {
      onClearPick();
      return;
    }
    if (!onClear || busy) return;
    setBusy(true);
    try {
      await onClear();
      onChanged?.(null);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const hasPreview = Boolean(preview);

  return (
    <div className="flex flex-col gap-1 text-[12px] font-medium text-[var(--text-secondary)]">
      {label}
      {editable ? (
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--bg-subtle)] text-[var(--text-tertiary)]">
            {preview ? (
              <img src={preview} alt="" className="h-full w-full object-contain" />
            ) : (
              <ImageIcon className="h-4 w-4" />
            )}
          </span>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] px-2.5 py-1.5 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-60"
          >
            {hasPreview ? t('iconUpload.replace') : t('iconUpload.upload')}
          </button>
          {hasPreview && (
            <button
              type="button"
              onClick={onClearClick}
              disabled={busy}
              className="rounded-[var(--radius-sm)] px-2 py-1.5 text-[12px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-60"
            >
              {t('iconUpload.clear')}
            </button>
          )}
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            className="hidden"
            aria-label={label}
            onChange={onFileChange}
          />
        </div>
      ) : (
        <p className="text-[12px] leading-relaxed text-[var(--text-tertiary)]">
          {t('iconUpload.saveFirst')}
        </p>
      )}
    </div>
  );
}

export default IconUploadField;
