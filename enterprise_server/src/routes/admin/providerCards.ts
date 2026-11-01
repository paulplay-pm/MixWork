import { Hono } from 'hono';
import { z } from 'zod';

import { auditStore } from '../../audit/auditStore';
import { requirePermission } from '../../auth/middleware';
import { providerCards } from '../../models/providerCards';
import { AuditAction } from '../../shared/enterpriseServerConstants';
import { PermissionPoint as PP } from '../../shared/permissionPoints';

export const adminProviderCardRoutes = new Hono();

adminProviderCardRoutes.get('/admin/provider-cards', requirePermission(PP.ProviderView), async c => {
  const orgId = c.req.query('orgId');
  if (!orgId) return c.json({ error: 'orgId required' }, 400);
  // Cross-tenant guard: the orgId query param must match the caller's token.
  const claims = c.get('claims');
  if (orgId !== claims.orgId) return c.json({ error: 'org_mismatch' }, 400);
  return c.json(await providerCards.list(orgId));
});

adminProviderCardRoutes.post('/admin/provider-cards', requirePermission(PP.ProviderEdit), async c => {
  const claims = c.get('claims');
  const parsed = z
    .object({
      orgId: z.string(),
      provider: z.string().min(1),
      label: z.string().optional(),
    })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join('.') ?? 'body';
    return c.json({ error: 'validation_error', field }, 400);
  }
  const body = parsed.data;
  // Cross-tenant guard: the body's orgId must match the caller's token.
  if (body.orgId !== claims.orgId) return c.json({ error: 'org_mismatch' }, 400);
  let id: string;
  try {
    ({ id } = await providerCards.create({
      orgId: body.orgId,
      provider: body.provider,
      label: body.label,
      createdBy: claims.sub,
    }));
  } catch (err) {
    // The card's qualified-name prefix is unique per org. A duplicate is a
    // client mistake (the admin picked a vendor that already has a card),
    // not a server failure.
    if (err instanceof Error && err.message === 'card_duplicate') {
      return c.json({ error: 'card_duplicate' }, 409);
    }
    throw err;
  }
  await auditStore.write({
    orgId: body.orgId,
    userId: claims.sub,
    action: AuditAction.ProviderKeyAdd,
    targetType: 'provider_card',
    targetId: id,
    payload: { provider: body.provider, label: body.label },
  });
  return c.json({ id });
});

adminProviderCardRoutes.patch('/admin/provider-cards/:id', requirePermission(PP.ProviderEdit), async c => {
  const claims = c.get('claims');
  const id = c.req.param('id');
  const parsed = z
    .object({
      label: z.string().nullable().optional(),
      enabled: z.boolean().optional(),
    })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join('.') ?? 'body';
    return c.json({ error: 'validation_error', field }, 400);
  }
  const body = parsed.data;
  // A card of another org is a 404, not a 200: the caller must not learn
  // that the id exists somewhere else.
  const existing = await providerCards.getById(claims.orgId, id);
  if (!existing) return c.json({ error: 'card_not_found' }, 404);
  try {
    await providerCards.patch(claims.orgId, id, {
      ...(body.label !== undefined ? { label: body.label } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'card_duplicate') {
      return c.json({ error: 'card_duplicate' }, 409);
    }
    throw err;
  }
  await auditStore.write({
    orgId: claims.orgId,
    userId: claims.sub,
    action: AuditAction.ProviderKeyUpdate,
    targetType: 'provider_card',
    targetId: id,
    payload: { label: body.label, enabled: body.enabled },
  });
  return c.json({ ok: true });
});

adminProviderCardRoutes.delete('/admin/provider-cards/:id', requirePermission(PP.ProviderEdit), async c => {
  const claims = c.get('claims');
  const id = c.req.param('id');
  const existing = await providerCards.getById(claims.orgId, id);
  if (!existing) return c.json({ error: 'card_not_found' }, 404);
  const result = await providerCards.remove(claims.orgId, id);
  await auditStore.write({
    orgId: claims.orgId,
    userId: claims.sub,
    action: AuditAction.ProviderKeyDelete,
    targetType: 'provider_card',
    targetId: id,
    payload: { provider: existing.provider, deletedKeys: result.deletedKeys, deletedModels: result.deletedModels },
  });
  return c.json({ ok: true, ...result });
});
