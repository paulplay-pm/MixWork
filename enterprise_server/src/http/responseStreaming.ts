/**
 * Must this response be piped to the client instead of buffered?
 *
 * Two cases need it:
 *  - `accept-ranges`: the installer-download path (a large file the client may
 *    resume), handled outside Hono's own streaming.
 *  - `text/event-stream`: MCP's server→client channel. The stream stays open
 *    for the life of a session, so buffering it means never answering at all.
 *
 * Everything else is small and cheap to buffer.
 */
export function shouldStreamResponse(headers: { get(name: string): string | null }): boolean {
  if (headers.get('accept-ranges')) return true;
  const contentType = headers.get('content-type');
  return !!contentType && contentType.toLowerCase().startsWith('text/event-stream');
}
