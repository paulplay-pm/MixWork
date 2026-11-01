import type {
  KitReference,
  ResolvedKitCapabilities,
} from '../../shared/kit/constants';
import type { CoworkBrowserAnnotationMessageBatch } from '../../shared/mixwork/browserAnnotations';
import type {
  MixWorkContextUsageFailureReason,
  MixWorkContextUsageSource,
  MixWorkForkMode,
} from '../../shared/mixwork/constants';
import type { CoworkErrorDetail } from '../../shared/mixwork/errorDetail';
import type { CoworkGoal } from '../../shared/mixwork/goal';
import type {
  CoworkImageAttachmentPayload,
  CoworkImageAttachmentPreview,
} from '../../shared/mixwork/imageAttachments';
import type { CoworkSelectedTextSnippet } from '../../shared/mixwork/selectedText';
import type {
  OpenClawEngineErrorCode,
  OpenClawEnginePhase as SharedOpenClawEnginePhase,
  OpenClawGatewayRepairErrorCode,
} from '../../shared/openclawEngine/constants';
import type { Platform } from '../../shared/platform';
import type { ModelThinkingLevel } from '../../shared/providers/modelThinking';

// MixWork image attachment for vision-capable models
export type MixWorkImageAttachment = CoworkImageAttachmentPayload;

// MixWork session status
export const MixWorkSessionStatusValue = {
  Idle: 'idle',
  Running: 'running',
  Completed: 'completed',
  Error: 'error',
} as const;

export type MixWorkSessionStatus =
  typeof MixWorkSessionStatusValue[keyof typeof MixWorkSessionStatusValue];

// MixWork message types
export type MixWorkMessageType = 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system';

// MixWork execution mode
export type MixWorkExecutionMode = 'auto' | 'local' | 'sandbox';
export type MixWorkAgentEngine = 'openclaw';

export const MixWorkCollaborationMode = {
  Default: 'default',
  Plan: 'plan',
} as const;

export type MixWorkCollaborationMode =
  typeof MixWorkCollaborationMode[keyof typeof MixWorkCollaborationMode];

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

