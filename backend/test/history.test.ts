import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { createTestPool, resetDatabase } from './helpers/database';
import { startServer, testConfig, type RunningServer } from './helpers/server';
import { api, asAdmin, errorOf, type Device, type History } from './helpers/api';
import { HISTORY_ROW_LIMIT } from '../src/routes/readings';

/** Chicago is six hours behind UTC in September (CDT), so its 5 September starts at 05:00Z. */
const CHICAGO = 'America/Chicago';
const DAY = '2026-09-05';
const DAY_START = '2026-09-05T05:00:00.000Z';
const NEXT_DAY_START = '2026-09-06T05:00:00.000Z';
/** 14:30 Chicago time on the day. */
const NOW = new Date('2026-09-05T19:30:00Z');

describe('/api/devices/:id/history', () => {
  let pool: Pool;
  let server: RunningServer;
  let client: ReturnType<typeof api>;

  before(async () => {
    pool = createTestPool();
    server = await startServer(pool, testConfig(), { now: () => NOW });
    client = api(server);
  });
  beforeEach(() => resetDatabase(pool));
  after(async () => {
    await server.close();
    await pool.end();
  });

  const registerDevice = async (hostname = 'ESP_A1B2C3', closet = 'IDF 2'): Promise<Device> => {
    const campus = await client.campuses.create();
    return client.devices.create(campus.id, hostname, closet);
  };
  // Ingest stamps the server's time, so a Reading at a chosen instant can only be arranged by writing the row directly.
  const readingAt = async (deviceId: number, recordedAt: string, tempF = 72, humidity: number | null = 40) => {
    await pool.query('INSERT INTO readings (device_id, temp_f, humidity, recorded_at) VALUES (?, ?, ?, ?)', [
      deviceId,
      tempF,
      humidity,
      new Date(recordedAt),
    ]);
  };
  const historyOf = async (id: number, query = `?date=${DAY}&tz=${CHICAGO}`): Promise<History> => {
    const response = await client.devices.history(id, query);
    const body = await response.text();
    assert.equal(response.status, 200, body);
    return JSON.parse(body) as History;
  };
  const rowCount = async (): Promise<number> => {
    const [rows] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM readings');
    return Number(rows[0].n);
  };

  describe('GET', () => {
    test('an empty day is a 200 with the device, the bounds, no readings, and no summary', async () => {
      const device = await registerDevice('ESP_A1B2C3', 'MDF');
      const history = await historyOf(device.id);
      assert.deepEqual(history, {
        device: { id: device.id, hostname: 'ESP_A1B2C3', closet: 'MDF', closetType: 'MDF', campus: device.campus, sensor: null },
        date: DAY,
        timeZone: CHICAGO,
        from: DAY_START,
        to: NEXT_DAY_START,
        readings: [],
        truncated: false,
        retentionDays: 90,
        summary: { tempF: null, humidity: null },
      });
    });

    test('keeps only the local day, from its midnight up to but not including the next, oldest first', async () => {
      const device = await registerDevice();
      await readingAt(device.id, '2026-09-05T04:59:59Z', 60); // 23:59:59 the night before
      await readingAt(device.id, '2026-09-06T04:59:59Z', 63); // 23:59:59, the last second of the day
      await readingAt(device.id, DAY_START, 61); // midnight, the first second of the day
      await readingAt(device.id, NEXT_DAY_START, 64); // midnight the next day
      await readingAt(device.id, '2026-09-05T19:00:00Z', 62); // 2 PM

      const { readings } = await historyOf(device.id);
      assert.deepEqual(
        readings.map((r) => [r.tempF, r.recordedAt]),
        [
          [61, DAY_START],
          [62, '2026-09-05T19:00:00.000Z'],
          [63, '2026-09-06T04:59:59.000Z'],
        ],
      );
    });

    test('cuts the day in the zone asked for, so the same instant can fall on different days', async () => {
      const device = await registerDevice();
      // 02:00Z on the 6th is 9 PM on the 5th in Chicago and already the 6th in Tokyo.
      await readingAt(device.id, '2026-09-06T02:00:00Z', 70);

      const chicago = await historyOf(device.id, `?date=${DAY}&tz=${CHICAGO}`);
      assert.equal(chicago.readings.length, 1);
      const tokyo = await historyOf(device.id, `?date=${DAY}&tz=Asia/Tokyo`);
      assert.deepEqual([tokyo.from, tokyo.to, tokyo.readings.length], ['2026-09-04T15:00:00.000Z', '2026-09-05T15:00:00.000Z', 0]);
      const tokyoNextDay = await historyOf(device.id, `?date=2026-09-06&tz=Asia/Tokyo`);
      assert.equal(tokyoNextDay.readings.length, 1);
    });

    test('a day that crosses a clock change is still one local day, however long it is', async () => {
      const device = await registerDevice();
      // Chicago springs forward on 8 March 2026: the day is 23 hours long.
      const { from, to } = await historyOf(device.id, `?date=2026-03-08&tz=${CHICAGO}`);
      assert.deepEqual([from, to], ['2026-03-08T06:00:00.000Z', '2026-03-09T05:00:00.000Z']);
    });

    test('summarises temperature and humidity with min, max, and a one-decimal average, ignoring missing humidity', async () => {
      const device = await registerDevice();
      await readingAt(device.id, '2026-09-05T10:00:00Z', 70, 40);
      await readingAt(device.id, '2026-09-05T11:00:00Z', 75, null);
      await readingAt(device.id, '2026-09-05T12:00:00Z', 72, 50);
      await readingAt(device.id, '2026-09-06T12:00:00Z', 99, 99); // the next day: not counted

      const { readings, summary } = await historyOf(device.id);
      assert.equal(readings.length, 3);
      assert.deepEqual(summary, {
        tempF: { min: 70, max: 75, avg: 72.3 },
        humidity: { min: 40, max: 50, avg: 45 },
      });
    });

    test('a day whose readings all lack humidity summarises temperature only', async () => {
      const device = await registerDevice();
      await readingAt(device.id, '2026-09-05T10:00:00Z', 70, null);
      const { summary } = await historyOf(device.id);
      assert.deepEqual(summary, { tempF: { min: 70, max: 70, avg: 70 }, humidity: null });
    });

    test('is only ever that device: another device on the same day is left out', async () => {
      const first = await registerDevice('ESP_000001');
      const second = await client.devices.create(first.campus.id, 'ESP_000002');
      await readingAt(first.id, '2026-09-05T10:00:00Z', 70);
      await readingAt(second.id, '2026-09-05T10:00:00Z', 80);

      const { readings, summary } = await historyOf(first.id);
      assert.deepEqual(readings.map((r) => r.tempF), [70]);
      assert.equal(summary.tempF?.max, 70);
    });

    test('stops at the row limit, oldest first, and says the day was cut short', async () => {
      const device = await registerDevice();
      // One a second from the day's first instant: more than the limit, all inside the day.
      const start = Date.parse(DAY_START);
      const rows = Array.from({ length: HISTORY_ROW_LIMIT + 1 }, (_, i) => [device.id, 70, 40, new Date(start + i * 1000)]);
      for (let i = 0; i < rows.length; i += 5000) {
        await pool.query('INSERT INTO readings (device_id, temp_f, humidity, recorded_at) VALUES ?', [rows.slice(i, i + 5000)]);
      }

      const history = await historyOf(device.id);
      assert.equal(history.truncated, true);
      assert.equal(history.readings.length, HISTORY_ROW_LIMIT);
      assert.equal(history.readings[0].recordedAt, DAY_START);
      assert.equal(history.readings.at(-1)?.recordedAt, new Date(start + (HISTORY_ROW_LIMIT - 1) * 1000).toISOString());
    });

    test('a day under the row limit is not cut short', async () => {
      const device = await registerDevice();
      await readingAt(device.id, '2026-09-05T10:00:00Z');
      assert.equal((await historyOf(device.id)).truncated, false);
    });

    test('defaults to today in the zone asked for', async () => {
      const device = await registerDevice();
      // NOW is 19:30Z: 14:30 on the 5th in Chicago, 04:30 on the 6th in Tokyo.
      const chicago = await historyOf(device.id, `?tz=${CHICAGO}`);
      assert.equal(chicago.date, DAY);
      const tokyo = await historyOf(device.id, '?tz=Asia/Tokyo');
      assert.equal(tokyo.date, '2026-09-06');
    });

    test("defaults to the server's own zone when none is asked for", async () => {
      const device = await registerDevice();
      const history = await historyOf(device.id, `?date=${DAY}`);
      assert.equal(history.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
    });

    test('rejects a date that is not a real YYYY-MM-DD day with 422', async () => {
      const device = await registerDevice();
      for (const date of ['2026-9-5', '05/09/2026', '2026-02-30', '2026-13-01', 'today', '2026-09-05T00:00:00Z']) {
        const response = await client.devices.history(device.id, `?date=${encodeURIComponent(date)}&tz=${CHICAGO}`);
        assert.equal(response.status, 422, date);
        assert.match(await errorOf(response), /YYYY-MM-DD/);
      }
    });

    test('rejects a zone it does not know with 422', async () => {
      const device = await registerDevice();
      const response = await client.devices.history(device.id, `?date=${DAY}&tz=Mars/Olympus_Mons`);
      assert.equal(response.status, 422);
      assert.match(await errorOf(response), /time zone/i);
    });

    test('is 404 for a device that does not exist', async () => {
      for (const id of ['999', '0', 'ESP_A1B2C3']) {
        const response = await fetch(`${server.url}/api/devices/${id}/history?date=${DAY}&tz=${CHICAGO}`, asAdmin());
        assert.equal(response.status, 404, id);
        assert.equal(await errorOf(response), 'Device not found');
      }
    });
  });

  describe('DELETE', () => {
    test("deletes only that device's readings with the Admin token and answers 204", async () => {
      const first = await registerDevice('ESP_000001');
      const second = await client.devices.create(first.campus.id, 'ESP_000002');
      await readingAt(first.id, '2026-09-05T10:00:00Z');
      await readingAt(first.id, '2026-09-01T10:00:00Z'); // an older day goes too: reset is the whole history
      await readingAt(second.id, '2026-09-05T10:00:00Z');

      const response = await client.devices.resetHistory(first.id);
      assert.equal(response.status, 204);
      assert.equal(await rowCount(), 1);
      assert.deepEqual((await historyOf(first.id)).readings, []);
      assert.equal((await historyOf(second.id)).readings.length, 1);
      assert.deepEqual(await client.devices.list(), [first, second], 'the devices themselves stay');
    });

    test('is 204 when there was nothing to delete', async () => {
      const device = await registerDevice();
      assert.equal((await client.devices.resetHistory(device.id)).status, 204);
    });

    test('rejects a reset without a token or with the wrong token with 401 and deletes nothing', async () => {
      const device = await registerDevice();
      await readingAt(device.id, '2026-09-05T10:00:00Z');
      const missing = await client.devices.resetHistory(device.id, {});
      assert.equal(missing.status, 401);
      const wrong = await client.devices.resetHistory(device.id, { headers: { Authorization: 'Bearer nope' } });
      assert.equal(wrong.status, 401);
      assert.equal(await errorOf(wrong), 'Not authorised');
      assert.equal(await rowCount(), 1);
    });

    test('is 404 for a device that does not exist', async () => {
      const response = await client.devices.resetHistory(999);
      assert.equal(response.status, 404);
      assert.equal(await errorOf(response), 'Device not found');
    });
  });
});
