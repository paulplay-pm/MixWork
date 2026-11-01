import { AsrApiCode } from '../../shared/asr/constants';
import type {
  AsrProvider,
  AsrRecognitionEnvelope,
  AsrStream,
  ResolvedAsrConfig,
} from '../types';

/**
 * MiniMax realtime ASR (model `asr-1.0`).
 *
 * API: `POST {base}/v1/speech_to_text`, multipart/form-data with
 * `model`, `stream=true` and a `file` part; the response is
 * `text/event-stream` whose lines are `data: {"index":0,"delta":"…",
 * "finish":false}` with a final `finish:true` event that also carries
 * `duration`. Auth is `Authorization: Bearer <key>`; an optional `language`
 * header takes a BCP-47 tag.
 *
 * TWO SHAPES OF THE PROBLEM, AND BOTH ARE THE UPSTREAM'S, NOT OURS:
 *
 *  1. **Minimax takes a FILE, not a live PCM socket.** So "streaming" here
 *     means pseudo-streaming: segment the audio yourself (their docs say to
 *     do it with VAD) and send each utterance as its own request. The
 *     server therefore runs an energy VAD over the incoming PCM and posts a
 *     segment as soon as it hears a pause. The desktop sees a continuous
 *     transcript, because the client's buffer concatenates segments by id.
 *
 *  2. **The desktop's first frame carries a 44-byte WAV header** and the rest
 *     is bare PCM16. Minimax decodes WAV, so the header is the CONTAINER and
 *     must be kept — but each segment we post needs its own valid header
 *     (with that segment's sizes), so the header is rebuilt per segment
 *     rather than copied. Getting this backwards either sends a header to an
 *     upstream expecting raw PCM, or sends PCM with a header describing the
 *     wrong length.
 */
const DEFAULT_ASR_MODEL = 'asr-1.0';
const DEFAULT_BASE_URL = 'https://api.minimax.cn';

/** The desktop's `langType` is youdao's vocabulary; Minimax takes BCP-47. */
const LANGUAGE_BY_LANG_TYPE: Record<string, string> = {
  'zh-CHS': 'zh',
  'zh-CHT': 'zh',
  en: 'en',
  ja: 'ja',
  ko: 'ko',
};

/** Energy VAD. Deliberately simple: a frame of 20ms whose RMS is below the
 *  noise floor counts as silence, and a run of silent frames closes the
 *  utterance. */
const VAD_FRAME_MS = 20;
const SILENCE_TO_CLOSE_MS = 600;
const MIN_SEGMENT_MS = 300;

/** Below this RMS (0..1) a frame counts as silence. PCM16 samples are
 *  normalised by 32768. */
const NOISE_FLOOR = 0.012;

interface VadState {
  frameSamples: number;
  silentMs: number;
  speechMs: number;
  segmentStart: number;
}

export class MinimaxAsrProvider implements AsrProvider {
  /**
   * The desktop's stream IS a WAV file (44-byte header, then PCM16). Minimax
   * decodes WAV, so the header stays — the relay must not strip it.
   */
  readonly container = 'wav' as const;

  async openStream(cfg: ResolvedAsrConfig, params: { langType: string }): Promise<AsrStream> {
    return new MinimaxAsrStream(cfg, params);
  }
}

type Listener = {
  recognition: Array<(envelope: AsrRecognitionEnvelope) => void>;
  closed: Array<() => void>;
  error: Array<(code: number, message?: string) => void>;
};

export class MinimaxAsrStream implements AsrStream {
  private readonly listeners: Listener = { recognition: [], closed: [], error: [] };
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly language: string | undefined;
  private readonly apiKey: string;

  /** Everything received since the last posted segment, header included. */
  private buffer: Buffer = Buffer.alloc(0);
  private header: Buffer | null = null;
  private vad: VadState = { frameSamples: 0, silentMs: 0, speechMs: 0, segmentStart: 0 };
  /** Bytes of the current segment, header excluded. */
  private segmentPcm: Buffer = Buffer.alloc(0);
  private postedAny = false;
  private lastFinalEnvelope: { segId: number; sentence: string } | null = null;
  private segCounter = 0;
  private closed = false;

