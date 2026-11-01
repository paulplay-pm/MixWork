import type {
  KitReference,
  ResolvedKitCapabilities,
} from '../../shared/kit/constants';
import type { CoworkBrowserAnnotationMessageBatch } from '../../shared/mixcwork/browserAnnotations';
import type {
  MixCWorkContextUsageFailureReason,
  MixCWorkContextUsageSource,
  MixCWorkForkMode,
} from '../../shared/mixcwork/constants';
import type { CoworkErrorDetail } from '../../shared/mixcwork/errorDetail';
import type { CoworkGoal } from '../../shared/mixcwork/goal';
import type {
  CoworkImageAttachmentPayload,
  CoworkImageAttachmentPreview,
} from '../../shared/mixcwork/imageAttachments';
import type { CoworkSelectedTextSnippet } from '../../shared/mixcwork/selectedText';
import type {
  OpenClawEngineErrorCode,
  OpenClawEnginePhase as SharedOpenClawEnginePhase,
  OpenClawGatewayRepairErrorCode,
} from '../../shared/openclawEngine/constants';
import type { Platform } from '../../shared/platform';
import type { ModelThinkingLevel } from '../../shared/providers/modelThinking';

// MixCWork image attachment for vision-capable models
export type MixCWorkImageAttachment = CoworkImageAttachmentPayload;

// MixCWork session status
export const MixCWorkSessionStatusValue = {
  Idle: 'idle',
  Running: 'running',
  Completed: 'completed',
  Error: 'error',
} as const;

export type MixCWorkSessionStatus =
  typeof MixCWorkSessionStatusValue[keyof typeof MixCWorkSessionStatusValue];

// MixCWork message types
export type MixCWorkMessageType = 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system';

// MixCWork execution mode
export type MixCWorkExecutionMode = 'auto' | 'local' | 'sandbox';
export type MixCWorkAgentEngine = 'openclaw';

export const MixCWorkCollaborationMode = {
  Default: 'default',
  Plan: 'plan',
} as const;

export type MixCWorkCollaborationMode =
  typeof MixCWorkCollaborationMode[keyof typeof MixCWorkCollaborationMode];

export const OpenClawSessionKeepAlive = {
  OneDay: '1d',
  SevenDays: '7d',
  ThirtyDays: '30d',
  OneYear: '365d',
} as const;

export type OpenClawSessionKeepAlive =
  typeof OpenClawSessionKeepAlive[keyof typeof OpenClawSessionKeepAlive];

export interface OpenClawSessionPolicyConfig {
  keepAlive: OpenClawSessionKeepAlive;
}

