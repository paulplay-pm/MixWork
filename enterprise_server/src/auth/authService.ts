import { pool } from '../db/pool';
import { LoginErrorCode, Role } from '../shared/enterpriseServerConstants';
import { type Claims,signToken } from './jwt';
import { hashPassword, verifyPassword } from './password';

export interface CreateUserInput {
  orgId: string;
  username: string;
  password: string;
  displayName?: string;
  roles?: string[];
}

export interface LoginResult {
  token: string;
  claims: Claims;
}

/**
 * A login attempt that could not be authenticated.
 *
 * `code` is the wire value the route puts in the response body's `error`
 * field, so the client can tell the user WHICH part of the credential was
 * wrong instead of showing a bare 401.
 */
export class LoginFailed extends Error {
  readonly code: LoginErrorCode;

  constructor(code: LoginErrorCode) {
    super(code);
    this.name = 'LoginFailed';
    this.code = code;
  }
}

export const authService = {
  async createUser(input: CreateUserInput): Promise<{ id: string }> {
    const id = crypto.randomUUID();
    const roles = input.roles ?? [Role.User];
    const hash = await hashPassword(input.password);
    await pool.query(
      `INSERT INTO users(id, org_id, username, password_hash, display_name, extra_roles)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, input.orgId, input.username, hash, input.displayName ?? null, JSON.stringify(roles)]
    );
    return { id };
  },

  async login(orgName: string, username: string, password: string): Promise<LoginResult> {
    // Resolve orgId from the user-supplied org name. Names are UNIQUE
    // (see migration 009), so this is a single-row lookup. The user never
    // sees the org_id — it's an internal-only identifier that lives in
    // the JWT claim.
    const orgRow = await pool.query<{ id: string }>(
      `SELECT id FROM orgs WHERE name = $1`,
      [orgName]
    );
    const orgId = orgRow.rows[0]?.id;
    if (!orgId) throw new LoginFailed(LoginErrorCode.OrgNotFound);

    const r = await pool.query<{
      id: string;
      password_hash: string;
      status: string;
      extra_roles: string[];
    }>(
      `SELECT id, password_hash, status, extra_roles
       FROM users WHERE org_id=$1 AND username=$2`,
      [orgId, username]
    );
    const u = r.rows[0];
    if (!u) throw new LoginFailed(LoginErrorCode.UserNotFound);
    if (u.status !== 'active') throw new LoginFailed(LoginErrorCode.UserDisabled);
    const ok = await verifyPassword(password, u.password_hash);
    if (!ok) throw new LoginFailed(LoginErrorCode.InvalidPassword);
    const roles = u.extra_roles ?? [Role.User];
    const claims: Claims = { sub: u.id, orgId, roles };
    return { token: await signToken(claims), claims };
  },

  async disable(userId: string): Promise<void> {
    await pool.query(`UPDATE users SET status='disabled' WHERE id=$1`, [userId]);
  },

  async refresh(userId: string, orgId: string, roles: string[]): Promise<string> {
    return signToken({ sub: userId, orgId, roles });
  },
};