/**
 * Sentinel sessionId for permission requests that arrive without a resolvable
 * OpenClaw session key (e.g. AskUserQuestion callbacks missing sessionKey).
 * The renderer must surface these in whichever session is currently open —
 * they can never match a real session id.
 */
export const SESSION_AGNOSTIC_PERMISSION_SESSION_ID = '__askuser__';

/**
 * Tool name carried by AskUserQuestion requests when they are surfaced through
 * the permission-request channel. Used to classify "waiting for input"
 * requests apart from regular approval requests.
 */
export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion';

/** Default page size for session list pagination. */
export const MIXCWORK_SESSION_PAGE_SIZE = 50;

/** Default page size for message history pagination. */
export const MIXCWORK_MESSAGE_PAGE_SIZE = 30;

/**
 * Number of rows from the full mixed-message timeline inspected per
 * conversation-search request. Search pages intentionally use a separate,
 * bounded projection so tool/system payloads and message metadata never cross
 * the renderer IPC boundary.
 */
export const MIXCWORK_SEARCH_MESSAGE_PAGE_SIZE = 200;

/** Defensive upper bound for renderer-supplied conversation-search page sizes. */
export const MIXCWORK_SEARCH_MESSAGE_PAGE_MAX_SIZE = 500;

/** Maximum aggregate searchable UTF-8 content returned by one IPC page. */
export const MIXCWORK_SEARCH_MESSAGE_PAGE_MAX_CONTENT_BYTES = 16_777_216;

/** Maximum number of rows inspected from the complete mixed-message timeline. */
export const MIXCWORK_SEARCH_HISTORY_MAX_MIXED_ROWS = 100_000;

/** Maximum searchable content retained by the renderer, measured in UTF-16 code units. */
export const MIXCWORK_SEARCH_HISTORY_MAX_CONTENT_CODE_UNITS = 16_777_216;

/** Maximum searchable content retained for one message, measured in UTF-16 code units. */
export const MIXCWORK_SEARCH_HISTORY_MAX_MESSAGE_CONTENT_CODE_UNITS = 1_048_576;

/**
 * Per-working-directory scratch directory for intermediate files (model
 * helper scripts, pasted attachments, drafts). Swept by the mixcwork temp
 * janitor; user-facing deliverables must not live here.
 */
export const MIXCWORK_TEMP_DIR_NAME = '.mixcwork-temp';

/**
 * Subdirectory of the mixcwork temp dir holding pasted/manual attachments.
 * Attachment originals are referenced by message metadata (re-edit restores
 * them), so the janitor never deletes this subtree.
 */
export const MIXCWORK_TEMP_ATTACHMENTS_DIR_NAME = 'attachments';

export const MixCWorkIpcChannel = {
  CancelMediaTask: 'mixcwork:media:cancel',
  GetMediaModels: 'media:getModels',
  MediaStatusPollUpdate: 'mixcwork:media:statusPollUpdate',
  ForkSession: 'mixcwork:session:fork',
  StopSession: 'mixcwork:session:stop',
  SubTaskHistory: 'mixcwork:subTask:history',
  SubagentList: 'mixcwork:subagent:list',
  SubagentListByAgent: 'mixcwork:subagent:listByAgent',
  SubagentDelete: 'mixcwork:subagent:delete',
  MarkSessionViewed: 'mixcwork:session:markViewed',
  SetActiveSession: 'mixcwork:session:setActive',
  ExportSessionDiagnostics: 'mixcwork:session:exportDiagnostics',
  GetSessionMessageRailIndex: 'mixcwork:session:getMessageRailIndex',
  GetSessionSearchMessages: 'mixcwork:session:getSearchMessages',
  OpenSessionFromNotification: 'mixcwork:session:openFromNotification',
  OpenSessionFromNotificationReady: 'mixcwork:session:openFromNotificationReady',
  GoalCommand: 'mixcwork:session:goalCommand',
  SubmitBtw: 'mixcwork:session:submitBtw',
  AbortBtw: 'mixcwork:session:abortBtw',
  SubmitSteer: 'mixcwork:session:submitSteer',
  SessionModelOverrideChanged: 'mixcwork:session:modelOverrideChanged',
  SessionsChanged: 'mixcwork:sessions:changed',
  StreamBtwResult: 'mixcwork:stream:btwResult',
  StreamGoal: 'mixcwork:stream:goal',
  MemoryReadRaw: 'mixcwork:memory:readRaw',
  MemoryWriteRaw: 'mixcwork:memory:writeRaw',
  BootstrapRead: 'mixcwork:bootstrap:read',
  BootstrapWrite: 'mixcwork:bootstrap:write',
  TempStorageUsage: 'mixcwork:tempStorage:usage',
  TempStorageClean: 'mixcwork:tempStorage:clean',
} as const;
export type MixCWorkIpcChannel = typeof MixCWorkIpcChannel[keyof typeof MixCWorkIpcChannel];

export interface MixCWorkSessionsChangedPayload {
  sessionIds: string[];
}

export const MixCWorkForkMode = {
  None: 'none',
  Conversation: 'conversation',
  Worktree: 'worktree',
} as const;
export type MixCWorkForkMode = typeof MixCWorkForkMode[keyof typeof MixCWorkForkMode];

export const MixCWorkContextUsageSource = {
  Live: 'live',
  Cache: 'cache',
  Unavailable: 'unavailable',
} as const;
export type MixCWorkContextUsageSource =
  typeof MixCWorkContextUsageSource[keyof typeof MixCWorkContextUsageSource];

export const MixCWorkContextUsageFailureReason = {
  Timeout: 'timeout',
  GatewayError: 'gateway_error',
} as const;
export type MixCWorkContextUsageFailureReason =
  typeof MixCWorkContextUsageFailureReason[keyof typeof MixCWorkContextUsageFailureReason];

export const MixCWorkContextUsageRefreshMode = {
  Auto: 'auto',
  Manual: 'manual',
  PostRun: 'postRun',
} as const;
export type MixCWorkContextUsageRefreshMode =
  typeof MixCWorkContextUsageRefreshMode[keyof typeof MixCWorkContextUsageRefreshMode];
