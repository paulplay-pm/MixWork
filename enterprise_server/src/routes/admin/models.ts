import { Hono } from 'hono';
import { z } from 'zod';

import { requirePermission } from '../../auth/middleware';
import { MODEL_TYPE_VALUES,modelCatalog, ModelType, ModelTypeValue } from '../../models/modelCatalog';
import { modelTypeDefaults } from '../../models/modelTypeDefaults';
import { PermissionPoint as PP } from '../../shared/permissionPoints';

/** Legacy 6-value single-type vocabulary (deprecated `type` field). Distinct
 * from the 8-value `MODEL_TYPE_VALUES` multi-type list in modelCatalog —
 * renamed to avoid a name collision with the new export. */
const LEGACY_TYPE_VALUES = Object.values(ModelType) as [ModelType, ...ModelType[]];

/** PATCH /admin/models/:id body. Typed so the `.catch(() => ({}))` fallback
 * (malformed/empty JSON) doesn't collapse every property access to `unknown`. */
interface ModelPatchBody {
  displayName?: string;
  type?: ModelType;
  types?: string[];
  enabled?: boolean;
  capabilities?: {
    supportsImage?: boolean;
    supportsVideo?: boolean;
    supportsThinking?: boolean;
    contextWindow?: number | null;
    maxTokens?: number | null;
    temperature?: number | null;
    topP?: number | null;
    maxOutputTokens?: number | null;
  };
  /** Mark this model as the org's default for one capability type. The type
   * is inside the object because the path carries the model id but not the
   * type, and "clear the default" is meaningless without naming the type. */
  defaultForType?: { type: string; isDefault: boolean };
  /** Free-form capability parameters; stored as JSONB in `parameter_spec`. */
  parameterSpec?: Record<string, unknown>;
}

export const adminModelRoutes = new Hono();

adminModelRoutes.get('/admin/models', requirePermission(PP.ModelView), async (c) => {
  const orgId = c.req.query('orgId');
  if (!orgId) return c.json({ error: 'orgId required' }, 400);
  // Cross-tenant guard: the orgId query param must match the caller's token.
  const claims = c.get('claims');
  if (orgId !== claims.orgId) return c.json({ error: 'org_mismatch' }, 400);
  return c.json(await modelCatalog.listForAdmin(orgId));
});

adminModelRoutes.post('/admin/models', requirePermission(PP.ModelCreate), async (c) => {
  const parsed = z
    .object({
      orgId: z.string(),
      providerKeyId: z.string(),
      provider: z.string(),
      model: z.string(),
      displayName: z.string().optional(),
      type: z.enum(LEGACY_TYPE_VALUES).optional(),
      types: z
        .array(z.enum(MODEL_TYPE_VALUES as [ModelTypeValue, ...ModelTypeValue[]]))
        .min(1)
        .optional(),
      quotaPerDay: z.number().int().nullable().optional(),
      capabilities: z
        .object({
          supportsImage: z.boolean().optional(),
          supportsVideo: z.boolean().optional(),
          supportsThinking: z.boolean().optional(),
          contextWindow: z.number().int().nullable().optional(),
          maxTokens: z.number().int().nullable().optional(),
          temperature: z.number().min(0).max(2).nullable().optional(),
          topP: z.number().min(0).max(1).nullable().optional(),
          maxOutputTokens: z.number().int().min(1).max(200000).nullable().optional(),
        })
        .optional(),
      parameterSpec: z.record(z.unknown()).optional(),
    })
    .safeParse(await c.req.json());
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join('.') ?? 'body';
    return c.json({ error: 'validation_error', field }, 400);
  }
  const body = parsed.data;
  // Cross-tenant guard: the body's orgId must match the caller's token.
  const claims = c.get('claims');
  if (body.orgId !== claims.orgId) return c.json({ error: 'org_mismatch' }, 400);
  try {
    const { id } = await modelCatalog.add({
      orgId: body.orgId,
      providerKeyId: body.providerKeyId,
      provider: body.provider,
      model: body.model,
      displayName: body.displayName,
      type: body.type,
      types: body.types,
      quotaPerDay: body.quotaPerDay,
      capabilities: body.capabilities
        ? {
            supports_image: body.capabilities.supportsImage ?? false,
            supports_video: body.capabilities.supportsVideo ?? false,
            supports_thinking: body.capabilities.supportsThinking ?? false,
            context_window: body.capabilities.contextWindow ?? null,
            max_tokens: body.capabilities.maxTokens ?? null,
            temperature: body.capabilities.temperature ?? null,
            top_p: body.capabilities.topP ?? null,
            max_output_tokens: body.capabilities.maxOutputTokens ?? null,
          }
        : undefined,
      parameterSpec: body.parameterSpec,
    });
    return c.json({ id });
  } catch (e) {
    if ((e as Error).message === 'model_duplicate') {
      return c.json({ error: 'model_duplicate' }, 409);
    }
    throw e;
  }
});

