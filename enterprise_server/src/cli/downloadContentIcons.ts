// One-off: pull the icon URLs already stored in the kit / skill catalogs down
// onto this server.
//
// Both catalogs used to take an icon URL, so every row that had an icon
// pointed at an external host. The admin console now uploads a file instead,
// which leaves those rows pointing at the old host — the icon disappears the
// day the host does. This script downloads each one, stores it exactly where
// an upload would have put it, and rewrites the column to the served path.
//
// Safe to run more than once: a row whose value is already a served path is
// skipped, and a download that fails leaves the row untouched so the run can
// be repeated after the host comes back.
//
//   npx tsx --env-file=.env src/cli/downloadContentIcons.ts [--dry-run]
import { mkdirSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';

import { pool } from '../db/pool';
import { kitIconFile, kitIconUploadDir, skillIconFile, skillIconUploadDir } from '../lib/stateDir';

const MAX_BYTES = 1024 * 1024;

/** Extensions a URL may carry that we are willing to store. */
const URL_ICON_EXTS = new Set(['.png', '.jpg', '.webp', '.svg', '.gif']);

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/gif': '.gif',
};

interface Target {
  label: 'kit' | 'skill';
  table: string;
  idColumn: string;
  column: string;
  publicPrefix: string;
  uploadDir: () => string;
  file: (id: string, ext: string) => string;
}

const KITS: Target = {
  label: 'kit',
  table: 'kit_catalog',
  idColumn: 'slug',
  column: 'icon_url',
  publicPrefix: '/kit-icons/uploads',
  uploadDir: kitIconUploadDir,
  file: kitIconFile,
};

const SKILLS: Target = {
  label: 'skill',
  table: 'skill_marketplace_skills',
  idColumn: 'skill_id',
  column: 'icon',
  publicPrefix: '/skill-icons/uploads',
  uploadDir: skillIconUploadDir,
  file: skillIconFile,
};

async function download(url: string): Promise<{ bytes: Uint8Array; ext: string } | string> {
  let res: Response;
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    return `network: ${(e as Error).message}`;
  }
  if (!res.ok) return `http ${res.status}`;

  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength === 0) return 'empty body';
  if (buf.byteLength > MAX_BYTES) return `too large: ${buf.byteLength} bytes`;

  const mime = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  // Prefer the declared type; a host that serves `application/octet-stream`
  // still usually has the extension in the path.
  const rawExt = extname(new URL(url).pathname).toLowerCase();
  const urlExt = rawExt === '.jpeg' ? '.jpg' : rawExt;
  const usableUrlExt = URL_ICON_EXTS.has(urlExt) ? urlExt : null;
  const ext = EXT_BY_MIME[mime] ?? usableUrlExt;
  if (!ext) return `unsupported type: ${mime || 'unknown'}`;
  return { bytes: buf, ext };
}

async function migrate(target: Target, dryRun: boolean): Promise<{ moved: number; failed: number }> {
  const rows = await pool.query<{ id: string; icon: string | null; org_id: string }>(
    `SELECT ${target.idColumn} AS id, ${target.column} AS icon, org_id
       FROM ${target.table}
      WHERE ${target.column} LIKE 'http%'
      ORDER BY ${target.idColumn}`,
  );
  let moved = 0;
  let failed = 0;
  for (const row of rows.rows) {
    const result = await download(row.icon!);
    if (typeof result === 'string') {
      failed += 1;
      console.warn(`[icons] ${target.label} ${row.id}: skipped (${result})`);
      continue;
    }
    const iconPath = `${target.publicPrefix}/${row.id}${result.ext}`;
    if (dryRun) {
      console.log(`[icons] ${target.label} ${row.id}: would store ${result.bytes.byteLength} bytes → ${iconPath}`);
      moved += 1;
      continue;
    }
    mkdirSync(target.uploadDir(), { recursive: true });
    writeFileSync(target.file(row.id, result.ext), result.bytes);
    await pool.query(
      `UPDATE ${target.table} SET ${target.column} = $1, updated_at = NOW() WHERE ${target.idColumn} = $2 AND org_id = $3`,
      [iconPath, row.id, row.org_id],
    );
    moved += 1;
    console.log(`[icons] ${target.label} ${row.id}: stored ${result.bytes.byteLength} bytes → ${iconPath}`);
  }
  return { moved, failed };
}

async function run(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) console.log('[icons] dry run — nothing will be written');

  const kits = await migrate(KITS, dryRun);
  const skills = await migrate(SKILLS, dryRun);
  console.log(
    `[icons] done: kits ${kits.moved} moved / ${kits.failed} failed; `
    + `skills ${skills.moved} moved / ${skills.failed} failed`,
  );
  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
