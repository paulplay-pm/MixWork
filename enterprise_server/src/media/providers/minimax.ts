import type {
  MediaGenerateParams,
  MediaPollResult,
  MediaProvider,
  MediaSubmitResult,
  ResolvedMediaConfig,
} from '../types';

/**
 * MiniMax image and video adapters.
 *
 * API (verified against platform.minimax.cn/docs):
 *
 *  - IMAGE: `POST {base}/v1/image_generation`, JSON body
 *    `{ model, prompt, aspect_ratio?, width?, height?, response_format, subject_reference? }`,
 *    `Authorization: Bearer <key>`. The response is
 *    `{ data: { image_urls: string[] } }` when `response_format: 'url'` (the
 *    default) and `{ data: { image_base64: string[] } }` for `'base64'`.
 *    Synchronous — the URLs are in the response, so there is no task to poll.
 *    The URLs are valid for 24 hours.
 *
 *  - VIDEO: asynchronous, two calls.
 *    `POST {base}/v2/video_generation` with a multimodal `content[]` array
 *    (`{type:'text'|'image_url'|'video_url'|'audio_url'}`, plus `role` for
 *    frames/references) returns `{ task_id }`.
 *    `GET {base}/v2/query/video_generation/{task_id}` returns
 *    `{ task: { status, content: { url }, error } }`.
 *    `DELETE {base}/v2/video_generation/{task_id}` cancels a queued task or
 *    deletes a finished one's record — the server picks by current status, so
 *    there is no action parameter to send.
 *
 * The `model` for images is `image-01`; for videos it is `MiniMax-H3` (or
 * `MiniMax-H3-Max`). Both are configurable per provider row through
 * `provider_keys.config`.
 */

const DEFAULT_BASE_URL = 'https://api.minimax.cn';
const DEFAULT_IMAGE_MODEL = 'image-01';
const DEFAULT_VIDEO_MODEL = 'MiniMax-H3';

/**
 * The desktop's media tools (`mixwork_image_generate` /
 * `mixwork_video_generate`) define their OWN parameter vocabulary, and the
 * server hands that bag to the adapter verbatim:
 *
 *   `aspectRatio`, `resolution`, `size`, `imageSize`, `n` / `count`,
 *   `quality`, `outputFormat`, `durationSeconds`, `seed`, `watermark`,
 *   `firstFrame`, `lastFrame`, `images` + `imageRoles`, `referenceImages`,
 *   `videos` + `videoRoles`, `media`, `providerOptions`.
 *
 * The adapter is the translation layer, so it reads THOSE names. Reading
 * Minimax's own names instead (`duration`, `ratio`, `aspect_ratio`) dropped
 * fields the upstream REQUIRES — a video call went out with no `duration`
 * and no `ratio` and came back 400 — so the mapping is explicit below.
 */

/**
 * What each Minimax video model accepts.
 *
 * `duration` and `resolution` are REQUIRED by `/v2/video_generation`, and
 * the valid ranges differ per model: `MiniMax-H3-Max` starts at 5 seconds
 * and none of the models below except plain H3 support 2K. Sending an
 * out-of-range value is a 400, so the request is brought into range first.
 */
const VIDEO_MODEL_SPECS: Record<
  string,
  { minDuration: number; maxDuration: number; resolutions: string[] }
> = {
  'MiniMax-H3': { minDuration: 4, maxDuration: 15, resolutions: ['768P', '2K'] },
  'MiniMax-H3-Highspeed': { minDuration: 4, maxDuration: 15, resolutions: ['768P'] },
  'MiniMax-H3-Lite': { minDuration: 4, maxDuration: 15, resolutions: ['480P', '768P'] },
  'MiniMax-H3-Max': { minDuration: 5, maxDuration: 15, resolutions: ['480P', '768P'] },
};

const DEFAULT_VIDEO_SPEC = { minDuration: 4, maxDuration: 15, resolutions: ['768P', '2K'] };

/** The duration used when the desktop asks for "auto" (`-1`) or says nothing.
 *  5 seconds is inside every model's range. */
const DEFAULT_VIDEO_DURATION = 5;

