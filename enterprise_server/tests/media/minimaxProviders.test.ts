import { describe, expect, test, vi } from 'vitest';

import {
  MinimaxAsrProvider,
  MinimaxAsrStream,
} from '../../src/asr/providers/minimax';
import {
  MinimaxImageProvider,
  MinimaxVideoProvider,
} from '../../src/media/providers/minimax';
import { AsrApiCode } from '../../src/shared/asr/constants';

const CFG = {
  id: 'pk1', protocol: 'realtime-asr', provider: 'minimax',
  endpoint: 'https://api.minimax.test', apiKey: 'sk-test', config: {}, sampleRate: 16000,
};

function wavHeader(pcmBytes = 0): Buffer {
  const h = Buffer.alloc(44, 0);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + pcmBytes, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(pcmBytes, 40);
  return h;
}

describe('minimax ASR adapter', () => {
  test('声明 WAV 容器（桌面端首帧的头不能剥）', () => {
    expect(new MinimaxAsrProvider().container).toBe('wav');
  });

  test('SSE 事件被翻译成桌面端读的信封：raw.result[].st.sentence + seg_id', async () => {
    const fetchMock = vi.fn<[string, RequestInit], Promise<Response>>(async () => {
      const sse =
        'data: {"index":0,"delta":"你好","finish":false}\n' +
        'data: {"index":1,"delta":"世界","finish":false}\n' +
        'data: {"index":2,"delta":"","finish":true,"duration":1.5}\n';
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const stream = new MinimaxAsrStream(CFG, { langType: 'zh-CHS' });
    const events: unknown[] = [];
    stream.on('recognition', (e) => events.push(e));

    // One second of PCM after the header.
    stream.send(Buffer.concat([wavHeader(32000), Buffer.alloc(32000, 1)]));
    // The VAD needs a pause to close a segment; force it by finishing.
    stream.finish();
    await new Promise((r) => setTimeout(r, 50));

    expect(events.length).toBeGreaterThan(0);
    const last = events[events.length - 1] as {
      type: string;
      raw: { result: Array<{ seg_id: number; st: { sentence: string; partial: boolean } }> };
    };
    expect(last.type).toBe('recognition');
    // The client reads raw.result[].st.sentence and keys on seg_id.
    expect(last.raw.result[0]).toHaveProperty('seg_id');
    expect(last.raw.result[0].st).toHaveProperty('sentence');
    // And it finalises on partial === false.
    expect(last.raw.result[0].st.partial).toBe(false);

    const body = fetchMock.mock.calls[0]?.[1] as { body: Buffer; headers: Record<string, string> };
    expect(body.headers.Authorization).toBe('Bearer sk-test');
    expect(body.headers['Content-Type']).toContain('multipart/form-data');
    expect(body.headers.language).toBe('zh');  // BCP-47, not youdao's zh-CHS
    const text = body.body.toString('latin1');
    expect(text).toContain('name="model"');
    expect(text).toContain('asr-1.0');
    expect(text).toContain('name="stream"');
    expect(text).toContain('filename="audio.wav"');
    vi.unstubAllGlobals();
  });

  test('上游 401 → UpstreamAuthFailed；429 → UpstreamRateLimited；402 → 余额不足', async () => {
    for (const [status, expected] of [
      [401, AsrApiCode.UpstreamAuthFailed],
      [429, AsrApiCode.UpstreamRateLimited],
      [402, AsrApiCode.UpstreamBalanceInsufficient],
    ] as const) {
      vi.stubGlobal(
        'fetch',
        vi.fn<[string, RequestInit], Promise<Response>>(async () => new Response(JSON.stringify({ error: { type: 'x' } }), { status })),
      );
      const stream = new MinimaxAsrStream(CFG, { langType: 'zh-CHS' });
      const errs: Array<[number, string | undefined]> = [];
      stream.on('error', (code, message) => errs.push([code, message]));
      stream.send(Buffer.concat([wavHeader(32000), Buffer.alloc(32000, 1)]));
      stream.finish();
      await new Promise((r) => setTimeout(r, 50));
      expect(errs.length).toBeGreaterThan(0);
      expect(errs[0][0]).toBe(expected);
    }
    vi.unstubAllGlobals();
  });
});

describe('minimax image adapter', () => {
  test('同步：POST /v1/image_generation，response_format=url，取 data.image_urls', async () => {
    const fetchMock = vi.fn<[string, RequestInit], Promise<Response>>(async () =>
      new Response(JSON.stringify({ data: { image_urls: ['https://cdn/x.png'] } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new MinimaxImageProvider();
    expect(provider.synchronous).toBe(true);
    const result = await provider.submit(
      { ...CFG, protocol: 'image-gen', config: { model: 'image-01' } },
      { model: 'image-01', type: 'image', prompt: 'a cat', params: { aspect_ratio: '16:9' } },
    );
    expect(result.immediateResult?.resultUrls).toEqual(['https://cdn/x.png']);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.minimax.test/v1/image_generation');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: 'image-01',
      prompt: 'a cat',
      aspect_ratio: '16:9',
      response_format: 'url',
    });
    vi.unstubAllGlobals();
  });
});

describe('minimax video adapter', () => {
  test('异步：POST /v2/video_generation 返回 task_id', async () => {
    const fetchMock = vi.fn<[string, RequestInit], Promise<Response>>(async () => new Response(JSON.stringify({ task_id: 'task-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new MinimaxVideoProvider();
    expect(provider.synchronous).toBe(false);
    const result = await provider.submit(
      { ...CFG, protocol: 'video-gen', config: { model: 'MiniMax-H3' } },
      { model: 'MiniMax-H3', type: 't2v', prompt: 'a cat', params: { duration: 5, resolution: '2K' } },
    );
    expect(result.upstreamTaskId).toBe('task-1');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.minimax.test/v2/video_generation');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('MiniMax-H3');
    expect(body.content[0]).toEqual({ type: 'text', text: 'a cat' });
    expect(body.duration).toBe(5);
    vi.unstubAllGlobals();
  });

  test('i2v：首帧图进 content[] 且 role=first_frame', async () => {
    const fetchMock = vi.fn<[string, RequestInit], Promise<Response>>(async () => new Response(JSON.stringify({ task_id: 't' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await new MinimaxVideoProvider().submit(
      { ...CFG, protocol: 'video-gen', config: {} },
      { model: 'MiniMax-H3', type: 'i2v', prompt: 'move', params: { firstFrame: 'https://cdn/f.png' } },
    );
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'https://cdn/f.png' },
      role: 'first_frame',
    });
    vi.unstubAllGlobals();
  });

  test('轮询：GET /v2/query/... 映射状态与结果 URL', async () => {
    const fetchMock = vi.fn<[string, RequestInit], Promise<Response>>(async () =>
      new Response(JSON.stringify({ task: { status: 'Success', content: { url: 'https://cdn/v.mp4' } } }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await new MinimaxVideoProvider().poll(
      { ...CFG, protocol: 'video-gen', config: {} },
      'task-1',
    );
    expect(result.status).toBe('succeeded');
    expect(result.resultUrls).toEqual(['https://cdn/v.mp4']);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.minimax.test/v2/query/video_generation/task-1',
    );
    vi.unstubAllGlobals();
  });

  /**
   * The status vocabulary is NOT stable across Minimax API versions: the same
   * task came back as `Success` from one call and `succeeded` from the next.
   *
   * 'succeeded'.includes('success') is FALSE — it is 'succee' + 'ded' — so a
   * substring test maps a FINISHED task to 'running'. The server then polled
   * it every five seconds until the task expired, and the user never got
   * their video even though Minimax had rendered it.
   */
  test('轮询：上游返回 succeeded（过去式）也映射成 succeeded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<[string, RequestInit], Promise<Response>>(async () =>
        new Response(JSON.stringify({ task: { status: 'succeeded', content: { url: 'https://cdn/v.mp4' } } }), {
          status: 200,
        }),
      ),
    );
    const result = await new MinimaxVideoProvider().poll(
      { ...CFG, protocol: 'video-gen', config: {} },
      'task-1',
    );
    expect(result.status).toBe('succeeded');
    expect(result.resultUrls).toEqual(['https://cdn/v.mp4']);
    vi.unstubAllGlobals();
  });

  test('轮询：上游状态的各种拼写都映射到桌面端的终态集合', async () => {
    const cases: Array<[string, string]> = [
      ['Success', 'succeeded'],
      ['succeeded', 'succeeded'],
      ['success', 'succeeded'],
      ['Completed', 'succeeded'],
      ['Fail', 'failed'],
      ['failed', 'failed'],
      ['Cancelled', 'cancelled'],
      ['Queueing', 'queued'],
      ['Preparing', 'queued'],
      ['Processing', 'running'],
    ];
    for (const [raw, expected] of cases) {
      vi.stubGlobal(
        'fetch',
        vi.fn<[string, RequestInit], Promise<Response>>(async () =>
          new Response(JSON.stringify({ task: { status: raw } }), { status: 200 }),
        ),
      );
      const result = await new MinimaxVideoProvider().poll(
        { ...CFG, protocol: 'video-gen', config: {} },
        'task-1',
      );
      expect(result.status, `status=${raw}`).toBe(expected);
      vi.unstubAllGlobals();
    }
  });

  test('轮询失败态带错误文案', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<[string, RequestInit], Promise<Response>>(async () =>
        new Response(JSON.stringify({ task: { status: 'Failed', error: 'upstream boom' } }), {
          status: 200,
        }),
      ),
    );
    const result = await new MinimaxVideoProvider().poll(
      { ...CFG, protocol: 'video-gen', config: {} },
      'task-1',
    );
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toBe('upstream boom');
    vi.unstubAllGlobals();
  });
});

describe('minimax 的 200-带错误信封', () => {
  // Minimax 的 /v1/image_generation 在鉴权失败时返回 HTTP 200 和
  // { base_resp: { status_code: 1004, status_msg: 'login fail: …' } }，
  // 响应里根本没有 data。只看 resp.ok 会把每一次失败的生成当成"成功但没有
  // 图片"——桌面端于是显示一张空图，而不是错误。
  test('图片：base_resp.status_code 非 0 → 抛错，不能当成成功', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<[string, RequestInit], Promise<Response>>(async () =>
        new Response(
          JSON.stringify({
            base_resp: { status_code: 1004, status_msg: 'login fail: Please carry the API secret key' },
          }),
          { status: 200 },
        ),
      ),
    );
    await expect(
      new MinimaxImageProvider().submit(
        { ...CFG, protocol: 'image-gen', config: { model: 'image-01' } },
        { model: 'image-01', type: 'image', prompt: 'a cat', params: {} },
      ),
    ).rejects.toThrow(/login fail/);
    vi.unstubAllGlobals();
  });

  test('图片：base_resp.status_code = 0 → 正常取 image_urls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<[string, RequestInit], Promise<Response>>(async () =>
        new Response(
          JSON.stringify({
            base_resp: { status_code: 0, status_msg: 'success' },
            data: { image_urls: ['https://cdn/x.png'] },
          }),
          { status: 200 },
        ),
      ),
    );
    const result = await new MinimaxImageProvider().submit(
      { ...CFG, protocol: 'image-gen', config: { model: 'image-01' } },
      { model: 'image-01', type: 'image', prompt: 'a cat', params: {} },
    );
    expect(result.immediateResult?.resultUrls).toEqual(['https://cdn/x.png']);
    vi.unstubAllGlobals();
  });

  test('视频：base_resp.status_code 非 0 → 抛错', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<[string, RequestInit], Promise<Response>>(async () =>
        new Response(
          JSON.stringify({ base_resp: { status_code: 1004, status_msg: 'login fail: bad key' } }),
          { status: 200 },
        ),
      ),
    );
    await expect(
      new MinimaxVideoProvider().submit(
        { ...CFG, protocol: 'video-gen', config: { model: 'MiniMax-H3' } },
        { model: 'MiniMax-H3', type: 't2v', prompt: 'a cat', params: {} },
      ),
    ).rejects.toThrow(/login fail/);
    vi.unstubAllGlobals();
  });

  test('轮询：base_resp.status_code 非 0 → 判为 failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<[string, RequestInit], Promise<Response>>(async () =>
        new Response(
          JSON.stringify({ base_resp: { status_code: 1004, status_msg: 'login fail: bad key' } }),
          { status: 200 },
        ),
      ),
    );
    const result = await new MinimaxVideoProvider().poll(
      { ...CFG, protocol: 'video-gen', config: {} },
      'task-1',
    );
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toMatch(/login fail/);
    vi.unstubAllGlobals();
  });
});

