import { describe, expect, test } from 'vitest';

import { MinimaxAsrProvider } from '../../src/asr/providers/minimax';
import { asrProtocols, getAsrProvider, hasAsrProvider } from '../../src/asr/registry';
import { FakeAsrStream } from '../helpers/fakeAsrStream';

describe('asr adapter registry', () => {
  test('realtime-asr 解析到 Minimax adapter', () => {
    expect(getAsrProvider('realtime-asr')).toBeInstanceOf(MinimaxAsrProvider);
    expect(hasAsrProvider('realtime-asr')).toBe(true);
    expect(asrProtocols()).toContain('realtime-asr');
  });

  test('未知/缺失 protocol 解析不到（调用方据此回 ConfigInvalid）', () => {
    expect(getAsrProvider('nope')).toBeUndefined();
    expect(getAsrProvider(null)).toBeUndefined();
    expect(getAsrProvider(undefined)).toBeUndefined();
    expect(hasAsrProvider('openai')).toBe(false);
  });

  test('Minimax adapter 声明它要 WAV 容器（桌面端首帧的 44 字节头是容器，不能剥）', () => {
    expect(new MinimaxAsrProvider().container).toBe('wav');
  });
});

describe('FakeAsrStream', () => {
  test('记录 send 的裸 PCM、finish、close', () => {
    const s = new FakeAsrStream();
    s.send(Buffer.from([1, 2, 3]));
    s.send(Buffer.from([4, 5]));
    s.finish();
    s.close();
    expect(s.received).toHaveLength(2);
    expect(s.received[0]).toEqual(Buffer.from([1, 2, 3]));
    expect(s.finished).toBe(true);
    expect(s.closed).toBe(true);
  });

  test('recognition / error 事件可被订阅并触发', () => {
    const s = new FakeAsrStream();
    const seen: unknown[] = [];
    const errs: Array<[unknown, string | undefined]> = [];
    s.on('recognition', (e) => seen.push(e));
    s.on('error', (c, m) => errs.push([c, m]));
    s.emitRecognition({
      type: 'recognition',
      raw: { result: [{ st: { sentence: '你好', partial: false } }] },
    });
    s.emitError(41405, 'upstream auth failed');
    expect(seen).toHaveLength(1);
    expect(errs[0][1]).toBe('upstream auth failed');
  });
});
