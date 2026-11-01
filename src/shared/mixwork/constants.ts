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
export const MIXWORK_SESSION_PAGE_SIZE = 50;

/** Default page size for message history pagination. */
export const MIXWORK_MESSAGE_PAGE_SIZE = 30;

/**
 * Number of rows from the full mixed-message timeline inspected per
 * conversation-search request. Search pages intentionally use a separate,
 * bounded projection so tool/system payloads and message metadata never cross
 * the renderer IPC boundary.
 */
export const MIXWORK_SEARCH_MESSAGE_PAGE_SIZE = 200;

/** Defensive upper bound for renderer-supplied conversation-search page sizes. */
export const MIXWORK_SEARCH_MESSAGE_PAGE_MAX_SIZE = 500;

/** Maximum aggregate searchable UTF-8 content returned by one IPC page. */
export const MIXWORK_SEARCH_MESSAGE_PAGE_MAX_CONTENT_BYTES = 16_777_216;

/** Maximum number of rows inspected from the complete mixed-message timeline. */
export const MIXWORK_SEARCH_HISTORY_MAX_MIXED_ROWS = 100_000;

/** Maximum searchable content retained by the renderer, measured in UTF-16 code units. */
export const MIXWORK_SEARCH_HISTORY_MAX_CONTENT_CODE_UNITS = 16_777_216;

/** Maximum searchable content retained for one message, measured in UTF-16 code units. */
export const MIXWORK_SEARCH_HISTORY_MAX_MESSAGE_CONTENT_CODE_UNITS = 1_048_576;

/**
 * Per-working-directory scratch directory for intermediate files (model
 * helper scripts, pasted attachments, drafts). Swept by the mixwork temp
 * janitor; user-facing deliverables must not live here.
 */
export const MIXWORK_TEMP_DIR_NAME = '.mixwork-temp';

/**
 * Subdirectory of the mixwork temp dir holding pasted/manual attachments.
 * Attachment originals are referenced by message metadata (re-edit restores
 * them), so the janitor never deletes this subtree.
 */
export const MIXWORK_TEMP_ATTACHMENTS_DIR_NAME = 'attachments';

export const MixWorkIpcChannel = {
  CancelMediaTask: 'mixwork:media:cancel',
  GetMediaModels: 'media:getModels',
  MediaStatusPollUpdate: 'mixwork:media:statusPollUpdate',
  ForkSession: 'mixwork:session:fork',
  StopSession: 'mixwork:session:stop',
  SubTaskHistory: 'mixwork:subTask:history',
  SubagentList: 'mixwork:subagent:list',
  SubagentListByAgent: 'mixwork:subagent:listByAgent',
  SubagentDelete: 'mixwork:subagent:delete',
  MarkSessionViewed: 'mixwork:session:markViewed',
  SetActiveSession: 'mixwork:session:setActive',
  ExportSessionDiagnostics: 'mixwork:session:exportDiagnostics',
  GetSessionMessageRailIndex: 'mixwork:session:getMessageRailIndex',
  GetSessionSearchMessages: 'mixwork:session:getSearchMessages',
  OpenSessionFromNotification: 'mixwork:session:openFromNotification',
  OpenSessionFromNotificationReady: 'mixwork:session:openFromNotificationReady',
  GoalCommand: 'mixwork:session:goalCommand',
  SubmitBtw: 'mixwork:session:submitBtw',
  AbortBtw: 'mixwork:session:abortBtw',
  SubmitSteer: 'mixwork:session:submitSteer',
  SessionModelOverrideChanged: 'mixwork:session:modelOverrideChanged',
  SessionsChanged: 'mixwork:sessions:changed',
  StreamBtwResult: 'mixwork:stream:btwResult',
  StreamGoal: 'mixwork:stream:goal',
  MemoryReadRaw: 'mixwork:memory:readRaw',
  MemoryWriteRaw: 'mixwork:memory:writeRaw',
  BootstrapRead: 'mixwork:bootstrap:read',
  BootstrapWrite: 'mixwork:bootstrap:write',
  TempStorageUsage: 'mixwork:tempStorage:usage',
  TempStorageClean: 'mixwork:tempStorage:clean',
} as const;
export type MixWorkIpcChannel = typeof MixWorkIpcChannel[keyof typeof MixWorkIpcChannel];

export interface MixWorkSessionsChangedPayload {
  sessionIds: string[];
}

export const MixWorkForkMode = {
  None: 'none',
  Conversation: 'conversation',
  Worktree: 'worktree',
} as const;
export type MixWorkForkMode = typeof MixWorkForkMode[keyof typeof MixWorkForkMode];

export const MixWorkContextUsageSource = {
  Live: 'live',
  Cache: 'cache',
  Unavailable: 'unavailable',
} as const;
export type MixWorkContextUsageSource =
  typeof MixWorkContextUsageSource[keyof typeof MixWorkContextUsageSource];

export const MixWorkContextUsageFailureReason = {
  Timeout: 'timeout',
  GatewayError: 'gateway_error',
} as const;
export type MixWorkContextUsageFailureReason =
  typeof MixWorkContextUsageFailureReason[keyof typeof MixWorkContextUsageFailureReason];

export const MixWorkContextUsageRefreshMode = {
  Auto: 'auto',
  Manual: 'manual',
  PostRun: 'postRun',
} as const;
export type MixWorkContextUsageRefreshMode =
  typeof MixWorkContextUsageRefreshMode[keyof typeof MixWorkContextUsageRefreshMode];