adminModelRoutes.patch('/admin/models/:id', requirePermission(PP.ModelEdit), async (c) => {
  const body: ModelPatchBody = (await c.req.json().catch(() => ({}))) as ModelPatchBody;

  const orgId = c.req.query('orgId');
  if (!orgId) return c.json({ error: 'orgId required' }, 400);
  // Cross-tenant guard: the orgId query param must match the caller's token.
  const claims = c.get('claims');
  if (orgId !== claims.orgId) return c.json({ error: 'org_mismatch' }, 400);
  const id = c.req.param('id');

  if (body.capabilities) {
    const { temperature, topP, maxOutputTokens } = body.capabilities;
    if (temperature != null && (temperature < 0 || temperature > 2)) {
      return c.json({ error: 'validation_error', field: 'temperature' }, 400);
    }
    if (topP != null && (topP < 0 || topP > 1)) {
      return c.json({ error: 'validation_error', field: 'topP' }, 400);
    }
    if (maxOutputTokens != null && (maxOutputTokens < 1 || maxOutputTokens > 200000)) {
      return c.json({ error: 'validation_error', field: 'maxOutputTokens' }, 400);
    }
  }

  if (body.type !== undefined && !LEGACY_TYPE_VALUES.includes(body.type)) {
    return c.json({ error: 'validation_error', field: 'type' }, 400);
  }

  if (body.types !== undefined && (!Array.isArray(body.types) || body.types.length === 0 || body.types.some((t) => !MODEL_TYPE_VALUES.includes(t as ModelTypeValue)))) {
    return c.json({ error: 'validation_error', field: 'types' }, 400);
  }

  // `parameterSpec` is free-form JSON, so its shape is checked here: a
  // non-object would not survive the JSONB column.
  if (
    body.parameterSpec !== undefined
    && (
      typeof body.parameterSpec !== 'object'
      || body.parameterSpec === null
      || Array.isArray(body.parameterSpec)
    )
  ) {
    return c.json({ error: 'validation_error', field: 'parameterSpec' }, 400);
  }

  // The default-model flag: the type must be one the model actually carries.
  let defaultForType: { type: ModelTypeValue; isDefault: boolean } | undefined;
  if (body.defaultForType !== undefined) {
    const dft = body.defaultForType;
    if (
      !dft
      || typeof dft.type !== 'string'
      || !MODEL_TYPE_VALUES.includes(dft.type as ModelTypeValue)
    ) {
      return c.json({ error: 'validation_error', field: 'defaultForType.type' }, 400);
    }
    if (typeof dft.isDefault !== 'boolean') {
      return c.json({ error: 'validation_error', field: 'defaultForType.isDefault' }, 400);
    }
    defaultForType = { type: dft.type as ModelTypeValue, isDefault: dft.isDefault };
  }

  // Validate the default-model request BEFORE writing anything: a rejected
  // request must not leave half of its fields applied.
  if (defaultForType?.isDefault) {
    const model = await modelCatalog.getById(id);
    if (!model || model.org_id !== orgId) return c.json({ error: 'model_not_found' }, 404);
    // The type list this request produces: the body may be re-typing the
    // model in the same call.
    const effectiveTypes = body.types ?? model.types;
    if (!effectiveTypes.includes(defaultForType.type)) {
      return c.json({ error: 'type_mismatch', field: 'defaultForType.type' }, 400);
    }
  }

  const ok = await modelCatalog.patch(orgId, id, {
    // Only write the display name when the request mentions it: this route is
    // also the target of single-field PATCHes (the enable switch, the
    // per-type default), and `?? null` would wipe the admin's label on every
    // one of them.
    display_name: 'displayName' in body ? (body.displayName ?? null) : undefined,
    type: body.type,
    // Validated against the 8-value set above.
    types: body.types as ModelTypeValue[] | undefined,
    enabled: body.enabled,
    capabilities: body.capabilities
      ? {
          supports_image: body.capabilities.supportsImage,
          supports_video: body.capabilities.supportsVideo,
          supports_thinking: body.capabilities.supportsThinking,
          context_window: body.capabilities.contextWindow,
          max_tokens: body.capabilities.maxTokens,
          temperature: body.capabilities.temperature,
          top_p: body.capabilities.topP,
          max_output_tokens: body.capabilities.maxOutputTokens,
        }
      : undefined,
    parameterSpec: body.parameterSpec,
  });
  if (!ok) return c.json({ error: 'model_not_found' }, 404);

  if (defaultForType) {
    if (defaultForType.isDefault) {
      await modelTypeDefaults.set(orgId, defaultForType.type, id);
    } else {
      // Only clear when this model IS the current default: the console never
      // asks to clear another model's default, and silently clearing it would
      // be a surprise.
      const current = await modelTypeDefaults.get(orgId, defaultForType.type);
      if (current === id) await modelTypeDefaults.clear(orgId, defaultForType.type);
    }
  }
  return c.json({ ok: true });
});

