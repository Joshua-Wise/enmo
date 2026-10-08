import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { createTestPool, resetDatabase } from './helpers/database';
import { startServer, testConfig, type RunningServer } from './helpers/server';
import { api, asAdmin, errorOf, json, type Campus, type Condition, type Reading } from './helpers/api';
import { insertIncident } from '../src/incidentStore';
import { PAST_DAYS_CACHE_MS, selectDayMaxima } from '../src/routes/campusOverview';
import { localDay, type LocalDay } from '../src/localDay';
import type { IncidentState } from '../src/incidents';

const DAY_MS = 86_400_000;

interface OverviewDay {
  date: string;
  from: string;
  to: string;
  partial: boolean;
  maxTempF: number | null;
  incident: boolean;
  /** The worst level any incident reached on that day, or null. */
  incidentLevel: Condition['level'] | null;
}

interface CampusOverview {
  id: number;
  name: string;
  shortcode: string;
  closets: number;
  level: Condition['level'] | null;
  now: {
    conditions: (Condition & { count: number })[];
    headsUp: (Condition & { count: number })[];
  };
  worst: {
    id: number;
    hostname: string;
    closet: string;
    closetType: 'IDF' | 'MDF' | null;
    latestReading: Reading | null;
    level: Condition['level'] | null;
    offline: boolean;
    /** Seconds since its latest Reading by the server's clock, so a browser never subtracts its own clock from the server's. */
    secondsSinceReading: number | null;
    conditions: Condition[];
  } | null;
  days: OverviewDay[];
  lastIncident: { ongoing: true; start: string } | { ongoing: false; end: string } | null;
}

interface Overview {
  timeZone: string;
  threshold: { name: 'Hot'; level: 'warning'; tempF: number };
  retentionDays: number;
  campuses: CampusOverview[];
}

/** 10:00 on Monday 5 October 2026 in Chicago (CDT, five hours behind UTC). */
const NOW = new Date('2026-10-05T15:00:00Z');

