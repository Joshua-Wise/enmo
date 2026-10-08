import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { createTestPool, resetDatabase } from './helpers/database';
import { startServer, TEST_ADMIN_TOKEN, type RunningServer } from './helpers/server';
import { api, asAdmin, asDevice, errorOf, json, type Device, type RecordedReading } from './helpers/api';

interface StoredReading {
  deviceId: number;
  tempF: number;
  humidity: number;
  /** The column text as MySQL holds it, unaffected by the driver's time zone handling. */
  recordedAt: string;
}

describe('POST /api/readings', () => {
  let pool: Pool;
  let server: RunningServer;
  let client: ReturnType<typeof api>;

  before(() => {
    pool = createTestPool();
  });
  // A fresh server per test so the write rate limiter starts from zero every time.
  beforeEach(async () => {
    await resetDatabase(pool);
    server = await startServer(pool);
    client = api(server);
  });
  afterEach(() => server.close());
  after(() => pool.end());

  const post = (body: unknown, init?: RequestInit) => client.readings.add(body, init);
  const registerDevice = async (hostname = 'ESP_A1B2C3'): Promise<Device> => {
    const campus = await client.campuses.create();
    return client.devices.create(campus.id, hostname);
  };
  const stored = async (): Promise<StoredReading[]> => {
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT device_id AS deviceId, temp_f AS tempF, humidity, CAST(recorded_at AS CHAR) AS recordedAt FROM readings ORDER BY id',
    );
    return rows as StoredReading[];
  };
  const withoutToken = (): RequestInit => ({ headers: { 'Content-Type': 'application/json' } });
  const withToken = (token: string): RequestInit => asDevice({ headers: { Authorization: `Bearer ${token}` } });

  test('records a reading against the device with a server-side UTC timestamp and returns 201', async () => {
    const device = await registerDevice();
    const before = Date.now();
    const response = await post({ device: 'ESP_A1B2C3', temp: 72, humidity: 40 });
    const after = Date.now();
    assert.equal(response.status, 201);

    const body = await json<RecordedReading>(response);
    assert.equal(body.device, device.hostname);
    assert.equal(body.reading.tempF, 72);
    assert.equal(body.reading.humidity, 40);
    assert.match(body.reading.recordedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/, 'recordedAt is an ISO UTC instant to the second');
    const recordedAt = Date.parse(body.reading.recordedAt);
    assert.ok(recordedAt >= before - 1000 && recordedAt <= after, 'recordedAt is when the server received the reading');

    const rows = await stored();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].deviceId, device.id);
    assert.equal(rows[0].tempF, 72);
    assert.equal(rows[0].humidity, 40);
    // The stored text is the same UTC instant, so the column really holds UTC rather than some local zone.
    assert.equal(rows[0].recordedAt, body.reading.recordedAt.replace('T', ' ').replace('.000Z', ''));
  });

  test('rounds fractional temperature and humidity to integers', async () => {
    await registerDevice();
    const response = await post({ device: 'ESP_A1B2C3', temp: 72.6, humidity: 40.4 });
    assert.equal(response.status, 201);
    const body = await json<RecordedReading>(response);
    assert.equal(body.reading.tempF, 73);
    assert.equal(body.reading.humidity, 40);
    const [row] = await stored();
    assert.equal(row.tempF, 73);
    assert.equal(row.humidity, 40);
  });

  test('normalises hyphens in the posted hostname to underscores and ignores case', async () => {
    const device = await registerDevice('ESP_A1B2C3');
    const response = await post({ device: 'esp-a1b2c3', temp: 70, humidity: 35 });
    assert.equal(response.status, 201);
    assert.equal((await json<RecordedReading>(response)).device, 'ESP_A1B2C3');
    const [row] = await stored();
    assert.equal(row.deviceId, device.id);
  });

  test('rejects a missing or wrong Device token with 401, and the Admin token does not count', async () => {
    await registerDevice();
    const body = { device: 'ESP_A1B2C3', temp: 72, humidity: 40 };
    for (const init of [withoutToken(), withToken('nope'), withToken(TEST_ADMIN_TOKEN)]) {
      const response = await post(body, init);
      assert.equal(response.status, 401, JSON.stringify(init.headers));
      assert.deepEqual(await response.json(), { error: 'Not authorised' });
    }
    assert.deepEqual(await stored(), []);
  });

  test('rejects an unknown hostname with 404 so an unregistered board is not silently dropped', async () => {
    await registerDevice('ESP_A1B2C3');
    const response = await post({ device: 'ESP_FFFFFF', temp: 72, humidity: 40 });
    assert.equal(response.status, 404);
    assert.match(await errorOf(response), /ESP_FFFFFF/);
    assert.deepEqual(await stored(), []);
  });

  test('rejects a missing, non-numeric, or impossible temp or humidity with 422', async () => {
    await registerDevice();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ device: 'ESP_A1B2C3', temp: 1e12, humidity: 40 }, /temp/i],
      [{ device: 'ESP_A1B2C3', temp: 201, humidity: 40 }, /temp/i],
      [{ device: 'ESP_A1B2C3', temp: -41, humidity: 40 }, /temp/i],
      [{ device: 'ESP_A1B2C3', temp: 72, humidity: 101 }, /humidity/i],
      [{ device: 'ESP_A1B2C3', temp: 72, humidity: -1 }, /humidity/i],
      [{ device: 'ESP_A1B2C3', humidity: 40 }, /temp/i],
      [{ device: 'ESP_A1B2C3', temp: null, humidity: 40 }, /temp/i],
      [{ device: 'ESP_A1B2C3', temp: '72', humidity: 40 }, /temp/i],
      [{ device: 'ESP_A1B2C3', temp: 'warm', humidity: 40 }, /temp/i],
      [{ device: 'ESP_A1B2C3', temp: 72 }, /humidity/i],
      [{ device: 'ESP_A1B2C3', temp: 72, humidity: null }, /humidity/i],
      [{ device: 'ESP_A1B2C3', temp: 72, humidity: '40' }, /humidity/i],
      [{ device: 'ESP_A1B2C3', temp: 72, humidity: true }, /humidity/i],
    ];
    for (const [body, message] of cases) {
      const response = await post(body);
      assert.equal(response.status, 422, JSON.stringify(body));
      assert.match(await errorOf(response), message, JSON.stringify(body));
    }
    assert.deepEqual(await stored(), []);
  });

  test('rejects a missing or blank hostname with 422 rather than 404', async () => {
    await registerDevice();
    for (const body of [{ temp: 72, humidity: 40 }, { device: '', temp: 72, humidity: 40 }, { device: 7, temp: 72, humidity: 40 }]) {
      const response = await post(body);
      assert.equal(response.status, 422, JSON.stringify(body));
      assert.match(await errorOf(response), /device/i);
    }
    assert.deepEqual(await stored(), []);
  });

  test('rejects a malformed JSON body with 400', async () => {
    await registerDevice();
    const response = await fetch(client.readings.url(), { ...asDevice(), method: 'POST', body: '{not json' });
    assert.equal(response.status, 400);
    assert.deepEqual(await stored(), []);
  });

  test('accepts the edges of the plausible range', async () => {
    await registerDevice();
    for (const [temp, humidity] of [[-40, 0], [200, 100]]) {
      assert.equal((await post({ device: 'ESP_A1B2C3', temp, humidity })).status, 201, `${temp} °F, ${humidity}%`);
    }
  });

  test('keeps the status of a body the parser refuses: 413 too large, 415 unsupported charset', async () => {
    await registerDevice();
    const tooLarge = await post({ device: 'ESP_A1B2C3', temp: 72, humidity: 40, pad: 'x'.repeat(200_000) });
    assert.equal(tooLarge.status, 413);
    assert.match(await errorOf(tooLarge), /too large/i);

    const charset = await fetch(client.readings.url(), {
      ...asDevice({ headers: { 'Content-Type': 'application/json; charset=klingon' } }),
      method: 'POST',
      body: JSON.stringify({ device: 'ESP_A1B2C3', temp: 72, humidity: 40 }),
    });
    assert.equal(charset.status, 415);
    assert.match(await errorOf(charset), /charset/i);
    assert.deepEqual(await stored(), []);
  });

  test('the old /api/write route is gone', async () => {
    await registerDevice();
    const response = await fetch(`${server.url}/api/write`, {
      ...asDevice(),
      method: 'POST',
      body: JSON.stringify({ table: 'ESP_A1B2C3', temp: 72, humidity: 40 }),
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await stored(), []);
  });

  test('limits a Device to 20 Readings a minute; another Device at the same address, and the rest of the API, are unaffected', async () => {
    const first = await registerDevice();
    await client.devices.create(first.campus.id, 'ESP_000002');
    for (let i = 0; i < 20; i++) {
      assert.equal((await post({ device: 'ESP_A1B2C3', temp: 70 + i, humidity: 40 })).status, 201, `write ${i + 1}`);
    }
    const limited = await post({ device: 'ESP_A1B2C3', temp: 99, humidity: 40 });
    assert.equal(limited.status, 429);
    assert.match(await errorOf(limited), /too many readings from this device/i);
    assert.equal((await stored()).length, 20);

    // The limit is per Device: a campus's boards share one address behind NAT.
    assert.equal((await post({ device: 'esp-000002', temp: 70, humidity: 40 })).status, 201);
    assert.equal((await stored()).length, 21);

    // A wrong token is refused as such, never counted against the Device.
    const wrongToken = await client.readings.add({ device: 'ESP_A1B2C3', temp: 70, humidity: 40 }, withToken('wrong'));
    assert.equal(wrongToken.status, 401);

    // The rest of the API from the same IP is unaffected.
    assert.equal((await fetch(client.devices.url(), asAdmin())).status, 200);
    assert.equal((await client.campuses.add({ name: 'West Elementary', shortcode: 'WES' })).status, 201);
  });
});
