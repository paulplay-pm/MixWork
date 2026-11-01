/**
 * The AGENTS.md chapter that tells the model which connectors it has and how
 * to treat them.
 *
 * Why a chapter and not a per-turn prompt: the desktop's connectors are
 * enabled globally, so the set of "designated" connectors is the same on
 * every turn. A standing chapter costs nothing per turn, survives long
 * conversations, and is rewritten on every config sync — so it always
 * matches the connectors that are actually loaded.
 */

import {
  McpServerKind,
  type ResolvedMcpServer,
  resolveMcpServerEntries,
} from './openclawMcpServers';

/**
 * How many connectors the chapter names.
 *
 * AGENTS.md is read into every turn and OpenClaw truncates a long file
 * ("AGENTS.md was truncated; read the full AGENTS.md before relying on scoped
 * policy"), so an unbounded list could push the rules themselves out of
 * context. The cap is generous: an organization with more enabled
 * connectors than this has a catalog problem, not a prompt problem.
 */
const MAX_LISTED_CONNECTORS = 30;

/**
 * The display name as it should appear in the chapter.
 *
 * The name is user-facing text that the model reads, so it must not be able
 * to break out of the list item it sits in.
 */
function formatConnectorName(name: string): string {
  const cleaned = name.replace(/[\r\n]+/g, ' ').replace(/[`*_#]/g, '').trim();
  return cleaned || 'Unnamed connector';
}

/**
 * The "connected data sources" chapter, or undefined when there is nothing to
 * say.
 *
 * The chapter carries two things the tool schema cannot:
 *
 * 1. The mapping from a connector's display name to the prefix of its tool
 *    names. The model sees `fxiaoke__query_company`, not 纷享销客 — without
 *    this line it cannot connect "用纷享销客查一下" to a tool.
 * 2. The rule that a connector beats the web. Tool descriptions say what a
 *    tool does; they never say that the connector is the authoritative source
 *    and that guessing is not allowed.
 */
export function buildConnectedSourcesPrompt(servers: ResolvedMcpServer[]): string | undefined {
  const { entries } = resolveMcpServerEntries(servers);
  const connectors = entries.filter(
    (entry) => (entry.server.kind ?? McpServerKind.Connector) === McpServerKind.Connector,
  );
  if (connectors.length === 0) return undefined;

  const listed = connectors.slice(0, MAX_LISTED_CONNECTORS);
  const omitted = connectors.length - listed.length;
  const lines = listed.map(
    (entry) => `- ${formatConnectorName(entry.server.name)} — its tools are named \`${entry.key}__*\``,
  );
  if (omitted > 0) {
    lines.push(`- and ${omitted} more connector${omitted === 1 ? '' : 's'} not listed here`);
  }

  return [
    '## Connected Data Sources',
    '',
    'These connectors are installed and enabled on this desktop. The tools of each connector are named with the prefix shown below.',
    '',
    ...lines,
    '',
    'When the request is about data a connector covers, call that connector\'s tools directly instead of searching the web or answering from memory.',
    '',
    'If a connector listed here has no tools in your available tool list, say so instead of guessing.',
  ].join('\n');
}
