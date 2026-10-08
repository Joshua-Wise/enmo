/**
 * Users (docs/adr/0010): who may sign in, as an Admin, who may change things, or a Viewer, who may
 * only look. The rules that keep the system reachable live here, in the transaction that makes the
 * change: the last enabled Admin cannot be demoted, disabled, or deleted, and no one deletes or
 * disables themselves. Every rule is checked with the enabled Admins' rows locked, so two Admins
 * demoting each other at once cannot both succeed.
 */
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { isDuplicateKey } from './db';
import { DEFAULT_ADMIN_PASSWORD, hashPassword, passwordProblem } from './passwords';

export type Role = 'admin' | 'viewer';
export const ROLES: readonly Role[] = ['admin', 'viewer'];
export const isRole = (value: unknown): value is Role => ROLES.includes(value as Role);

/** The name a fresh install's first user has. */
export const FIRST_USERNAME = 'admin';

/** A user as the API sends it: never its password hash. */
export interface UserPayload {
  id: number;
  username: string;
  role: Role;
  disabled: boolean;
  /** ISO instants in UTC; null until the user has signed in. */
  createdAt: string;
  lastSignInAt: string | null;
}

interface UserRow extends RowDataPacket {
  id: number;
  username: string;
  role: Role;
  disabled: number;
  createdAt: Date;
  lastSignInAt: Date | null;
}

/** A user as sign-in needs it: with the hash to check against. */
export interface StoredUser extends UserPayload {
  passwordHash: string;
  mustChangePassword: boolean;
}

const SELECT_USERS = `SELECT id, username, role, disabled, created_at AS createdAt, last_sign_in_at AS lastSignInAt,
                             password_hash AS passwordHash, must_change_password AS mustChangePassword
                        FROM users`;

const payloadOf = (row: UserRow): UserPayload => ({
  id: row.id,
  username: row.username,
  role: row.role,
  disabled: row.disabled === 1,
  createdAt: row.createdAt.toISOString(),
  lastSignInAt: row.lastSignInAt?.toISOString() ?? null,
});

/** A username as typed, or why it will not do: 1 to 64 letters, digits, and . _ @ -. Compared ignoring case. */
export function parseUsername(raw: unknown): { username: string } | { error: string } {
  const username = typeof raw === 'string' ? raw.trim() : '';
  if (!/^[A-Za-z0-9._@-]{1,64}$/.test(username)) return { error: 'A username is 1 to 64 letters, digits, and . _ @ -' };
  return { username };
}

export async function listUsers(pool: Pool): Promise<UserPayload[]> {
  const [rows] = await pool.query<UserRow[]>(`${SELECT_USERS} ORDER BY username`);
  return rows.map(payloadOf);
}

const storedOf = (row: UserRow): StoredUser => ({ ...payloadOf(row), passwordHash: row.passwordHash as string, mustChangePassword: row.mustChangePassword === 1 });

/** A stored user without what only sign-in reads, as the API may send it. */
export const publicUser = ({ passwordHash: _hash, mustChangePassword: _change, ...user }: StoredUser): UserPayload => user;

/** The user with this name, ignoring case, disabled ones included. */
export async function findUserByName(pool: Pool, username: string): Promise<StoredUser | undefined> {
  const [rows] = await pool.query<UserRow[]>(`${SELECT_USERS} WHERE username = ?`, [username]);
  return rows[0] === undefined ? undefined : storedOf(rows[0]);
}

export async function findUser(pool: Pool | PoolConnection, id: number): Promise<StoredUser | undefined> {
  const [rows] = await pool.query<UserRow[]>(`${SELECT_USERS} WHERE id = ?`, [id]);
  return rows[0] === undefined ? undefined : storedOf(rows[0]);
}

/** What a refused change answers: the status and a sentence for the person who asked. */
export interface Refusal {
  status: 404 | 409 | 422;
  error: string;
}

export type UserResult = { user: UserPayload } | Refusal;

export interface NewUser {
  username: unknown;
  role: unknown;
  password: unknown;
}

export async function createUser(pool: Pool, input: NewUser, now: Date): Promise<UserResult> {
  const name = parseUsername(input.username);
  if ('error' in name) return { status: 422, error: name.error };
  if (!isRole(input.role)) return { status: 422, error: 'A role is admin or viewer' };
  const problem = passwordProblem(input.password);
  if (problem !== undefined) return { status: 422, error: `${problem} (the starting password)` };
  try {
    const [result] = await pool.query<ResultSetHeader>(
      'INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)',
      [name.username, await hashPassword(input.password as string), input.role, now],
    );
    return { user: publicUser((await findUser(pool, result.insertId)) as StoredUser) };
  } catch (error) {
    if (isDuplicateKey(error)) return { status: 409, error: `There is already a user called ${name.username}` };
    throw error;
  }
}

/** The enabled Admins, their rows locked until the transaction ends. */
async function lockEnabledAdmins(conn: PoolConnection): Promise<number[]> {
  const [rows] = await conn.query<RowDataPacket[]>("SELECT id FROM users WHERE role = 'admin' AND disabled = 0 FOR UPDATE");
  return rows.map((r) => r.id as number);
}

async function inTransaction<T>(pool: Pool, work: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await work(conn);
    await conn.commit();
    return result;
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }
}

export interface UserChanges {
  role?: unknown;
  disabled?: unknown;
  /** A new password set by an Admin, for a user who forgot theirs. */
  password?: unknown;
}

/** Who is asking: the signed-in Admin's id, or undefined for the Admin token, which is no user. */
export type Actor = number | undefined;

