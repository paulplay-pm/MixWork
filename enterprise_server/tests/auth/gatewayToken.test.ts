import '../helpers/setupEnv';

import { SignJWT } from 'jose';
import { describe, expect, test } from 'vitest';

import { signGatewayToken, signToken, verifyGatewayToken, verifyToken } from '../../src/auth/jwt';

const claims = { sub: 'u1', orgId: 'o1', roles: [] as string[] };
const DAY_MS = 24 * 60 * 60 * 1000;

describe('signGatewayToken / verifyGatewayToken', () => {
  test('a gsj round-trips with its server key and purpose', async () => {
    const { token, expiresAt } = await signGatewayToken({ ...claims, serverKey: 'sk-1' });
    const v = await verifyGatewayToken(token);
    expect(v).toMatchObject({ sub: 'u1', orgId: 'o1', serverKey: 'sk-1', purpose: 'mcp_gateway' });
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now() + 89 * DAY_MS);
  });

  test('a tampered or malformed token verifies to null, never throws', async () => {
    expect(await verifyGatewayToken('not-a-jwt')).toBeNull();
    const { token } = await signGatewayToken({ ...claims, serverKey: 'sk-1' });
    expect(await verifyGatewayToken(`${token}x`)).toBeNull();
  });
});

describe('the two token families never verify into each other', () => {
  test('a member jwt is not a gsj', async () => {
    const memberJwt = await signToken(claims);
    expect(await verifyGatewayToken(memberJwt)).toBeNull();
  });

  test('a gsj-shaped payload signed with the member secret is rejected', async () => {
    // The invariant is key separation, not the `purpose` field: a token that
    // *looks* like a GSJ but was signed with JWT_SECRET must not pass.
    const forged = await new SignJWT({
      orgId: 'o1',
      serverKey: 'sk-1',
      purpose: 'mcp_gateway',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u1')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
    expect(await verifyGatewayToken(forged)).toBeNull();
  });

  test('a gsj is not a member jwt', async () => {
    const { token: gsj } = await signGatewayToken({ ...claims, serverKey: 'sk-1' });
    await expect(verifyToken(gsj)).rejects.toBeTruthy();
  });
});