  constructor(cfg: ResolvedAsrConfig, params: { langType: string }) {
    this.baseUrl = (cfg.endpoint ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.model = typeof cfg.config.model === 'string' ? cfg.config.model : DEFAULT_ASR_MODEL;
    this.language = LANGUAGE_BY_LANG_TYPE[params.langType];
    this.apiKey = cfg.apiKey;
  }

  on(event: 'recognition', cb: (envelope: AsrRecognitionEnvelope) => void): void;
  on(event: 'closed', cb: () => void): void;
  on(event: 'error', cb: (code: number, message?: string) => void): void;
  on(event: keyof Listener, cb: never): void {
    (this.listeners[event] as unknown as Array<(a?: unknown) => void>).push(cb as never);
  }

  send(chunk: Buffer): void {
    if (this.closed) return;
    if (!this.header && chunk.length >= 44 && chunk.subarray(0, 4).toString('ascii') === 'RIFF') {
      this.header = chunk.subarray(0, 44);
      this.segmentPcm = Buffer.concat([this.segmentPcm, chunk.subarray(44)]);
    } else {
      this.segmentPcm = Buffer.concat([this.segmentPcm, chunk]);
    }
    this.runVad(chunk);
  }

  finish(): void {
    if (this.closed) return;
    void this.flush(true);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.listeners.closed) cb();
  }

  // --- VAD -------------------------------------------------------------

  private runVad(chunk: Buffer): void {
    const bytesPerSample = 2;
    const samplesPerFrame = Math.floor((VAD_FRAME_MS / 1000) * this.sampleRate());
    let offset = 0;
    while (offset + samplesPerFrame * bytesPerSample <= chunk.length) {
      const frame = chunk.subarray(offset, offset + samplesPerFrame * bytesPerSample);
      offset += samplesPerFrame * bytesPerSample;
      let sum = 0;
      for (let i = 0; i + 1 < frame.length; i += 2) {
        const sample = frame.readInt16LE(i) / 32768;
        sum += sample * sample;
      }
      const rms = Math.sqrt(sum / Math.max(1, samplesPerFrame));
      if (rms < NOISE_FLOOR) {
        this.vad.silentMs += VAD_FRAME_MS;
      } else {
        this.vad.silentMs = 0;
        this.vad.speechMs += VAD_FRAME_MS;
      }
      if (this.vad.silentMs >= SILENCE_TO_CLOSE_MS && this.vad.speechMs >= MIN_SEGMENT_MS) {
        this.vad = { frameSamples: 0, silentMs: 0, speechMs: 0, segmentStart: 0 };
        void this.flush(false);
      }
    }
  }

  private sampleRate(): number {
    const rate = this.header?.readUInt32LE(24);
    return rate && rate > 0 ? rate : 16000;
  }

  // --- Posting ---------------------------------------------------------

  /** Post the pending segment. `final` marks the utterance's end, which is
   *  what tells the CLIENT the transcript is complete. */
  private async flush(final: boolean): Promise<void> {
    const pcm = this.segmentPcm;
    this.segmentPcm = Buffer.alloc(0);
    if (pcm.length === 0) {
      if (final) this.emitSyntheticFinal();
      return;
    }

    const wav = this.buildWav(pcm);
    try {
      await this.postSegment(wav, final);
    } catch (error) {
      this.closed = true;
      for (const cb of this.listeners.error) {
        cb(
          error instanceof MinimaxUpstreamError ? error.code : AsrApiCode.UpstreamError,
          error instanceof Error ? error.message : 'upstream request failed',
        );
      }
    }
  }

  /** A WAV container for one segment: the desktop's header with the sizes
   *  rewritten to describe THIS segment. */
  private buildWav(pcm: Buffer): Buffer {
    const header = this.header ? Buffer.from(this.header) : Buffer.alloc(44);
    if (header.length < 44) {
      const fresh = Buffer.alloc(44);
      fresh.write('RIFF', 0, 'ascii');
      fresh.writeUInt32LE(36 + pcm.length, 4);
      fresh.write('WAVE', 8, 'ascii');
      fresh.write('fmt ', 12, 'ascii');
      fresh.writeUInt32LE(16, 16);
      fresh.writeUInt16LE(1, 20);
      fresh.writeUInt16LE(1, 22);
      fresh.writeUInt32LE(this.sampleRate(), 24);
      fresh.writeUInt32LE(this.sampleRate() * 2, 28);
      fresh.writeUInt16LE(2, 32);
      fresh.writeUInt16LE(16, 34);
      fresh.write('data', 36, 'ascii');
      fresh.writeUInt32LE(pcm.length, 40);
      return Buffer.concat([fresh, pcm]);
    }
    header.writeUInt32LE(36 + pcm.length, 4);
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
  }

