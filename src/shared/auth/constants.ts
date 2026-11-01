export const AuthIpcChannel = {
  QuotaChanged: 'auth:quotaChanged',
} as const;

export type AuthIpcChannel = typeof AuthIpcChannel[keyof typeof AuthIpcChannel];

export const AuthRefreshOutcome = {
  NoTokens: 'no_tokens',
  Success: 'success',
  TerminalFailure: 'terminal_failure',
  TransientFailure: 'transient_failure',
} as const;

export type AuthRefreshOutcome = typeof AuthRefreshOutcome[keyof typeof AuthRefreshOutcome];

export type AuthTokenRefreshResult = {
  outcome: AuthRefreshOutcome;
  accessToken?: string;
};

export const AuthSubscriptionStatus = {
  Active: 'active',
  Enterprise: 'enterprise',
  Free: 'free',
} as const;

export type AuthSubscriptionStatus = typeof AuthSubscriptionStatus[keyof typeof AuthSubscriptionStatus];
