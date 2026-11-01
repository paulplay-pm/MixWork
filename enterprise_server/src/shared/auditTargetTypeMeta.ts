/**
 * Display label for `audit_events.target_type`.
 *
 * Unlike `AUDIT_ACTION_META`, this list is deliberately NOT exhaustive:
 * `POST /audit` (`src/routes/audit.ts`) accepts any authenticated client and
 * lets it self-report an arbitrary `targetType` string, so no compile-time
 * `Record<SomeEnum, …>` guarantee is possible — the accessor falls back to
 * the raw value instead. Adding a value to `KNOWN_TARGET_TYPES` still forces
 * a matching row via the `Record<KnownTargetType, …>` annotation below.
 */
export const KNOWN_TARGET_TYPES = [
  'agent',
  'agent_references',
  'archive',
  'connector',
  'connector_category',
  'dept',
  'enterprise_models_sync',
  'html_share',
  'kit',
  'kit_category',
  'login',
  'model',
  'org',
  'provider_card',
  'provider_key',
  'release',
  'role',
  'route',
  'skill',
  'skill_category',
  'sso_connection',
  'submission',
  'user',
] as const;
export type KnownTargetType = (typeof KNOWN_TARGET_TYPES)[number];

export interface AuditTargetTypeMeta {
  zh: string;
  en: string;
}

export const AUDIT_TARGET_TYPE_META: Record<KnownTargetType, AuditTargetTypeMeta> = {
  agent: { zh: '智能体', en: 'Agent' },
  agent_references: { zh: '智能体引用', en: 'Agent references' },
  archive: { zh: '归档', en: 'Archive' },
  connector: { zh: 'MCP 服务', en: 'MCP service' },
  connector_category: { zh: 'MCP 分类', en: 'MCP category' },
  dept: { zh: '部门', en: 'Department' },
  enterprise_models_sync: { zh: '企业模型同步', en: 'Enterprise model sync' },
  html_share: { zh: 'HTML 分享', en: 'HTML share' },
  kit: { zh: '套件', en: 'Kit' },
  kit_category: { zh: '套件分类', en: 'Kit category' },
  login: { zh: '登录', en: 'Sign-in' },
  model: { zh: '模型', en: 'Model' },
  org: { zh: '组织', en: 'Organization' },
  provider_card: { zh: '服务商卡片', en: 'Provider card' },
  provider_key: { zh: '服务商密钥', en: 'Provider key' },
  release: { zh: '版本', en: 'Release' },
  role: { zh: '角色', en: 'Role' },
  route: { zh: '接口路径', en: 'API route' },
  skill: { zh: '技能', en: 'Skill' },
  skill_category: { zh: '技能分类', en: 'Skill category' },
  sso_connection: { zh: 'SSO 连接', en: 'SSO connection' },
  submission: { zh: '提交记录', en: 'Submission' },
  user: { zh: '用户', en: 'User' },
};

export interface ResolvedAuditTargetTypeMeta extends AuditTargetTypeMeta {
  value: string;
}

/**
 * Label lookup for the audit feed's object column.
 *
 * `null`/`undefined` means "no object" — returns `null` so the UI can render
 * an em dash rather than the literal string 「null」. Anything unrecognised
 * (a client-invented target type, or a module that starts writing a new one)
 * falls back to the raw value in all three fields, so the row stays readable
 * and the filter link keeps working.
 *
 * The `hasOwnProperty` guard is load-bearing: `targetType` is client-
 * controlled, and a bare `TABLE[key]` would return `Object.prototype.toString`
 * for `'toString'`, spreading a function into the result and leaving `zh` and
 * `en` undefined — the blank cell the fallback exists to prevent.
 */
export function auditTargetTypeMeta(t: string | null | undefined): ResolvedAuditTargetTypeMeta | null {
  if (typeof t !== 'string' || t.length === 0) return null;
  if (!Object.prototype.hasOwnProperty.call(AUDIT_TARGET_TYPE_META, t)) {
    return { value: t, zh: t, en: t };
  }
  return { value: t, ...AUDIT_TARGET_TYPE_META[t as KnownTargetType] };
}