// MixCWork message metadata
export interface MixCWorkMessageMetadata {
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  toolUseId?: string | null;
  error?: string;
  errorDetail?: CoworkErrorDetail;
  isError?: boolean;
  isStreaming?: boolean;
  isFinal?: boolean;
  isThinking?: boolean;
  skillIds?: string[];
  kitIds?: string[];
  kitReferences?: KitReference[];
  resolvedKitCapabilities?: ResolvedKitCapabilities;
  imageAttachments?: MixCWorkImageAttachment[];
  imageAttachmentPreviews?: CoworkImageAttachmentPreview[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  contextPercent?: number;
  model?: string;
  agentName?: string;
  selectedTextSnippets?: CoworkSelectedTextSnippet[];
  browserAnnotations?: CoworkBrowserAnnotationMessageBatch[];
  goalSetting?: {
    action: 'start' | 'create' | 'set';
    objective: string;
  };
  localMediaAttachments?: Array<{
    localPath: string;
    mimeType?: string;
    name?: string;
  }>;
  [key: string]: unknown;
}

export interface MixCWorkContextUsage {
  sessionId: string;
  sessionKey?: string;
  usedTokens?: number;
  contextTokens?: number;
  percent?: number;
  compactionCount?: number;
  status: 'unknown' | 'normal' | 'warning' | 'danger' | 'compacting';
  latestCompactionCheckpointId?: string;
  latestCompactionReason?: string;
  latestCompactionCreatedAt?: number;
  model?: string;
  updatedAt: number;
}

export type MixCWorkContextUsageResult =
  | {
      success: true;
      usage?: MixCWorkContextUsage | null;
      source?: MixCWorkContextUsageSource;
    }
  | {
      success: false;
      error?: string;
      reason?: MixCWorkContextUsageFailureReason;
    };

// MixCWork message
export interface MixCWorkMessage {
  id: string;
  type: MixCWorkMessageType;
  content: string;
  timestamp: number;
  metadata?: MixCWorkMessageMetadata;
}

// MixCWork session
export interface MixCWorkSession {
  id: string;
  title: string;
  openclawSessionId: string | null;
  scheduledTaskId: string | null;
  status: MixCWorkSessionStatus;
  pinned: boolean;
  pinOrder?: number | null;
  cwd: string;
  systemPrompt: string;
  modelOverride: string;
  thinkingLevel?: ModelThinkingLevel | '';
  executionMode: MixCWorkExecutionMode;
  activeSkillIds: string[];
  activeKitIds?: string[];
  agentId: string;
  messages: MixCWorkMessage[];
  /** Offset of the first loaded message in the full message history. 0 means loaded from the beginning. */
  messagesOffset: number;
  /** Total number of messages stored for this session. */
  totalMessages: number;
  parentSessionId?: string | null;
  forkedFromMessageId?: string | null;
  forkedAt?: number | null;
  forkMode?: MixCWorkForkMode;
  forkWorkspacePath?: string | null;
  forkGitBranch?: string | null;
  forkGitBaseRef?: string | null;
  goal?: CoworkGoal | null;
  createdAt: number;
  updatedAt: number;
}

// MixCWork configuration
export interface MixCWorkConfig {
  workingDirectory: string;
  systemPrompt: string;
  executionMode: MixCWorkExecutionMode;
  agentEngine: MixCWorkAgentEngine;
  memoryEnabled: boolean;
  memoryImplicitUpdateEnabled: boolean;
  memoryLlmJudgeEnabled: boolean;
  memoryGuardLevel: 'strict' | 'standard' | 'relaxed';
  memoryUserMemoriesMaxItems: number;
  skipMissedJobs: boolean;
  openClawHeartbeatEnabled: boolean;
  embeddingEnabled: boolean;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingLocalModelPath: string;
  embeddingVectorWeight: number;
  embeddingRemoteBaseUrl: string;
  embeddingRemoteApiKey: string;
  dreamingEnabled: boolean;
  dreamingFrequency: string;
  dreamingModel: string;
  dreamingTimezone: string;
  openClawSessionPolicy: OpenClawSessionPolicyConfig;
}

/** Per-directory `.cowork-temp` preview entry shown in the clean confirmation dialog. */
export interface MixCWorkTempDirPreview {
  cwd: string;
  tempDir: string;
  totalBytes: number;
  totalFiles: number;
  cleanableBytes: number;
  cleanableFiles: number;
  isActive: boolean;
  truncated: boolean;
}

export type MixCWorkConfigUpdate = Partial<Pick<
  MixCWorkConfig,
  | 'workingDirectory'
  | 'executionMode'
  | 'agentEngine'
  | 'memoryEnabled'
  | 'memoryImplicitUpdateEnabled'
  | 'memoryLlmJudgeEnabled'
  | 'memoryGuardLevel'
  | 'memoryUserMemoriesMaxItems'
  | 'skipMissedJobs'
  | 'openClawHeartbeatEnabled'
  | 'embeddingEnabled'
  | 'embeddingProvider'
  | 'embeddingModel'
  | 'embeddingLocalModelPath'
  | 'embeddingVectorWeight'
  | 'embeddingRemoteBaseUrl'
  | 'embeddingRemoteApiKey'
  | 'dreamingEnabled'
  | 'dreamingFrequency'
  | 'dreamingModel'
  | 'dreamingTimezone'
>>;

export interface MixCWorkApiConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  apiType?: 'anthropic' | 'openai';
}

export type OpenClawEnginePhase = SharedOpenClawEnginePhase;

export interface OpenClawEngineStatus {
  phase: OpenClawEnginePhase;
  version: string | null;
  progressPercent?: number;
  message?: string;
  errorCode?: OpenClawEngineErrorCode;
  gatewayPort?: number | null;
  gatewayHttpUrl?: string | null;
  canRetry: boolean;
}

export interface OpenClawGatewayRepairResult {
  success: boolean;
  status?: OpenClawEngineStatus;
  originalPath?: string;
  backupPath?: string;
  error?: string;
  errorCode?: OpenClawGatewayRepairErrorCode;
  recoverable?: boolean;
}

export interface MixCWorkUserMemoryEntry {
  id: string;
  text: string;
  section?: string;
}

export interface MixCWorkMemoryStats {
  total: number;
  created: number;
  stale: number;
  deleted: number;
  explicit: number;
  implicit: number;
}

// MixCWork pending permission request
export interface MixCWorkPermissionRequest {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  requestId: string;
  toolUseId?: string | null;
}

export type MixCWorkPermissionResult =
  | {
      behavior: 'allow';
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: Record<string, unknown>[];
      toolUseID?: string;
    }
  | {
      behavior: 'deny';
      message: string;
      interrupt?: boolean;
      toolUseID?: string;
    };

// MixCWork permission response
export interface MixCWorkPermissionResponse {
  requestId: string;
  result: MixCWorkPermissionResult;
}