/** The resolution used when the desktop asks for one the model cannot do.
 *  768P is the only tier all four models support. */
const DEFAULT_VIDEO_RESOLUTION = '768P';

/** The ratio used when the desktop says nothing — or says `adaptive` for a
 *  text-only request, which the upstream rejects. */
const DEFAULT_VIDEO_RATIO = '16:9';

/** Minimax's image width/height bounds, and the multiple both must be of. */
const IMAGE_DIMENSION_MIN = 512;
const IMAGE_DIMENSION_MAX = 2048;
const IMAGE_DIMENSION_MULTIPLE = 8;

/** The desktop's size presets → pixels. `4K` is deliberately absent: it is
 *  above Minimax's 2048 ceiling. */
const IMAGE_SIZE_PRESETS: Record<string, number> = {
  '512px': 512,
  '1K': 1024,
  '2K': 2048,
};

/**
 * Minimax's video task statuses, mapped onto ours.
 *
 * Their vocabulary differs from the desktop's terminal set, and it is NOT
 * stable across API versions: the same task came back as `Success` from one
 * call and `succeeded` from the next.
 *
 * So this is a SET of known spellings, not a substring test.
 * 'succeeded'.includes('success') is FALSE — it is 'succee' + 'ded' — and
 * that wrong test mapped a FINISHED task to 'running': the server polled it
 * every five seconds until the task expired, and the user never got a video
 * Minimax had already rendered.
 *
 * An unknown spelling falls back to 'running' (keep polling) rather than a
 * terminal state: a status we have never seen is not a reason to fail a
 * generation that may still succeed.
 */
const VIDEO_STATUS_MAP: Record<string, MediaPollResult['status']> = {
  success: 'succeeded',
  succeeded: 'succeeded',
  successful: 'succeeded',
  complete: 'succeeded',
  completed: 'succeeded',
  finished: 'succeeded',
  done: 'succeeded',
  fail: 'failed',
  failed: 'failed',
  failure: 'failed',
  error: 'failed',
  cancel: 'cancelled',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  queue: 'queued',
  queueing: 'queued',
  queued: 'queued',
  prepare: 'queued',
  preparing: 'queued',
  wait: 'queued',
  waiting: 'queued',
  processing: 'running',
  running: 'running',
  in_progress: 'running',
};

function mapVideoStatus(raw: string): MediaPollResult['status'] {
  return VIDEO_STATUS_MAP[raw.trim().toLowerCase()] ?? 'running';
}

interface MinimaxMediaErrorBody {
  error?: { type?: string; message?: string; http_code?: string };
  base_resp?: { status_code?: number; status_msg?: string };
}

/**
 * Minimax reports SOME failures inside a 200 response.
 *
 * `POST /v1/image_generation` answers a bad key with HTTP 200 and
 * `{ base_resp: { status_code: 1004, status_msg: 'login fail: …' } }` — the
 * response carries no `data` at all. Treating `resp.ok` as success made every
 * failed generation look like a finished one with an empty URL list, so the
 * desktop showed an empty image instead of an error.
 *
 * `status_code` 0 means success; anything else is a failure, and
 * `status_msg` is the human-readable reason.
 */
function assertMinimaxSuccess(body: MinimaxMediaErrorBody): void {
  const status = body.base_resp?.status_code;
  if (typeof status === 'number' && status !== 0) {
    throw new Error(body.base_resp?.status_msg ?? `upstream error ${status}`);
  }
}

async function upstreamErrorMessage(resp: Response): Promise<string> {
  try {
    const body = (await resp.json()) as MinimaxMediaErrorBody;
    return (
      body.error?.message ??
      body.base_resp?.status_msg ??
      body.error?.type ??
      `upstream HTTP ${resp.status}`
    );
  } catch {
    return `upstream HTTP ${resp.status}`;
  }
}

abstract class MinimaxMediaProviderBase implements MediaProvider {
  abstract readonly synchronous: boolean;
  protected abstract readonly kind: 'image' | 'video';
  protected abstract readonly defaultModel: string;

