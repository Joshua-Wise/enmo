import type { Pool, ResultSetHeader } from 'mysql2/promise';
import { hashPassword } from '../../src/passwords';
import type { Role } from '../../src/users';
import type { RunningServer } from './server';

export interface TestUser {
  id: number;
  username: string;
  password: string;
  role: Role;
}

/** A user straight into the database, as an Admin would add one. */
export async function addUser(pool: Pool, username: string, role: Role = 'viewer', password = `${username}-password`, mustChangePassword = false): Promise<TestUser> {
  const [result] = await pool.query<ResultSetHeader>(
    'INSERT INTO users (username, password_hash, role, must_change_password, created_at) VALUES (?, ?, ?, ?, NOW(3))',
    [username, await hashPassword(password), role, mustChangePassword ? 1 : 0],
  );
  return { id: result.insertId, username, password, role };
}

/** Sign in as a browser would; the response, whatever it was. */
export const signInResponse = (server: RunningServer, username: string, password: string, headers: Record<string, string> = {}) =>
  fetch(`${server.url}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ username, password }),
  });

/** The session cookie a successful sign-in sets, `ta_session=...`, ready to send back. */
export async function signIn(server: RunningServer, username: string, password: string): Promise<string> {
  const response = await signInResponse(server, username, password);
  if (response.status !== 200) throw new Error(`sign-in as ${username}: ${response.status} ${await response.text()}`);
  const cookie = response.headers.getSetCookie().find((c) => c.startsWith('ta_session='));
  if (cookie === undefined) throw new Error(`sign-in as ${username} set no session cookie`);
  return cookie.split(';')[0];
}

/** A JSON request as the signed-in browser would send it, with any header overridable. */
export const asSession =
  (cookie: string) =>
  (init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: { 'Content-Type': 'application/json', Cookie: cookie, ...init.headers },
  });