// Session summary for list display (without full messages)
export interface MixCWorkSessionSummary {
  id: string;
  title: string;
  scheduledTaskId: string | null;
  status: MixCWorkSessionStatus;
  pinned: boolean;
  pinOrder?: number | null;
  agentId?: string;
  imPlatform?: Platform | null;
  parentSessionId?: string | null;
  forkedAt?: number | null;
  forkMode?: MixCWorkForkMode;
  goal?: CoworkGoal | null;
  createdAt: number;
  updatedAt: number;
}

export interface MixCWorkForkSessionOptions {
  sessionId: string;
  forkedFromMessageId?: string | null;
  title?: string;
}

// Subagent session summary for sidebar display
export interface SubagentSessionSummary {
  id: string;
  agentId: string | null;
  task: string | null;
  label: string | null;
  sessionKey: string | null;
  childMixCWorkSessionId?: string | null;
  parentSessionId: string;
  parentAgentId?: string | null;
  parentTitle?: string | null;
  parentUpdatedAt?: number | null;
  status: 'running' | 'done' | 'error';
  createdAt: number;
  endedAt: number | null;
}

// Start session options
export interface MixCWorkStartOptions {
  prompt: string;
  cwd?: string;
  systemPrompt?: string;
  title?: string;
  activeSkillIds?: string[];
  runtimeSkillIds?: string[];
  kitIds?: string[];
  kitReferences?: KitReference[];
  resolvedKitCapabilities?: ResolvedKitCapabilities;
  agentId?: string;
  modelOverride?: string;
  thinkingLevel?: ModelThinkingLevel;
  imageAttachments?: MixCWorkImageAttachment[];
  mediaSelection?: { mode: string; modelId?: string; modelName?: string; imageModelId?: string; videoModelId?: string };
  mediaReferences?: import('./mediaGeneration').MediaAttachmentRef[];
  selectedTextSnippets?: CoworkSelectedTextSnippet[];
  browserAnnotations?: CoworkBrowserAnnotationMessageBatch[];
}

// Continue session options
export interface MixCWorkContinueOptions {
  sessionId: string;
  prompt: string;
  systemPrompt?: string;
  activeSkillIds?: string[];
  runtimeSkillIds?: string[];
  kitIds?: string[];
  kitReferences?: KitReference[];
  resolvedKitCapabilities?: ResolvedKitCapabilities;
  imageAttachments?: MixCWorkImageAttachment[];
  mediaSelection?: { mode: string; modelId?: string; modelName?: string; imageModelId?: string; videoModelId?: string };
  mediaReferences?: import('./mediaGeneration').MediaAttachmentRef[];
  selectedTextSnippets?: CoworkSelectedTextSnippet[];
  browserAnnotations?: CoworkBrowserAnnotationMessageBatch[];
}

// IPC result types
export interface MixCWorkSessionResult {
  success: boolean;
  session?: MixCWorkSession;
  error?: string;
}

export interface MixCWorkSessionListResult {
  success: boolean;
  sessions?: MixCWorkSessionSummary[];
  /** Whether more sessions exist beyond the currently loaded set. */
  hasMore?: boolean;
  error?: string;
}

export interface MixCWorkMessageListResult {
  success: boolean;
  messages?: MixCWorkMessage[];
  /** Offset of the first returned message. */
  offset?: number;
  /** Total message count for the session. */
  total?: number;
  error?: string;
}

export interface MixCWorkConfigResult {
  success: boolean;
  config?: MixCWorkConfig;
  error?: string;
}

// ── Dreaming content display types ──────────────────────────────────

export interface DreamingPhaseInfo {
  enabled: boolean;
  cron: string;
  nextRunAtMs?: number;
}

export interface DreamingEntry {
  key: string;
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  recallCount: number;
  dailyCount: number;
  groundedCount: number;
  totalSignalCount: number;
  lightHits: number;
  remHits: number;
  phaseHitCount: number;
  promotedAt?: string;
  lastRecalledAt?: string;
}

export interface DreamingStatusData {
  enabled: boolean;
  timezone?: string;
  shortTermCount: number;
  groundedSignalCount: number;
  totalSignalCount: number;
  promotedToday: number;
  promotedTotal: number;
  shortTermEntries: DreamingEntry[];
  promotedEntries: DreamingEntry[];
  phases?: {
    light: DreamingPhaseInfo;
    deep: DreamingPhaseInfo;
    rem: DreamingPhaseInfo;
  };
}

export interface DreamDiaryData {
  found: boolean;
  path: string;
  content?: string;
  updatedAtMs?: number;
}

// Stream event types for IPC communication
export type MixCWorkStreamEventType =
  | 'message'
  | 'tool_use'
  | 'tool_result'
  | 'permission_request'
  | 'complete'
  | 'error';

export interface MixCWorkStreamEvent {
  type: MixCWorkStreamEventType;
  sessionId: string;
  data: {
    message?: MixCWorkMessage;
    permission?: MixCWorkPermissionRequest;
    error?: string;
    openclawSessionId?: string;
  };
}
