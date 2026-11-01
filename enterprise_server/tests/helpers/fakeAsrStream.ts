import type { AsrRecognitionEnvelope, AsrStream } from '../../src/asr/types';
import { AsrApiCode } from '../../src/shared/asr/constants';

/**
 * A test double for an upstream ASR stream.
 *
 * It lives in the test tree rather than beside the real adapter: it is a
 * harness, not a shipped capability, and keeping it out of `src/` stops
 * someone from registering it as a provider by accident.
 */
export class FakeAsrStream implements AsrStream {
  readonly received: Buffer[] = [];
  finished = false;
  closed = false;
  private listeners: {
    recognition: Array<(envelope: AsrRecognitionEnvelope) => void>;
    closed: Array<() => void>;
    error: Array<(code: number, message?: string) => void>;
  } = { recognition: [], closed: [], error: [] };

  send(pcmRaw: Buffer): void {
    this.received.push(Buffer.from(pcmRaw));
  }

  finish(): void {
    this.finished = true;
  }

  close(): void {
    this.closed = true;
    for (const cb of this.listeners.closed) cb();
  }

  on(event: 'recognition', cb: (envelope: AsrRecognitionEnvelope) => void): void;
  on(event: 'closed', cb: () => void): void;
  on(event: 'error', cb: (code: number, message?: string) => void): void;
  on(event: keyof FakeAsrStream['listeners'], cb: never): void {
    (this.listeners[event] as unknown as Array<(a?: unknown) => void>).push(cb as never);
  }

  /** Emit a recognition already shaped as the envelope the client reads. */
  emitRecognition(envelope: AsrRecognitionEnvelope): void {
    for (const cb of this.listeners.recognition) cb(envelope);
  }

  /** The shorthand form: one segment, with the finality flag the client uses. */
  emitSegment(segId: number, sentence: string, partial: boolean): void {
    this.emitRecognition({
      type: 'recognition',
      raw: { result: [{ seg_id: segId, st: { sentence, partial } }] },
    });
  }

  emitError(code: AsrApiCode | number, message?: string): void {
    for (const cb of this.listeners.error) cb(code, message);
  }
}
