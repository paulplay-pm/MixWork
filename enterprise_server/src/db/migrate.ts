import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pool } from './pool';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/** Split a migration file's SQL into single statements the way production executes them. */
export function splitStatements(sql: string): string[] {
  const padded = sql.endsWith('\n') ? sql : sql + '\n';
  // Strip line comments before deciding whether a chunk is empty, so
  // single-statement migrations prefixed by `--` comments (like 008 and
  // 009) are still executed. The previous `s.startsWith('--')` check
  // would drop the whole chunk if the first non-blank line was a
  // comment, even when valid SQL followed.
  return padded
    .split(/;\s*(?:\n|$)/)
    .map((s) =>
      s
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim()
    )
    .filter((s) => s.length > 0);
}

/**
 * A checksum of a migration's SEMANTIC content: its statements, with line
 * comments stripped.
 *
 * Comment-only edits do not change it — only a change to the SQL does. That
 * distinction matters, because the drift check below is only worth having if
 * it does not cry wolf over a reworded comment.
 */
export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(splitStatements(sql).join(';\n')).digest('hex');
}

/** The pool surface the runner needs, so a test can run it against pglite. */
export interface MigrationClient {
  query<T = unknown>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number }>;
}

export interface MigrationRunResult {
  /** Files applied during this run. */
  applied: string[];
  /** Files skipped because the ledger already recorded them. */
  skipped: string[];
  /**
   * Files that were applied BEFORE and whose content has changed since.
   *
   * The ledger keys on the file NAME, so a file recorded there never runs
   * again — editing an applied file changes nothing on an existing database
   * and its schema change is silently missing everywhere. The fix is always a
   * NEW migration file; this list is how that mistake stops being silent.
   */
  drifted: string[];
}

/**
 * Run all SQL migrations in order, idempotently.
 *
 * Each migration file may contain multiple statements. We split on `;` and
 * execute one statement per call so the pg driver returns a single result
 * per call (multi-statement simple queries can return `rows: undefined`,
 * which the pool adapter cannot safely interpret).
 *
 * Idempotency: the `000_ledger.sql` migration establishes a `_migrations`
 * ledger; subsequent runs skip files already recorded in it.
 */
export async function runMigrations(
  client: MigrationClient = pool,
  options?: { dir?: string },
): Promise<MigrationRunResult> {
  const dir = options?.dir ?? join(__dirname, 'migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const result: MigrationRunResult = { applied: [], skipped: [], drifted: [] };
  // Make sure the ledger table exists before we consult it. CREATE TABLE
  // IF NOT EXISTS is itself idempotent and cheap.
  for (const stmt of [
    `CREATE TABLE IF NOT EXISTS _migrations (file TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    `ALTER TABLE _migrations ADD COLUMN IF NOT EXISTS checksum TEXT`,
  ]) {
    await client.query(stmt);
  }
  const ledger = await client.query<{ file: string; checksum: string | null }>(
    `SELECT file, checksum FROM _migrations`,
  );
  const applied = new Map(ledger.rows.map((r) => [r.file, r.checksum ?? null]));

  // Drift is detected BEFORE anything is applied, because the whole point is
  // that an edited file will not run: the check has to look at what is on disk
  // against what the ledger recorded, not at what the run did.
  for (const f of files) {
    const recorded = applied.get(f);
    // `null` means the row predates the checksum column: nothing to compare
    // against, and it is backfilled below.
    if (recorded == null) continue;
    const current = migrationChecksum(readFileSync(join(dir, f), 'utf8'));
    if (current === recorded) continue;
    result.drifted.push(f);
    console.error(
      `[DB] migration ${f} was CHANGED after it was applied. The ledger keys on the file name, `
      + `so it will never run again and its schema change is missing from this database. `
      + `Add a NEW migration file instead of editing an applied one.`,
    );
  }

  for (const f of files) {
    if (applied.has(f)) {
      result.skipped.push(f);
      continue;
    }
    const sql = readFileSync(join(dir, f), 'utf8');
    if (sql.trim().startsWith('-- v2')) {
      // v2 placeholders are tracked but never applied
      await client.query(`INSERT INTO _migrations(file) VALUES ($1) ON CONFLICT DO NOTHING`, [f]);
      result.skipped.push(f);
      continue;
    }
    // Execute each statement individually (see splitStatements).
    const statements = splitStatements(sql);
    for (const stmt of statements) {
      await client.query(stmt);
    }
    await client.query(
      `INSERT INTO _migrations(file, checksum) VALUES ($1, $2)
       ON CONFLICT (file) DO UPDATE SET checksum = EXCLUDED.checksum`,
      [f, migrationChecksum(sql)],
    );
    result.applied.push(f);
  }

  // Backfill checksums for rows recorded before the column existed, so drift
  // is detected from here on. The backfill assumes the file on disk is what
  // was applied — for a file that WAS edited after being applied, that
  // assumption is wrong and the edit stays invisible. That is the price of
  // not having recorded checksums in the first place; the repair is a new
  // migration file, not a rewrite of history.
  for (const [file, checksum] of applied) {
    if (checksum != null) continue;
    if (!files.includes(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    if (sql.trim().startsWith('-- v2')) continue;
    await client.query(
      `UPDATE _migrations SET checksum = $2 WHERE file = $1 AND checksum IS NULL`,
      [file, migrationChecksum(sql)],
    );
  }

  return result;
}
