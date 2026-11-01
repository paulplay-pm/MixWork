// enterprise_server/src/routes/contentIconUpload.ts
// Per-item icon upload + clear for the two content catalogs: expert kits and
// skills.
//
// Both used to take an icon URL. An admin had to host the image somewhere
// first, and the row then pointed at an external host that could disappear —
// the same reason the connector icon became an upload. The file lands in the
// state dir and the row points at a path served from this server's origin.
//
// The shape mirrors ssoLogoUpload / connectorIconUpload: a MIME whitelist, a
// 1 MB ceiling, a static route under server.ts, and a clear route that removes
// both the file and the column value.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

import { Hono } from 'hono';

import { auditStore } from '../audit/auditStore';
import { requireAuth, requirePermission } from '../auth/middleware';
import { pool } from '../db/pool';
import {
  agentIconFile,
  agentIconUploadDir,
  kitIconFile,
  kitIconUploadDir,
  skillIconFile,
  skillIconUploadDir,
} from '../lib/stateDir';
import { AuditAction } from '../shared/enterpriseServerConstants';
import { type PermissionPoint,PermissionPoint as PP } from '../shared/permissionPoints';

export const contentIconUploadRoutes = new Hono();
contentIconUploadRoutes.use('/api/admin/kits/*', requireAuth);
contentIconUploadRoutes.use('/api/admin/skill-marketplace/*', requireAuth);
contentIconUploadRoutes.use('/api/admin/agent-marketplace/*', requireAuth);

/** Max upload size: 1 MB, the same ceiling the other icon uploads use. */
export const MAX_ICON_BYTES = 1024 * 1024;

const ALLOWED_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};

const jsonError = (status: number, error: string): Response =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Everything that differs between the two catalogs. */
interface IconTarget {
  /** The route's path segment, e.g. `kits`. */
  route: string;
  /** `kit_catalog`, `skill_marketplace_skills` or `agent_marketplace_agents`. */
  table: string;
  /** `slug` for kits, `skill_id` for skills, `agent_id` for agents. */
  idColumn: string;
  /** `icon_url` for kits, `icon` for skills and agents. */
  column: string;
  /** The public path prefix the static route serves. */
  publicPrefix: string;
  uploadDir: () => string;
  file: (id: string, ext: string) => string;
  uploadAction: AuditAction;
  clearAction: AuditAction;
  /** The audit `targetType` for rows in this table. */
  targetType: 'kit' | 'skill' | 'agent';
  /** What "no icon" is written as. The agent table's column is NOT NULL with
   *  an empty-string default, so it cannot take NULL. */
  clearValue: null | '';
}

const KIT: IconTarget = {
  route: 'kits',
  table: 'kit_catalog',
  idColumn: 'slug',
  column: 'icon_url',
  publicPrefix: '/kit-icons/uploads',
  uploadDir: kitIconUploadDir,
  file: kitIconFile,
  uploadAction: AuditAction.KitIconUpload,
  clearAction: AuditAction.KitIconClear,
  targetType: 'kit',
  clearValue: null,
};

const SKILL: IconTarget = {
  route: 'skill-marketplace/skills',
  table: 'skill_marketplace_skills',
  idColumn: 'skill_id',
  column: 'icon',
  publicPrefix: '/skill-icons/uploads',
  uploadDir: skillIconUploadDir,
  file: skillIconFile,
  uploadAction: AuditAction.SkillIconUpload,
  clearAction: AuditAction.SkillIconClear,
  targetType: 'skill',
  clearValue: null,
};

/** The row's current icon, scoped to the caller's org, or `'not_found'`. */
async function loadScopedIcon(target: IconTarget, id: string, orgId: string): Promise<string | null | 'not_found'> {
  const r = await pool.query<{ icon: string | null }>(
    `SELECT ${target.column} AS icon FROM ${target.table} WHERE ${target.idColumn} = $1 AND org_id = $2`,
    [id, orgId],
  );
  if (!r.rowCount) return 'not_found';
  return r.rows[0]!.icon;
}

/**
 * Remove the file behind an uploaded icon.
 *
 * Only a path this server wrote is deleted. A legacy `http…` value is left
 * alone: it names someone else's file, and the row is about to point
 * elsewhere anyway.
 */
function removeUploadedFile(target: IconTarget, iconPath: string | null): void {
  if (!iconPath || !iconPath.startsWith(`${target.publicPrefix}/`)) return;
  // The stored value names the file outright, which is what makes a replace
  // exact even though the name carries a version suffix.
  try {
    unlinkSync(target.file(basename(iconPath, extname(iconPath)), extname(iconPath)));
  } catch {
    /* already gone */
  }
}

