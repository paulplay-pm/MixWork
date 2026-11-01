import { AsrApiCode, type AsrRealtimeRecognitionRawItem } from '../shared/asr/constants';

/**
 * An upstream speech provider resolved down to what an adapter actually needs.
 *
 * Produced by the registry from a `provider_keys` row plus its decrypted key.
 * `protocol` is the adapter registry key (not a vendor), so swapping vendors
 * is a config change; `sampleRate` rides in `config` because the desktop sends
 * PCM16 at a fixed rate and the adapter must agree with it or every frame is
 * noise.
 */
export interface ResolvedAsrConfig {
  id: string;
  protocol: string;
  provider: string;
  endpoint: string | null;
  apiKey: string;
  config: Record<string, unknown>;
  /** Desktop sends PCM16 at this rate (VOICE_INPUT_TARGET_SAMPLE_RATE). */
  sampleRate: number;
}

/**
 * A live upstream recognition stream.
 *
 * `send` takes **raw** PCM16 with the WAV header already stripped — the
 * desktop prefixes 44 bytes to its first frame only, and forwarding that to
 * an upstream that expects raw PCM injects a header as if it were audio.
 *
 * `finish` is a separate verb from `close`: the desktop sends a text
 * `{"end":"true"}` control frame and then waits for trailing recognition, so
 * "stop feeding me audio" and "hang up" are different events and collapsing
 * them truncates the last few words.
 *
 * `recognition` payloads are ALREADY in the desktop's youdao envelope
 * (`result[].seg_id`, `result[].st.sentence`, `result[].st.partial`). The
 * adapter owns that translation because vendor knowledge lives here, not in
 * the relay: relaying a vendor's native `transcript.delta` shape would render
 * nothing at all with no error anywhere.
 */
export interface AsrStream {
  send(pcmRaw: Buffer): void;
  finish(): void;
  close(): void;
  on(event: 'recognition', cb: (envelope: AsrRecognitionEnvelope) => void): void;
  on(event: 'closed', cb: () => void): void;
  on(event: 'error', cb: (code: AsrApiCode | number, message?: string) => void): void;
}

/**
 * The recognition envelope the DESKTOP actually reads.
 *
 * Not `unknown`: the client checks `message.type === 'recognition'` AND reads
 * `message.raw.result[]` (`realtimeAsrClient.ts`), while the server's prose
 * elsewhere says "result[]". Filling a vendor's events into the wrong shape
 * connects cleanly, reports no error, and renders no text at all — so the
 * shape is pinned here instead of being left to the adapter author.
 */
export interface AsrRecognitionEnvelope {
  type: 'recognition';
  raw: {
    result: AsrRealtimeRecognitionRawItem[];
  };
}

export interface AsrProvider {
  /**
   * The container the desktop's first frame arrives in.
   *
   * `wav` means the 44-byte header is the CONTAINER and must be KEPT — the
   * upstream decodes WAV, so stripping it sends a header to something that
   * expects raw PCM. `raw-pcm` means it must be stripped, or the upstream
   * decodes the header as if it were audio and the quota is a frame short.
   *
   * Which one applies is a property of the UPSTREAM, not of the client, so it
   * lives on the adapter.
   */
  readonly container: 'wav' | 'raw-pcm';
  openStream(cfg: ResolvedAsrConfig, params: { langType: string }): Promise<AsrStream>;
}