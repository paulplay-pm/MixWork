import { describe, expect, test } from 'vitest';

import {
  buildOpenClawMcpServers,
  isOpenClawSafeKey,
  resolveMcpServerEntries,
  resolveMcpServerKey,
} from './openclawMcpServers';

const remote = (over: Record<string, unknown> = {}) => ({
  name: 'crm',
  transportType: 'http' as const,
  url: 'https://crm.example.com/mcp',
  ...over,
});

describe('buildOpenClawMcpServers — tool policy', () => {
  test('writes no toolFilter when the org left every tool enabled', () => {
    const out = buildOpenClawMcpServers([remote()]);
    expect(out.crm).not.toHaveProperty('toolFilter');
  });

  test('writes an include whitelist', () => {
    const out = buildOpenClawMcpServers([remote({ toolFilter: { include: ['query', 'create'] } })]);
    expect(out.crm.toolFilter).toEqual({ include: ['query', 'create'] });
  });

  test('writes an exclude list when the org disabled every tool', () => {
    const out = buildOpenClawMcpServers([remote({ toolFilter: { exclude: ['query'] } })]);
    expect(out.crm.toolFilter).toEqual({ exclude: ['query'] });
  });

  test('an empty filter object writes nothing', () => {
    // An empty `include` is invalid in OpenClaw's schema (min 1), and an absent
    // filter means "all tools" — so an empty one must never be emitted.
    const out = buildOpenClawMcpServers([remote({ toolFilter: { include: [], exclude: [] } })]);
    expect(out.crm).not.toHaveProperty('toolFilter');
  });

  test('a stdio server carries its filter too', () => {
    const out = buildOpenClawMcpServers([
      { name: 'local', transportType: 'stdio', command: 'node', args: ['s.js'], toolFilter: { include: ['run'] } },
    ]);
    expect(out.local.toolFilter).toEqual({ include: ['run'] });
  });

  test('headers still lowercase and the remote entry stays intact', () => {
    const out = buildOpenClawMcpServers([
      remote({
        headers: { Authorization: 'Bearer t' },
        toolFilter: { include: ['query'] },
      }),
    ]);
    expect(out.crm.url).toBe('https://crm.example.com/mcp');
    expect(out.crm.transport).toBe('streamable-http');
    expect(out.crm.headers).toEqual({ authorization: 'Bearer t' });
  });
});

describe('buildOpenClawMcpServers — per-call timeout', () => {
  test('writes the org\'s timeout in seconds when there is one', () => {
    const out = buildOpenClawMcpServers([remote({ timeoutSeconds: 90 })]);
    expect(out.crm.timeout).toBe(90);
  });

  test('writes no timeout when the org left it at the runtime default', () => {
    const out = buildOpenClawMcpServers([remote()]);
    expect(out.crm).not.toHaveProperty('timeout');
  });

  test('a nonsense timeout is not written', () => {
    const out = buildOpenClawMcpServers([remote({ timeoutSeconds: 0 })]);
    expect(out.crm).not.toHaveProperty('timeout');
  });
});

describe('resolveMcpServerKey', () => {
  test('prefers the enterprise serverKey over the display name', () => {
    expect(resolveMcpServerKey({ serverKey: 'fxiaoke', name: '纷享销客' })).toBe('fxiaoke');
  });

  test('falls back to the display name when there is no serverKey', () => {
    expect(resolveMcpServerKey({ name: 'GitHub' })).toBe('GitHub');
  });

  test('a name OpenClaw would rewrite is rewritten the same way here', () => {
    // OpenClaw's `sanitizeServerName` turns "My Server" into "My-Server" and
    // gives a name that does not start with a letter an `mcp-` prefix. If the
    // desktop kept its own spelling, the config key and the tool-name prefix
    // would differ and no connector could be named by its tools.
    expect(resolveMcpServerKey({ name: 'My Server' })).toBe('My-Server');
    expect(resolveMcpServerKey({ name: 'my.server' })).toBe('my-server');
    expect(resolveMcpServerKey({ name: '12306' })).toBe('mcp-12306');
  });

  test('a non-ASCII name gets a stable hash, not a collapsing key', () => {
    // Every CJK character collapses to "-", so 纷享销客 and 腾讯文档 would both
    // land on `mcp-----` and be told apart only by an order-dependent suffix.
    const first = resolveMcpServerKey({ name: '纷享销客' });
    const second = resolveMcpServerKey({ name: '腾讯文档' });
    expect(first).not.toBe(second);
    expect(first).toMatch(/^mcp-[0-9a-f]{8}$/);
    expect(resolveMcpServerKey({ name: '纷享销客' })).toBe(first);
  });

  test('every key it produces is one OpenClaw leaves untouched', () => {
    const names = ['fxiaoke', 'My Server', '12306', '纷享销客', 'QQ邮箱', 'a'.repeat(80)];
    for (const name of names) {
      expect(isOpenClawSafeKey(resolveMcpServerKey({ name }))).toBe(true);
    }
  });
});

describe('buildOpenClawMcpServers — keys', () => {
  test('writes the enterprise serverKey as the key', () => {
    const out = buildOpenClawMcpServers([
      remote({ name: '纷享销客', serverKey: 'fxiaoke' }),
    ]);
    expect(Object.keys(out)).toEqual(['fxiaoke']);
  });

  test('two servers whose keys collide do not overwrite each other', () => {
    // The map is keyed by server name, so a collision used to make one of the
    // two connectors vanish from the config without a word.
    const out = buildOpenClawMcpServers([
      remote({ name: 'My Server', url: 'https://a.example.com/mcp' }),
      remote({ name: 'My-Server', url: 'https://b.example.com/mcp' }),
    ]);
    expect(Object.keys(out)).toHaveLength(2);
    expect(out['My-Server'].url).toBe('https://a.example.com/mcp');
    expect(out['My-Server-2'].url).toBe('https://b.example.com/mcp');
  });

  test('every written key is one OpenClaw leaves untouched', () => {
    const out = buildOpenClawMcpServers([
      remote({ name: 'My Server', url: 'https://a.example.com/mcp' }),
      remote({ name: '纷享销客', serverKey: 'fxiaoke', url: 'https://b.example.com/mcp' }),
    ]);
    for (const key of Object.keys(out)) {
      expect(isOpenClawSafeKey(key)).toBe(true);
    }
  });

  test('a server with an unusable URL is left out, and the next one still gets its key', () => {
    const { entries, skipped } = resolveMcpServerEntries([
      remote({ name: 'broken', url: 'not a url' }),
      remote({ name: 'crm', url: 'https://crm.example.com/mcp' }),
    ]);
    expect(skipped.map((server) => server.name)).toEqual(['broken']);
    expect(entries.map((entry) => entry.key)).toEqual(['crm']);
  });
});
