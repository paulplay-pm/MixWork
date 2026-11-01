import type { ModelTypeValue } from '../../api/models';

/**
 * A starting parameter spec per media / speech model type.
 *
 * These are not invented: each entry mirrors a parameter the server-side
 * pipeline actually reads, with the value it falls back to when the parameter
 * is absent — `enterprise_server/src/media/providers/minimax.ts` (image `size`
 * and `n`; video `durationSeconds` / `resolution` / `aspectRatio`, whose
 * no-answer defaults are 5 s, 768P and 16:9) and
 * `enterprise_server/src/routes/asr.ts` (`zh-CHS`, 16 kHz PCM16). They are
 * kept in step with that code by hand; when a pipeline default moves, move it
 * here too.
 *
 * The spec is a request shape, not a schema: it is printed to the agent as the
 * parameters the model accepts, so the values must be ones the model can be
 * called with as they stand.
 */
export const DEFAULT_PARAMETER_SPECS: Partial<Record<ModelTypeValue, Record<string, unknown>>> =
  {
    'image-gen': { size: '1024x1024', n: 1 },
    'video-gen': { durationSeconds: 5, resolution: '768P', aspectRatio: '16:9' },
    'asr': { langType: 'zh-CHS', sampleRate: 16000 },
  };

/**
 * The default spec for a model carrying `types`: the single default-bearing
 * type's entry. A chat model that also paints pictures still gets one; two
 * media types at once have no single request shape, so nothing is seeded and
 * the admin writes the spec that fits. `undefined` means "no default".
 */
export function defaultParameterSpecFor(
  types: readonly ModelTypeValue[]
): Record<string, unknown> | undefined {
  const specs = types
    .map((value) => DEFAULT_PARAMETER_SPECS[value])
    .filter((spec): spec is Record<string, unknown> => spec !== undefined);
  return specs.length === 1 ? { ...specs[0] } : undefined;
}
