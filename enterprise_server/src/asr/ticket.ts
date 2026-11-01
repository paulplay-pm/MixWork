import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export interface AsrTicketClaims {
  orgId: string;
  userId: string;
  requestId: string;
  langType: string;
  providerKeyId: string;
  protocol: string;
  /** The model the catalog selected for this session (the BARE model name).
   *  Optional: absent when the server fell back to a key with no catalog row.
   *  This is the ONLY channel the choice can travel on — the relay re-reads
   *  the provider row and never sees the session route's config object. */
  model?: string;
}

/** Tickets are short-lived: the client opens the socket moments after it asks
 *  for the session, and a long-lived one would be a bearer credential lying
 *  around in a URL. */
export const ASR_TICKET_TTL_SECONDS = 60;

/**
 * Redeemed ticket ids, with the moment they were redeemed.
 *
 * A `Set` alone grows for the life of the process — one entry per session
 * request — so this is a bounded map instead: entries older than the ticket
 * TTL are dropped, because a ticket that old has expired anyway and cannot be
 * replayed.
 */
const usedTickets = new Map<string, number>();

function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not set');
  return s;
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

/**
 * Issue a single-use ticket for the websocket upgrade.
 *
 * Single-use is what keeps `maxConcurrentSessions: 1` honest: a replayable
 * ticket would open N sockets from one session request, and the per-user
 * concurrency limit is the only thing standing between a client and a
 * runaway set of upstream audio streams.
 *
 * The used-set is per-process. A multi-replica deployment would need the
 * claim in Postgres (or Redis) instead, because a ticket redeemed on replica
 * A could be replayed against replica B. The deployment ships a single server,
 * and the caveat is recorded rather than papered over.
 */
export async function issueAsrTicket(claims: AsrTicketClaims): Promise<string> {
  const id = randomUUID();
  const exp = Math.floor(Date.now() / 1000) + ASR_TICKET_TTL_SECONDS;
  const payload = Buffer.from(
    JSON.stringify({ id, exp, ...claims }),
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export interface VerifiedTicket extends AsrTicketClaims {
  id: string;
}

/** Verify a ticket's signature and expiry, and mark it used.
 *
 *  Returns null for anything that does not verify — a bad signature, an
 *  expired ticket, a malformed payload. A null is what the relay turns into
 *  a close-with-error, never into a partially-authenticated session. */
export async function redeemAsrTicket(ticket: string): Promise<VerifiedTicket | null> {
  const dot = ticket.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = ticket.slice(0, dot);
  const signature = ticket.slice(dot + 1);
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let parsed: (AsrTicketClaims & { id: string; exp: number });
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.exp !== 'number' || parsed.exp * 1000 < Date.now()) return null;
  const redeemedAt = usedTickets.get(parsed.id);
  if (redeemedAt !== undefined && Date.now() - redeemedAt < ASR_TICKET_TTL_SECONDS * 1000) {
    return null;
  }
  usedTickets.set(parsed.id, Date.now());
  for (const [id, at] of usedTickets) {
    if (Date.now() - at >= ASR_TICKET_TTL_SECONDS * 1000) usedTickets.delete(id);
  }

  return {
    id: parsed.id,
    orgId: parsed.orgId,
    userId: parsed.userId,
    requestId: parsed.requestId,
    langType: parsed.langType,
    providerKeyId: parsed.providerKeyId,
    protocol: parsed.protocol,
    // Carried explicitly: the object above is hand-built, so a field the
    // session route set would otherwise be dropped here and the relay would
    // fall back to the stale stored model.
    model: parsed.model,
  };
}

/** Test helper: forget redeemed tickets. */
export function _resetAsrTicketsForTest(): void {
  usedTickets.clear();
}