/**
 * The desktop's media tools speak their OWN parameter vocabulary
 * (`aspectRatio`, `durationSeconds`, `resolution`, `n`/`count`, `size`,
 * `imageSize`, `firstFrame`/`lastFrame`, `images`+`imageRoles`,
 * `videos`+`videoRoles`, `media`), and the server hands that bag to the
 * adapter verbatim. The adapter is the translation layer, so it has to
 * accept the DESKTOP's names — reading Minimax's own names (`duration`,
 * `ratio`) silently dropped a field Minimax REQUIRES, and the call 400'd.
 */
describe('minimax adapter：把桌面端的参数词汇翻译成 Minimax 的字段', () => {
  test('图片：aspectRatio → aspect_ratio，n/count → n，size → width/height', async () => {
    const fetchMock = vi.fn<[string, RequestInit], Promise<Response>>(async () =>
      new Response(JSON.stringify({ data: { image_urls: ['https://cdn/x.png'] } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new MinimaxImageProvider().submit(
      { ...CFG, protocol: 'image-gen', config: {} },
      {
        model: 'image-01',
        type: 'image',
        prompt: 'a cat',
        params: { aspectRatio: '16:9', count: 2, size: '1024x1024' },
      },
    );
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.aspect_ratio).toBe('16:9');
    expect(body.n).toBe(2);
    expect(body.width).toBe(1024);
    expect(body.height).toBe(1024);
    vi.unstubAllGlobals();
  });

  test('图片：参考图（images）翻译成 subject_reference', async () => {
    const fetchMock = vi.fn<[string, RequestInit], Promise<Response>>(async () =>
      new Response(JSON.stringify({ data: { image_urls: ['https://cdn/x.png'] } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new MinimaxImageProvider().submit(
      { ...CFG, protocol: 'image-gen', config: {} },
      {
        model: 'image-01',
        type: 'image',
        prompt: 'a cat',
        params: { images: ['https://cdn/ref.png'] },
      },
    );
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.subject_reference).toEqual([
      { type: 'character', image_file: 'https://cdn/ref.png' },
    ]);
    vi.unstubAllGlobals();
  });

  test('图片：imageSize 的预设换算成宽高（超出 Minimax 上限则不发送）', async () => {
    const fetchMock = vi.fn<[string, RequestInit], Promise<Response>>(async () =>
      new Response(JSON.stringify({ data: { image_urls: [] } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new MinimaxImageProvider().submit(
      { ...CFG, protocol: 'image-gen', config: {} },
      { model: 'image-01', type: 'image', prompt: 'a cat', params: { imageSize: '2K' } },
    );
    let body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.width).toBe(2048);
    expect(body.height).toBe(2048);

    await new MinimaxImageProvider().submit(
      { ...CFG, protocol: 'image-gen', config: {} },
      { model: 'image-01', type: 'image', prompt: 'a cat', params: { imageSize: '4K' } },
    );
    body = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string);
    // 4096 超出 [512,2048]，Minimax 会 400，所以宁可不发。
    expect(body.width).toBeUndefined();
    expect(body.height).toBeUndefined();
    vi.unstubAllGlobals();
  });

  test('视频：durationSeconds → duration，aspectRatio → ratio，resolution 大小写归一', async () => {
    const fetchMock = vi.fn<[string, RequestInit], Promise<Response>>(async () =>
      new Response(JSON.stringify({ task_id: 'task-1' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    // MiniMax-H3-Lite 支持 480P，所以大小写归一后原样保留。
    await new MinimaxVideoProvider().submit(
      { ...CFG, protocol: 'video-gen', config: {} },
      {
        model: 'MiniMax-H3-Lite',
        type: 't2v',
        prompt: 'a cat',
        params: { durationSeconds: 8, aspectRatio: '9:16', resolution: '480p' },
      },
    );
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.duration).toBe(8);
    expect(body.ratio).toBe('9:16');
    expect(body.resolution).toBe('480P');
    vi.unstubAllGlobals();
  });

  test('视频：桌面端没给参数时补上 Minimax 必填项（duration/resolution/ratio）', async () => {
    const fetchMock = vi.fn<[string, RequestInit], Promise<Response>>(async () =>
      new Response(JSON.stringify({ task_id: 'task-1' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new MinimaxVideoProvider().submit(
      { ...CFG, protocol: 'video-gen', config: {} },
      { model: 'MiniMax-H3', type: 't2v', prompt: 'a cat', params: {} },
    );
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.duration).toBe(5);
    expect(body.resolution).toBe('768P');
    expect(body.ratio).toBe('16:9');
    vi.unstubAllGlobals();
  });

  test('视频：durationSeconds=-1（自动）落到默认值，且被夹进模型允许的区间', async () => {
    const fetchMock = vi.fn<[string, RequestInit], Promise<Response>>(async () =>
      new Response(JSON.stringify({ task_id: 'task-1' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new MinimaxVideoProvider().submit(
      { ...CFG, protocol: 'video-gen', config: {} },
      { model: 'MiniMax-H3', type: 't2v', prompt: 'a cat', params: { durationSeconds: -1 } },
    );
    let body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.duration).toBe(5);

    // MiniMax-H3-Max 的时长下限是 5 秒，4 秒会被上游拒绝。
    await new MinimaxVideoProvider().submit(
      { ...CFG, protocol: 'video-gen', config: {} },
      { model: 'MiniMax-H3-Max', type: 't2v', prompt: 'a cat', params: { durationSeconds: 4 } },
    );
    body = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string);
    expect(body.duration).toBe(5);
    vi.unstubAllGlobals();
  });

  test('视频：模型不支持的分辨率回落到该模型的默认值', async () => {
    const fetchMock = vi.fn<[string, RequestInit], Promise<Response>>(async () =>
      new Response(JSON.stringify({ task_id: 'task-1' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    // MiniMax-H3-Lite 只有 480P / 768P，2K 会被上游拒绝。
    await new MinimaxVideoProvider().submit(
      { ...CFG, protocol: 'video-gen', config: {} },
      { model: 'MiniMax-H3-Lite', type: 't2v', prompt: 'a cat', params: { resolution: '2K' } },
    );
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.resolution).toBe('768P');
    vi.unstubAllGlobals();
  });

  test('视频：ratio 按模式来（t2v 必须具体比例，i2v/r2v 用 adaptive）', async () => {
    const fetchMock = vi.fn<[string, RequestInit], Promise<Response>>(async () =>
      new Response(JSON.stringify({ task_id: 't' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new MinimaxVideoProvider();
    const bodyOf = (call: number): Record<string, unknown> =>
      JSON.parse((fetchMock.mock.calls[call] as [string, RequestInit])[1].body as string);

    // t2v: ratio 必填，且不能是 adaptive
    await provider.submit(
      { ...CFG, protocol: 'video-gen', config: {} },
      { model: 'MiniMax-H3', type: 't2v', prompt: 'a', params: { aspectRatio: 'adaptive' } },
    );
    expect(bodyOf(0).ratio).toBe('16:9');

    // i2v: 宽高比由输入图决定，恒为 adaptive
    await provider.submit(
      { ...CFG, protocol: 'video-gen', config: {} },
      { model: 'MiniMax-H3', type: 'i2v', prompt: 'a', params: { firstFrame: 'https://cdn/f.png' } },
    );
    expect(bodyOf(1).ratio).toBe('adaptive');

    // r2v: 默认 adaptive，显式指定具体比例时照用
    await provider.submit(
      { ...CFG, protocol: 'video-gen', config: {} },
      { model: 'MiniMax-H3', type: 'r2v', prompt: 'a', params: { referenceImages: ['https://cdn/a.png'] } },
    );
    expect(bodyOf(2).ratio).toBe('adaptive');

    await provider.submit(
      { ...CFG, protocol: 'video-gen', config: {} },
      {
        model: 'MiniMax-H3',
        type: 'r2v',
        prompt: 'a',
        params: { referenceImages: ['https://cdn/a.png'], aspectRatio: '4:3' },
      },
    );
    expect(bodyOf(3).ratio).toBe('4:3');

    // MiniMax-H3-Lite 不支持 adaptive，必须给具体比例
    await provider.submit(
      { ...CFG, protocol: 'video-gen', config: {} },
      { model: 'MiniMax-H3-Lite', type: 'r2v', prompt: 'a', params: { referenceImages: ['https://cdn/a.png'] } },
    );
    expect(bodyOf(4).ratio).toBe('16:9');
    vi.unstubAllGlobals();
  });

  test('视频：文生视频不能传 adaptive（上游会拒绝），回落到 16:9', async () => {
    const fetchMock = vi.fn<[string, RequestInit], Promise<Response>>(async () =>
      new Response(JSON.stringify({ task_id: 'task-1' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new MinimaxVideoProvider().submit(
      { ...CFG, protocol: 'video-gen', config: {} },
      { model: 'MiniMax-H3', type: 't2v', prompt: 'a cat', params: { aspectRatio: 'adaptive' } },
    );
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.ratio).toBe('16:9');
    vi.unstubAllGlobals();
  });

  test('视频：尾帧图进 content[] 且 role=last_frame', async () => {
    const fetchMock = vi.fn<[string, RequestInit], Promise<Response>>(async () =>
      new Response(JSON.stringify({ task_id: 't' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new MinimaxVideoProvider().submit(
      { ...CFG, protocol: 'video-gen', config: {} },
      {
        model: 'MiniMax-H3',
        type: 'i2v',
        prompt: 'grow up',
        params: { firstFrame: 'https://cdn/f.png', lastFrame: 'https://cdn/l.png' },
      },
    );
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'https://cdn/f.png' },
      role: 'first_frame',
    });
    expect(body.content[2]).toEqual({
      type: 'image_url',
      image_url: { url: 'https://cdn/l.png' },
      role: 'last_frame',
    });
    vi.unstubAllGlobals();
  });

  /**
   * i2v and r2v are MUTUALLY EXCLUSIVE upstream: a content array that carries
   * both a `first_frame` and a `reference_image` is rejected with 400. So the
   * adapter keeps the mode's own roles and drops the other mode's entries.
   */
  test('视频：r2v 模式丢掉 first_frame 条目（上游不允许两种模式混用）', async () => {
    const fetchMock = vi.fn<[string, RequestInit], Promise<Response>>(async () =>
      new Response(JSON.stringify({ task_id: 't' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new MinimaxVideoProvider().submit(
      { ...CFG, protocol: 'video-gen', config: {} },
      {
        model: 'MiniMax-H3',
        type: 'r2v',
        prompt: 'dance',
        params: {
          images: ['https://cdn/a.png', 'https://cdn/b.png'],
          imageRoles: ['reference_image', 'first_frame'],
        },
      },
    );
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'https://cdn/a.png' },
      role: 'reference_image',
    });
    expect(body.content[2]).toBeUndefined();
    vi.unstubAllGlobals();
  });

  test('视频：i2v 模式丢掉 reference_image 条目', async () => {
    const fetchMock = vi.fn<[string, RequestInit], Promise<Response>>(async () =>
      new Response(JSON.stringify({ task_id: 't' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new MinimaxVideoProvider().submit(
      { ...CFG, protocol: 'video-gen', config: {} },
      {
        model: 'MiniMax-H3',
        type: 'i2v',
        prompt: 'move',
        params: {
          images: ['https://cdn/a.png', 'https://cdn/b.png'],
          imageRoles: ['reference_image', 'first_frame'],
        },
      },
    );
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'https://cdn/b.png' },
      role: 'first_frame',
    });
    expect(body.content[2]).toBeUndefined();
    vi.unstubAllGlobals();
  });

  test('视频：没有 role 的图片在 i2v 里是首帧，在 r2v 里是参考图', async () => {
    const fetchMock = vi.fn<[string, RequestInit], Promise<Response>>(async () =>
      new Response(JSON.stringify({ task_id: 't' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new MinimaxVideoProvider();

    await provider.submit(
      { ...CFG, protocol: 'video-gen', config: {} },
      { model: 'MiniMax-H3', type: 'i2v', prompt: 'move', params: { images: ['https://cdn/a.png'] } },
    );
    let body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.content[1].role).toBe('first_frame');

    await provider.submit(
      { ...CFG, protocol: 'video-gen', config: {} },
      { model: 'MiniMax-H3', type: 'r2v', prompt: 'move', params: { images: ['https://cdn/a.png'] } },
    );
    body = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string);
    expect(body.content[1].role).toBe('reference_image');
    vi.unstubAllGlobals();
  });

  test('视频：超过上游上限的参考图被丢掉（参考图最多 9 张）', async () => {
    const fetchMock = vi.fn<[string, RequestInit], Promise<Response>>(async () =>
      new Response(JSON.stringify({ task_id: 't' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new MinimaxVideoProvider().submit(
      { ...CFG, protocol: 'video-gen', config: {} },
      {
        model: 'MiniMax-H3',
        type: 'r2v',
        prompt: 'cast',
        params: {
          images: Array.from({ length: 12 }, (_, i) => `https://cdn/${i}.png`),
          imageRoles: Array.from({ length: 12 }, () => 'reference_image'),
        },
      },
    );
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    // 1 个 text + 最多 9 张参考图
    expect(body.content).toHaveLength(10);
    vi.unstubAllGlobals();
  });

  test('视频：空 prompt 直接报错（上游要求 content 里必须有 text）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<[string, RequestInit], Promise<Response>>(async () => new Response('{}', { status: 200 })),
    );
    await expect(
      new MinimaxVideoProvider().submit(
        { ...CFG, protocol: 'video-gen', config: {} },
        { model: 'MiniMax-H3', type: 't2v', prompt: '   ', params: {} },
      ),
    ).rejects.toThrow(/prompt/);
    vi.unstubAllGlobals();
  });

  test('视频：videos + videoRoles 进 content[] 且 type=video_url', async () => {
    const fetchMock = vi.fn<[string, RequestInit], Promise<Response>>(async () =>
      new Response(JSON.stringify({ task_id: 't' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new MinimaxVideoProvider().submit(
      { ...CFG, protocol: 'video-gen', config: {} },
      {
        model: 'MiniMax-H3',
        type: 'r2v',
        prompt: 'follow the motion',
        params: { videos: ['https://cdn/v.mp4'], videoRoles: ['reference_video'] },
      },
    );
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.content[1]).toEqual({
      type: 'video_url',
      video_url: { url: 'https://cdn/v.mp4' },
      role: 'reference_video',
    });
    vi.unstubAllGlobals();
  });

  test('视频：media[] 的原生条目按其 type/role 翻译', async () => {
    const fetchMock = vi.fn<[string, RequestInit], Promise<Response>>(async () =>
      new Response(JSON.stringify({ task_id: 't' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new MinimaxVideoProvider().submit(
      { ...CFG, protocol: 'video-gen', config: {} },
      {
        model: 'MiniMax-H3',
        type: 'r2v',
        prompt: 'use the audio',
        params: { media: [{ type: 'audio_url', audio_url: { url: 'https://cdn/a.wav' }, role: 'reference_audio' }] },
      },
    );
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.content[1]).toEqual({
      type: 'audio_url',
      audio_url: { url: 'https://cdn/a.wav' },
      role: 'reference_audio',
    });
    vi.unstubAllGlobals();
  });
});
