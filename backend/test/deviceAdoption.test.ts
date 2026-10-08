import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'mysql2/promise';
import { createTestPool, resetDatabase } from './helpers/database';
import { startServer, testConfig, TEST_DEVICE_TOKEN, type RunningServer } from './helpers/server';
import { api, asAdmin, asDevice, json, type Campus } from './helpers/api';
import { createDeviceSightings, TOKEN_MISMATCH_WINDOW_MS } from '../src/deviceSightings';

const wrongToken = (address = '198.51.100.40'): RequestInit => ({
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer not-the-device-token', 'X-Forwarded-For': address },
});

interface ListedDevice {
  hostname: string;
  tokenMismatchAt: string | null;
}

interface PendingDevice {
  hostname: string;
  firstSeen: string;
  lastSeen: string;
  reports: number;
  lastReading: { tempF: number; humidity: number } | null;
  address: string | null;
  ignored: boolean;
}

describe('a registered Device with the wrong token (token mismatch)', () => {
  let pool: Pool;
  let server: RunningServer;
  let client: ReturnType<typeof api>;
  let clock: Date;

  before(() => {
    pool = createTestPool();
  });
  beforeEach(async () => {
    await resetDatabase(pool);
    clock = new Date('2026-10-06T12:00:00Z');
    server = await startServer(pool, testConfig(), { sightings: createDeviceSightings({ now: () => clock }) });
    client = api(server);
    const campus = await client.campuses.create();
    await client.devices.create(campus.id, 'ESP_A1B2C3');
    await client.devices.create(campus.id, 'ESP_D4E5F6');
  });
  afterEach(() => server.close());
  after(() => pool.end());

  const dashboardDevice = async (hostname: string) => (await client.dashboard.get()).devices.find((d) => d.hostname === hostname) as unknown as ListedDevice;
  const listedDevice = async (hostname: string) => (await json<ListedDevice[]>(await fetch(client.devices.url(), asAdmin()))).find((d) => d.hostname === hostname);

  test('is refused, and the dashboard and the Device list say token mismatch for it alone', async () => {
    const refused = await client.readings.add({ device: 'esp-a1b2c3', temp: 70, humidity: 40 }, wrongToken());
    assert.equal(refused.status, 401);
    await refused.arrayBuffer();
    assert.equal((await dashboardDevice('ESP_A1B2C3')).tokenMismatchAt, clock.toISOString());
    assert.equal((await listedDevice('ESP_A1B2C3'))?.tokenMismatchAt, clock.toISOString());
    assert.equal((await dashboardDevice('ESP_D4E5F6')).tokenMismatchAt, null);
  });

  test('clears with the next accepted Reading', async () => {
    await (await client.readings.add({ device: 'ESP_A1B2C3', temp: 70, humidity: 40 }, wrongToken())).arrayBuffer();
    const accepted = await client.readings.add({ device: 'ESP_A1B2C3', temp: 70, humidity: 40 });
    assert.equal(accepted.status, 201);
    await accepted.arrayBuffer();
    assert.equal((await dashboardDevice('ESP_A1B2C3')).tokenMismatchAt, null);
  });

  test(`clears on its own ${TOKEN_MISMATCH_WINDOW_MS / 60000} minutes after the last refused attempt`, async () => {
    await (await client.readings.add({ device: 'ESP_A1B2C3', temp: 70, humidity: 40 }, wrongToken())).arrayBuffer();
    clock = new Date(clock.getTime() + TOKEN_MISMATCH_WINDOW_MS - 1000);
    assert.notEqual((await dashboardDevice('ESP_A1B2C3')).tokenMismatchAt, null);
    clock = new Date(clock.getTime() + 2000);
    assert.equal((await dashboardDevice('ESP_A1B2C3')).tokenMismatchAt, null);
  });

  test("the firmware check with the wrong token flags the board by its MAC", async () => {
    const response = await fetch(`${server.url}/api/firmware`, {
      headers: { Authorization: `Basic ${Buffer.from('device:wrong').toString('base64')}`, 'x-ESP8266-STA-MAC': '5C:CF:7F:D4:E5:F6' },
    });
    assert.equal(response.status, 401);
    await response.arrayBuffer();
    assert.notEqual((await dashboardDevice('ESP_D4E5F6')).tokenMismatchAt, null);
  });

  test('a wrong token for a hostname nobody registered is refused and shown nowhere', async () => {
    await (await client.readings.add({ device: 'ESP_FFFFFF', temp: 70, humidity: 40 }, wrongToken())).arrayBuffer();
    const pending = await json<PendingDevice[]>(await fetch(client.devices.url('/pending'), asAdmin()));
    assert.deepEqual(pending, []);
  });
});

