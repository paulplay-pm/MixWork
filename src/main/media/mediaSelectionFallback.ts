import { bareMediaModelId } from '../../shared/mediaModelAliases';
import {
  MediaGenerationTool,
  MediaSelectionMode,
  type MediaSelectionState,
} from '../mediaGenerationPolicy';

export type MediaSelectionResolutionSource = 'bound' | 'tool' | 'default' | 'none';

export interface MediaSelectionResolution {
  selection: MediaSelectionState | undefined;
  source: MediaSelectionResolutionSource;
  /** The tool named a model the account has not configured. */
  unavailableModel?: string;
  /** The tool named a model but the account has no media models configured. */
  noModelsConfigured?: boolean;
}

const isBoundSelectionActive = (selection?: MediaSelectionState): boolean =>
  !!selection && selection.mode !== MediaSelectionMode.None;

/**
 * Resolve the media selection that actually gates a generate request.
 *
 * The desktop has no media picker UI in the enterprise deployment, so a turn
 * normally arrives with no bound selection. The only signal that a user wants
 * media is the tool call itself. Rather than rejecting every generate (which
 * made image generation completely unusable), the tool-requested model is
 * accepted AS the selection — but only when the account actually has that
 * model configured on the server, so the gate still fails closed when the
 * org has not configured the media provider.
 *
 * Callers pass canonicalized model ids (see `canonicalizeMediaModelId`). The
 * server addresses media models as `<prefix>/<model>`, so a model is matched
 * on its bare part: a tool that names `image-01` matches `minimax/image-01`.
 */
export const resolveEffectiveMediaSelection = (input: {
  tool: string;
  boundSelection?: MediaSelectionState;
  explicitModel?: string;
  availableModelIds: string[];
  /** The server's default model for this kind, when it has one. */
  defaultModelId?: string;
}): MediaSelectionResolution => {
  if (isBoundSelectionActive(input.boundSelection)) {
    return { selection: input.boundSelection, source: 'bound' };
  }

  const mode = input.tool === MediaGenerationTool.Video
    ? MediaSelectionMode.Video
    : MediaSelectionMode.Image;
  const modelId = input.explicitModel?.trim() || '';

  const buildSelection = (
    chosenModelId: string,
  ): MediaSelectionState => ({
    mode,
    modelId: chosenModelId,
    ...(mode === MediaSelectionMode.Image
      ? { imageModelId: chosenModelId }
      : { videoModelId: chosenModelId }),
  });

  if (!modelId) {
    // The LLM named no model. The server's default for this kind is the
    // answer — but only when the account actually has it configured.
    const defaultModelId = input.defaultModelId?.trim() || '';
    const wantedDefault = bareMediaModelId(defaultModelId);
    if (
      defaultModelId
      && input.availableModelIds.some(
        (available) => available === defaultModelId
          || bareMediaModelId(available) === wantedDefault,
      )
    ) {
      return { selection: buildSelection(defaultModelId), source: 'default' };
    }
    if (input.availableModelIds.length === 0) {
      return { selection: undefined, source: 'none', noModelsConfigured: true };
    }
    return { selection: undefined, source: 'none' };
  }

  if (input.availableModelIds.length === 0) {
    return { selection: undefined, source: 'none', noModelsConfigured: true };
  }

  // A tool may name either the bare model or the qualified id; both identify
  // the same model, so compare the bare forms.
  const wantedBare = bareMediaModelId(modelId);
  const available = input.availableModelIds.some(
    (candidate) => candidate === modelId || bareMediaModelId(candidate) === wantedBare,
  );
  if (!available) {
    return { selection: undefined, source: 'none', unavailableModel: modelId };
  }

  return { selection: buildSelection(modelId), source: 'tool' };
};
