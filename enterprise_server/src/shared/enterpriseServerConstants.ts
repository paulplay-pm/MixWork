export const Role = {
  SuperAdmin: 'super_admin',
  Admin: 'admin',
  User: 'user',
} as const;
export type Role = typeof Role[keyof typeof Role];

export const PermissionCode = {
  UsersManage: 'users.manage',
  RolesManage: 'roles.manage',
  DepartmentsManage: 'departments.manage',
  ModelsManage: 'models.manage',
  ProviderKeysManage: 'provider_keys.manage',
  SkillsManage: 'skills.manage',
  AuditView: 'audit.view',
  ReleasesManage: 'releases.manage',
  McpManage: 'mcp.manage',
  AgentsManage: 'agents.manage',
} as const;
export type PermissionCode = typeof PermissionCode[keyof typeof PermissionCode];

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
  SkillToggle: 'skill_toggle',
  SkillDelete: 'skill_delete',
  SkillCategoryCreate: 'skill_category_create',
  SkillCategoryUpdate: 'skill_category_update',
  SkillCategoryDelete: 'skill_category_delete',
  AgentIconUpload: 'agent_icon_upload',
  AgentIconClear: 'agent_icon_clear',
  KitIconUpload: 'kit_icon_upload',
  KitIconClear: 'kit_icon_clear',
  SkillIconUpload: 'skill_icon_upload',
  SkillIconClear: 'skill_icon_clear',
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
export type AuditAction = typeof AuditAction[keyof typeof AuditAction];

export const ProviderProxyResultCode = {
  Ok: 200,
  QuotaExceeded: 429,
  ModelDisabled: 403,
  Unauthorized: 401,
  NotFound: 404,
} as const;
export type ProviderProxyResultCode =
  typeof ProviderProxyResultCode[keyof typeof ProviderProxyResultCode];

/**
 * `error` discriminants the LLM proxy writes into its JSON error bodies. The
 * desktop mirrors these (MixWork `src/shared/enterpriseAccount/proxyWireSignals.ts`)
 * and reads them out of the OpenClaw-preserved raw error body, so these string
 * values are the source of truth for the wire. Kept separate from
 * `ProviderProxyResultCode` (the numeric HTTP status) because the desktop keys
 * off the body discriminator, not the status line.
 */
/**
 * Numeric error codes the DESKTOP reads out of a response body.
 *
 * The desktop's membership-revocation hook (`readEnterpriseApiErrorCode`)
 * looks for `body.code === EnterpriseApiErrorCode.NotMember` — a NUMBER. The
 * wire error string (`'not_member'`) is what the LLM proxy historically
 * returned, and a body carrying only that string never triggers revocation on
 * the client. The ASR and media routes therefore emit the numeric code so a
 * revoked member is actually signed out instead of being shown a login prompt
 * forever.
 */
export const EnterpriseApiErrorCode = {
  NotMember: 41602,
} as const;
export type EnterpriseApiErrorCode = typeof EnterpriseApiErrorCode[keyof typeof EnterpriseApiErrorCode];

export const ProviderProxyWireError = {
  QuotaExceeded: 'quota_exceeded',
  NotMember: 'not_member',
} as const;
export type ProviderProxyWireError =
  typeof ProviderProxyWireError[keyof typeof ProviderProxyWireError];

/** `reason` discriminator on the `429` quota-exceeded body. */
export const ProviderProxyQuotaReason = {
  DailyQuotaExhausted: 'daily_quota_exhausted',
} as const;
export type ProviderProxyQuotaReason =
  typeof ProviderProxyQuotaReason[keyof typeof ProviderProxyQuotaReason];

/**
 * Browser session cookie used to authenticate org-restricted share pages
 * (Phase 2: "org-only" links prompt for login in a browser instead of
 * returning a bare 401). The cookie carries the same signed JWT the SPA
 * stores in localStorage, so `verifyToken` re-validates it on every page
 * serve. Set by POST /auth/login, cleared by POST /auth/logout.
 */
export const AuthSessionCookie = 'mixwork_session';

/** Max-Age (seconds) for the session cookie. Matches the 1h JWT lifetime. */
export const AUTH_SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60;

/**
 * `error` codes returned by `POST /auth/login` (and by the pre-login
 * `/auth/sso/*` routes) in the JSON body.
 *
 * The clients map each code to a localized message instead of showing a raw
 * HTTP status, so the strings are a wire contract. Keep them in sync with:
 *   - desktop: `src/shared/enterpriseAccount/loginErrorCodes.ts`
 *   - web console: `enterprise_server/web/src/shared/loginErrorCodes.ts`
 */
export const LoginErrorCode = {
  /** The submitted org name does not exist. */
  OrgNotFound: 'org_not_found',
  /** The username does not exist in that org. */
  UserNotFound: 'user_not_found',
  /** The username exists but the password does not match. */
  InvalidPassword: 'invalid_password',
  /** The account exists but has been disabled by an admin. */
  UserDisabled: 'user_disabled',
  /** Too many failed attempts for this org+username (HTTP 429). */
  RateLimited: 'rate_limited',
  /** The server hosts several orgs and the client did not pick one (HTTP 400). */
  OrgRequired: 'org_required',
  /** Generic failure — unknown org, unknown user, or wrong password. */
  Invalid: 'invalid',
} as const;
export type LoginErrorCode = typeof LoginErrorCode[keyof typeof LoginErrorCode];