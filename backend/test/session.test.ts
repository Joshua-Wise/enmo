import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { createTestPool, resetDatabase } from './helpers/database';
import { startServer, testConfig, TEST_ADMIN_TOKEN, type RunningServer } from './helpers/server';
import { asAdmin, errorOf, json } from './helpers/api';
import { subscribe, type SseClient } from './helpers/sse';
import { addUser, asSession, signIn, signInResponse } from './helpers/users';
import { createBroadcaster, type Broadcaster } from '../src/sse';
import { createSessions, SESSION_IDLE_MS, SESSION_MAX_MS } from '../src/sessions';
import { ensureFirstUser } from '../src/users';
import { SIGN_IN_FAILURES_PER_ADDRESS, SIGN_IN_FAILURES_PER_USERNAME } from '../src/routes/session';

interface WhoIs {
  user: { id: number; username: string; role: 'admin' | 'viewer' };
  mustChangePassword: boolean;
}

describe('/api/session', () => {
  let pool: Pool;
  let server: RunningServer;
  let sse: Broadcaster;
  /** The server's clock, which a test may move. */
  let clock: Date;
  const open: SseClient[] = [];

  before(() => {
    pool = createTestPool();
  });
  beforeEach(async () => {
    await resetDatabase(pool);
    clock = new Date();
    sse = createBroadcaster({ heartbeatMs: 100 });
    server = await startServer(pool, testConfig({ corsOrigin: 'http://localhost:5173' }), { sse, now: () => clock });
  });
  afterEach(async () => {
    for (const c of open.splice(0)) c.close();
    await server.close();
  });
  after(() => pool.end());

  const get = (path: string, init: RequestInit = {}) => fetch(`${server.url}${path}`, init);
  const whoAmI = (cookie: string) => get('/api/session', { headers: { Cookie: cookie } });
  const listen = async (headers: Record<string, string>): Promise<SseClient> => {
    const c = await subscribe(`${server.url}/api/dashboard/stream`, headers);
    open.push(c);
    return c;
  };

  describe('signing in', () => {
    test('the right password signs in: who it is, and a session cookie script cannot read, sent only to the API on this site', async () => {
      const sam = await addUser(pool, 'sam', 'admin');
      const response = await signInResponse(server, 'sam', sam.password);
      assert.equal(response.status, 200);
      assert.deepEqual(await json<WhoIs>(response), { user: { id: sam.id, username: 'sam', role: 'admin' }, mustChangePassword: false });
      const [cookie] = response.headers.getSetCookie();
      assert.match(cookie, /^ta_session=[A-Za-z0-9_-]{43};/);
      const attributes = cookie.split(';').map((a) => a.trim().toLowerCase());
      assert.ok(attributes.includes('httponly'), cookie);
      assert.ok(attributes.includes('samesite=strict'), cookie);
      assert.ok(attributes.includes('path=/api'), cookie);
      assert.ok(attributes.includes(`max-age=${SESSION_MAX_MS / 1000}`), cookie);
      // Plain HTTP here, so the browser must be able to send it back over plain HTTP.
      assert.ok(!attributes.includes('secure'), cookie);
    });

    test('over HTTPS (nginx says so in X-Forwarded-Proto) the cookie is Secure', async () => {
      const sam = await addUser(pool, 'sam', 'admin');
      const response = await signInResponse(server, 'sam', sam.password, { 'X-Forwarded-Proto': 'https' });
      assert.equal(response.status, 200);
      assert.ok(response.headers.getSetCookie()[0].split(';').map((a) => a.trim().toLowerCase()).includes('secure'));
    });

    test('the username is matched ignoring case', async () => {
      const sam = await addUser(pool, 'Sam', 'viewer');
      const response = await signInResponse(server, 'SAM', sam.password);
      assert.equal(response.status, 200);
      assert.equal((await json<WhoIs>(response)).user.username, 'Sam');
    });

    test('a wrong password, an unknown name, and a disabled user all say only "Wrong username or password", and set no cookie', async () => {
      const sam = await addUser(pool, 'sam', 'admin');
      const off = await addUser(pool, 'off', 'viewer');
      await pool.query('UPDATE users SET disabled = 1 WHERE id = ?', [off.id]);
      for (const [username, password] of [['sam', 'not-the-password'], ['nobody', sam.password], ['off', off.password]]) {
        const response = await signInResponse(server, username, password);
        assert.equal(response.status, 401, `${username}`);
        assert.equal(await errorOf(response), 'Wrong username or password');
        assert.deepEqual(response.headers.getSetCookie(), []);
      }
    });

    test('a sign-in with no username or password, or sent as a form, is refused with no cookie', async () => {
      await addUser(pool, 'sam', 'admin', 'sam-password');
      for (const body of [{}, { username: 'sam' }, { username: '', password: 'x' }, { username: 'sam', password: 42 }]) {
        const response = await fetch(`${server.url}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        assert.equal(response.status, 400, JSON.stringify(body));
      }
      // What a form on another site could send: no JSON, so no body is read.
      const form = await fetch(`${server.url}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=sam&password=sam-password',
      });
      assert.equal(form.status, 400);
      assert.deepEqual(form.headers.getSetCookie(), []);
    });

    test('records when the user last signed in', async () => {
      const sam = await addUser(pool, 'sam', 'viewer');
      await signIn(server, 'sam', sam.password);
      const [[row]] = await pool.query<RowDataPacket[]>('SELECT last_sign_in_at AS at FROM users WHERE id = ?', [sam.id]);
      assert.equal((row.at as Date).getTime(), clock.getTime());
    });

    test('the session is stored as a digest: the cookie value is nowhere in the database', async () => {
      const sam = await addUser(pool, 'sam', 'viewer');
      const cookie = await signIn(server, 'sam', sam.password);
      const [rows] = await pool.query<RowDataPacket[]>('SELECT id FROM sessions');
      assert.equal(rows.length, 1);
      assert.notEqual(rows[0].id, cookie.split('=')[1]);
      assert.match(rows[0].id as string, /^[0-9a-f]{64}$/);
    });
  });

  describe('the sign-in limit', () => {
    test(`after ${SIGN_IN_FAILURES_PER_USERNAME} failures for one username, from any addresses, even the right password is refused with 429`, async () => {
      const sam = await addUser(pool, 'sam', 'admin');
      for (let i = 0; i < SIGN_IN_FAILURES_PER_USERNAME; i++) {
        const response = await signInResponse(server, i % 2 === 0 ? 'sam' : 'SAM', 'wrong-password', { 'X-Forwarded-For': `198.51.100.${i + 1}` });
        assert.equal(response.status, 401);
      }
      const locked = await signInResponse(server, 'sam', sam.password, { 'X-Forwarded-For': '203.0.113.9' });
      assert.equal(locked.status, 429);
      assert.ok(Number(locked.headers.get('retry-after')) > 0);
      assert.match(await errorOf(locked), /Too many failed sign-ins/);
      // Another user is not locked out by it.
      const kim = await addUser(pool, 'kim', 'viewer');
      assert.equal((await signInResponse(server, 'kim', kim.password, { 'X-Forwarded-For': '203.0.113.9' })).status, 200);
    });

    test(`after ${SIGN_IN_FAILURES_PER_ADDRESS} failures from one address, any username is refused from it, and other addresses still sign in`, async () => {
      const sam = await addUser(pool, 'sam', 'admin');
      const from = { 'X-Forwarded-For': '198.51.100.7' };
      for (let i = 0; i < SIGN_IN_FAILURES_PER_ADDRESS; i++) {
        assert.equal((await signInResponse(server, `guess${i}`, 'wrong-password', from)).status, 401);
      }
      assert.equal((await signInResponse(server, 'sam', sam.password, from)).status, 429);
      assert.equal((await signInResponse(server, 'sam', sam.password, { 'X-Forwarded-For': '198.51.100.8' })).status, 200);
    });

    test('a right sign-in is never counted', async () => {
      const sam = await addUser(pool, 'sam', 'viewer');
      for (let i = 0; i < SIGN_IN_FAILURES_PER_USERNAME + 2; i++) {
        assert.equal((await signInResponse(server, 'sam', sam.password)).status, 200);
      }
    });
  });

  describe('who is signed in, and signing out', () => {
    test('GET says who is signed in, and 401 with no session', async () => {
      const kim = await addUser(pool, 'kim', 'viewer');
      assert.equal((await get('/api/session')).status, 401);
      const cookie = await signIn(server, 'kim', kim.password);
      const response = await whoAmI(cookie);
      assert.equal(response.status, 200);
      assert.deepEqual(await json<WhoIs>(response), { user: { id: kim.id, username: 'kim', role: 'viewer' }, mustChangePassword: false });
    });

    test('signing out ends the session at once: the cookie is cleared and refused after, and its open stream closes', async () => {
      const kim = await addUser(pool, 'kim', 'viewer');
      const cookie = await signIn(server, 'kim', kim.password);
      const other = await signIn(server, 'kim', kim.password);
      const stream = await listen({ Cookie: cookie });
      const otherStream = await listen({ Cookie: other });
      assert.equal(stream.response.status, 200);

      const out = await fetch(`${server.url}/api/session`, asSession(cookie)({ method: 'DELETE' }));
      assert.equal(out.status, 204);
      assert.match(out.headers.getSetCookie()[0], /^ta_session=;.*Expires=Thu, 01 Jan 1970/i);
      await stream.ended;
      assert.equal((await whoAmI(cookie)).status, 401);
      assert.equal((await get('/api/dashboard', { headers: { Cookie: cookie } })).status, 401);
      assert.equal((await fetch(`${server.url}/api/dashboard/stream`, { headers: { Cookie: cookie } })).status, 401);
      // The same user's other session is untouched.
      assert.equal((await whoAmI(other)).status, 200);
      assert.equal(sse.clientCount, 1);
      otherStream.close();
    });

    test('signing in again from the same browser ends the session it held', async () => {
      const kim = await addUser(pool, 'kim', 'viewer');
      const first = await signIn(server, 'kim', kim.password);
      const again = await fetch(`${server.url}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: first },
        body: JSON.stringify({ username: 'kim', password: kim.password }),
      });
      assert.equal(again.status, 200);
      assert.equal((await whoAmI(first)).status, 401);
    });

    test('signing out with no session is still a 204', async () => {
      assert.equal((await fetch(`${server.url}/api/session`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } })).status, 204);
    });
  });

  describe('expiry', () => {
    test('a session unused for 12 hours has ended', async () => {
      const kim = await addUser(pool, 'kim', 'viewer');
      const cookie = await signIn(server, 'kim', kim.password);
      clock = new Date(clock.getTime() + SESSION_IDLE_MS - 1000);
      assert.equal((await whoAmI(cookie)).status, 200);
      clock = new Date(clock.getTime() + SESSION_IDLE_MS - 1000);
      assert.equal((await whoAmI(cookie)).status, 200, 'used 1 s short of 12 hours ago');
      clock = new Date(clock.getTime() + SESSION_IDLE_MS);
      assert.equal((await whoAmI(cookie)).status, 401);
    });

    test('a session in use ends after 7 days all the same', async () => {
      const kim = await addUser(pool, 'kim', 'viewer');
      const cookie = await signIn(server, 'kim', kim.password);
      const start = clock.getTime();
      for (let at = start + 6 * 60 * 60 * 1000; at < start + SESSION_MAX_MS; at += 6 * 60 * 60 * 1000) {
        clock = new Date(at);
        assert.equal((await whoAmI(cookie)).status, 200, `at ${(at - start) / 3_600_000} h`);
      }
      clock = new Date(start + SESSION_MAX_MS);
      assert.equal((await whoAmI(cookie)).status, 401);
    });

    test('the sweep keeps a session with an open stream in use, forgets expired ones, and closes the streams of ended ones', async () => {
      const kim = await addUser(pool, 'kim', 'viewer');
      const sam = await addUser(pool, 'sam', 'viewer');
      const watching = await signIn(server, 'kim', kim.password);
      const idle = await signIn(server, 'kim', kim.password);
      const disabled = await signIn(server, 'sam', sam.password);
      await listen({ Cookie: watching });
      const samStream = await listen({ Cookie: disabled });
      await pool.query('UPDATE users SET disabled = 1 WHERE id = ?', [sam.id]);

      const sessions = createSessions({ pool, sse, now: () => clock });
      clock = new Date(clock.getTime() + SESSION_IDLE_MS - 60_000);
      await sessions.sweep();
      await samStream.ended;
      assert.equal(sse.clientCount, 1);
      clock = new Date(clock.getTime() + 120_000);
      // Twelve hours since either was used by a request: the one with the stream open is still in use.
      assert.equal((await whoAmI(watching)).status, 200);
      assert.equal((await whoAmI(idle)).status, 401);
      await sessions.sweep();
      const [[{ n }]] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM sessions');
      assert.equal(Number(n), 2, 'the expired session is gone; the watching one and the disabled user\'s remain until it is enabled or deleted');
    });
  });

  describe('the first sign-in of a fresh install', () => {
    test('with no users, start-up creates admin / admin and says so; with any user it does nothing', async () => {
      const lines: string[] = [];
      assert.equal(await ensureFirstUser(pool, clock, (line) => lines.push(line)), true);
      assert.equal(lines.length, 1);
      assert.match(lines[0], /admin.*admin/);
      assert.equal(await ensureFirstUser(pool, clock, (line) => lines.push(line)), false);
      assert.equal(lines.length, 1);
      const [rows] = await pool.query<RowDataPacket[]>("SELECT username, role, must_change_password AS mustChange, password_hash AS hash FROM users");
      assert.equal(rows.length, 1);
      assert.deepEqual({ ...rows[0], hash: undefined }, { username: 'admin', role: 'admin', mustChange: 1, hash: undefined });
      assert.match(rows[0].hash as string, /^scrypt\$/);
    });

    test('admin / admin signs in to nothing but choosing a new password, which then opens everything', async () => {
      await ensureFirstUser(pool, clock, () => {});
      const response = await signInResponse(server, 'admin', 'admin');
      assert.equal(response.status, 200);
      assert.equal((await json<WhoIs>(response)).mustChangePassword, true);
      const cookie = response.headers.getSetCookie()[0].split(';')[0];
      const as = asSession(cookie);

      for (const [method, path] of [['GET', '/api/dashboard'], ['GET', '/api/campuses'], ['GET', '/api/users'], ['POST', '/api/campuses'], ['GET', '/api/dashboard/stream']]) {
        const refused = await fetch(`${server.url}${path}`, as({ method, body: method === 'POST' ? JSON.stringify({ name: 'X', shortcode: 'X' }) : undefined }));
        assert.equal(refused.status, 403, `${method} ${path}`);
        assert.equal(await errorOf(refused), 'Choose a new password first');
      }
      assert.equal((await whoAmI(cookie)).status, 200, 'who is signed in still answers');

      const change = (newPassword: string, currentPassword = 'admin') =>
        fetch(`${server.url}/api/session/password`, as({ method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }));
      const stays = await change('admin');
      assert.equal(stays.status, 422);
      assert.match(await errorOf(stays), /at least 8 characters/);
      assert.equal((await change('short')).status, 422);
      const changed = await change('closet-temps-2026');
      assert.equal(changed.status, 200);
      assert.equal((await json<WhoIs>(changed)).mustChangePassword, false);

      assert.equal((await fetch(`${server.url}/api/dashboard`, as())).status, 200);
      assert.equal((await fetch(`${server.url}/api/campuses`, as({ method: 'POST', body: JSON.stringify({ name: 'Central High', shortcode: 'CHS' }) }))).status, 201);
      assert.equal((await signInResponse(server, 'admin', 'admin')).status, 401);
      assert.equal((await signInResponse(server, 'admin', 'closet-temps-2026')).status, 200);
    });
  });

  describe('changing your own password', () => {
    test('needs the current one, takes 8 characters or more, and ends your other sessions but not this one', async () => {
      const kim = await addUser(pool, 'kim', 'viewer');
      const here = await signIn(server, 'kim', kim.password);
      const elsewhere = await signIn(server, 'kim', kim.password);
      const elsewhereStream = await listen({ Cookie: elsewhere });
      const change = (body: unknown) => fetch(`${server.url}/api/session/password`, asSession(here)({ method: 'POST', body: JSON.stringify(body) }));

      const wrong = await change({ currentPassword: 'not-it', newPassword: 'a-new-password' });
      assert.equal(wrong.status, 422);
      assert.equal(await errorOf(wrong), 'Your current password is not right');
      assert.equal((await change({ newPassword: 'a-new-password' })).status, 422);
      assert.equal((await change({ currentPassword: kim.password, newPassword: 'seven77' })).status, 422);
      assert.equal((await change({ currentPassword: kim.password, newPassword: 'x'.repeat(201) })).status, 422);

      assert.equal((await change({ currentPassword: kim.password, newPassword: 'a-new-password' })).status, 200);
      assert.equal((await whoAmI(here)).status, 200);
      assert.equal((await whoAmI(elsewhere)).status, 401);
      await elsewhereStream.ended;
      assert.equal((await signInResponse(server, 'kim', kim.password)).status, 401);
      assert.equal((await signInResponse(server, 'kim', 'a-new-password')).status, 200);
    });

    test('a wrong current password counts against the sign-in limit', async () => {
      const kim = await addUser(pool, 'kim', 'viewer');
      const cookie = await signIn(server, 'kim', kim.password);
      for (let i = 0; i < SIGN_IN_FAILURES_PER_USERNAME; i++) {
        const response = await fetch(`${server.url}/api/session/password`, asSession(cookie)({ method: 'POST', body: JSON.stringify({ currentPassword: `guess-${i}`, newPassword: 'a-new-password' }) }));
        assert.equal(response.status, 422);
      }
      const locked = await fetch(`${server.url}/api/session/password`, asSession(cookie)({ method: 'POST', body: JSON.stringify({ currentPassword: kim.password, newPassword: 'a-new-password' }) }));
      assert.equal(locked.status, 429);
    });

    test('is a session\'s own: the Admin token has no password to change', async () => {
      const response = await fetch(`${server.url}/api/session/password`, asAdmin({ method: 'POST', body: JSON.stringify({ currentPassword: 'x', newPassword: 'a-new-password' }) }));
      assert.equal(response.status, 401);
    });
  });

  describe('cross-site requests', () => {
    test('a change made with the cookie must be JSON: a form-shaped request is refused with 415 and changes nothing', async () => {
      const sam = await addUser(pool, 'sam', 'admin');
      const cookie = await signIn(server, 'sam', sam.password);
      for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', undefined]) {
        const response = await fetch(`${server.url}/api/campuses`, {
          method: 'POST',
          headers: { Cookie: cookie, ...(type === undefined ? {} : { 'Content-Type': type }) },
          body: type === undefined ? undefined : '{"name":"Forged","shortcode":"FRG"}',
        });
        assert.equal(response.status, 415, String(type));
      }
      assert.equal((await fetch(`${server.url}/api/campuses`, asSession(cookie)({ method: 'DELETE' }))).status, 404, 'a JSON-typed DELETE passes the check');
      const [rows] = await pool.query<RowDataPacket[]>('SELECT * FROM campuses');
      assert.equal(rows.length, 0);
    });

    test('the Admin token needs no such header: a browser never sends it on its own', async () => {
      const response = await fetch(`${server.url}/api/firmware`, { method: 'DELETE', headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` } });
      assert.notEqual(response.status, 415);
      assert.notEqual(response.status, 401);
    });

    test('CORS lets the configured origin send the cookie, and no other origin', async () => {
      const allowed = await fetch(`${server.url}/api/session`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
      assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');
      assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:5173');
      const refused = await fetch(`${server.url}/api/session`, { method: 'OPTIONS', headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' } });
      assert.equal(refused.status, 403);
      assert.equal(refused.headers.get('access-control-allow-credentials'), null);
    });
  });

  test('no password, hash, or session id is ever logged', async () => {
    const said: string[] = [];
    const methods = ['log', 'error', 'warn', 'info'] as const;
    const original = methods.map((m) => console[m]);
    for (const m of methods) console[m] = (...args: unknown[]) => void said.push(args.map(String).join(' '));
    try {
      const sam = await addUser(pool, 'sam', 'admin', 'sams-secret-password');
      await signInResponse(server, 'sam', 'a-wrong-guess-password');
      const cookie = await signIn(server, 'sam', sam.password);
      await fetch(`${server.url}/api/session/password`, asSession(cookie)({ method: 'POST', body: JSON.stringify({ currentPassword: sam.password, newPassword: 'sams-next-password' }) }));
      await fetch(`${server.url}/api/session`, asSession(cookie)({ method: 'DELETE' }));
      const [[{ hash }]] = await pool.query<RowDataPacket[]>('SELECT password_hash AS hash FROM users');
      const everything = said.join('\n');
      for (const secret of ['sams-secret-password', 'a-wrong-guess-password', 'sams-next-password', cookie.split('=')[1], hash as string]) {
        assert.ok(!everything.includes(secret), `logged: ${secret}`);
      }
    } finally {
      methods.forEach((m, i) => (console[m] = original[i]));
    }
  });
});
