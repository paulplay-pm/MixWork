/**
 * ASR wire constants — SERVER COPY.
 *
 * Hand-mirrored from the desktop's `src/shared/asr/constants.ts`. The desktop
 * is a separate npm project and the Dockerfile copies only `enterprise_server/`,
 * so the server physically cannot import the desktop's copy; this file is the
 * second source of truth that makes the ASR envelope exist on both sides.
 *
 * `tests/asr/asrConstantsParity.test.ts` (in the DESKTOP repo, which CAN reach
 * across) asserts the two agree key-for-key, so a one-sided edit fails a test
 * rather than shipping a code the client misreads. When you change a value
 * here, change it there, and run that test.
 *
 * Do NOT hand-edit values to "fix" a mismatch: the numbers are wire protocol.
 */

export const AsrLangType = {
  ZhChs: 'zh-CHS',
} as const;

export type AsrLangType = typeof AsrLangType[keyof typeof AsrLangType];

/**
 * Numeric codes, matching the desktop exactly.
 *
 * `Unauthorized` is 401 (same number as HTTP 401) — the desktop treats both
 * identically, so the collision is deliberate and harmless.
 */
export const AsrApiCode = {
  Unauthorized: 401,
  AuthTokenInvalid: 40100,
  ConfigInvalid: 41400,
  AudioInvalid: 41401,
  AudioTooLarge: 41402,
  AudioTooLong: 41403,
  DailyLimitExceeded: 41404,
  UpstreamAuthFailed: 41405,
  UpstreamRateLimited: 41406,
  RecognitionFailed: 41407,
  UpstreamError: 50201,
  UpstreamBalanceInsufficient: 50203,
  UpstreamInvalidParams: 50204,
} as const;

export type AsrApiCode = typeof AsrApiCode[keyof typeof AsrApiCode];

export const AsrRealtimeEventType = {
  Started: 'started',
  Recognition: 'recognition',
  Closed: 'closed',
  Error: 'error',
} as const;

export type AsrRealtimeEventType = typeof AsrRealtimeEventType[keyof typeof AsrRealtimeEventType];

export interface AsrRealtimeSessionRequest {
  langType?: AsrLangType;
}

export interface AsrRealtimeSessionData {
  requestId: string;
  wsUrl: string;
  expiresInSeconds: number;
  chunkIntervalMillis: number;
  maxSessionSeconds: number;
  maxConcurrentSessions: number;
  usedSecondsToday: number;
  remainingSecondsToday: number;
  limitSecondsToday: number;
}

/**
 * The recognition item shape the desktop's `RealtimeRecognitionBuffer` reads.
 * This is the youdao dialect, NOT a vendor's: `seg_id`, `st.sentence`, and
 * `partial === false` for a final segment. Upstream events must be translated
 * INTO this before they go to the client.
 */
export interface AsrRealtimeRecognitionRawItem {
  seg_id?: number;
  st?: {
    sentence?: string;
    partial?: boolean;
  };
}

export interface AsrRealtimeEvent {
  type?: AsrRealtimeEventType | string;
  code?: number;
  message?: string;
  requestId?: string;
  text?: string;
  raw?: {
    action?: string;
    errorCode?: string;
    result?: AsrRealtimeRecognitionRawItem[];
  };
}