  protected baseUrl(cfg: ResolvedMediaConfig): string {
    return (cfg.endpoint ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  }

  protected model(cfg: ResolvedMediaConfig): string {
    const configured = cfg.config.model;
    return typeof configured === 'string' && configured ? configured : this.defaultModel;
  }

  protected headers(cfg: ResolvedMediaConfig): Record<string, string> {
    return {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  async poll(cfg: ResolvedMediaConfig, upstreamTaskId: string): Promise<MediaPollResult> {
    const resp = await fetch(
      `${this.baseUrl(cfg)}/v2/query/video_generation/${encodeURIComponent(upstreamTaskId)}`,
      { method: 'GET', headers: { Authorization: `Bearer ${cfg.apiKey}` } },
    );
    if (!resp.ok) {
      return { status: 'failed', errorMessage: await upstreamErrorMessage(resp) };
    }
    const body = (await resp.json()) as {
      task?: {
        status?: string;
        content?: { url?: string };
        error?: string;
      };
      base_resp?: { status_code?: number; status_msg?: string };
    };
    try {
      assertMinimaxSuccess(body);
    } catch (error) {
      return {
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : 'upstream error',
      };
    }
    const task = body.task ?? {};
    const status = mapVideoStatus(task.status ?? 'running');
    if (status === 'succeeded') {
      return {
        status,
        resultUrls: task.content?.url ? [task.content.url] : [],
      };
    }
    if (status === 'failed' || status === 'cancelled') {
      return { status, errorMessage: task.error ?? status };
    }
    return { status };
  }

  async cancel(cfg: ResolvedMediaConfig, upstreamTaskId: string): Promise<void> {
    // Minimax picks the action from the task's current status: a queued task
    // is cancelled, a finished one's record is deleted. There is no action
    // parameter to send.
    await fetch(
      `${this.baseUrl(cfg)}/v2/video_generation/${encodeURIComponent(upstreamTaskId)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${cfg.apiKey}` } },
    );
  }

  abstract submit(
    cfg: ResolvedMediaConfig,
    p: MediaGenerateParams,
  ): Promise<MediaSubmitResult>;
}

/**
 * Image generation is SYNCHRONOUS: the response carries the finished URLs, so
 * there is no task to poll and nothing to cancel.
 */
export class MinimaxImageProvider extends MinimaxMediaProviderBase {
  readonly synchronous = true;
  protected readonly kind = 'image' as const;
  protected readonly defaultModel = DEFAULT_IMAGE_MODEL;

  async submit(
    cfg: ResolvedMediaConfig,
    p: MediaGenerateParams,
  ): Promise<MediaSubmitResult> {
    const params = p.params ?? {};
    const providerOptions = recordOf(params.providerOptions);
    const body: Record<string, unknown> = {
      model: p.model || this.model(cfg),
      prompt: p.prompt,
      // `url` (the default) rather than `base64`: the desktop renders the
      // result as a markdown image URL, and a base64 data URL in a chat
      // transcript is enormous. Minimax's URLs are valid for 24 hours.
      response_format: 'url',
    };
    const aspectRatio = firstString(params.aspectRatio, params.aspect_ratio);
    if (aspectRatio) body.aspect_ratio = aspectRatio;

    const dimensions = imageDimensions(params);
    if (dimensions) {
      body.width = dimensions.width;
      body.height = dimensions.height;
    }

    const n = firstNumber(params.n, params.count);
    if (n !== undefined) body.n = clamp(Math.round(n), 1, 9);

    const seed = firstNumber(params.seed, providerOptions?.seed);
    if (seed !== undefined && seed >= 0) body.seed = seed;

    const watermark = firstBoolean(params.watermark, providerOptions?.aigc_watermark);
    if (watermark !== undefined) body.aigc_watermark = watermark;

    const promptOptimizer = firstBoolean(
      params.prompt_optimizer,
      providerOptions?.prompt_optimizer,
    );
    if (promptOptimizer !== undefined) body.prompt_optimizer = promptOptimizer;

    // Image-to-image: the desktop sends the reference image(s) in `images`
    // (or `referenceImages`), and Minimax takes them in `subject_reference`
    // as `{ type: 'character', image_file: <url> }`. The upstream accepts ONE
    // reference image per request, so only the first is sent.
    const subjectReference = imageSubjectReference(params, providerOptions);
    if (subjectReference) body.subject_reference = subjectReference;
    // `style` only applies to image-01-live (画风设置).
    if (providerOptions?.style && typeof providerOptions.style === 'object') {
      body.style = providerOptions.style;
    }

    const resp = await fetch(`${this.baseUrl(cfg)}/v1/image_generation`, {
      method: 'POST',
      headers: this.headers(cfg),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(await upstreamErrorMessage(resp));
    }
    const json = (await resp.json()) as {
      data?: { image_urls?: string[]; image_base64?: string[] };
      base_resp?: { status_code?: number; status_msg?: string };
    };
    assertMinimaxSuccess(json);
    const urls = json.data?.image_urls ?? [];
    return {
      upstreamTaskId: `minimax-image-${Date.now()}`,
      immediateResult: { resultUrls: urls },
    };
  }
}

/**
 * Video generation is asynchronous: submit returns a task id, and the worker
 * polls until it succeeds or fails.
 */
export class MinimaxVideoProvider extends MinimaxMediaProviderBase {
  readonly synchronous = false;
  protected readonly kind = 'video' as const;
  protected readonly defaultModel = DEFAULT_VIDEO_MODEL;

