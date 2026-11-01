import { McpGatewayError } from '../../../shared/mcp/constants';
import type { McpToolListOutcome } from '../../types/mcp';

/**
 * The i18n key that explains a failed tool-list check, or null to fall back to
 * the raw reason the main process reported.
 *
 * The gateway knows exactly why it refused — a dead org key, an invisible
 * connector, an upstream that is simply down — and each one needs a different
 * action from the member. Printing "initialize failed: HTTP 502" for all of
 * them tells them none of it. `isGateway` gates the whole vocabulary: a direct
 * connector's own `{"error":"not_found"}` is its business, not the org's.
 */
export function toolListErrorKey(
  outcome: McpToolListOutcome,
  isGateway: boolean,
): string | null {
  if (!isGateway) return null;
  switch (outcome.errorCode) {
    case McpGatewayError.UpstreamUnauthorized:
      return 'mcpGatewayErrorUpstreamUnauthorized';
    case McpGatewayError.Forbidden:
      return 'mcpGatewayErrorForbidden';
    case McpGatewayError.NotFound:
      return 'mcpGatewayErrorNotFound';
    case McpGatewayError.UnsupportedTransport:
    case McpGatewayError.NotGatewayMode:
      return 'mcpGatewayErrorUnsupportedTransport';
    case McpGatewayError.UpstreamInsecure:
      return 'mcpGatewayErrorUpstreamInsecure';
    case McpGatewayError.UpstreamFailed:
      return 'mcpGatewayErrorUpstreamFailed';
    default:
      break;
  }
  // A gateway record that could not even produce a token: the member's own
  // session is the thing to fix, and the main process would otherwise show
  // them an English diagnostic sentence.
  if (outcome.status === 'missing-credential') return 'mcpGatewayErrorCredentialUnavailable';
  return null;
}
