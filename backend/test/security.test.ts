import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { createTestPool, resetDatabase } from './helpers/database';
import { startServer, testConfig, TEST_ADMIN_TOKEN, type RunningServer } from './helpers/server';
import { api, asAdmin, asDevice, json, type Campus, type Dashboard, type Device } from './helpers/api';
import { subscribe, type SseClient } from './helpers/sse';
import { createBroadcaster, DEFAULT_MAX_STREAMS, DEFAULT_MAX_STREAMS_PER_ADDRESS } from '../src/sse';
import { DEVICE_AUTH_FAILURE_LIMIT } from '../src/routes/readings';

/** As nginx forwards it: the address it saw is the last X-Forwarded-For entry (app.ts trusts one hop). */
const from = (address: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...(init.headers as Record<string, string>), 'X-Forwarded-For': address },
});

describe('security', () => {
  let pool: Pool;
  let server: RunningServer;
  let client: ReturnType<typeof api>;

  before(() => {
    pool = createTestPool();
  });
  beforeEach(async () => {
    await resetDatabase(pool);
    server = await startServer(pool);
    client = api(server);
  });
  afterEach(() => server.close());
  after(() => pool.end());

  describe('response headers', () => {
    test('no response names the framework (X-Powered-By)', async () => {
      for (const path of ['/api/campuses', '/api/nothing-here', '/api/dashboard']) {
        const response = await fetch(`${server.url}${path}`);
        await response.arrayBuffer();
        assert.equal(response.headers.get('x-powered-by'), null, path);
      }
    });
  });

  describe('tokens', () => {
    test('a refused token is never echoed in the response', async () => {
      const guess = 'guess-0123456789abcdef';
      const responses = [
        await client.readings.add({ device: 'ESP_A1B2C3', temp: 70, humidity: 40 }, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${guess}` } }),
        await client.campuses.add({ name: 'X', shortcode: 'X' }, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${guess}` } }),
      ];
      for (const response of responses) {
        assert.equal(response.status, 401);
        const body = await response.text();
        assert.ok(!body.includes(guess), body);
        assert.deepEqual(JSON.parse(body), { error: 'Not authorised' });
      }
    });

    test('a token of the same length that differs in its last character is refused', async () => {
      const nearMiss = TEST_ADMIN_TOKEN.slice(0, -1) + (TEST_ADMIN_TOKEN.endsWith('x') ? 'y' : 'x');
      const response = await client.campuses.add({ name: 'X', shortcode: 'X' }, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${nearMiss}` } });
      assert.equal(response.status, 401);
      await response.arrayBuffer();
    });

    test(`guessing the Device token is limited to ${DEVICE_AUTH_FAILURE_LIMIT} refusals per address; other addresses are unaffected`, async () => {
      const campus = await client.campuses.create();
      await client.devices.create(campus.id, 'ESP_A1B2C3');
      const guess = (i: number) => from('203.0.113.9', { headers: { 'Content-Type': 'application/json', Authorization: `Bearer guess-${i}` } });
      for (let i = 0; i < DEVICE_AUTH_FAILURE_LIMIT; i++) {
        const response = await client.readings.add({ device: 'ESP_A1B2C3', temp: 70, humidity: 40 }, guess(i));
        assert.equal(response.status, 401, `guess ${i + 1}`);
        await response.arrayBuffer();
      }
      const limited = await client.readings.add({ device: 'ESP_A1B2C3', temp: 70, humidity: 40 }, guess(-1));
      assert.equal(limited.status, 429);
      await limited.arrayBuffer();
      // Even the right token is refused from that address now, or the limit would tell a guesser when it was right.
      const right = await client.readings.add({ device: 'ESP_A1B2C3', temp: 70, humidity: 40 }, from('203.0.113.9', asDevice()));
      assert.equal(right.status, 429);
      await right.arrayBuffer();

      const elsewhere = await client.readings.add({ device: 'ESP_A1B2C3', temp: 70, humidity: 40 }, from('203.0.113.10', asDevice()));
      assert.equal(elsewhere.status, 201);
      await elsewhere.arrayBuffer();
    });

    test('a Device with the right token is never counted toward the refusal limit', async () => {
      const campus = await client.campuses.create();
      // Many Devices behind one campus address, each well within its own per-Device limit.
      const hostnames = Array.from({ length: DEVICE_AUTH_FAILURE_LIMIT + 5 }, (_, i) => `ESP_${(0xa00000 + i).toString(16).toUpperCase()}`);
      for (const hostname of hostnames) await client.devices.create(campus.id, hostname);
      for (const hostname of hostnames) {
        const response = await client.readings.add({ device: hostname, temp: 70, humidity: 40 }, from('198.51.100.4', asDevice()));
        assert.equal(response.status, 201, hostname);
        await response.arrayBuffer();
      }
    });

    test('Readings a board gave up on while the database stalled are never counted as wrong tokens', async () => {
      const campus = await client.campuses.create();
      // One Device per stalled POST, so the per-Device write limit never answers in their place.
      const hostnames = Array.from({ length: DEVICE_AUTH_FAILURE_LIMIT + 5 }, (_, i) => `ESP_${(0xb00000 + i).toString(16).toUpperCase()}`);
      for (const hostname of hostnames) await client.devices.create(campus.id, hostname);
      // The stall: every Device row locked by another connection, so ingest waits, as it does while the db is away or slow.
      const holder = createTestPool();
      const lock = await holder.getConnection();
      try {
        await lock.beginTransaction();
        await lock.query('SELECT id FROM devices FOR UPDATE');
        // Each board gives up before the answer, as the firmware does after its HTTP timeout.
        await Promise.all(
          hostnames.map((hostname) =>
            client.readings
              .add({ device: hostname, temp: 70, humidity: 40 }, from('198.51.100.77', { ...asDevice(), signal: AbortSignal.timeout(300) }))
              .then(
                (response: Response) => assert.fail(`${hostname} was answered ${response.status} during the stall`),
                (error: Error) => assert.equal(error.name, 'TimeoutError'),
              ),
          ),
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
      } finally {
        await lock.rollback();
        lock.release();
        await holder.end();
      }
      const after = await client.readings.add({ device: hostnames[0], temp: 70, humidity: 40 }, from('198.51.100.77', asDevice()));
      assert.equal(after.status, 201);
      await after.arrayBuffer();
      // The stalled Readings still commit once the lock goes (N5 in the resilience report); let them finish before the pool closes.
      for (let waited = 0; waited < 10_000; waited += 50) {
        const [[{ count }]] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS count FROM readings');
        if (Number(count) >= hostnames.length + 1) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    test('a refusal other than a wrong token is never counted as one', async () => {
      // No Device is registered, so every right-token Reading is a 404: neither a success nor a wrong token.
      for (let i = 0; i <= DEVICE_AUTH_FAILURE_LIMIT; i++) {
        const hostname = `ESP_${(0xc00000 + i).toString(16).toUpperCase()}`;
        const response = await client.readings.add({ device: hostname, temp: 70, humidity: 40 }, from('198.51.100.78', asDevice()));
        assert.equal(response.status, 404, `post ${i + 1}`);
        await response.arrayBuffer();
      }
    });
  });

  describe('input', () => {
    const injections = ["' OR '1'='1", "1; DROP TABLE devices; --", "\\' OR 1=1 -- ", '1 UNION SELECT id, name, shortcode FROM campuses'];

    test('SQL in every query parameter and path id is data, never SQL', async () => {
      const campus = await client.campuses.create();
      const device = await client.devices.create(campus.id);
      for (const payload of injections) {
        const q = encodeURIComponent(payload);
        const dashboard = await fetch(client.dashboard.url(`?campus=${q}`), asAdmin());
        assert.equal(dashboard.status, 200, payload);
        assert.equal((await json<Dashboard>(dashboard)).devices.length, 0, payload);

        for (const url of [
          client.dashboard.url(`?order=${q}`),
          `${server.url}/api/campuses/overview?tz=${q}`,
          `${server.url}/api/incidents?from=${q}&to=${q}`,
          `${server.url}/api/devices/${device.id}/history?date=${q}`,
          `${server.url}/api/devices/${device.id}/history?tz=${q}`,
        ]) {
          const response = await fetch(url, asAdmin());
          assert.equal(response.status, 422, `${url}`);
          await response.arrayBuffer();
        }
        for (const url of [`${server.url}/api/devices/${q}/history`, `${server.url}/api/devices/${q}`]) {
          const response = await fetch(url, url.endsWith('/history') ? asAdmin() : { ...asAdmin(), method: 'DELETE' });
          assert.equal(response.status, 404, url);
          await response.arrayBuffer();
        }
        const reading = await client.readings.add({ device: payload, temp: 70, humidity: 40 });
        assert.ok([404, 422].includes(reading.status), `${payload}: ${reading.status}`);
        await reading.arrayBuffer();
      }
      // Nothing was dropped or changed.
      assert.equal((await client.devices.list()).length, 1);
      assert.equal((await client.campuses.list()).length, 1);
    });

    test('SQL, markup, emoji, and right-to-left text in names are stored and returned verbatim', async () => {
      const names = ["Robert'); DROP TABLE campuses;--", '<img src=x onerror=alert(1)>', '🔥 Main Office 🌡️', 'מבנה א', 'Café ☕ Δ'];
      for (const [i, name] of names.entries()) {
        const response = await client.campuses.add({ name, shortcode: `S${i}` });
        assert.equal(response.status, 201, name);
        const created = await json<Campus>(response);
        assert.equal(created.name, name);
        const device = await client.devices.create(created.id, `ESP_B0000${i}`, name.slice(0, 50));
        assert.equal(device.closet, name.slice(0, 50));
      }
      const listed = await client.campuses.list();
      assert.deepEqual(listed.map((c) => c.name).sort(), [...names].sort());
      const devices = await client.devices.list();
      assert.equal(devices.length, names.length);
      // The API answers JSON, never HTML a browser would render.
      const response = await fetch(client.campuses.url(), asAdmin());
      assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
      await response.arrayBuffer();
    });

    test('a closet name of 50 emoji is refused, not cut or turned into a 500', async () => {
      const campus = await client.campuses.create();
      const response = await client.devices.add({ hostname: 'ESP_C0FFEE', campusId: campus.id, closet: '🔥'.repeat(50) });
      assert.equal(response.status, 422);
      await response.arrayBuffer();
      const fits = await client.devices.add({ hostname: 'ESP_C0FFEE', campusId: campus.id, closet: '🔥'.repeat(25) });
      assert.equal(fits.status, 201);
      assert.equal((await json<Device>(fits)).closet, '🔥'.repeat(25));
    });

    test('a body over the parser limit is a 413 with no stack trace', async () => {
      const response = await client.campuses.add({ name: 'x'.repeat(200_000), shortcode: 'BIG' });
      assert.equal(response.status, 413);
      const body = await response.text();
      assert.ok(!/at .*\.(js|ts):\d+/.test(body), body);
    });

    test('an unexpected error answers a generic 500, never the stack or the SQL', async () => {
      const broken = await startServer(
        { query: () => Promise.reject(Object.assign(new Error("ER_PARSE_ERROR near 'secret'"), { sql: 'SELECT secret' })) } as unknown as Pool,
        testConfig(),
      );
      try {
        const original = console.error;
        console.error = () => {};
        let response: Response;
        try {
          response = await fetch(`${broken.url}/api/campuses`, asAdmin());
        } finally {
          console.error = original;
        }
        assert.equal(response.status, 500);
        assert.deepEqual(await response.json(), { error: 'Internal server error' });
      } finally {
        await broken.close();
      }
    });

    test('CR and LF in a header value never reach a response header', async () => {
      // fetch itself refuses to send a header with CR/LF, so the injection can only come through a value
      // the server echoes. None of its headers echo request input; prove the one that could (CORS) does not.
      const response = await fetch(client.campuses.url(), { headers: { Origin: 'http://evil.example' } });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
      await response.arrayBuffer();
    });
  });

  describe('the stream', () => {
    let sseServer: RunningServer;
    let sse: ReturnType<typeof createBroadcaster>;
    const open: SseClient[] = [];

    beforeEach(async () => {
      sse = createBroadcaster({ heartbeatMs: 60_000, maxStreamsPerAddress: 3, maxStreams: 5 });
      sseServer = await startServer(pool, testConfig(), { sse });
    });
    afterEach(async () => {
      for (const c of open.splice(0)) c.close();
      await sseServer.close();
    });

    const listen = async (address: string): Promise<SseClient> => {
      const c = await subscribe(`${sseServer.url}/api/dashboard/stream`, { 'X-Forwarded-For': address });
      open.push(c);
      return c;
    };
    const until = async (condition: () => boolean) => {
      for (let i = 0; i < 100 && !condition(); i++) await new Promise((r) => setTimeout(r, 10));
    };

    test('one address may hold a few streams; past that it gets a 429, and closing one frees a place', async () => {
      for (let i = 0; i < 3; i++) assert.equal((await listen('192.0.2.1')).response.status, 200);
      const refused = await listen('192.0.2.1');
      assert.equal(refused.response.status, 429);
      assert.equal(sse.clientCount, 3);

      const other = await listen('192.0.2.2');
      assert.equal(other.response.status, 200);

      open[0].close();
      await until(() => sse.clientCount === 3);
      assert.equal((await listen('192.0.2.1')).response.status, 200);
    });

    // A wall of Campuses and Dashboard screens behind one NAT: the load test held 60 streams at no measurable cost (.scratch/prodtest/load.md).
    test('by default one address may hold 60 streams and the server 400', async () => {
      assert.equal(DEFAULT_MAX_STREAMS_PER_ADDRESS, 60);
      assert.equal(DEFAULT_MAX_STREAMS, 400);
      await sseServer.close();
      sse = createBroadcaster({ heartbeatMs: 60_000 });
      sseServer = await startServer(pool, testConfig(), { sse });
      const statuses = await Promise.all(Array.from({ length: 60 }, async () => (await listen('192.0.2.1')).response.status));
      assert.deepEqual(new Set(statuses), new Set([200]));
      assert.equal((await listen('192.0.2.1')).response.status, 429);
      assert.equal((await listen('192.0.2.2')).response.status, 200);
    });

    test('the server holds no more than its total number of streams, whatever the addresses', async () => {
      for (let i = 0; i < 5; i++) assert.equal((await listen(`192.0.2.${10 + i}`)).response.status, 200);
      const refused = await listen('192.0.2.99');
      assert.equal(refused.response.status, 503);
      assert.equal(sse.clientCount, 5);
    });
  });
});