  async submit(
    cfg: ResolvedMediaConfig,
    p: MediaGenerateParams,
  ): Promise<MediaSubmitResult> {
    const params = p.params ?? {};
    const model = p.model || this.model(cfg);
    const mode = videoMode(p, params);
    const content = videoContent(mode, p, params);

    const spec = VIDEO_MODEL_SPECS[model] ?? DEFAULT_VIDEO_SPEC;

    const body: Record<string, unknown> = { model, content };

    // `durationSeconds` is the desktop's name; `-1` means "you pick".
    const requestedDuration = firstNumber(params.durationSeconds, params.duration);
    const duration =
      requestedDuration === undefined || requestedDuration <= 0
        ? DEFAULT_VIDEO_DURATION
        : clamp(Math.round(requestedDuration), spec.minDuration, spec.maxDuration);
    body.duration = duration;

    // The desktop writes resolutions in mixed case ("480p", "768P"); the
    // upstream enum is upper-case. A tier the model cannot do falls back to
    // the closest one it can.
    const requestedResolution = firstString(params.resolution)?.toUpperCase();
    body.resolution = pickResolution(requestedResolution, spec.resolutions);

    // `ratio` rules (the upstream's own wording):
    //  - t2v: REQUIRED, and 'adaptive' is rejected.
    //  - i2v: the input image decides the ratio; anything else is ignored.
    //  - r2v: optional, 'adaptive' by default, a concrete ratio is honoured.
    //  - MiniMax-H3-Lite has no 'adaptive' at all and needs a concrete one.
    const requestedRatio = firstString(params.aspectRatio, params.ratio);
    const concreteRatio =
      requestedRatio && requestedRatio !== 'adaptive' ? requestedRatio : undefined;
    if (mode === 't2v' || model === 'MiniMax-H3-Lite') {
      body.ratio = concreteRatio ?? DEFAULT_VIDEO_RATIO;
    } else if (mode === 'i2v') {
      body.ratio = 'adaptive';
    } else {
      body.ratio = concreteRatio ?? 'adaptive';
    }

    const providerOptions = recordOf(params.providerOptions);
    if (providerOptions?.extra && typeof providerOptions.extra === 'object') {
      body.extra = providerOptions.extra;
    }
    const callbackUrl = firstString(params.callback_url, providerOptions?.callback_url);
    if (callbackUrl) body.callback_url = callbackUrl;

    const resp = await fetch(`${this.baseUrl(cfg)}/v2/video_generation`, {
      method: 'POST',
      headers: this.headers(cfg),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(await upstreamErrorMessage(resp));
    }
    const json = (await resp.json()) as {
      task_id?: string;
      base_resp?: { status_code?: number; status_msg?: string };
    };
    assertMinimaxSuccess(json);
    if (!json.task_id) {
      throw new Error('upstream did not return a task_id');
    }
    return { upstreamTaskId: json.task_id };
  }
}

/**
 * The three generation modes Minimax's video API supports.
 *
 *  - `t2v` — text only.
 *  - `i2v` — text + a first frame and/or a last frame.
 *  - `r2v` — text + reference images / videos / audio.
 *
 * i2v and r2v are MUTUALLY EXCLUSIVE upstream: a content array that carries
 * both a `first_frame` and a `reference_image` is rejected with 400. The
 * desktop picks the mode and sends it as the request's `type`, so the adapter
 * follows that and drops the other mode's entries instead of sending both.
 */
type VideoMode = 't2v' | 'i2v' | 'r2v';

/**
 * The reference image(s) for image-to-image.
 *
 * The upstream's shape is `{ type: 'character', image_file: <url> }` and it
 * takes ONE reference image per request, so the first reference is the one
 * that goes out. An explicit `subject_reference` (the upstream's own name)
 * always wins.
 */
function imageSubjectReference(
  params: Record<string, unknown>,
  providerOptions: Record<string, unknown> | undefined,
): Array<Record<string, unknown>> | undefined {
  if (Array.isArray(params.subject_reference)) return params.subject_reference;
  if (Array.isArray(providerOptions?.subject_reference)) {
    return providerOptions.subject_reference;
  }
  const images = [
    ...(Array.isArray(params.images) ? params.images : []),
    ...(Array.isArray(params.referenceImages) ? params.referenceImages : []),
  ];
  for (const image of images) {
    const url = firstString(image);
    if (url) return [{ type: 'character', image_file: url }];
  }
  return undefined;
}

/** How many of each role the upstream accepts. Over the limit it answers
 *  400, so the extra input is dropped here instead. */
const VIDEO_ROLE_LIMITS: Record<string, number> = {
  first_frame: 1,
  last_frame: 1,
  reference_image: 9,
  reference_video: 3,
  reference_audio: 3,
};

/** The roles that belong to the i2v (frame) mode. */
const FRAME_ROLES = new Set(['first_frame', 'last_frame']);

/**
 * The generation mode, from the request the desktop made.
 *
 * The desktop picks it (`inferVideoGenerationType` in src/main/main.ts) and
 * sends it as the request's `type`, so that is the source of truth. The
 * fallback mirrors the desktop's own inference for a caller that sends the
 * generic `video` type.
 */
function videoMode(p: MediaGenerateParams, params: Record<string, unknown>): VideoMode {
  if (p.type === 't2v' || p.type === 'i2v' || p.type === 'r2v') return p.type;
  const imageRoles = Array.isArray(params.imageRoles) ? params.imageRoles : [];
  const mediaTypes = (Array.isArray(params.media) ? params.media : [])
    .map((item) => firstString(recordOf(item)?.type)?.toLowerCase() ?? '');
  const hasReference =
    (Array.isArray(params.referenceImages) && params.referenceImages.length > 0)
    || imageRoles.some((role) => normalizeVideoRole(firstString(role), 'image_url') === 'reference_image')
    || mediaTypes.some(
      (type) => type === 'reference_image' || type === 'reference_video' || type === 'reference_audio',
    );
  if (hasReference) return 'r2v';
  const hasFrame =
    !!firstString(params.firstFrame, params.first_frame)
    || imageRoles.some((role) => normalizeVideoRole(firstString(role), 'image_url') === 'first_frame')
    || mediaTypes.some((type) => type === 'first_frame' || type === 'last_frame')
    || (Array.isArray(params.images) && params.images.length > 0);
  return hasFrame ? 'i2v' : 't2v';
}

/** The desktop's role names, mapped onto the upstream's. */
function normalizeVideoRole(
  role: string | undefined,
  kind: 'image_url' | 'video_url' | 'audio_url',
): string | undefined {
  const s = (role ?? '').trim().toLowerCase();
  if (s === 'first_frame' || s === 'firstframe' || s === 'first') return 'first_frame';
  if (s === 'last_frame' || s === 'lastframe' || s === 'last') return 'last_frame';
  if (s === 'reference_video' || s === 'referencevideo') return 'reference_video';
  if (s === 'reference_audio' || s === 'referenceaudio') return 'reference_audio';
  if (s === 'reference_image' || s === 'referenceimage' || s === 'reference') {
    if (kind === 'video_url') return 'reference_video';
    if (kind === 'audio_url') return 'reference_audio';
    return 'reference_image';
  }
  return undefined;
}

/** One media input, already in the upstream's vocabulary. */
interface VideoMediaEntry {
  type: 'image_url' | 'video_url' | 'audio_url';
  url: string;
  role: string;
}

/**
 * The media inputs the desktop sent, each with the role it plays.
 *
 * The role decides the mode: a frame role is i2v, a reference role is r2v.
 * A role-less image is the first frame in i2v (the upstream treats a
 * role-less image that way) and a reference image in r2v.
 */
function videoMediaEntries(
  mode: VideoMode,
  params: Record<string, unknown>,
): VideoMediaEntry[] {
  const entries: VideoMediaEntry[] = [];

  const firstFrame = firstString(params.firstFrame, params.first_frame);
  if (firstFrame) entries.push({ type: 'image_url', url: firstFrame, role: 'first_frame' });

  const lastFrame = firstString(params.lastFrame, params.last_frame);
  if (lastFrame) entries.push({ type: 'image_url', url: lastFrame, role: 'last_frame' });

  // `images` carries a parallel `imageRoles` array.
  const images = Array.isArray(params.images) ? params.images : [];
  const imageRoles = Array.isArray(params.imageRoles) ? params.imageRoles : [];
  images.forEach((image, index) => {
    const url = firstString(image);
    if (!url) return;
    const role =
      normalizeVideoRole(firstString(imageRoles[index]), 'image_url')
      ?? (mode === 'i2v' ? 'first_frame' : 'reference_image');
    entries.push({ type: 'image_url', url, role });
  });

  const referenceImages = Array.isArray(params.referenceImages)
    ? params.referenceImages
    : Array.isArray(params.reference_images)
      ? params.reference_images
      : [];
  for (const image of referenceImages) {
    const url = firstString(image);
    if (!url) continue;
    entries.push({ type: 'image_url', url, role: 'reference_image' });
  }

  // `videos` carries a parallel `videoRoles` array.
  const videos = Array.isArray(params.videos) ? params.videos : [];
  const videoRoles = Array.isArray(params.videoRoles) ? params.videoRoles : [];
  videos.forEach((video, index) => {
    const url = firstString(video);
    if (!url) return;
    const role = normalizeVideoRole(firstString(videoRoles[index]), 'video_url') ?? 'reference_video';
    entries.push({ type: 'video_url', url, role });
  });

  for (const video of Array.isArray(params.referenceVideos) ? params.referenceVideos : []) {
    const url = firstString(video);
    if (!url) continue;
    entries.push({ type: 'video_url', url, role: 'reference_video' });
  }

  // `media[]` is the desktop's pass-through for provider-native entries; the
  // upstream wants the same `{type, <type>_url: {url}, role}` shape.
  for (const item of Array.isArray(params.media) ? params.media : []) {
    const entry = recordOf(item);
    if (!entry) continue;
    const rawType = firstString(entry.type);
    const url = firstString(
      entry.url,
      recordOf(entry.image_url)?.url,
      recordOf(entry.video_url)?.url,
      recordOf(entry.audio_url)?.url,
    );
    if (!rawType || !url) continue;
    const type =
      rawType === 'image' || rawType === 'image_url'
        ? 'image_url'
        : rawType === 'video' || rawType === 'video_url'
          ? 'video_url'
          : rawType === 'audio' || rawType === 'audio_url'
            ? 'audio_url'
            : null;
    if (!type) continue;
    const role =
      normalizeVideoRole(firstString(entry.role), type)
      ?? (type === 'image_url'
        ? (mode === 'i2v' ? 'first_frame' : 'reference_image')
        : type === 'video_url'
          ? 'reference_video'
          : 'reference_audio');
    entries.push({ type, url, role });
  }

  return entries;
}

/**
 * The multimodal `content[]` array.
 *
 * Minimax infers the generation mode from WHAT is in the array (text only →
 * t2va, a first/last frame → i2va, references → r2va), so the roles are
 * taken from the desktop's explicit role fields rather than guessed from the
 * request type.
 */
function videoContent(
  mode: VideoMode,
  p: MediaGenerateParams,
  params: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const prompt = (p.prompt ?? '').trim();
  if (!prompt) {
    // The upstream rejects a content array with no text item. Failing here
    // names the missing field instead of relaying a 400.
    throw new Error('video generation requires a prompt');
  }
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: p.prompt }];
  if (mode === 't2v') return content;

