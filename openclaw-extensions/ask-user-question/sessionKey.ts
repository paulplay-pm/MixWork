const LEGACY_MIXWORK_SESSION_PREFIX = 'mixwork:';
const AGENT_SESSION_PREFIX = 'agent:';
const MIXWORK_SESSION_MARKER = 'mixwork';
const SUBAGENT_SESSION_MARKER = 'subagent';

export function isAskUserQuestionCandidateSessionKey(sessionKey: string | undefined | null): boolean {
  const raw = (sessionKey ?? '').trim();
  if (!raw) return false;

  if (raw.startsWith(LEGACY_MIXWORK_SESSION_PREFIX)) {
    return raw.slice(LEGACY_MIXWORK_SESSION_PREFIX.length).trim().length > 0;
  }

  if (!raw.startsWith(AGENT_SESSION_PREFIX)) {
    return false;
  }

  const parts = raw.split(':');
  if (parts.length < 4 || parts[0] !== 'agent') {
    return false;
  }

  const agentId = parts[1]?.trim() ?? '';
  const source = parts[2]?.trim() ?? '';
  const rest = parts.slice(3).join(':').trim();
  if (!agentId || !rest) {
    return false;
  }

  return source === MIXWORK_SESSION_MARKER || source === SUBAGENT_SESSION_MARKER;
}