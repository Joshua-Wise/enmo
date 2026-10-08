import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'mysql2/promise';
import { createTestPool, resetDatabase } from './helpers/database';
import { startServer, testConfig, TEST_ADMIN_TOKEN, TEST_DEVICE_TOKEN, type RunningServer } from './helpers/server';
import { addUser, signIn } from './helpers/users';
import { createBroadcaster } from '../src/sse';

/**
 * Who may reach what (docs/adr/0010), route by route over HTTP: every page read needs a session or
 * the Admin token; every change, and what only an Admin reads, an Admin's session or the token;
 * Readings, the firmware check, and health are as they were.
 */

const DAY = '?from=2026-10-01&to=2026-10-02&tz=UTC';
const WINDOW = `?from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z`;

/** What the pages read: any signed-in user. */
const PAGE_READS = [
  '/api/dashboard',
  '/api/campuses',
  '/api/campuses/overview?tz=UTC',
  '/api/devices',
  '/api/devices/999999/history?tz=UTC',
  `/api/devices/999999/readings.csv${DAY}`,
  `/api/incidents${WINDOW}`,
  `/api/incidents.csv${WINDOW}&tz=UTC`,
];

/** What only an Admin reads. */
const ADMIN_READS = [
  '/api/campuses/recipients',
  '/api/devices/pending',
  '/api/devices/rotation',
  '/api/firmware/status',
  '/api/notifications/status',
  '/api/system',
  '/api/users',
];

/** Every change, as [method, path]. Ids that name nothing, so a change that gets through changes nothing. */
const CHANGES: Array<[string, string]> = [
  ['POST', '/api/campuses'],
  ['PATCH', '/api/campuses/999999'],
  ['DELETE', '/api/campuses/999999'],
  ['POST', '/api/devices'],
  ['PATCH', '/api/devices/999999'],
  ['DELETE', '/api/devices/999999'],
  ['PATCH', '/api/devices/pending/ESP_FFFFFE'],
  ['DELETE', '/api/devices/pending/ESP_FFFFFE'],
  ['DELETE', '/api/devices/999999/history'],
  ['POST', '/api/incidents/999999/acknowledge'],
  ['POST', '/api/firmware'],
  ['POST', '/api/firmware/widen'],
  ['DELETE', '/api/firmware'],
  ['POST', '/api/notifications/test'],
  ['POST', '/api/notifications/report'],
  ['POST', '/api/users'],
  ['PATCH', '/api/users/999999'],
  ['DELETE', '/api/users/999999'],
];

describe('who may reach which route', () => {
  let pool: Pool;
  let server: RunningServer;
  let viewer: string;
  let admin: string;

  before(async () => {
    pool = createTestPool();
    await resetDatabase(pool);
    server = await startServer(pool, testConfig(), { sse: createBroadcaster({ heartbeatMs: 100 }) });
    const kim = await addUser(pool, 'kim', 'viewer');
    const sam = await addUser(pool, 'sam', 'admin');
    viewer = await signIn(server, 'kim', kim.password);
    admin = await signIn(server, 'sam', sam.password);
  });
  after(async () => {
    await server.close();
    await pool.end();
  });

  const read = (path: string, headers: Record<string, string> = {}) => fetch(`${server.url}${path}`, { headers });
  const send = (method: string, path: string, headers: Record<string, string> = {}) => {
    const firmware = path === '/api/firmware' && method === 'POST';
    return fetch(`${server.url}${path}`, {
      method,
      headers: { 'Content-Type': firmware ? 'application/octet-stream' : 'application/json', ...headers },
      body: firmware ? Buffer.from('not a signed build') : '{}',
    });
  };
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const statusOf = async (response: Promise<Response>) => {
    const r = await response;
    await r.body?.cancel();
    return r.status;
  };

  test('with no session, every read route and the stream answer 401', async () => {
    for (const path of [...PAGE_READS, ...ADMIN_READS, '/api/dashboard/stream']) {
      assert.equal(await statusOf(read(path)), 401, path);
    }
  });

  test('with no session, every change answers 401', async () => {
    for (const [method, path] of CHANGES) assert.equal(await statusOf(send(method, path)), 401, `${method} ${path}`);
  });

  test('the Device token reads nothing and changes nothing', async () => {
    for (const path of [...PAGE_READS, ...ADMIN_READS]) assert.equal(await statusOf(read(path, bearer(TEST_DEVICE_TOKEN))), 401, path);
    for (const [method, path] of CHANGES) assert.equal(await statusOf(send(method, path, bearer(TEST_DEVICE_TOKEN))), 401, `${method} ${path}`);
  });

  test('a Viewer reads every page, the stream included, and none of what only an Admin reads', async () => {
    for (const path of PAGE_READS) assert.ok(![401, 403].includes(await statusOf(read(path, { Cookie: viewer }))), path);
    for (const path of ADMIN_READS) assert.equal(await statusOf(read(path, { Cookie: viewer })), 403, path);
    const stream = await fetch(`${server.url}/api/dashboard/stream`, { headers: { Cookie: viewer } });
    assert.equal(stream.status, 200);
    await stream.body?.cancel();
  });

  test('a Viewer is refused every change with 403', async () => {
    for (const [method, path] of CHANGES) assert.equal(await statusOf(send(method, path, { Cookie: viewer })), 403, `${method} ${path}`);
  });

  test('an Admin\'s session and the Admin token get past every guard, on every read and change', async () => {
    for (const credential of [{ Cookie: admin }, bearer(TEST_ADMIN_TOKEN)]) {
      for (const path of [...PAGE_READS, ...ADMIN_READS]) assert.ok(![401, 403].includes(await statusOf(read(path, credential))), `${path} ${Object.keys(credential)}`);
      for (const [method, path] of CHANGES) {
        assert.ok(![401, 403, 415].includes(await statusOf(send(method, path, credential))), `${method} ${path} ${Object.keys(credential)}`);
      }
    }
  });

  test('health, Readings, and the firmware check are as they were: health open, the other two on the Device token alone', async () => {
    assert.equal(await statusOf(read('/api/health')), 200);
    const reading = (headers: Record<string, string>) =>
      fetch(`${server.url}/api/readings`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ device: 'ESP_A1B2C3', temp: 72, humidity: 40 }) });
    assert.equal(await statusOf(reading({ Cookie: admin })), 401);
    assert.equal(await statusOf(reading(bearer(TEST_ADMIN_TOKEN))), 401);
    assert.ok(![401, 403].includes(await statusOf(reading(bearer(TEST_DEVICE_TOKEN)))));
    const check = (headers: Record<string, string>) => read('/api/firmware', { 'x-ESP8266-STA-MAC': '5C:CF:7F:A1:B2:C3', 'x-ESP8266-version': '1', ...headers });
    assert.equal(await statusOf(check({ Cookie: admin })), 401);
    assert.ok(![401, 403].includes(await statusOf(check(bearer(TEST_DEVICE_TOKEN)))));
  });

  test('an unknown route under /api is still a 404', async () => {
    assert.equal(await statusOf(read('/api/nothing-here')), 404);
  });
});
