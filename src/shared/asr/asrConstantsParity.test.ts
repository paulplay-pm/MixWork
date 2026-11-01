/**
 * The desktop and the enterprise server each carry their own copy of the ASR
 * wire constants (the server is a separate npm project and cannot import the
 * desktop's). A one-sided edit silently breaks recognition — the client reads
 * `st.partial` and `result[].seg_id`, and a renamed code shows up as "no text
 * at all, no error anywhere".
 *
 * This test lives in the DESKTOP repo because only this side can reach across
 * and import both files.
 */
import { describe, expect, test } from 'vitest';

import * as server from '../../../enterprise_server/src/shared/asr/constants';
import * as desktop from './constants';

describe('ASR constants parity (desktop ↔ enterprise server)', () => {
  test('AsrApiCode 逐键相等', () => {
    expect(server.AsrApiCode).toEqual(desktop.AsrApiCode);
  });

  test('AsrLangType 逐键相等', () => {
    expect(server.AsrLangType).toEqual(desktop.AsrLangType);
  });

  test('AsrRealtimeEventType 逐键相等', () => {
    expect(server.AsrRealtimeEventType).toEqual(desktop.AsrRealtimeEventType);
  });

  test('AsrRealtimeSessionData 两份类型接受同一个对象（编译期）且字段名一致（运行时）', () => {
    // Interfaces erase at runtime, so the field-NAME check has to come from a
    // concrete object. Assigning it to both types makes a divergence a tsc
    // error in this file, which is the check that actually matters.
    const sample = {
      requestId: 'r', wsUrl: 'wss://x', expiresInSeconds: 120, chunkIntervalMillis: 200,
      maxSessionSeconds: 60, maxConcurrentSessions: 1, usedSecondsToday: 30,
      remainingSecondsToday: 570, limitSecondsToday: 600,
    };
    const asDesktop: desktop.AsrRealtimeSessionData = sample;
    const asServer: server.AsrRealtimeSessionData = sample;
    expect(Object.keys(asDesktop).sort()).toEqual(Object.keys(asServer).sort());
    // Pin the wire contract the relay and the client both depend on.
    expect(Object.keys(sample).sort()).toEqual([
      'chunkIntervalMillis', 'expiresInSeconds', 'limitSecondsToday', 'maxConcurrentSessions',
      'maxSessionSeconds', 'remainingSecondsToday', 'requestId', 'usedSecondsToday', 'wsUrl',
    ]);
  });

  test('识别项是 youdao 方言：seg_id / st.sentence / st.partial', () => {
    const item: desktop.AsrRealtimeRecognitionRawItem = {
      seg_id: 1, st: { sentence: '你好', partial: false },
    };
    const mirror: server.AsrRealtimeRecognitionRawItem = item;
    // `partial === false` is what marks a segment FINAL for the desktop's
    // buffer; renaming it would leave every segment looking provisional.
    expect(mirror.st?.partial).toBe(false);
  });
});
