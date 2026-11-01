/**
 * The media generation surface must authenticate with the ENTERPRISE org JWT.
 *
 * It used to use the consumer `auth_tokens`, which are always empty now that
 * MixWork has no youdao backend — so every media request died with "No auth
 * tokens are available" before it left the process. This test pins the switch
 * so it cannot silently regress.
 */
import { describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn() },
  net: { fetch: vi.fn() },
  session: { default: { persist: vi.fn() } },
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('media auth', () => {
  test('media 调用点全部用 mediaFetchWithAuth（企业 JWT），不再用消费者 fetchWithAuth', () => {
    const src = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');
    // Direct /api/media URLs
    // The plain consumer fetch must not target /api/media anywhere.
    const consumerMedia = [
      ...src.matchAll(/(?<![a-zA-Z])fetchWithAuth\(`\$\{serverBaseUrl\}\/api\/media[^`]*`/g),
      ...src.matchAll(/(?<![a-zA-Z])fetchWithAuth\(`\$\{serverBaseUrl\}\$\{endpoint\}`/g),
      ...src.matchAll(/(?<![a-zA-Z])fetchWithAuth\(taskUrl\)/g),
    ];
    expect(consumerMedia.map((m) => m[0])).toEqual([]);

    // And the enterprise one must actually be used for media.
    const enterpriseMedia = [
      ...src.matchAll(/mediaFetchWithAuth\(`\$\{serverBaseUrl\}\/api\/media[^`]*`/g),
      ...src.matchAll(/mediaFetchWithAuth\(`\$\{serverBaseUrl\}\$\{endpoint\}`/g),
      ...src.matchAll(/mediaFetchWithAuth\(taskUrl\)/g),
    ];
    expect(enterpriseMedia.length).toBeGreaterThanOrEqual(6);
  });

  test('mediaFetchWithAuth 在没有企业会话时返回 401 响应而不是抛异常', () => {
    // The eight call sites read `body.code` and surface the failure through the
    // tool result; a thrown error there would escape as an unhandled rejection
    // instead of a message the user sees.
    const src = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');
    expect(src).toContain('const mediaFetchWithAuth = async');
    expect(src).toMatch(/const mediaFetchWithAuth = async[\s\S]{0,900}status: 401/);
  });
});