/**
 * The org's default model per capability type. The console renders the
 * "默认" badge on the model's type chip, so it needs to know which
 * (model, type) pairs are defaults.
 */
adminModelRoutes.get('/admin/model-type-defaults', requirePermission(PP.ModelView), async (c) => {
  const orgId = c.req.query('orgId');
  if (!orgId) return c.json({ error: 'orgId required' }, 400);
  // Cross-tenant guard: the orgId query param must match the caller's token.
  const claims = c.get('claims');
  if (orgId !== claims.orgId) return c.json({ error: 'org_mismatch' }, 400);
  return c.json(await modelTypeDefaults.listForOrg(orgId));
});

adminModelRoutes.delete('/admin/models/:id', requirePermission(PP.ModelDelete), async (c) => {
  const orgId = c.req.query('orgId');
  if (!orgId) return c.json({ error: 'orgId required' }, 400);
  // Cross-tenant guard: the orgId query param must match the caller's token.
  const claims = c.get('claims');
  if (orgId !== claims.orgId) return c.json({ error: 'org_mismatch' }, 400);
  const id = c.req.param('id');
  const ok = await modelCatalog.remove(orgId, id);
  if (!ok) return c.json({ error: 'model_not_found' }, 404);
  return c.json({ ok: true });
});

adminModelRoutes.patch('/admin/models/:id/quota', requirePermission(PP.ModelEdit), async (c) => {
  const body = z
    .object({ quotaPerDay: z.number().int().nullable() })
    .parse(await c.req.json());
  await modelCatalog.setQuota(c.req.param('id'), body.quotaPerDay);
  return c.json({ ok: true });
});

adminModelRoutes.post('/admin/models/:id/disable', requirePermission(PP.ModelEdit), async (c) => {
  const claims = c.get('claims');
  const modelId = c.req.param('id');
  await modelCatalog.setModelDisabled(claims.orgId, modelId, true, claims.sub);
  return c.json({ ok: true });
});

adminModelRoutes.post('/admin/models/:id/enable', requirePermission(PP.ModelEdit), async (c) => {
  const claims = c.get('claims');
  const modelId = c.req.param('id');
  await modelCatalog.setModelDisabled(claims.orgId, modelId, false, claims.sub);
  return c.json({ ok: true });
});