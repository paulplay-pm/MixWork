import type { CoworkBrowserAnnotationBatch } from '@shared/mixwork/browserAnnotations';

export function resolveRemovedActiveBrowserAnnotationBatch(
  previousBatch: CoworkBrowserAnnotationBatch | undefined,
  nextBatch: CoworkBrowserAnnotationBatch | undefined,
  isAnnotating: boolean,
): CoworkBrowserAnnotationBatch | undefined {
  if (!isAnnotating || !previousBatch || nextBatch) return undefined;
  return previousBatch;
}
