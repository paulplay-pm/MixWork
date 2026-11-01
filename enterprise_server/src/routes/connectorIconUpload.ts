// enterprise_server/src/routes/connectorIconUpload.ts
// Per-connector icon upload + clear (admin half).
//
// An org connector's brand logo is a FILE the admin uploads, not a URL they
// type: the URL field left every connector pointing at some external host that
// could disappear, and it asked an admin to host an image somewhere first. The
// server stores the upload at
//   <stateDir>/connector-icons/uploads/<connectorId>.<ext>
// and persists `/connector-icons/uploads/<connectorId>.<ext>` in the `icon`
// column. A separate DELETE route clears the column and removes the file, so
// the connector falls back to the desktop's default glyph.
//
// The static-serve route at `/connector-icons/uploads/*` lives in `server.ts`
// (mounted BEFORE the SPA fallback) so the admin console and the desktop fetch
// the file from the same origin as the API.
//
// Deliberately independent of the connector's draft/publish/rollback flow: an
// icon is presentation, so replacing one must never require publishing a
// version, and rolling a version back must never revert the logo.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

import { Hono } from 'hono';

import { auditStore } from '../audit/auditStore';
import { requireAuth, requirePermission } from '../auth/middleware';
import { pool } from '../db/pool';
import { connectorIconFile, connectorIconUploadDir } from '../lib/stateDir';
import { AuditAction } from '../shared/enterpriseServerConstants';
import { PermissionPoint as PP } from '../shared/permissionPoints';

export const connectorIconUploadRoutes = new Hono();
connectorIconUploadRoutes.use('/admin/mcp-connectors/*', requireAuth);

/** Max upload size: 1 MB — the same ceiling the SSO logo uses. */
export const MAX_ICON_BYTES = 1024 * 1024;

/** Whitelisted MIME types → server-side file extension. SVG is allowed but
 *  served with `Content-Security-Policy: sandbox` by the static route, so an
 *  uploaded SVG cannot run a script in the console's origin. */
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

/** The connector's current icon, scoped to the caller's org. Returns
 *  `'not_found'` when the connector does not exist in this org. */
async function loadScopedIcon(connectorId: string, orgId: string): Promise<string | null | 'not_found'> {
  const r = await pool.query<{ icon: string | null }>(
    `SELECT icon FROM mcp_connectors WHERE id = $1 AND org_id = $2`,
    [connectorId, orgId],
  );
  if (!r.rowCount) return 'not_found';
  return r.rows[0]!.icon;
}

/** Remove the file behind an uploaded icon, if the column points at one. */
function removeUploadedFile(iconPath: string | null): void {
  if (!iconPath || !iconPath.startsWith('/connector-icons/uploads/')) return;
  const ext = extname(iconPath);
  if (!ext) return;
  try {
    unlinkSync(connectorIconFile(basename(iconPath, ext), ext));
  } catch {
    /* already gone */
  }
}

/** A file name that changes on every upload, so a replaced logo is a new URL
 *  and no cache — browser, desktop, or an installed record — keeps the old
 *  image. */
function iconStem(id: string): string {
  return `${id}-${randomBytes(4).toString('hex')}`;
}

connectorIconUploadRoutes.post(
  '/admin/mcp-connectors/:id/icon',
  requirePermission(PP.McpEdit),
  async (c) => {
    const claims = c.get('claims');
    const id = c.req.param('id');

    const current = await loadScopedIcon(id, claims.orgId);
    if (current === 'not_found') return jsonError(404, 'not_found');

    // The declared length is checked before parsing so an oversized body is
    // rejected without buffering it; the actual byte length is checked after,
    // so a missing or wrong Content-Length cannot bypass the cap.
    const declaredLen = Number(c.req.header('content-length') ?? '0');
    if (declaredLen > MAX_ICON_BYTES) return jsonError(413, 'too_large');

    const form = await c.req.parseBody();
    const file = form['icon'];
    if (!(file instanceof File)) return jsonError(400, 'missing_file');

    if (file.size > MAX_ICON_BYTES) return jsonError(413, 'too_large');
    const ext = ALLOWED_MIME[file.type];
    if (!ext) return jsonError(415, 'unsupported_mime');

    // Replace any prior file first, so the static route never serves a stale
    // image between the write and the column update.
    removeUploadedFile(current);

    mkdirSync(connectorIconUploadDir(), { recursive: true });
    const buf = new Uint8Array(await file.arrayBuffer());
    const stem = iconStem(id);
    writeFileSync(connectorIconFile(stem, ext), buf);

    const iconPath = `/connector-icons/uploads/${stem}${ext}`;
    await pool.query(
      `UPDATE mcp_connectors SET icon = $1, updated_at = NOW() WHERE id = $2 AND org_id = $3`,
      [iconPath, id, claims.orgId],
    );
    await auditStore.write({
      orgId: claims.orgId,
      userId: claims.sub,
      action: AuditAction.McpConnectorIconUpload,
      targetType: 'connector',
      targetId: id,
      payload: { ext, bytes: buf.length },
    });
    return c.json({ icon: iconPath });
  },
);

connectorIconUploadRoutes.delete(
  '/admin/mcp-connectors/:id/icon',
  requirePermission(PP.McpEdit),
  async (c) => {
    const claims = c.get('claims');
    const id = c.req.param('id');

    const current = await loadScopedIcon(id, claims.orgId);
    if (current === 'not_found') return jsonError(404, 'not_found');

    // Idempotent: clearing a connector that has no icon is a no-op success.
    removeUploadedFile(current);
    await pool.query(
      `UPDATE mcp_connectors SET icon = NULL, updated_at = NOW() WHERE id = $1 AND org_id = $2`,
      [id, claims.orgId],
    );
    // Sweep the uploads dir if it is now empty so the tree does not accumulate
    // empty parents, then restore it so the next upload needs no mkdir race.
    try {
      if (readdirSync(connectorIconUploadDir()).length === 0) {
        rmSync(connectorIconUploadDir(), { recursive: true, force: true });
      }
    } catch {
      /* not empty / already gone */
    }
    if (!existsSync(connectorIconUploadDir())) mkdirSync(connectorIconUploadDir(), { recursive: true });

    await auditStore.write({
      orgId: claims.orgId,
      userId: claims.sub,
      action: AuditAction.McpConnectorIconClear,
      targetType: 'connector',
      targetId: id,
    });
    return c.json({ ok: true });
  },
);