// MixWork message metadata
export interface MixWorkMessageMetadata {
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
  imageAttachments?: MixWorkImageAttachment[];
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

export interface MixWorkContextUsage {
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

export type MixWorkContextUsageResult =
  | {
      success: true;
      usage?: MixWorkContextUsage | null;
      source?: MixWorkContextUsageSource;
    }
  | {
      success: false;
      error?: string;
      reason?: MixWorkContextUsageFailureReason;
    };

// MixWork message
export interface MixWorkMessage {
  id: string;
  type: MixWorkMessageType;
  content: string;
  timestamp: number;
  metadata?: MixWorkMessageMetadata;
}

// MixWork session
export interface MixWorkSession {
  id: string;
  title: string;
  openclawSessionId: string | null;
  scheduledTaskId: string | null;
  status: MixWorkSessionStatus;
  pinned: boolean;
  pinOrder?: number | null;
  cwd: string;
  systemPrompt: string;
  modelOverride: string;
  thinkingLevel?: ModelThinkingLevel | '';
  executionMode: MixWorkExecutionMode;
  activeSkillIds: string[];
  activeKitIds?: string[];
  agentId: string;
  messages: MixWorkMessage[];
  /** Offset of the first loaded message in the full message history. 0 means loaded from the beginning. */
  messagesOffset: number;
  /** Total number of messages stored for this session. */
  totalMessages: number;
  parentSessionId?: string | null;
  forkedFromMessageId?: string | null;
  forkedAt?: number | null;
  forkMode?: MixWorkForkMode;
  forkWorkspacePath?: string | null;
  forkGitBranch?: string | null;
  forkGitBaseRef?: string | null;
  goal?: CoworkGoal | null;
  createdAt: number;
  updatedAt: number;
}

// MixWork configuration
export interface MixWorkConfig {
  workingDirectory: string;
  systemPrompt: string;
  executionMode: MixWorkExecutionMode;
  agentEngine: MixWorkAgentEngine;
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
export interface MixWorkTempDirPreview {
  cwd: string;
  tempDir: string;
  totalBytes: number;
  totalFiles: number;
  cleanableBytes: number;
  cleanableFiles: number;
  isActive: boolean;
  truncated: boolean;
}

export type MixWorkConfigUpdate = Partial<Pick<
  MixWorkConfig,
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

export interface MixWorkApiConfig {
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

export interface MixWorkUserMemoryEntry {
  id: string;
  text: string;
  section?: string;
}

export interface MixWorkMemoryStats {
  total: number;
  created: number;
  stale: number;
  deleted: number;
  explicit: number;
  implicit: number;
}

// MixWork pending permission request
export interface MixWorkPermissionRequest {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  requestId: string;
  toolUseId?: string | null;
}

export type MixWorkPermissionResult =
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

// MixWork permission response
export interface MixWorkPermissionResponse {
  requestId: string;
  result: MixWorkPermissionResult;
}

// Session summary for list display (without full messages)
export interface MixWorkSessionSummary {
  id: string;
  title: string;
  scheduledTaskId: string | null;
  status: MixWorkSessionStatus;
  pinned: boolean;
  pinOrder?: number | null;
  agentId?: string;
  imPlatform?: Platform | null;
  parentSessionId?: string | null;
  forkedAt?: number | null;
  forkMode?: MixWorkForkMode;
  goal?: CoworkGoal | null;
  createdAt: number;
  updatedAt: number;
}

export interface MixWorkForkSessionOptions {
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
  childMixWorkSessionId?: string | null;
  parentSessionId: string;
  parentAgentId?: string | null;
  parentTitle?: string | null;
  parentUpdatedAt?: number | null;
  status: 'running' | 'done' | 'error';
  createdAt: number;
  endedAt: number | null;
}

// Start session options
export interface MixWorkStartOptions {
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
  imageAttachments?: MixWorkImageAttachment[];
  mediaSelection?: { mode: string; modelId?: string; modelName?: string; imageModelId?: string; videoModelId?: string };
  mediaReferences?: import('./mediaGeneration').MediaAttachmentRef[];
  selectedTextSnippets?: CoworkSelectedTextSnippet[];
  browserAnnotations?: CoworkBrowserAnnotationMessageBatch[];
}

// Continue session options
export interface MixWorkContinueOptions {
  sessionId: string;
  prompt: string;
  systemPrompt?: string;
  activeSkillIds?: string[];
  runtimeSkillIds?: string[];
  kitIds?: string[];
  kitReferences?: KitReference[];
  resolvedKitCapabilities?: ResolvedKitCapabilities;
  imageAttachments?: MixWorkImageAttachment[];
  mediaSelection?: { mode: string; modelId?: string; modelName?: string; imageModelId?: string; videoModelId?: string };
  mediaReferences?: import('./mediaGeneration').MediaAttachmentRef[];
  selectedTextSnippets?: CoworkSelectedTextSnippet[];
  browserAnnotations?: CoworkBrowserAnnotationMessageBatch[];
}

// IPC result types
export interface MixWorkSessionResult {
  success: boolean;
  session?: MixWorkSession;
  error?: string;
}

export interface MixWorkSessionListResult {
  success: boolean;
  sessions?: MixWorkSessionSummary[];
  /** Whether more sessions exist beyond the currently loaded set. */
  hasMore?: boolean;
  error?: string;
}

export interface MixWorkMessageListResult {
  success: boolean;
  messages?: MixWorkMessage[];
  /** Offset of the first returned message. */
  offset?: number;
  /** Total message count for the session. */
  total?: number;
  error?: string;
}

export interface MixWorkConfigResult {
  success: boolean;
  config?: MixWorkConfig;
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
export type MixWorkStreamEventType =
  | 'message'
  | 'tool_use'
  | 'tool_result'
  | 'permission_request'
  | 'complete'
  | 'error';

export interface MixWorkStreamEvent {
  type: MixWorkStreamEventType;
  sessionId: string;
  data: {
    message?: MixWorkMessage;
    permission?: MixWorkPermissionRequest;
    error?: string;
    openclawSessionId?: string;
  };
}
