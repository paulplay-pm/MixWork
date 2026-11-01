/**
 * Audit action display labels for the admin SPA — a hand-kept mirror of
 * `enterprise_server/src/shared/auditActionMeta.ts` (see
 * web/src/shared/permissions.ts for the established mirror convention — the
 * SPA does not import from the server's src/). 71 action codes, keyed to the
 * same `AuditAction` values the server declares in
 * `src/shared/enterpriseServerConstants.ts`.
 *
 * If an action code is added, removed or relabelled server-side, update this
 * file; `web/tests/shared/auditActionMeta.parity.test.ts` imports the server
 * module directly and fails in BOTH directions until the mirror is back in
 * step.
 *
 * The local `AuditAction` const below exists only so this file is
 * self-contained and `AUDIT_ACTION_META` stays `Record<…, …>`-typed (a row
 * missing here is a compile error, not a blank cell). It is NOT a substitute
 * for the parity test — two mirrors can agree with each other and still drift
 * from the server.
 */

/**
 * Semantic colour for an audit row; the SPA maps each tone onto a badge. Kept
 * identical to the server's `AuditTone`.
 */
export const AuditTone = {
  Auth: 'auth',
  Success: 'success',
  Failure: 'failure',
  Change: 'change',
  Danger: 'danger',
  Normal: 'normal',
} as const;
export type AuditTone = (typeof AuditTone)[keyof typeof AuditTone];

