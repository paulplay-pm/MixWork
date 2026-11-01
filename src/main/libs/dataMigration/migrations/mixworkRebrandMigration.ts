import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { APP_NAME } from '../../../appConstants';
import { DataMigrationVersion } from '../constants';

export const MIXWORK_REBRAND_MIGRATION_VERSION: DataMigrationVersion = {
  id: 'mixwork-rebrand-2026-09-04',
  version: 100,
  description:
    'Rename MixWork SQLite file, rename cowork_* tables to mixwork_*, ' +
    'rename claude_session_id column to openclaw_session_id, rewrite kv ' +
    'keys with mixwork: / cowork: prefixes to mixwork:.',
};

interface LegacyTableRow {
  name: string;
}

interface LegacyKvRow {
  key: string;
}

const LEGACY_DB_FILENAME = 'mixwork.sqlite';
const NEW_DB_FILENAME = 'mixwork.sqlite';
const LEGACY_TABLE_RENAMES: ReadonlyArray<readonly [string, string]> = [
  ['cowork_sessions', 'mixwork_sessions'],
  ['cowork_messages', 'mixwork_messages'],
  ['cowork_config', 'mixwork_config'],
  ['cowork_session_capsules', 'mixwork_session_capsules'],
];
const LEGACY_KV_PREFIXES: ReadonlyArray<string> = ['cowork:'];
const NEW_KV_PREFIX = 'mixwork:';
const SESSION_ID_COLUMN_RENAMES: ReadonlyArray<readonly [string, string]> = [
  ['claude_session_id', 'openclaw_session_id'],
];

export interface MixWorkRebrandMigrationResult {
  renamedTables: string[];
  renamedColumns: Array<{ table: string; from: string; to: string }>;
  renamedKvKeys: string[];
  renamedDatabaseFile: boolean;
}

export function runMixWorkRebrandMigration(
  db: Database.Database,
  _userDataDir: string,
): MixWorkRebrandMigrationResult {
  const result: MixWorkRebrandMigrationResult = {
    renamedTables: [],
    renamedColumns: [],
    renamedKvKeys: [],
    renamedDatabaseFile: false,
  };

  // 1. SQLite schema: tables.
  const existing = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all() as LegacyTableRow[];

  const tableNames = new Set(existing.map((r) => r.name));

  for (const [from, to] of LEGACY_TABLE_RENAMES) {
    if (tableNames.has(from) && !tableNames.has(to)) {
      db.exec(`ALTER TABLE "${from}" RENAME TO "${to}"`);
      result.renamedTables.push(from);
      tableNames.delete(from);
      tableNames.add(to);
    }
  }

  // 2. Column rename: claude_session_id → openclaw_session_id on mixwork_sessions.
  if (tableNames.has('mixwork_sessions')) {
    const cols = db
      .prepare(`PRAGMA table_info("mixwork_sessions")`)
      .all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    for (const [from, to] of SESSION_ID_COLUMN_RENAMES) {
      if (colNames.has(from) && !colNames.has(to)) {
        db.exec(`ALTER TABLE "mixwork_sessions" RENAME COLUMN "${from}" TO "${to}"`);
        result.renamedColumns.push({ table: 'mixwork_sessions', from, to });
      }
    }
  }

  // 3. KV table prefixes.
  if (tableNames.has('kv')) {
    for (const prefix of LEGACY_KV_PREFIXES) {
      const rows = db
        .prepare(`SELECT key FROM kv WHERE key LIKE ?`)
        .all(`${prefix}%`) as LegacyKvRow[];
      const update = db.prepare(`UPDATE kv SET key = ? WHERE key = ?`);
      for (const row of rows) {
        const nextKey = NEW_KV_PREFIX + row.key.slice(prefix.length);
        update.run(nextKey, row.key);
        result.renamedKvKeys.push(row.key);
      }
    }
  }

  return result;
}

/**
 * Resolves the legacy UserData directory for the given app name on the
 * current platform. On macOS: ~/Library/Application Support/<name>.
 * On Windows: %APPDATA%\<name>. On Linux: ~/.config/<name>.
 */
export function deriveLegacyUserDataDir(legacyName: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', legacyName);
    case 'win32':
      return path.join(
        process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
        legacyName,
      );
    default:
      return path.join(
        process.env.XDG_CONFIG_HOME || path.join(home, '.config'),
        legacyName,
      );
  }
}

/**
 * Moves the legacy `mixwork.sqlite` (and -wal/-shm) from the pre-rebrand
 * MixWork UserData directory into the current UserData directory as
 * `mixwork.sqlite` if the new file does not yet exist. Returns true if a
 * rename happened.
 */
export function adoptLegacySqliteFile(userDataDir: string): boolean {
  const legacyDir = deriveLegacyUserDataDir('MixWork');
  const from = path.join(legacyDir, LEGACY_DB_FILENAME);
  const to = path.join(userDataDir, NEW_DB_FILENAME);
  if (!fs.existsSync(from) || fs.existsSync(to)) {
    return false;
  }
  for (const suffix of ['', '-wal', '-shm']) {
    const src = `${from}${suffix}`;
    const dst = `${to}${suffix}`;
    if (fs.existsSync(src)) {
      try {
        fs.renameSync(src, dst);
      } catch {
        return false;
      }
    }
  }
  return true;
}

// Keep APP_NAME referenced so tree-shaking cannot remove the import.
export const _MIXWORK_REBRAND_APP_NAME = APP_NAME;