describe('a board with the Device token that nobody has registered (adoption)', () => {
  let pool: Pool;
  let server: RunningServer;
  let client: ReturnType<typeof api>;
  let campus: Campus;

  before(() => {
    pool = createTestPool();
  });
  beforeEach(async () => {
    await resetDatabase(pool);
    server = await startServer(pool);
    client = api(server);
    campus = await client.campuses.create();
  });
  afterEach(() => server.close());
  after(() => pool.end());

  const post = async (device: string, temp = 71, humidity = 42) => {
    const response = await client.readings.add({ device, temp, humidity }, { ...asDevice(), headers: { ...asDevice().headers, 'X-Forwarded-For': '192.168.1.143' } });
    await response.arrayBuffer();
    return response.status;
  };
  const pending = async () => json<PendingDevice[]>(await fetch(client.devices.url('/pending'), asAdmin()));

  test('is still a 404, and the Admin sees it waiting to be adopted, with its last Reading and address', async () => {
    assert.equal(await post('esp-64533b', 84, 44), 404);
    assert.equal(await post('ESP_64533B', 85, 41), 404);
    const [board, ...rest] = await pending();
    assert.deepEqual(rest, []);
    assert.equal(board.hostname, 'ESP_64533B');
    assert.equal(board.reports, 2);
    assert.deepEqual(board.lastReading, { tempF: 85, humidity: 41 });
    assert.equal(board.address, '192.168.1.143');
    assert.equal(board.ignored, false);
  });

  test('only the Admin sees the list', async () => {
    await post('ESP_64533B');
    for (const init of [{}, asDevice()]) {
      const response = await fetch(client.devices.url('/pending'), init);
      assert.equal(response.status, 401);
      await response.arrayBuffer();
    }
  });

  test('a hostname that is not ESP_ and six hex digits is not kept', async () => {
    assert.equal(await post('kitchen-sensor'), 404);
    assert.deepEqual(await pending(), []);
  });

  test('adopting it (adding the Device) takes it off the list, and its next Reading is recorded', async () => {
    await post('ESP_64533B');
    const added = await client.devices.add({ hostname: 'ESP_64533B', campusId: campus.id, closet: 'IDF 1' });
    assert.equal(added.status, 201);
    await added.arrayBuffer();
    assert.deepEqual(await pending(), []);
    assert.equal(await post('ESP_64533B'), 201);
    assert.deepEqual(await pending(), []);
  });

  test('ignoring keeps it listed as ignored; forgetting removes it until it reports again', async () => {
    await post('ESP_64533B');
    const ignored = await fetch(client.devices.url('/pending/ESP_64533B'), { ...asAdmin(), method: 'PATCH', body: JSON.stringify({ ignored: true }) });
    assert.equal(ignored.status, 200);
    await ignored.arrayBuffer();
    assert.equal((await pending())[0].ignored, true);
    await post('ESP_64533B');
    assert.equal((await pending())[0].ignored, true, 'a new Reading does not un-ignore it');

    const forgotten = await fetch(client.devices.url('/pending/ESP_64533B'), { ...asAdmin(), method: 'DELETE' });
    assert.equal(forgotten.status, 204);
    assert.deepEqual(await pending(), []);
    await post('ESP_64533B');
    assert.equal((await pending()).length, 1);
  });

  test('changing or forgetting one that is not listed is a 404; the Device token cannot', async () => {
    const missing = await fetch(client.devices.url('/pending/ESP_000000'), { ...asAdmin(), method: 'PATCH', body: JSON.stringify({ ignored: true }) });
    assert.equal(missing.status, 404);
    await missing.arrayBuffer();
    await post('ESP_64533B');
    const asBoard = await fetch(client.devices.url('/pending/ESP_64533B'), { ...asDevice(), method: 'DELETE' });
    assert.equal(asBoard.status, 401);
    await asBoard.arrayBuffer();
  });

  test('a firmware check from an unregistered board lists it too, without a Reading', async () => {
    const response = await fetch(`${server.url}/api/firmware`, {
      headers: { Authorization: `Bearer ${TEST_DEVICE_TOKEN}`, 'x-ESP8266-STA-MAC': '48:3F:DA:64:53:3B', 'x-ESP8266-version': '2' },
    });
    assert.equal(response.status, 404);
    await response.arrayBuffer();
    const [board] = await pending();
    assert.equal(board.hostname, 'ESP_64533B');
    assert.equal(board.lastReading, null);
  });
});