describe('GET /api/campuses/overview', () => {
  let pool: Pool;
  let server: RunningServer | undefined;
  let client: ReturnType<typeof api>;
  let admin: RunningServer;

  before(() => {
    pool = createTestPool();
  });
  beforeEach(async () => {
    await resetDatabase(pool);
    // Campuses and Devices go in through the API; the overview server is started per test with its clock pinned.
    admin = await startServer(pool);
    client = api(admin);
  });
  afterEach(async () => {
    await admin.close();
    await server?.close();
    server = undefined;
  });
  after(() => pool.end());

  const overviewAt = async (now: Date, query = ''): Promise<Response> => {
    await server?.close();
    server = await startServer(pool, testConfig(), { now: () => now });
    return fetch(`${server.url}/api/campuses/overview${query}`, asAdmin());
  };
  const overview = async (now = NOW, query = '?tz=America/Chicago'): Promise<Overview> => {
    const response = await overviewAt(now, query);
    assert.equal(response.status, 200, await response.clone().text());
    return json<Overview>(response);
  };
  const campus = (name: string, shortcode: string): Promise<Campus> => client.campuses.create(name, shortcode);
  let hostnames = 0;
  const device = async (campusId: number, closet = 'IDF 1') =>
    client.devices.create(campusId, `ESP_${(0xa00000 + ++hostnames).toString(16).toUpperCase()}`, closet);
  // Ingest stamps the server's time, so a Reading at a chosen instant is written directly.
  const readingAt = async (deviceId: number, recordedAt: Date, tempF = 72, humidity = 40) => {
    await pool.query('INSERT INTO readings (device_id, temp_f, humidity, recorded_at) VALUES (?, ?, ?, ?)', [deviceId, tempF, humidity, recordedAt]);
  };
  const incident = async (deviceId: number, start: Date, end: Date | null, condition: IncidentState['condition'] = 'Hot') => {
    await insertIncident(pool, deviceId, {
      condition,
      level: 'warning',
      start,
      end,
      peak: { tempF: 85, humidity: 40, recordedAt: start },
      segments: [{ level: 'warning', start, end }],
      cleanReadings: end === null ? 0 : 2,
      firstCleanAt: end,
    });
  };
  const secondsAgo = (s: number) => new Date(NOW.getTime() - s * 1000);
  const byShortcode = (o: Overview, shortcode: string): CampusOverview => {
    const found = o.campuses.find((c) => c.shortcode === shortcode);
    assert.ok(found, `no ${shortcode} in ${JSON.stringify(o.campuses.map((c) => c.shortcode))}`);
    return found;
  };

  test('names the Hot warning threshold and the retention window the server uses, and refuses an unknown zone (422)', async () => {
    const response = await overviewAt(NOW);
    assert.equal(response.status, 200);
    const body = await json<Overview>(response);
    assert.deepEqual(body.threshold, { name: 'Hot', level: 'warning', tempF: 82 });
    assert.equal(body.retentionDays, 90);
    assert.deepEqual(body.campuses, []);

    const bad = await overviewAt(NOW, '?tz=Mars/Olympus');
    assert.equal(bad.status, 422);
    assert.match(await errorOf(bad), /Unknown time zone Mars\/Olympus/);
  });

  test('a Campus with no Devices: no closets, no worst, seven empty days, no last incident', async () => {
    await campus('Empty Elementary', 'EE');
    const [empty] = (await overview()).campuses;
    assert.equal(empty.closets, 0);
    assert.equal(empty.level, null);
    assert.deepEqual(empty.now, { conditions: [], headsUp: [] });
    assert.equal(empty.worst, null);
    assert.equal(empty.days.length, 7);
    assert.ok(empty.days.every((d) => d.maxTempF === null && !d.incident));
    assert.equal(empty.lastIncident, null);
  });

  test('a Campus with no incident in 90 days has no last incident, though an older one is still stored', async () => {
    const c = await campus('Calm High', 'CH');
    const d = await device(c.id);
    await readingAt(d.id, secondsAgo(10), 72, 40);
    await incident(d.id, new Date(NOW.getTime() - 100 * DAY_MS), new Date(NOW.getTime() - 99 * DAY_MS));

    const [calm] = (await overview()).campuses;
    assert.equal(calm.lastIncident, null);
    assert.equal(calm.level, null);
    assert.equal(calm.worst?.hostname, d.hostname);
    assert.equal(calm.worst?.offline, false);
    assert.deepEqual(calm.worst?.latestReading, { tempF: 72, humidity: 40, recordedAt: secondsAgo(10).toISOString() });
    assert.ok(calm.days.every((day) => !day.incident));
    assert.equal(calm.days.at(-1)?.maxTempF, 72);
  });

  test('a day that held an incident is marked, the others are not, and its end is the last incident', async () => {
    const c = await campus('Recent Middle', 'RM');
    const d = await device(c.id);
    await readingAt(d.id, secondsAgo(10));
    // 2 October, 14:00 to 15:30 in Chicago.
    const start = new Date('2026-10-02T19:00:00Z');
    const end = new Date('2026-10-02T20:30:00Z');
    await incident(d.id, start, end);
    // An older one, also closed, must not be taken for the last.
    await incident(d.id, new Date(NOW.getTime() - 30 * DAY_MS), new Date(NOW.getTime() - 29 * DAY_MS));

    const [recent] = (await overview()).campuses;
    assert.deepEqual(recent.days.map((day) => [day.date, day.incident]), [
      ['2026-09-29', false],
      ['2026-09-30', false],
      ['2026-10-01', false],
      ['2026-10-02', true],
      ['2026-10-03', false],
      ['2026-10-04', false],
      ['2026-10-05', false],
    ]);
    assert.deepEqual(recent.lastIncident, { ongoing: false, end: end.toISOString() });
  });

  test('each day carries the worst level an incident reached on that day, from its segments, so a critical stretch is never shown as warning', async () => {
    const c = await campus('Swing High', 'SH');
    const d = await device(c.id);
    await readingAt(d.id, secondsAgo(10));
    // Hot warning from 22:00 on 1 October in Chicago, critical from 01:00 to 02:00 on the 2nd, warning again until 03:00.
    const t = (iso: string) => new Date(iso);
    await insertIncident(pool, d.id, {
      condition: 'Hot',
      level: 'critical',
      start: t('2026-10-02T03:00:00Z'),
      end: t('2026-10-02T08:00:00Z'),
      peak: { tempF: 91, humidity: 40, recordedAt: t('2026-10-02T06:30:00Z') },
      segments: [
        { level: 'warning', start: t('2026-10-02T03:00:00Z'), end: t('2026-10-02T06:00:00Z') },
        { level: 'critical', start: t('2026-10-02T06:00:00Z'), end: t('2026-10-02T07:00:00Z') },
        { level: 'warning', start: t('2026-10-02T07:00:00Z'), end: t('2026-10-02T08:00:00Z') },
      ],
      cleanReadings: 2,
      firstCleanAt: t('2026-10-02T08:00:00Z'),
    });

    const [swing] = (await overview()).campuses;
    assert.deepEqual(swing.days.filter((day) => day.incident).map((day) => [day.date, day.incidentLevel]), [
      ['2026-10-01', 'warning'],
      ['2026-10-02', 'critical'],
    ]);
    assert.ok(swing.days.filter((day) => !day.incident).every((day) => day.incidentLevel === null));
  });

  test('an ongoing incident marks every day since it began and is reported with its start', async () => {
    const c = await campus('Ongoing Academy', 'OA');
    const d = await device(c.id);
    await readingAt(d.id, secondsAgo(10), 88, 40);
    const start = new Date('2026-10-03T23:00:00Z'); // 18:00 on 3 October in Chicago
    await incident(d.id, start, null);
    await incident(d.id, new Date('2026-10-01T15:00:00Z'), new Date('2026-10-01T16:00:00Z'), 'Dry');

    const [ongoing] = (await overview()).campuses;
    assert.deepEqual(ongoing.lastIncident, { ongoing: true, start: start.toISOString() });
    assert.deepEqual(ongoing.days.filter((day) => day.incident).map((day) => day.date), ['2026-10-01', '2026-10-03', '2026-10-04', '2026-10-05']);
  });

  test('the seven days are the configured zone\'s days, today partial, each with its highest temperature', async () => {
    const c = await campus('Boundary High', 'BH');
    const d = await device(c.id);
    await readingAt(d.id, new Date('2026-09-29T04:59:59Z'), 99); // 23:59:59 on 28 September in Chicago: before the window
    await readingAt(d.id, new Date('2026-09-29T05:00:00Z'), 70); // midnight starting 29 September
    await readingAt(d.id, new Date('2026-09-30T04:59:59Z'), 75); // the last second of 29 September
    await readingAt(d.id, new Date('2026-09-30T05:00:00Z'), 80); // midnight starting 30 September
    await readingAt(d.id, secondsAgo(10), 77);
    // Later today, hours past the pinned clock: only a clock step stamps one, so it is not today's high yet.
    await readingAt(d.id, new Date('2026-10-06T04:59:59Z'), 95);

    const chicago = (await overview()).campuses[0];
    assert.equal(chicago.days[0].date, '2026-09-29');
    assert.equal(chicago.days[0].from, '2026-09-29T05:00:00.000Z');
    assert.equal(chicago.days[0].to, '2026-09-30T05:00:00.000Z');
    assert.deepEqual(chicago.days.map((day) => [day.date, day.maxTempF, day.partial]), [
      ['2026-09-29', 75, false],
      ['2026-09-30', 80, false],
      ['2026-10-01', null, false],
      ['2026-10-02', null, false],
      ['2026-10-03', null, false],
      ['2026-10-04', null, false],
      ['2026-10-05', 77, true],
    ]);

    // In UTC the same Readings fall on other days: the 99 °F one is now inside the window.
    const utc = await overview(NOW, '?tz=UTC');
    assert.equal(utc.timeZone, 'UTC');
    assert.deepEqual(utc.campuses[0].days.slice(0, 2).map((day) => [day.date, day.maxTempF]), [
      ['2026-09-29', 99],
      ['2026-09-30', 80],
    ]);
  });

  test('today is read fresh on every request; the completed days are reused for a few minutes', async () => {
    const c = await campus('Cache High', 'CA');
    const d = await device(c.id);
    await readingAt(d.id, new Date('2026-10-01T17:00:00Z'), 74);
    await readingAt(d.id, secondsAgo(60), 75);
    let clock = NOW;
    server = await startServer(pool, testConfig(), { now: () => clock });
    const get = async () => (await json<Overview>(await fetch(`${server!.url}/api/campuses/overview?tz=America/Chicago`, asAdmin()))).campuses[0].days;
    const highOn = (days: OverviewDay[], date: string) => days.find((day) => day.date === date)?.maxTempF;

    assert.equal(highOn(await get(), '2026-10-01'), 74);
    await readingAt(d.id, new Date('2026-10-01T18:00:00Z'), 81);
    await readingAt(d.id, secondsAgo(30), 80);
    const soon = await get();
    assert.equal(highOn(soon, '2026-10-05'), 80, 'today is never cached');
    assert.equal(highOn(soon, '2026-10-01'), 74, 'a finished day is reused');

    clock = new Date(NOW.getTime() + PAST_DAYS_CACHE_MS);
    assert.equal(highOn(await get(), '2026-10-01'), 81, 'and read again once the cache has aged out');
  });

  test('a day the clocks go back on is 25 hours long', async () => {
    await campus('Clock Change High', 'CC');
    // 3 November 2026 in Chicago; the clocks went back at 02:00 on 1 November.
    const [c] = (await overview(new Date('2026-11-03T18:00:00Z'))).campuses;
    const fallBack = c.days.find((day) => day.date === '2026-11-01');
    assert.ok(fallBack);
    assert.equal(new Date(fallBack.to).getTime() - new Date(fallBack.from).getTime(), 25 * 3_600_000);
  });

  test('worst first by the worst closet now, then by name; counts per Condition, with moderate Mold risk apart', async () => {
    const calm = await campus('Alpha Calm', 'AC');
    const hot = await campus('Zulu Hot', 'ZH');
    const silent = await campus('Mike Silent', 'MS');
    const damp = await campus('Echo Damp', 'ED');
    await campus('Bravo Empty', 'BE');

    await readingAt((await device(calm.id)).id, secondsAgo(10), 72, 40);

    const critical = await device(hot.id, 'MDF');
    await readingAt(critical.id, secondsAgo(10), 93, 40);
    await readingAt((await device(hot.id, 'IDF 1')).id, secondsAgo(10), 84, 40);
    await readingAt((await device(hot.id, 'IDF 2')).id, secondsAgo(10), 85, 40);
    await readingAt((await device(hot.id, 'IDF 3')).id, secondsAgo(10), 72, 65);

    const dead = await device(silent.id);
    await readingAt(dead.id, secondsAgo(600), 72, 40);

    await readingAt((await device(damp.id)).id, secondsAgo(10), 72, 65);

    const body = await overview();
    assert.deepEqual(body.campuses.map((c) => [c.shortcode, c.level]), [
      ['ZH', 'critical'],
      ['MS', 'warning'],
      ['ED', 'moderate'],
      ['AC', null],
      ['BE', null],
    ]);

    const zulu = byShortcode(body, 'ZH');
    assert.equal(zulu.closets, 4);
    assert.deepEqual(zulu.now.conditions, [
      { name: 'Hot', level: 'critical', count: 1 },
      { name: 'Hot', level: 'warning', count: 2 },
    ]);
    assert.deepEqual(zulu.now.headsUp, [{ name: 'Mold risk', level: 'moderate', count: 1 }]);
    assert.equal(zulu.worst?.id, critical.id);
    assert.equal(zulu.worst?.closetType, 'MDF');
    assert.equal(zulu.worst?.level, 'critical');
    assert.equal(zulu.worst?.latestReading?.tempF, 93);

    const mike = byShortcode(body, 'MS');
    assert.deepEqual(mike.now.conditions, [{ name: 'Offline', level: 'warning', count: 1 }]);
    assert.equal(mike.worst?.offline, true);
    assert.equal(mike.worst?.id, dead.id);

    assert.deepEqual(byShortcode(body, 'ED').now, { conditions: [], headsUp: [{ name: 'Mold risk', level: 'moderate', count: 1 }] });
  });
  test("the worst closet carries its age by the server's clock, and a Reading stamped in the future by a clock step is passed over", async () => {
    const c = await campus('Clock Step High', 'CS');
    const d = await device(c.id);
    await readingAt(d.id, secondsAgo(600), 72);
    await readingAt(d.id, new Date(NOW.getTime() + 3_600_000), 99);
    const [row] = (await overview()).campuses;
    assert.equal(row.worst?.secondsSinceReading, 600);
    assert.equal(row.worst?.offline, true);
    assert.equal(row.worst?.latestReading?.tempF, 72);
    const today = row.days.find((day) => day.partial);
    assert.equal(today?.maxTempF, 72, "a future Reading is not today's high either");
  });

  test("requests that miss the completed days' cache together share one read of them", async () => {
    const c = await campus('Busy High', 'BH');
    await readingAt((await device(c.id)).id, new Date('2026-10-01T17:00:00Z'), 74);
    let pastReads = 0;
    // The completed days are the only statement with a CASE per day boundary.
    const counting = new Proxy(pool, {
      get(target, key) {
        if (key === 'query') {
          return (sql: string, ...rest: unknown[]) => {
            if (typeof sql === 'string' && sql.includes('MAX(r.temp_f)') && sql.includes('CASE')) pastReads += 1;
            return (target.query as (...a: unknown[]) => unknown)(sql, ...rest);
          };
        }
        const value = Reflect.get(target, key) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    server = await startServer(counting, testConfig(), { now: () => NOW });
    const responses = await Promise.all(Array.from({ length: 5 }, () => fetch(`${server!.url}/api/campuses/overview?tz=America/Chicago`, asAdmin())));
    for (const response of responses) assert.equal(response.status, 200);
    assert.equal(pastReads, 1);
  });

  test('a clock stepped back does not keep the completed days cached for the length of the step', async () => {
    const c = await campus('Step Back High', 'SB');
    const d = await device(c.id);
    await readingAt(d.id, new Date('2026-10-01T17:00:00Z'), 74);
    let clock = new Date(NOW.getTime() + 2 * 3_600_000);
    server = await startServer(pool, testConfig(), { now: () => clock });
    const get = async () => (await json<Overview>(await fetch(`${server!.url}/api/campuses/overview?tz=America/Chicago`, asAdmin()))).campuses[0].days;
    assert.equal((await get()).find((day) => day.date === '2026-10-01')?.maxTempF, 74);
    await readingAt(d.id, new Date('2026-10-01T18:00:00Z'), 81);
    clock = NOW;
    assert.equal((await get()).find((day) => day.date === '2026-10-01')?.maxTempF, 81);
  });
});

describe("the overview's day-maxima statement", () => {
  let pool: Pool;
  before(() => {
    pool = createTestPool();
  });
  after(() => pool.end());

  /** Every table access in an EXPLAIN FORMAT=JSON plan. */
  const tablesIn = (node: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] => {
    if (Array.isArray(node)) node.forEach((n) => tablesIn(n, found));
    else if (node !== null && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      if (typeof record.table_name === 'string' && typeof record.access_type === 'string') found.push(record);
      Object.values(record).forEach((n) => tablesIn(n, found));
    }
    return found;
  };

  // At 90 days a join on device_id ran as a ref lookup over every Device's whole history, then a
  // row lookup each for temp_f: 9 to 28 s at 26 M Readings (.scratch/prodtest/load.md, B1).
  test("range-scans each Device's span on the covering index, reading no table rows", async () => {
    await resetDatabase(pool);
    const [campus] = await pool.query<ResultSetHeader>("INSERT INTO campuses (name, shortcode) VALUES ('Plan High', 'PH')");
    const ids: number[] = [];
    for (const hostname of ['ESP_PLAN01', 'ESP_PLAN02']) {
      const [d] = await pool.query<ResultSetHeader>("INSERT INTO devices (hostname, campus_id, closet) VALUES (?, ?, 'IDF 1')", [
        hostname,
        campus.insertId,
      ]);
      ids.push(d.insertId);
    }
    // Thirty days, one Reading every ten minutes each, so the week is a small part of each Device's history.
    const start = NOW.getTime() - 30 * DAY_MS;
    for (const id of ids) {
      const rows = Array.from({ length: 30 * 144 }, (_, i) => [id, 70 + (i % 7), 40, new Date(start + i * 600_000)]);
      await pool.query('INSERT INTO readings (device_id, temp_f, humidity, recorded_at) VALUES ?', [rows]);
    }
    await pool.query('ANALYZE TABLE readings');

    const days = ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'].map(
      (date) => localDay(date, 'America/Chicago') as LocalDay,
    );
    for (const [label, span, first] of [['past days', days.slice(0, -1), 0], ['today', days.slice(-1), 6]] as const) {
      const statement = selectDayMaxima(ids, span, first);
      assert.ok(statement);
      const { sql, params } = statement;
      const [[{ EXPLAIN: plan }]] = await pool.query<RowDataPacket[]>(`EXPLAIN FORMAT=JSON ${sql}`, params);
      const readings = tablesIn(JSON.parse(plan as string)).filter((t) => t.table_name === 'r');
      assert.equal(readings.length, 1, `${label}: ${plan}`);
      assert.equal(readings[0].access_type, 'range', `${label}: ${plan}`);
      assert.equal(readings[0].using_index, true, `${label}: ${plan}`);
      assert.equal(readings[0].key, 'ix_readings_device_recorded_temp', `${label}: ${plan}`);
    }
  });

  test('is skipped when there are no Devices', () => {
    assert.equal(selectDayMaxima([], [localDay('2026-10-05', 'UTC') as LocalDay], 6), null);
  });
});