/** Mirror of the server's `AuditAction`; see the header note. */
export const AuditAction = {
  Login: 'login',
  LoginFailed: 'login_failed',
  TokenRefresh: 'token_refresh',
  ProviderCall: 'provider_call',
  QuotaExceeded: 'quota_exceeded',
  QuotaWarning: 'quota_warning',
  AdminAccessDenied: 'admin_access_denied',
  SetupRedeem: 'setup_redeem',
  ProviderKeyAdd: 'provider_key_add',
  ProviderKeyUpdate: 'provider_key_update',
  ProviderKeyDelete: 'provider_key_delete',
  ProviderKeyBuiltinDelete: 'provider_key_builtin_delete',
  UserCreate: 'user_create',
  UserPatch: 'user_patch',
  UserBatch: 'user_batch',
  UserDisable: 'user_disable',
  UserEnable: 'user_enable',
  UserResetPassword: 'user_reset_password',
  UserArchive: 'workspace_archive',
  ReadUserWorkspace: 'read_user_workspace',
  PasswordChange: 'password_change',
  ProfileUpdate: 'profile_update',
  ReleaseCreate: 'release_create',
  ReleaseUpdate: 'release_update',
  ReleaseSetLatest: 'release_set_latest',
  ReleaseDelete: 'release_delete',
  EnterpriseModelsSync: 'enterprise_models_sync',
  HtmlShareCreate: 'html_share_create',
  HtmlShareDelete: 'html_share_delete',
  RoleCreate: 'role_create',
  RoleUpdate: 'role_update',
  RoleDelete: 'role_delete',
  RoleCopy: 'role_copy',
  DeptCreate: 'dept_create',
  DeptUpdate: 'dept_update',
  DeptMove: 'dept_move',
  DeptDelete: 'dept_delete',
  DeptReorder: 'dept_reorder',
  AgentCreate: 'agent_create',
  AgentUpdate: 'agent_update',
  AgentDelete: 'agent_delete',
  AgentIconUpload: 'agent_icon_upload',
  AgentIconClear: 'agent_icon_clear',
  McpConnectorCreate: 'mcp_connector_create',
  McpGatewayCall: 'mcp_gateway_call',
  McpConnectorUpdate: 'mcp_connector_update',
  McpConnectorDelete: 'mcp_connector_delete',
  McpConnectorToggle: 'mcp_connector_toggle',
  McpConnectorTest: 'mcp_connector_test',
  McpConnectorIconUpload: 'mcp_connector_icon_upload',
  McpConnectorIconClear: 'mcp_connector_icon_clear',
  McpConnectorCategoryCreate: 'mcp_connector_category_create',
  McpConnectorCategoryDelete: 'mcp_connector_category_delete',
  McpConnectorSettingUpdate: 'mcp_connector_setting_update',
  McpSubmissionSubmit: 'mcp_submission_submit',
  McpSubmissionApprove: 'mcp_submission_approve',
  McpSubmissionReject: 'mcp_submission_reject',
  McpSubmissionWithdraw: 'mcp_submission_withdraw',
  SkillCreate: 'skill_create',
  SkillUpdate: 'skill_update',
  SkillIconUpload: 'skill_icon_upload',
  SkillIconClear: 'skill_icon_clear',
  SkillToggle: 'skill_toggle',
  SkillDelete: 'skill_delete',
  SkillCategoryCreate: 'skill_category_create',
  SkillCategoryUpdate: 'skill_category_update',
  SkillCategoryDelete: 'skill_category_delete',
  KitIconUpload: 'kit_icon_upload',
  KitIconClear: 'kit_icon_clear',
  KitCreate: 'kit_create',
  KitUpdate: 'kit_update',
  KitToggle: 'kit_toggle',
  KitDelete: 'kit_delete',
  KitCategoryCreate: 'kit_category_create',
  KitCategoryUpdate: 'kit_category_update',
  KitCategoryDelete: 'kit_category_delete',
  SkillSubmissionSubmit: 'skill_submission_submit',
  SkillSubmissionApprove: 'skill_submission_approve',
  SkillSubmissionReject: 'skill_submission_reject',
  SkillSubmissionWithdraw: 'skill_submission_withdraw',
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditActionMeta {
  zh: string;
  en: string;
  tone: AuditTone;
}

/** Identical to the server's table; see the header note. */
export const AUDIT_ACTION_META: Record<AuditAction, AuditActionMeta> = {
  // --- authentication ---------------------------------------------------
  [AuditAction.Login]: { zh: '登录', en: 'Signed in', tone: AuditTone.Auth },
  [AuditAction.LoginFailed]: { zh: '登录失败', en: 'Sign-in failed', tone: AuditTone.Failure },
  [AuditAction.TokenRefresh]: { zh: '令牌刷新', en: 'Refreshed token', tone: AuditTone.Auth },
  [AuditAction.PasswordChange]: { zh: '修改密码', en: 'Changed password', tone: AuditTone.Auth },

  // --- proxy / quota ----------------------------------------------------
  [AuditAction.ProviderCall]: { zh: '调用模型服务商', en: 'Called model provider', tone: AuditTone.Normal },
  [AuditAction.QuotaExceeded]: { zh: '配额超限', en: 'Quota exceeded', tone: AuditTone.Failure },
  [AuditAction.QuotaWarning]: { zh: '配额预警', en: 'Quota warning', tone: AuditTone.Normal },
  [AuditAction.AdminAccessDenied]: { zh: '管理访问被拒绝', en: 'Admin access denied', tone: AuditTone.Failure },
  [AuditAction.SetupRedeem]: { zh: '完成初始化', en: 'Completed setup', tone: AuditTone.Success },

  // --- provider keys ---------------------------------------------------
  [AuditAction.ProviderKeyAdd]: { zh: '添加服务商密钥', en: 'Added provider key', tone: AuditTone.Change },
  [AuditAction.ProviderKeyUpdate]: { zh: '更新服务商密钥', en: 'Updated provider key', tone: AuditTone.Change },
  [AuditAction.ProviderKeyDelete]: { zh: '删除服务商密钥', en: 'Deleted provider key', tone: AuditTone.Danger },
  [AuditAction.ProviderKeyBuiltinDelete]: {
    zh: '删除内置服务商密钥',
    en: 'Deleted built-in provider key',
    tone: AuditTone.Danger,
  },

  // --- users -----------------------------------------------------------
  [AuditAction.UserCreate]: { zh: '创建用户', en: 'Created user', tone: AuditTone.Normal },
  [AuditAction.UserPatch]: { zh: '更新用户', en: 'Updated user', tone: AuditTone.Change },
  [AuditAction.UserBatch]: { zh: '批量操作用户', en: 'Batch user operation', tone: AuditTone.Change },
  [AuditAction.UserDisable]: { zh: '停用用户', en: 'Disabled user', tone: AuditTone.Danger },
  [AuditAction.UserEnable]: { zh: '启用用户', en: 'Enabled user', tone: AuditTone.Normal },
  [AuditAction.UserResetPassword]: { zh: '重置用户密码', en: 'Reset user password', tone: AuditTone.Change },
  [AuditAction.ProfileUpdate]: { zh: '更新个人资料', en: 'Updated profile', tone: AuditTone.Change },
  [AuditAction.UserArchive]: { zh: '归档工作区', en: 'Archived workspace', tone: AuditTone.Normal },
  [AuditAction.ReadUserWorkspace]: { zh: '模拟登录用户', en: 'Impersonated user', tone: AuditTone.Danger },

  // --- releases --------------------------------------------------------
  [AuditAction.ReleaseCreate]: { zh: '创建版本', en: 'Created release', tone: AuditTone.Normal },
  [AuditAction.ReleaseUpdate]: { zh: '更新版本', en: 'Updated release', tone: AuditTone.Change },
  [AuditAction.ReleaseSetLatest]: { zh: '设为最新版本', en: 'Set release as latest', tone: AuditTone.Change },
  [AuditAction.ReleaseDelete]: { zh: '删除版本', en: 'Deleted release', tone: AuditTone.Danger },

  // --- org-wide config -------------------------------------------------
  [AuditAction.EnterpriseModelsSync]: {
    zh: '企业模型同步',
    en: 'Synced enterprise models',
    tone: AuditTone.Success,
  },

  // --- HTML shares -----------------------------------------------------
  [AuditAction.HtmlShareCreate]: { zh: '创建 HTML 分享', en: 'Created HTML share', tone: AuditTone.Normal },
  [AuditAction.HtmlShareDelete]: { zh: '删除 HTML 分享', en: 'Deleted HTML share', tone: AuditTone.Danger },

  // --- roles -----------------------------------------------------------
  [AuditAction.RoleCreate]: { zh: '创建角色', en: 'Created role', tone: AuditTone.Normal },
  [AuditAction.RoleUpdate]: { zh: '更新角色', en: 'Updated role', tone: AuditTone.Change },
  [AuditAction.RoleDelete]: { zh: '删除角色', en: 'Deleted role', tone: AuditTone.Danger },
  [AuditAction.RoleCopy]: { zh: '复制角色', en: 'Copied role', tone: AuditTone.Normal },

  // --- departments -----------------------------------------------------
  [AuditAction.DeptCreate]: { zh: '创建部门', en: 'Created department', tone: AuditTone.Normal },
  [AuditAction.DeptUpdate]: { zh: '更新部门', en: 'Updated department', tone: AuditTone.Change },
  [AuditAction.DeptMove]: { zh: '移动部门', en: 'Moved department', tone: AuditTone.Change },
  [AuditAction.DeptDelete]: { zh: '删除部门', en: 'Deleted department', tone: AuditTone.Danger },
  [AuditAction.DeptReorder]: { zh: '调整部门顺序', en: 'Reordered departments', tone: AuditTone.Change },

  // --- agents ----------------------------------------------------------
  [AuditAction.AgentCreate]: { zh: '创建智能体', en: 'Created agent', tone: AuditTone.Normal },
  [AuditAction.AgentUpdate]: { zh: '更新智能体', en: 'Updated agent', tone: AuditTone.Change },
  [AuditAction.AgentIconUpload]: { zh: '上传智能体图标', en: 'Uploaded agent icon', tone: AuditTone.Change },
  [AuditAction.AgentIconClear]: { zh: '清除智能体图标', en: 'Cleared agent icon', tone: AuditTone.Change },
  [AuditAction.AgentDelete]: { zh: '删除智能体', en: 'Deleted agent', tone: AuditTone.Danger },

  // --- MCP services ----------------------------------------------------
  [AuditAction.McpConnectorCreate]: { zh: '创建 MCP 服务', en: 'Created MCP service', tone: AuditTone.Normal },
  [AuditAction.McpConnectorUpdate]: { zh: '更新 MCP 服务', en: 'Updated MCP service', tone: AuditTone.Change },
  [AuditAction.McpConnectorDelete]: { zh: '删除 MCP 服务', en: 'Deleted MCP service', tone: AuditTone.Danger },
  [AuditAction.McpConnectorToggle]: {
    zh: '切换 MCP 服务启用状态',
    en: 'Toggled MCP service',
    tone: AuditTone.Change,
  },
  [AuditAction.McpConnectorTest]: { zh: '测试 MCP 服务', en: 'Tested MCP service', tone: AuditTone.Normal },
  [AuditAction.McpConnectorIconUpload]: { zh: '上传 MCP 服务图标', en: 'Uploaded MCP service icon', tone: AuditTone.Change },
  [AuditAction.McpConnectorIconClear]: { zh: '清除 MCP 服务图标', en: 'Cleared MCP service icon', tone: AuditTone.Change },
  [AuditAction.McpGatewayCall]: {
    zh: '经网关调用 MCP 工具',
    en: 'Called an MCP tool through the gateway',
    tone: AuditTone.Normal,
  },
  [AuditAction.McpConnectorCategoryCreate]: {
    zh: '创建 MCP 分类',
    en: 'Created MCP category',
    tone: AuditTone.Normal,
  },
  [AuditAction.McpConnectorCategoryDelete]: {
    zh: '删除 MCP 分类',
    en: 'Deleted MCP category',
    tone: AuditTone.Danger,
  },
  [AuditAction.McpConnectorSettingUpdate]: {
    zh: '更新 MCP 提交设置',
    en: 'Updated MCP submission setting',
    tone: AuditTone.Change,
  },

  // --- MCP submissions -------------------------------------------------
  [AuditAction.McpSubmissionSubmit]: {
    zh: '提交 MCP 服务审核',
    en: 'Submitted MCP service for review',
    tone: AuditTone.Normal,
  },
  [AuditAction.McpSubmissionApprove]: {
    zh: 'MCP 服务审核通过',
    en: 'Approved MCP service submission',
    tone: AuditTone.Success,
  },
  [AuditAction.McpSubmissionReject]: {
    zh: 'MCP 服务审核拒绝',
    en: 'Rejected MCP service submission',
    tone: AuditTone.Failure,
  },
  [AuditAction.McpSubmissionWithdraw]: {
    zh: '撤回 MCP 服务提交',
    en: 'Withdrew MCP service submission',
    tone: AuditTone.Normal,
  },

  // --- skills ----------------------------------------------------------
  [AuditAction.SkillCreate]: { zh: '创建技能', en: 'Created skill', tone: AuditTone.Normal },
  [AuditAction.SkillIconUpload]: { zh: '上传技能图标', en: 'Uploaded skill icon', tone: AuditTone.Change },
  [AuditAction.SkillIconClear]: { zh: '清除技能图标', en: 'Cleared skill icon', tone: AuditTone.Change },
  [AuditAction.SkillUpdate]: { zh: '更新技能', en: 'Updated skill', tone: AuditTone.Change },
  [AuditAction.SkillToggle]: { zh: '切换技能启用状态', en: 'Toggled skill', tone: AuditTone.Change },
  [AuditAction.SkillDelete]: { zh: '删除技能', en: 'Deleted skill', tone: AuditTone.Danger },
  [AuditAction.SkillCategoryCreate]: {
    zh: '创建技能分类',
    en: 'Created skill category',
    tone: AuditTone.Normal,
  },
  [AuditAction.SkillCategoryUpdate]: {
    zh: '更新技能分类',
    en: 'Updated skill category',
    tone: AuditTone.Change,
  },
  [AuditAction.SkillCategoryDelete]: {
    zh: '删除技能分类',
    en: 'Deleted skill category',
    tone: AuditTone.Danger,
  },

  // --- kits -----------------------------------------------------------
  [AuditAction.KitCreate]: { zh: '创建套件', en: 'Created kit', tone: AuditTone.Normal },
  [AuditAction.KitIconUpload]: { zh: '上传套件图标', en: 'Uploaded kit icon', tone: AuditTone.Change },
  [AuditAction.KitIconClear]: { zh: '清除套件图标', en: 'Cleared kit icon', tone: AuditTone.Change },
  [AuditAction.KitUpdate]: { zh: '更新套件', en: 'Updated kit', tone: AuditTone.Change },
  [AuditAction.KitToggle]: { zh: '切换套件启用状态', en: 'Toggled kit', tone: AuditTone.Change },
  [AuditAction.KitDelete]: { zh: '删除套件', en: 'Deleted kit', tone: AuditTone.Danger },
  [AuditAction.KitCategoryCreate]: {
    zh: '创建套件分类',
    en: 'Created kit category',
    tone: AuditTone.Normal,
  },
  [AuditAction.KitCategoryUpdate]: {
    zh: '更新套件分类',
    en: 'Updated kit category',
    tone: AuditTone.Change,
  },
  [AuditAction.KitCategoryDelete]: {
    zh: '删除套件分类',
    en: 'Deleted kit category',
    tone: AuditTone.Danger,
  },

  // --- skill submissions -----------------------------------------------
  [AuditAction.SkillSubmissionSubmit]: {
    zh: '提交技能审核',
    en: 'Submitted skill for review',
    tone: AuditTone.Normal,
  },
  [AuditAction.SkillSubmissionApprove]: {
    zh: '技能审核通过',
    en: 'Approved skill',
    tone: AuditTone.Success,
  },
  [AuditAction.SkillSubmissionReject]: {
    zh: '技能审核拒绝',
    en: 'Rejected skill',
    tone: AuditTone.Failure,
  },
  [AuditAction.SkillSubmissionWithdraw]: {
    zh: '撤回技能提交',
    en: 'Withdrew skill submission',
    tone: AuditTone.Normal,
  },
};

/**
 * `POST /audit` lets any authenticated client self-report an `action` string
 * it made up, so this falls back to the raw code with a neutral tone rather
 * than throwing or rendering a blank cell.
 *
 * The `hasOwnProperty` guard is load-bearing: `action` is client-controlled,
 * and a bare `TABLE[key] ?? fallback` would return
 * `Object.prototype.constructor` for `'constructor'` — a function whose `zh`
 * is undefined, rendering the blank cell the fallback exists to prevent.
 */
export function auditActionMeta(action: string): AuditActionMeta {
  if (Object.prototype.hasOwnProperty.call(AUDIT_ACTION_META, action)) {
    return AUDIT_ACTION_META[action as AuditAction];
  }
  return { zh: action, en: action, tone: AuditTone.Normal };
}