import { describe, expect, test } from 'vitest';

import { shouldStreamResponse } from '../../src/http/responseStreaming';

const h = (m: Record<string, string>) => ({ get: (n: string) => m[n.toLowerCase()] ?? null });

describe('shouldStreamResponse', () => {
  test('streams text/event-stream', () => {
    expect(shouldStreamResponse(h({ 'content-type': 'text/event-stream; charset=utf-8' }))).toBe(true);
  });

  test('keeps streaming range responses', () => {
    expect(shouldStreamResponse(h({ 'accept-ranges': 'bytes', 'content-type': 'application/zip' }))).toBe(true);
  });

  test('buffers an ordinary json response', () => {
    expect(shouldStreamResponse(h({ 'content-type': 'application/json' }))).toBe(false);
  });
});