/**
 * Change a user's role, disable or enable them, or set a new password. Returns the user as it now
 * is, and whether its sessions must end (disabled, or a new password).
 */
export async function updateUser(pool: Pool, id: number, changes: UserChanges, actor: Actor): Promise<UserResult & { endSessions?: boolean }> {
  const { role, disabled, password } = changes;
  if (role === undefined && disabled === undefined && password === undefined) {
    return { status: 422, error: 'Give a role, disabled, or a password to change' };
  }
  if (role !== undefined && !isRole(role)) return { status: 422, error: 'A role is admin or viewer' };
  if (disabled !== undefined && typeof disabled !== 'boolean') return { status: 422, error: 'disabled is true or false' };
  const problem = password === undefined ? undefined : passwordProblem(password);
  if (problem !== undefined) return { status: 422, error: problem };
  // Hashed before the transaction, so the locks are not held through 50 ms of scrypt.
  const hash = password === undefined ? undefined : await hashPassword(password as string);

  return inTransaction(pool, async (conn) => {
    const admins = await lockEnabledAdmins(conn);
    const user = await findUser(conn, id);
    if (user === undefined) return { status: 404, error: 'User not found' };
    if (disabled === true && !user.disabled && id === actor) return { status: 409, error: 'You cannot disable yourself; another Admin can' };
    const staysEnabledAdmin = (role ?? user.role) === 'admin' && !(disabled ?? user.disabled);
    if (admins.includes(id) && !staysEnabledAdmin && admins.length === 1) {
      return { status: 409, error: `${user.username} is the last enabled Admin; make another user an Admin first` };
    }
    const sets: string[] = [];
    const values: unknown[] = [];
    if (role !== undefined) {
      sets.push('role = ?');
      values.push(role);
    }
    if (disabled !== undefined) {
      sets.push('disabled = ?');
      values.push(disabled ? 1 : 0);
    }
    if (hash !== undefined) {
      sets.push('password_hash = ?', 'must_change_password = 0');
      values.push(hash);
    }
    await conn.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...values, id]);
    const updated = publicUser((await findUser(conn, id)) as StoredUser);
    return { user: updated, endSessions: (disabled === true && !user.disabled) || hash !== undefined };
  });
}

/** Delete a user and, with it, every session they hold. */
export async function deleteUser(pool: Pool, id: number, actor: Actor): Promise<{ deleted: true } | Refusal> {
  return inTransaction(pool, async (conn) => {
    const admins = await lockEnabledAdmins(conn);
    const user = await findUser(conn, id);
    if (user === undefined) return { status: 404, error: 'User not found' };
    if (id === actor) return { status: 409, error: 'You cannot delete yourself; another Admin can' };
    if (admins.length === 1 && admins[0] === id) {
      return { status: 409, error: `${user.username} is the last enabled Admin; make another user an Admin first` };
    }
    await conn.query('DELETE FROM users WHERE id = ?', [id]);
    return { deleted: true as const };
  });
}

/** A user's own new password, once they have proved the current one. Clears the change a first sign-in asks for. */
export async function setOwnPassword(pool: Pool, id: number, password: string): Promise<void> {
  await pool.query('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [await hashPassword(password), id]);
}

export async function recordSignIn(pool: Pool, id: number, at: Date): Promise<void> {
  await pool.query('UPDATE users SET last_sign_in_at = ? WHERE id = ?', [at, id]);
}

/**
 * A fresh install's first user: with no user at all, `admin` with the password `admin`, an Admin
 * who must choose a new password at the first sign-in. Says so through `log`; nothing else about
 * passwords is ever logged. Returns whether it made one.
 */
export async function ensureFirstUser(pool: Pool, now: Date, log: (line: string) => void): Promise<boolean> {
  const [[{ n }]] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM users');
  if (Number(n) > 0) return false;
  try {
    await pool.query(
      "INSERT INTO users (username, password_hash, role, must_change_password, created_at) VALUES (?, ?, 'admin', 1, ?)",
      [FIRST_USERNAME, await hashPassword(DEFAULT_ADMIN_PASSWORD), now],
    );
  } catch (error) {
    // A second process got there first.
    if (isDuplicateKey(error)) return false;
    throw error;
  }
  log(`No users yet: created the Admin "${FIRST_USERNAME}" with the password "${DEFAULT_ADMIN_PASSWORD}". Sign in and choose a new password.`);
  return true;
}

/**
 * The operator's way back in (deploy.sh reset-admin-password, userCli.ts): `username` becomes an
 * enabled Admin with this password, created if it does not exist, and every session it held ends
 * (its open streams close at api's next session sweep, within a minute). Returns the name as stored.
 */
export async function resetAdminPassword(pool: Pool, username: string, password: string, now: Date): Promise<{ done: 'reset' | 'created'; username: string }> {
  const hash = await hashPassword(password);
  return inTransaction(pool, async (conn) => {
    const [rows] = await conn.query<RowDataPacket[]>('SELECT id, username FROM users WHERE username = ? FOR UPDATE', [username]);
    if (rows.length === 0) {
      await conn.query("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, 'admin', ?)", [username, hash, now]);
      return { done: 'created' as const, username };
    }
    const id = rows[0].id as number;
    await conn.query("UPDATE users SET password_hash = ?, role = 'admin', disabled = 0, must_change_password = 0 WHERE id = ?", [hash, id]);
    await conn.query('DELETE FROM sessions WHERE user_id = ?', [id]);
    return { done: 'reset' as const, username: rows[0].username as string };
  });
}
