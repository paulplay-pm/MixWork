export type MediaKind = 'image' | 'video';

/** The generation `type` the desktop sends. `t2v`/`i2v`/`r2v` are the video
 *  modes (text-to-video, image-to-video, reference-to-video); `image`/`video`
 *  are the plain ones. */
export type MediaGenerateType = 'image' | 'video' | 't2v' | 'i2v' | 'r2v';

/**
 * One entry of the desktop's media model picker, as `GET /api/media/:kind/models`
 * serves it. `modelId` is the QUALIFIED id (`minimax/image-01`) — the bare
 * upstream name is not unique across vendors.
 */
export interface MediaModelDescriptor {
  modelId: string;
  displayName: string;
  /** The owning provider key's slug. */
  provider: string;
  /** The model's catalog types, e.g. `['image-gen']`. */
  capabilities: string[];
  parameterSpec: Record<string, unknown>;
}

export interface MediaGenerateParams {
  model: string;
  type: MediaGenerateType;
  prompt: string;
  params: Record<string, unknown>;
}

export interface ResolvedMediaConfig {
  id: string;
  protocol: string;
  provider: string;
  endpoint: string | null;
  apiKey: string;
  config: Record<string, unknown>;
}

export interface MediaSubmitResult {
  upstreamTaskId: string;
  /** Set by a SYNCHRONOUS upstream (most image APIs answer with the URL
   *  directly). The server records a task that is already `succeeded` and
   *  never runs the worker for it. */
  immediateResult?: { resultUrls: string[] };
}

export interface MediaPollResult {
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  resultUrls?: string[];
  errorMessage?: string;
}

/**
 * A media upstream.
 *
 * `synchronous` is a capability flag, not a detail: most image APIs POST and
 * get a URL back, with no task to poll and nothing to cancel. An interface
 * that can only describe the async shape would force the server to invent a
 * task for a provider that never had one, and would make the worker
 * mandatory for a flow that does not need it.
 */
export interface MediaProvider {
  readonly synchronous: boolean;
  submit(cfg: ResolvedMediaConfig, p: MediaGenerateParams): Promise<MediaSubmitResult>;
  poll(cfg: ResolvedMediaConfig, upstreamTaskId: string): Promise<MediaPollResult>;
  cancel(cfg: ResolvedMediaConfig, upstreamTaskId: string): Promise<void>;
}
