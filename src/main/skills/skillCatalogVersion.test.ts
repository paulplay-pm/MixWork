import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const electronState = vi.hoisted(() => ({ userData: '', appPath: '' }));

vi.mock('electron', () => ({
  app: {
    getAppPath: () => electronState.appPath,
    getPath: () => electronState.userData,
    isPackaged: false,
  },
  BrowserWindow: { getAllWindows: () => [] },
  session: { defaultSession: { webRequest: { onBeforeSendHeaders: vi.fn() }, fetch: vi.fn() } },
}));
vi.mock('../libs/nodeRuntime', () => ({ resolveNodeRuntimeForSpawn: vi.fn() }));
vi.mock('../auth/enterpriseClient', () => ({
  enterpriseClient: { getToken: vi.fn().mockResolvedValue('tok-123') },
}));

import { resolveSkillVersion, SkillManager } from './skillManager';

/** The minimum the manager reads out of the kv store. */
function fakeStore(): { get: (key: string) => unknown; set: (key: string, value: unknown) => void } {
  const values = new Map<string, unknown>();
  return {
    get: (key) => values.get(key),
    set: (key, value) => {
      values.set(key, value);
    },
  };
}

function writeSkill(id: string, frontmatter: string): void {
  const dir = path.join(electronState.userData, 'SKILLs', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n# ${id}\n`, 'utf8');
}

let manager: SkillManager;

beforeEach(() => {
  electronState.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-skill-version-'));
  // An app path with no bundled catalog keeps the listing to the fixtures.
  electronState.appPath = path.join(electronState.userData, 'app');
  const store = fakeStore();
  manager = new SkillManager(() => store as never);
});

afterEach(() => {
  fs.rmSync(electronState.userData, { recursive: true, force: true });
});

test('resolveSkillVersion: 包自带版本优先，其次是记录的目录版本', () => {
  expect(resolveSkillVersion({ version: '2.0.0' }, '1.0.0')).toBe('2.0.0');
  expect(resolveSkillVersion({ version: 2 }, '1.0.0')).toBe('2');
  expect(resolveSkillVersion({}, '1.0.0')).toBe('1.0.0');
  expect(resolveSkillVersion({}, undefined)).toBeUndefined();
});

test('企业目录安装的技能：包里没有版本号时，读回目录记录的版本', () => {
  // Enterprise catalog packages ship name/description only — no `version:`.
  // Without the recorded version the marketplace card compared the catalog
  // version against a blank and offered 更新 again right after a successful
  // upgrade, which is the bug this covers.
  writeSkill('bid-doc-writer', 'name: bid-doc-writer\ndescription: 标书');
  expect(manager.listSkills().find((s) => s.id === 'bid-doc-writer')?.version).toBeUndefined();

  manager.recordCatalogVersion('bid-doc-writer', '1.4.2');
  expect(manager.listSkills().find((s) => s.id === 'bid-doc-writer')?.version).toBe('1.4.2');
  // Recording must survive a reload of the map (it is persisted, not cached).
  expect(manager.getInstalledCatalogVersion('bid-doc-writer')).toBe('1.4.2');
});

test('升级后目录版本被覆盖为新版本', () => {
  writeSkill('weather', 'name: weather\ndescription: w');
  manager.recordCatalogVersion('weather', '1.0.0');
  expect(manager.listSkills().find((s) => s.id === 'weather')?.version).toBe('1.0.0');
  manager.recordCatalogVersion('weather', '1.1.0');
  expect(manager.listSkills().find((s) => s.id === 'weather')?.version).toBe('1.1.0');
});

test('记录版本时忽略空值，不会把已有版本抹掉', () => {
  writeSkill('weather', 'name: weather\ndescription: w');
  manager.recordCatalogVersion('weather', '1.0.0');
  manager.recordCatalogVersion('weather', '');
  manager.recordCatalogVersion('weather', null);
  expect(manager.getInstalledCatalogVersion('weather')).toBe('1.0.0');
});

test('包自带版本号时仍以包为准，不被记录的目录版本覆盖', () => {
  writeSkill('clawhub-skill', 'name: clawhub-skill\ndescription: c\nversion: 3.0.0');
  manager.recordCatalogVersion('clawhub-skill', '1.0.0');
  expect(manager.listSkills().find((s) => s.id === 'clawhub-skill')?.version).toBe('3.0.0');
});
