import { createHash } from 'node:crypto';

import { jwtVerify,SignJWT } from 'jose';

export interface Claims {
  sub: string;
  orgId: string;
  roles: string[];
}

function secret(): Uint8Array {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) throw new Error('JWT_SECRET must be ≥32 chars');
  return new TextEncoder().encode(s);
}

export async function signToken(c: Claims): Promise<string> {
  return new SignJWT({ orgId: c.orgId, roles: c.roles })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(c.sub)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(secret());
}

export async function verifyToken(token: string): Promise<Claims> {
  const { payload } = await jwtVerify(token, secret());
  return {
    sub: payload.sub as string,
    orgId: (payload as unknown as { orgId: string }).orgId,
    roles: ((payload as unknown as { roles?: string[] }).roles) ?? [],
  };
}
/**
 * Gateway service tokens (GSJ) — a SECOND token family, deliberately on a
 * different key.
 *
 * A GSJ authorizes exactly one thing: calling one connector through the MCP
 * gateway. If it shared `JWT_SECRET`, a GSJ would also verify as a member
 * token (`verifyToken` reads only `sub`/`orgId`/`roles`), so anyone holding one
 * could call every member-level API. Deriving a separate key makes a GSJ
 * useless anywhere else, and a member JWT useless at the gateway.
 *
 * 90 days because the token is persisted in the desktop's OpenClaw config, and
 * every change to that config's `mcp` section restarts the agent gateway. The
 * desktop refreshes it when it has less than 15 days left.
 */
const GATEWAY_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;
export const GATEWAY_TOKEN_PURPOSE = 'mcp_gateway';

function gatewaySecret(): Uint8Array {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) throw new Error('JWT_SECRET must be ≥32 chars');
  return createHash('sha256').update(`${s}::mcp_gateway`).digest();
}

export interface GatewayClaims {
  orgId: string;
  sub: string;
  serverKey: string;
  purpose: string;
}

export async function signGatewayToken(c: {
  orgId: string;
  sub: string;
  serverKey: string;
}): Promise<{ token: string; expiresAt: string }> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + GATEWAY_TOKEN_TTL_SECONDS;
  const token = await new SignJWT({
    orgId: c.orgId,
    serverKey: c.serverKey,
    purpose: GATEWAY_TOKEN_PURPOSE,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(c.sub)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(gatewaySecret());
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

/** `null` rather than a throw: every failure at the gateway is the same 401. */
export async function verifyGatewayToken(token: string): Promise<GatewayClaims | null> {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, gatewaySecret()));
  } catch {
    return null;
  }
  const { sub } = payload;
  const orgId = payload.orgId;
  const serverKey = payload.serverKey;
  const purpose = payload.purpose;
  if (
    typeof sub !== 'string' ||
    typeof orgId !== 'string' ||
    typeof serverKey !== 'string' ||
    purpose !== GATEWAY_TOKEN_PURPOSE
  ) {
    return null;
  }
  return { orgId, sub, serverKey, purpose };
}