/**
 * A file name that changes on every upload.
 *
 * Everything that shows an icon — the console, the desktop, an installed
 * connector's cached copy — keys off the URL. A name derived only from the
 * item's id meant a replaced logo kept the old URL, so every one of those
 * kept showing the old image until its cache expired.
 */
function iconStem(id: string): string {
  return `${id}-${randomBytes(4).toString('hex')}`;
}

/** Drop the upload directory once it is empty, then restore it so the next
 *  upload needs no mkdir race. */
function sweepUploadDir(dir: string): void {
  try {
    if (readdirSync(dir).length === 0) {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    /* not empty / already gone */
  }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function register(target: IconTarget, permission: PermissionPoint): void {
  const base = `/api/admin/${target.route}/:id/icon`;

  contentIconUploadRoutes.post(base, requirePermission(permission), async (c) => {
    const claims = c.get('claims');
    const id = c.req.param('id') ?? '';

    const current = await loadScopedIcon(target, id, claims.orgId);
    if (current === 'not_found') return jsonError(404, 'not_found');

    // Declared length first (an oversized body is rejected unparsed), then the
    // real byte length (a missing Content-Length cannot bypass the cap).
    const declaredLen = Number(c.req.header('content-length') ?? '0');
    if (declaredLen > MAX_ICON_BYTES) return jsonError(413, 'too_large');

    const form = await c.req.parseBody();
    const file = form['icon'];
    if (!(file instanceof File)) return jsonError(400, 'missing_file');
    if (file.size > MAX_ICON_BYTES) return jsonError(413, 'too_large');
    const ext = ALLOWED_MIME[file.type];
    if (!ext) return jsonError(415, 'unsupported_mime');

    // Replace any prior upload first, so the static route never serves a stale
    // image between the write and the column update.
    removeUploadedFile(target, current);

    mkdirSync(target.uploadDir(), { recursive: true });
    const buf = new Uint8Array(await file.arrayBuffer());
    const stem = iconStem(id);
    writeFileSync(target.file(stem, ext), buf);

    const iconPath = `${target.publicPrefix}/${stem}${ext}`;
    await pool.query(
      `UPDATE ${target.table} SET ${target.column} = $1, updated_at = NOW() WHERE ${target.idColumn} = $2 AND org_id = $3`,
      [iconPath, id, claims.orgId],
    );
    await auditStore.write({
      orgId: claims.orgId,
      userId: claims.sub,
      action: target.uploadAction,
      targetType: target.targetType,
      targetId: id,
      payload: { ext, bytes: buf.length },
    });
    return c.json({ icon: iconPath });
  });

  contentIconUploadRoutes.delete(base, requirePermission(permission), async (c) => {
    const claims = c.get('claims');
    const id = c.req.param('id') ?? '';

    const current = await loadScopedIcon(target, id, claims.orgId);
    if (current === 'not_found') return jsonError(404, 'not_found');

    // Idempotent: clearing an item that has no icon is a no-op success.
    removeUploadedFile(target, current);
    await pool.query(
      `UPDATE ${target.table} SET ${target.column} = $1, updated_at = NOW() WHERE ${target.idColumn} = $2 AND org_id = $3`,
      [target.clearValue, id, claims.orgId],
    );
    sweepUploadDir(target.uploadDir());

    await auditStore.write({
      orgId: claims.orgId,
      userId: claims.sub,
      action: target.clearAction,
      targetType: target.targetType,
      targetId: id,
    });
    return c.json({ ok: true });
  });
}

/**
 * Agents are different from the two catalogs above: their stored icon may also
 * be one of the desktop's built-in avatars (`agent-avatar-svg:<name>`), which
 * this route never touches — it only writes when a file is uploaded, and the
 * patch route still owns the built-in value.
 */
const AGENT: IconTarget = {
  route: 'agent-marketplace/agents',
  table: 'agent_marketplace_agents',
  idColumn: 'agent_id',
  column: 'icon',
  publicPrefix: '/agent-icons/uploads',
  uploadDir: agentIconUploadDir,
  file: agentIconFile,
  uploadAction: AuditAction.AgentIconUpload,
  clearAction: AuditAction.AgentIconClear,
  targetType: 'agent',
  clearValue: '',
};

register(KIT, PP.KitEdit);
register(SKILL, PP.SkillEdit);
register(AGENT, PP.AgentEdit);
