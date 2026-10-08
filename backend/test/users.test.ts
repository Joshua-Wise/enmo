import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { createTestPool, resetDatabase } from './helpers/database';
import { startServer, testConfig, type RunningServer } from './helpers/server';
import { asAdmin, errorOf, json } from './helpers/api';
import { subscribe, type SseClient } from './helpers/sse';
import { addUser, asSession, signIn, signInResponse, type TestUser } from './helpers/users';
import { createBroadcaster } from '../src/sse';
import { resetAdminPassword, type UserPayload } from '../src/users';

describe('/api/users', () => {
  let pool: Pool;
  let server: RunningServer;
  /** The Admin everyone else is managed by, and their session. */
  let boss: TestUser;
  let as: ReturnType<typeof asSession>;
  const open: SseClient[] = [];

  before(() => {
    pool = createTestPool();
  });
  beforeEach(async () => {
    await resetDatabase(pool);
    server = await startServer(pool, testConfig(), { sse: createBroadcaster({ heartbeatMs: 100 }) });
    boss = await addUser(pool, 'boss', 'admin');
    as = asSession(await signIn(server, 'boss', boss.password));
  });
  afterEach(async () => {
    for (const c of open.splice(0)) c.close();
    await server.close();
  });
  after(() => pool.end());

  const url = (path = '') => `${server.url}/api/users${path}`;
  const add = (body: unknown, init: RequestInit = as()) => fetch(url(), { ...init, method: 'POST', body: JSON.stringify(body) });
  const change = (id: number, body: unknown, init: RequestInit = as()) => fetch(url(`/${id}`), { ...init, method: 'PATCH', body: JSON.stringify(body) });
  const remove = (id: number, init: RequestInit = as()) => fetch(url(`/${id}`), { ...init, method: 'DELETE' });
  const list = async () => json<UserPayload[]>(await fetch(url(), as()));
  const whoAmI = (cookie: string) => fetch(`${server.url}/api/session`, { headers: { Cookie: cookie } });

  test('an Admin lists users with role, disabled, and last sign-in, and never a password hash', async () => {
    await addUser(pool, 'kim', 'viewer');
    const users = await list();
    assert.deepEqual(users.map(({ username, role, disabled }) => ({ username, role, disabled })), [
      { username: 'boss', role: 'admin', disabled: false },
      { username: 'kim', role: 'viewer', disabled: false },
    ]);
    assert.equal(typeof users[0].lastSignInAt, 'string');
    assert.equal(users[1].lastSignInAt, null);
    assert.ok(!JSON.stringify(users).includes('scrypt'));
    assert.deepEqual(Object.keys(users[0]).sort(), ['createdAt', 'disabled', 'id', 'lastSignInAt', 'role', 'username']);
  });

  test('an Admin adds a user with a starting password, who can then sign in with it', async () => {
    const response = await add({ username: 'kim', role: 'viewer', password: 'kims-start-pass' });
    assert.equal(response.status, 201);
    const kim = await json<UserPayload>(response);
    assert.deepEqual({ username: kim.username, role: kim.role, disabled: kim.disabled }, { username: 'kim', role: 'viewer', disabled: false });
    assert.ok(!JSON.stringify(kim).includes('scrypt'));
    assert.equal((await signInResponse(server, 'kim', 'kims-start-pass')).status, 200);
  });

  test('a new user needs a good username, a role, and a starting password of 8 characters or more; names are unique ignoring case', async () => {
    for (const body of [
      { username: '', role: 'viewer', password: 'long-enough' },
      { username: 'has space', role: 'viewer', password: 'long-enough' },
      { username: 'x'.repeat(65), role: 'viewer', password: 'long-enough' },
      { username: 'kim', role: 'owner', password: 'long-enough' },
      { username: 'kim', role: 'viewer', password: 'short' },
      { username: 'kim', role: 'viewer' },
    ]) {
      assert.equal((await add(body)).status, 422, JSON.stringify(body));
    }
    assert.equal((await add({ username: 'Kim', role: 'viewer', password: 'long-enough' })).status, 201);
    const again = await add({ username: 'KIM', role: 'admin', password: 'long-enough' });
    assert.equal(again.status, 409);
    assert.equal(await errorOf(again), 'There is already a user called KIM');
  });

  test('a new password set by an Admin replaces the old one and ends that user\'s sessions and streams at once', async () => {
    const kim = await addUser(pool, 'kim', 'viewer');
    const cookie = await signIn(server, 'kim', kim.password);
    const stream = await subscribe(`${server.url}/api/dashboard/stream`, { Cookie: cookie });
    open.push(stream);
    const response = await change(kim.id, { password: 'set-by-the-boss' });
    assert.equal(response.status, 200);
    await stream.ended;
    assert.equal((await whoAmI(cookie)).status, 401);
    assert.equal((await signInResponse(server, 'kim', kim.password)).status, 401);
    assert.equal((await signInResponse(server, 'kim', 'set-by-the-boss')).status, 200);
    assert.equal((await change(kim.id, { password: 'short' })).status, 422);
  });

  test('a role change takes effect on the user\'s next request, without signing in again', async () => {
    const kim = await addUser(pool, 'kim', 'viewer');
    const kims = asSession(await signIn(server, 'kim', kim.password));
    const addCampus = () => fetch(`${server.url}/api/campuses`, kims({ method: 'POST', body: JSON.stringify({ name: 'Central High', shortcode: 'CHS' }) }));
    assert.equal((await addCampus()).status, 403);
    assert.equal((await change(kim.id, { role: 'admin' })).status, 200);
    assert.equal((await addCampus()).status, 201);
    assert.equal((await change(kim.id, { role: 'viewer' })).status, 200);
    assert.equal((await fetch(`${server.url}/api/campuses/1`, kims({ method: 'DELETE' }))).status, 403);
  });

  test('disabling a user ends their session and stream at once and refuses their sign-in; enabling lets them back', async () => {
    const kim = await addUser(pool, 'kim', 'viewer');
    const cookie = await signIn(server, 'kim', kim.password);
    const stream = await subscribe(`${server.url}/api/dashboard/stream`, { Cookie: cookie });
    open.push(stream);
    const disabled = await change(kim.id, { disabled: true });
    assert.equal(disabled.status, 200);
    assert.equal((await json<UserPayload>(disabled)).disabled, true);
    await stream.ended;
    assert.equal((await whoAmI(cookie)).status, 401);
    const refused = await signInResponse(server, 'kim', kim.password);
    assert.equal(refused.status, 401);
    assert.equal(await errorOf(refused), 'Wrong username or password');
    assert.equal((await change(kim.id, { disabled: false })).status, 200);
    assert.equal((await signInResponse(server, 'kim', kim.password)).status, 200);
  });

  test('deleting a user ends their session; a missing user is 404; a change with nothing in it is 422', async () => {
    const kim = await addUser(pool, 'kim', 'viewer');
    const cookie = await signIn(server, 'kim', kim.password);
    assert.equal((await remove(kim.id)).status, 204);
    assert.equal((await whoAmI(cookie)).status, 401);
    assert.deepEqual((await list()).map((u) => u.username), ['boss']);
    assert.equal((await remove(kim.id)).status, 404);
    assert.equal((await change(kim.id, { role: 'admin' })).status, 404);
    assert.equal((await change(boss.id, {})).status, 422);
    assert.equal((await change(boss.id, { disabled: 'yes' })).status, 422);
    assert.equal((await remove(0)).status, 404);
  });

  describe('the rules that keep an Admin in the system', () => {
    test('the last enabled Admin cannot be demoted, disabled, or deleted, by themselves or with the Admin token', async () => {
      for (const init of [as(), asAdmin()]) {
        const demote = await change(boss.id, { role: 'viewer' }, init);
        assert.equal(demote.status, 409);
        assert.match(await errorOf(demote), /boss is the last enabled Admin/);
        assert.equal((await change(boss.id, { disabled: true }, init)).status, 409);
        assert.equal((await remove(boss.id, init)).status, 409);
      }
      const [[row]] = await pool.query<RowDataPacket[]>('SELECT role, disabled FROM users WHERE id = ?', [boss.id]);
      assert.deepEqual({ ...row }, { role: 'admin', disabled: 0 });
    });

    test('a disabled Admin does not count: the one enabled Admin is still the last', async () => {
      const old = await addUser(pool, 'old', 'admin');
      assert.equal((await change(old.id, { disabled: true })).status, 200);
      assert.equal((await change(boss.id, { role: 'viewer' }, asAdmin())).status, 409);
      // Enabling the other again makes room.
      assert.equal((await change(old.id, { disabled: false })).status, 200);
      assert.equal((await change(old.id, { role: 'viewer' })).status, 200);
    });

    test('with another enabled Admin, either may be demoted, disabled, or deleted, but no one deletes or disables themselves', async () => {
      const two = await addUser(pool, 'two', 'admin');
      const self = await remove(boss.id);
      assert.equal(self.status, 409);
      assert.match(await errorOf(self), /cannot delete yourself/);
      assert.equal((await change(boss.id, { disabled: true })).status, 409);
      assert.equal((await change(two.id, { disabled: true })).status, 200);
      assert.equal((await change(two.id, { disabled: false })).status, 200);
      assert.equal((await change(two.id, { role: 'viewer' })).status, 200);
      assert.equal((await change(two.id, { role: 'admin' })).status, 200);
      assert.equal((await remove(two.id)).status, 204);
      // The other may demote this one, who is then no longer an Admin at all.
      const three = await addUser(pool, 'three', 'admin');
      const threes = asSession(await signIn(server, 'three', three.password));
      assert.equal((await change(boss.id, { role: 'viewer' }, threes())).status, 200);
      assert.equal((await fetch(url(), as())).status, 403);
    });

    test('two Admins demoting each other at once: one of them stays an Admin', async () => {
      const two = await addUser(pool, 'two', 'admin');
      const twos = asSession(await signIn(server, 'two', two.password));
      const results = await Promise.all([change(two.id, { role: 'viewer' }), change(boss.id, { role: 'viewer' }, twos())]);
      // The other is refused: as the last Admin (409), or, once already demoted, as no Admin at all (403).
      const statuses = results.map((r) => r.status);
      assert.equal(statuses.filter((s) => s === 200).length, 1, String(statuses));
      assert.ok(statuses.every((s) => [200, 403, 409].includes(s)), String(statuses));
      const [[{ n }]] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0");
      assert.equal(Number(n), 1);
    });
  });

  test('the Admin token manages users too (bench and deploy scripts have no session)', async () => {
    const response = await add({ username: 'walker', role: 'admin', password: 'a-long-password' }, asAdmin());
    assert.equal(response.status, 201);
    const walker = await json<UserPayload>(response);
    assert.equal((await fetch(url(), asAdmin())).status, 200);
    assert.equal((await remove(walker.id, asAdmin())).status, 204);
  });

  describe('reset-admin-password (deploy.sh, userCli.ts)', () => {
    test('makes the named user an enabled Admin with the new password and ends its sessions', async () => {
      const cookie = await signIn(server, 'boss', boss.password);
      await pool.query("UPDATE users SET role = 'viewer', disabled = 1 WHERE id = ?", [boss.id]);
      assert.deepEqual(await resetAdminPassword(pool, 'BOSS', 'recovered-password', new Date()), { done: 'reset', username: 'boss' });
      assert.equal((await whoAmI(cookie)).status, 401);
      const response = await signInResponse(server, 'boss', 'recovered-password');
      assert.equal(response.status, 200);
      assert.equal((await json<{ user: { role: string } }>(response)).user.role, 'admin');
    });

    test('creates the user when none is called that', async () => {
      await pool.query('DELETE FROM users');
      assert.deepEqual(await resetAdminPassword(pool, 'admin', 'recovered-password', new Date()), { done: 'created', username: 'admin' });
      const response = await signInResponse(server, 'admin', 'recovered-password');
      assert.equal(response.status, 200);
      assert.deepEqual((await json<{ user: { role: string }; mustChangePassword: boolean }>(response)).mustChangePassword, false);
    });
  });
});