  const counts: Record<string, number> = {};
  for (const entry of videoMediaEntries(mode, params)) {
    // i2v and r2v cannot be mixed upstream: keep the mode's own roles and
    // drop the other mode's entries.
    const belongsToMode =
      mode === 'i2v' ? FRAME_ROLES.has(entry.role) : !FRAME_ROLES.has(entry.role);
    if (!belongsToMode) continue;
    const limit = VIDEO_ROLE_LIMITS[entry.role] ?? 0;
    const used = counts[entry.role] ?? 0;
    if (limit === 0 || used >= limit) continue;
    counts[entry.role] = used + 1;
    content.push({ type: entry.type, [entry.type]: { url: entry.url }, role: entry.role });
  }
  return content;
}

/**
 * The image's pixel dimensions, from whichever of the desktop's size
 * parameters was given.
 *
 * Minimax requires width AND height together, both within [512, 2048] and
 * both multiples of 8 — so a size outside that range is dropped rather than
 * sent as a request the upstream would reject.
 */
function imageDimensions(
  params: Record<string, unknown>,
): { width: number; height: number } | null {
  let width = firstNumber(params.width);
  let height = firstNumber(params.height);

  if (width === undefined || height === undefined) {
    // "1024x1024"
    const size = firstString(params.size);
    const match = size?.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
    if (match) {
      width = width ?? Number(match[1]);
      height = height ?? Number(match[2]);
    }
  }

  if (width === undefined || height === undefined) {
    // "512px" / "1K" / "2K" — a square preset.
    const preset = IMAGE_SIZE_PRESETS[(firstString(params.imageSize) ?? '').toUpperCase()];
    if (preset) {
      width = width ?? preset;
      height = height ?? preset;
    }
  }

  if (width === undefined || height === undefined) return null;
  if (!isValidImageDimension(width) || !isValidImageDimension(height)) return null;
  return { width: Math.round(width), height: Math.round(height) };
}

function isValidImageDimension(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  if (value < IMAGE_DIMENSION_MIN || value > IMAGE_DIMENSION_MAX) return false;
  return value % IMAGE_DIMENSION_MULTIPLE === 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The resolution tiers, cheapest first. */
const RESOLUTION_TIERS = ['480P', '768P', '2K'];

/**
 * The resolution to ask for: the requested one when the model supports it,
 * otherwise the closest tier it does.
 *
 * `MiniMax-H3` renders 768P / 2K and `MiniMax-H3-Lite` renders 480P / 768P,
 * so a request for a tier the model cannot do is a 400 upstream — and a
 * silent 400 is a worse answer than a slightly different tier.
 */
function pickResolution(
  requested: string | undefined,
  supported: string[],
): string {
  if (!requested) return DEFAULT_VIDEO_RESOLUTION;
  const exact = supported.find((r) => r.toUpperCase() === requested);
  if (exact) return exact;
  const requestedIndex = RESOLUTION_TIERS.indexOf(requested);
  if (requestedIndex < 0) return DEFAULT_VIDEO_RESOLUTION;
  let best = DEFAULT_VIDEO_RESOLUTION;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of supported) {
    const index = RESOLUTION_TIERS.indexOf(candidate);
    if (index < 0) continue;
    const distance = Math.abs(index - requestedIndex);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  for (const v of values) {
    if (typeof v === 'boolean') return v;
  }
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}