  private async postSegment(wav: Buffer, final: boolean): Promise<void> {
    const boundary = `----mixcwork${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const parts: Buffer[] = [];
    const field = (name: string, value: string): void => {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
          'utf8',
        ),
      );
    };
    field('model', this.model);
    field('stream', 'true');
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
        'utf8',
      ),
    );
    parts.push(wav);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
    const body = Buffer.concat(parts);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length),
    };
    if (this.language) headers.language = this.language;

    const resp = await fetch(`${this.baseUrl}/v1/speech_to_text`, { method: 'POST', headers, body });
    if (!resp.ok) {
      throw await minimaxErrorFromResponse(resp);
    }
    if (!resp.body) {
      throw new MinimaxUpstreamError(AsrApiCode.UpstreamError, 'empty upstream response');
    }

    // Server-sent events: `data: {json}` lines.
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let event: { index?: number; delta?: string; finish?: boolean; duration?: number };
        try {
          event = JSON.parse(payload) as typeof event;
        } catch {
          continue;
        }
        this.emitRecognition(event, final);
      }
    }
  }

  /** Translate one Minimax SSE event into the desktop's youdao envelope.
   *
   *  The desktop's buffer keys segments by `seg_id` and joins them in id
   *  order, which is exactly Minimax's instruction ("按 index 顺序拼接所有
   *  delta") — so the index becomes the segment id and the delta becomes the
   *  segment text.
   *
   *  `partial` is the desktop's FINALITY signal: it finalizes the transcript
   *  on the first event with `partial === false`. A segment that is complete
   *  is not the utterance, so an intermediate segment's closing event is
   *  emitted with `partial: true` and the last one with `partial: false`.
   */
  private emitRecognition(
    event: { index?: number; delta?: string; finish?: boolean },
    final: boolean,
  ): void {
    const segId = typeof event.index === 'number' ? event.index : this.segCounter++;
    const sentence = typeof event.delta === 'string' ? event.delta : '';
    const isFinal = final && event.finish === true;
    if (event.finish === true) {
      this.lastFinalEnvelope = { segId, sentence };
    }
    this.emit({
      type: 'recognition',
      raw: { result: [{ seg_id: segId, st: { sentence, partial: !isFinal } }] },
    });
  }

  private emitSyntheticFinal(): void {
    // Nothing was ever posted (a click too short to segment). The client still
    // needs a final event, or it waits out its final-wait timer and reports an
    // empty transcript as a failure.
    const segId = this.lastFinalEnvelope?.segId ?? 0;
    const sentence = this.lastFinalEnvelope?.sentence ?? '';
    this.emit({
      type: 'recognition',
      raw: { result: [{ seg_id: segId, st: { sentence, partial: false } }] },
    });
  }

  private emit(envelope: AsrRecognitionEnvelope): void {
    for (const cb of this.listeners.recognition) cb(envelope);
  }
}

export class MinimaxUpstreamError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'MinimaxUpstreamError';
  }
}

/** Map a Minimax HTTP failure onto the ASR error codes the client renders.
 *  Minimax's own vocabulary: authorized_error(401), rate_limit_error(429),
 *  insufficient_balance_error(402), bad_request_error(400),
 *  unprocessable_entity_error(422), invalid_request_error(413),
 *  server_error(500). */
async function minimaxErrorFromResponse(resp: Response): Promise<MinimaxUpstreamError> {
  let detail = '';
  let type = '';
  try {
    const body = (await resp.json()) as {
      error?: { type?: string; message?: string; http_code?: string };
      base_resp?: { status_code?: number; status_msg?: string };
    };
    detail = body.error?.message ?? body.base_resp?.status_msg ?? '';
    type = body.error?.type ?? '';
  } catch {
    detail = resp.statusText;
  }
  const code = ((): number => {
    if (resp.status === 401 || type.includes('authorized')) return AsrApiCode.UpstreamAuthFailed;
    if (resp.status === 429 || type.includes('rate_limit')) return AsrApiCode.UpstreamRateLimited;
    if (resp.status === 402 || type.includes('insufficient_balance')) {
      return AsrApiCode.UpstreamBalanceInsufficient;
    }
    if (resp.status === 413) return AsrApiCode.AudioTooLarge;
    if (resp.status === 400 || resp.status === 422) return AsrApiCode.UpstreamInvalidParams;
    return AsrApiCode.UpstreamError;
  })();
  return new MinimaxUpstreamError(code, detail || `upstream HTTP ${resp.status}`);
}
