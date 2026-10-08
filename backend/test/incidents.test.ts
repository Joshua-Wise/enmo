import { test, describe, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { createTestPool, resetDatabase, testDatabaseConfig } from './helpers/database';
import { createPool } from '../src/db';
import { createListening } from '../src/listening';
import { startServer, testConfig, type RunningServer } from './helpers/server';
import { api, asAdmin, errorOf, json, type Incident, type RecordedReading } from './helpers/api';
import { subscribe, type SseClient } from './helpers/sse';
import { createGate, gatedPool, settlesWithin } from './helpers/gate';
import { createBroadcaster, type IncidentEvent } from '../src/sse';
import { runOfflineSweep, startOfflineSweep } from '../src/offlineSweep';
import { insertIncident } from '../src/incidentStore';
import {
  applyFaultReport,
  applyReading,
  missedOffline,
  offlineIncident,
  peakValue,
  replayIncidents,
  type IncidentState,
  type IncidentStep,
  type TimedReading,
  type TimedReport,
} from '../src/incidents';
import { DEFAULT_THRESHOLDS } from '../src/conditions';
import { deleteReadingsPastWindow } from '../src/retention';

const MINUTE = 60_000;
const DAY_MS = 86_400_000;
/** Three Report intervals of 30 seconds: Offline begins the second after. */
const OFFLINE_AFTER_MS = 90_000;

describe('incidents', () => {
  let pool: Pool;
  let server: RunningServer;
  let client: ReturnType<typeof api>;
  let sse: ReturnType<typeof createBroadcaster>;
  const open: SseClient[] = [];

  before(() => {
    pool = createTestPool();
  });
  beforeEach(async () => {
    await resetDatabase(pool);
    sse = createBroadcaster({ heartbeatMs: 60_000 });
    server = await startServer(pool, testConfig(), { sse });
    client = api(server);
  });
  afterEach(async () => {
    for (const c of open.splice(0)) c.close();
    await server.close();
  });
  after(() => pool.end());

  const registerDevice = async (hostname = 'ESP_A1B2C3') => {
    const campus = await client.campuses.create();
    return client.devices.create(campus.id, hostname, 'IDF 2');
  };
  const postReading = async (temp: number, humidity = 40, device = 'ESP_A1B2C3'): Promise<RecordedReading> => {
    const response = await client.readings.add({ device, temp, humidity });
    assert.equal(response.status, 201, await response.clone().text());
    return json<RecordedReading>(response);
  };
  /** Every incident from a day ago to an hour ahead: everything a test makes. */
  const allIncidents = async (): Promise<Incident[]> => (await client.incidents.list(new Date(Date.now() - DAY_MS), new Date(Date.now() + 60 * MINUTE))).incidents;
  const only = async (): Promise<Incident> => {
    const incidents = await allIncidents();
    assert.equal(incidents.length, 1, JSON.stringify(incidents));
    return incidents[0];
  };
  const countRows = async (table: string): Promise<number> => {
    const [rows] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${table}`);
    return Number(rows[0].n);
  };
  // Ingest stamps the server's time, so a Reading at a chosen instant can only be arranged by writing the row directly.
  const readingAt = async (deviceId: number, recordedAt: Date, tempF = 72, humidity = 40) => {
    await pool.query('INSERT INTO readings (device_id, temp_f, humidity, recorded_at) VALUES (?, ?, ?, ?)', [deviceId, tempF, humidity, recordedAt]);
  };
  const sweep = (now = new Date()) => runOfflineSweep({ pool, config: testConfig(), sse, now: () => now });

  describe('the rules, through ingest', () => {
    test('a warning Reading opens an incident with its Device, Condition, level, start, peak, and one open segment', async () => {
      const device = await registerDevice();
      await postReading(72);
      assert.deepEqual(await allIncidents(), [], 'a calm Reading opens nothing');

      const hot = await postReading(85);
      const incident = await only();
      assert.deepEqual(incident.device, { id: device.id, hostname: 'ESP_A1B2C3', closet: 'IDF 2', campus: device.campus });
      assert.equal(incident.condition, 'Hot');
      assert.equal(incident.level, 'warning');
      assert.equal(incident.start, hot.reading.recordedAt);
      assert.equal(incident.end, null);
      assert.deepEqual(incident.peak, { value: 85, tempF: 85, humidity: 40, recordedAt: hot.reading.recordedAt });
      assert.deepEqual(incident.segments, [{ level: 'warning', start: hot.reading.recordedAt, end: null }]);
    });

    test('a level change adds a segment and raises the worst level, which stays when the level falls back', async () => {
      await registerDevice();
      const warm = await postReading(85);
      const critical = await postReading(91);
      const back = await postReading(86);

      const incident = await only();
      assert.equal(incident.level, 'critical');
      assert.deepEqual(incident.segments, [
        { level: 'warning', start: warm.reading.recordedAt, end: critical.reading.recordedAt },
        { level: 'critical', start: critical.reading.recordedAt, end: back.reading.recordedAt },
        { level: 'warning', start: back.reading.recordedAt, end: null },
      ]);
      assert.equal(incident.peak.value, 91, 'the hottest Reading is the peak');
    });

    test('one clean Reading does not close it; two do, and it ends at the first of them', async () => {
      await registerDevice();
      await postReading(85);
      const firstClean = await postReading(72);
      assert.equal((await only()).end, null, 'one clean Reading is a blip');

      await postReading(73);
      const incident = await only();
      assert.equal(incident.end, firstClean.reading.recordedAt);
      assert.equal(incident.segments.at(-1)?.end, firstClean.reading.recordedAt);
    });

    test('a blip back into the Condition resets the count', async () => {
      await registerDevice();
      await postReading(85);
      await postReading(72);
      await postReading(84);
      await postReading(72);
      assert.equal((await only()).end, null, 'clean, hot, clean is not two clean Readings in a row');
      await postReading(72);
      assert.notEqual((await only()).end, null);
    });

    test('after it closes, the Condition returning opens a new incident', async () => {
      await registerDevice();
      await postReading(85);
      await postReading(72);
      await postReading(72);
      await postReading(83);
      const incidents = await allIncidents();
      assert.equal(incidents.length, 2);
      assert.notEqual(incidents[0].end, null);
      assert.equal(incidents[1].end, null);
    });

    test('moderate Mold risk opens nothing; high Mold risk does, peaking at the highest humidity', async () => {
      await registerDevice();
      await postReading(72, 65);
      await postReading(72, 68);
      assert.deepEqual(await allIncidents(), [], 'moderate Mold risk is a heads-up, not an incident');

      await postReading(80, 75);
      await postReading(80, 78);
      await postReading(80, 74);
      const incident = await only();
      assert.equal(incident.condition, 'Mold risk');
      assert.equal(incident.level, 'high');
      assert.equal(incident.peak.value, 78);
      assert.equal(incident.peak.humidity, 78);

      // Falling back to moderate counts as clean.
      await postReading(72, 65);
      await postReading(72, 65);
      assert.notEqual((await only()).end, null);
    });

    test('Cold and Dry peak at the lowest value, and two Conditions at once are two incidents', async () => {
      await registerDevice();
      await postReading(48, 18);
      await postReading(45, 19);
      await postReading(47, 12);
      const incidents = await allIncidents();
      assert.deepEqual(incidents.map((i) => [i.condition, i.peak.value]).sort(), [
        ['Cold', 45],
        ['Dry', 12],
      ]);
    });
  });

  describe('Offline', () => {
    test('opens through the sweep when the server would first report the Device Offline, and closes on the next Reading', async () => {
      const device = await registerDevice();
      const last = new Date(Math.floor((Date.now() - 5 * MINUTE) / 1000) * 1000);
      await readingAt(device.id, last, 71, 44);

      assert.equal(await sweep(new Date(last.getTime() + OFFLINE_AFTER_MS)), 0, 'exactly three intervals is still Online');
      assert.equal(await sweep(), 1);
      assert.equal(await sweep(), 0, 'a second pass opens no duplicate');

      const offline = await only();
      assert.equal(offline.condition, 'Offline');
      assert.equal(offline.level, 'warning');
      assert.equal(offline.start, new Date(last.getTime() + OFFLINE_AFTER_MS + 1000).toISOString());
      assert.equal(offline.end, null);
      assert.deepEqual(offline.peak, { value: null, tempF: 71, humidity: 44, recordedAt: last.toISOString() }, 'the peak is the last Reading before it');

      const back = await postReading(72);
      const closed = await only();
      assert.equal(closed.end, back.reading.recordedAt);
      assert.deepEqual(closed.segments, [{ level: 'warning', start: offline.start, end: back.reading.recordedAt }]);
    });

    test('a Reading stamped in the future by a clock step does not hide the silence from the sweep', async () => {
      const device = await registerDevice();
      const last = new Date(Math.floor((Date.now() - 5 * MINUTE) / 1000) * 1000);
      await readingAt(device.id, last, 71, 44);
      await readingAt(device.id, new Date(Date.now() + 60 * MINUTE), 71, 44);
      assert.equal(await sweep(), 1);
      const offline = await only();
      assert.equal(offline.condition, 'Offline');
      assert.equal(offline.peak.recordedAt, last.toISOString(), 'the last real Reading, not the future one');
    });

    test('a Device back before the sweep caught its silence still gets the Offline stretch, already closed', async () => {
      const device = await registerDevice();
      // Offline began 9 seconds ago, inside the sweep's period, and no pass has run since.
      const last = new Date(Math.floor((Date.now() - OFFLINE_AFTER_MS - 10_000) / 1000) * 1000);
      await readingAt(device.id, last, 71, 44);

      const back = await postReading(72);
      const offline = await only();
      assert.equal(offline.condition, 'Offline');
      assert.equal(offline.start, new Date(last.getTime() + OFFLINE_AFTER_MS + 1000).toISOString());
      assert.equal(offline.end, back.reading.recordedAt);
      assert.deepEqual(offline.peak, { value: null, tempF: 71, humidity: 44, recordedAt: last.toISOString() });
      assert.deepEqual(offline.segments, [{ level: 'warning', start: offline.start, end: back.reading.recordedAt }]);
      assert.equal(await sweep(), 0, 'the sweep opens nothing more');
    });

    test('a silence older than the sweep\'s period with nothing open is the server\'s own outage, not an incident', async () => {
      const device = await registerDevice();
      await readingAt(device.id, new Date(Date.now() - 10 * MINUTE), 71, 44);
      await postReading(72);
      assert.deepEqual(await allIncidents(), []);
    });

    test('the scheduled sweep waits one interval before its first pass, so a restart does not judge Devices before they can report', async () => {
      const device = await registerDevice();
      await readingAt(device.id, new Date(Date.now() - 5 * MINUTE));
      const job = startOfflineSweep({ pool, config: testConfig(), sse }, { intervalMs: 400 });
      try {
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.deepEqual(await allIncidents(), [], 'no pass at start');
        await new Promise((resolve) => setTimeout(resolve, 600));
        assert.equal((await only()).condition, 'Offline', 'the first pass, one interval in');
      } finally {
        await job.stop();
      }
    });

    test('stop waits for the pass in flight, which opens its incident, and no pass starts after', async () => {
      const device = await registerDevice();
      await readingAt(device.id, new Date(Date.now() - 5 * MINUTE));
      const gate = createGate();
      const statements: string[] = [];
      const job = startOfflineSweep({ pool: gatedPool(pool, gate, statements), config: testConfig(), sse }, { intervalMs: 50 });

      await gate.reached;
      const stopped = job.stop();
      try {
        assert.equal(await settlesWithin(stopped, 150), false, 'stop waits for the pass');
      } finally {
        gate.open();
      }
      await stopped;
      assert.equal((await only()).condition, 'Offline', 'the pass finished');
      const passes = statements.filter((sql) => sql === 'SELECT 1').length;
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(statements.filter((sql) => sql === 'SELECT 1').length, passes, 'no pass after the stop');
      assert.equal(passes, 1, 'ticks during the held pass were skipped');
    });

    describe('the server\'s own downtime (resilience.md S2)', () => {
      const whole = (ms: number) => new Date(Math.floor(ms / 1000) * 1000);

      test('after a start, silence counts from the start: no incident until one Offline window later, and none starting before it', async () => {
        const device = await registerDevice();
        const started = whole(Date.now() - MINUTE);
        await readingAt(device.id, new Date(started.getTime() - 4 * MINUTE), 71, 44);
        const listening = createListening(started);
        const sweepFrom = (now: Date) => runOfflineSweep({ pool, config: testConfig(), sse, now: () => now, listening });

        assert.equal(await sweepFrom(new Date()), 0, 'the Device has had a minute, not an Offline window, to report since the start');
        assert.equal(await sweepFrom(new Date(started.getTime() + OFFLINE_AFTER_MS)), 0);
        const at = new Date(started.getTime() + OFFLINE_AFTER_MS + 1000);
        assert.equal(await sweepFrom(at), 1, 'a Device still silent an Offline window after the start is Offline');
        const offline = await only();
        assert.equal(offline.start, at.toISOString(), 'it starts when the server could first have known, never inside its own downtime');
        assert.ok(new Date(offline.start).getTime() >= started.getTime());
      });

      test('a failed pass followed by a good one restarts the count, as after a database outage', async () => {
        const device = await registerDevice();
        await readingAt(device.id, whole(Date.now() - 5 * MINUTE), 71, 44);
        const listening = createListening(new Date(Date.now() - DAY_MS));
        const unreachable = createPool({ ...testDatabaseConfig(), host: '127.0.0.1', port: 1 });
        try {
          await assert.rejects(runOfflineSweep({ pool: unreachable, config: testConfig(), sse, listening }));
        } finally {
          await unreachable.end();
        }
        const now = whole(Date.now());
        assert.equal(await runOfflineSweep({ pool, config: testConfig(), sse, now: () => now, listening }), 0);
        assert.equal(listening.since().getTime(), now.getTime());
      });

      test('a Device back right after a database outage gets no Offline stretch for it', async () => {
        await server.close();
        const listening = createListening(new Date(Date.now() - DAY_MS));
        server = await startServer(pool, testConfig(), { sse, listening });
        client = api(server);
        const device = await registerDevice();
        // Its last Reading went Offline 9 seconds ago, inside the outage; the db is back and this is the first Reading since.
        await readingAt(device.id, whole(Date.now() - OFFLINE_AFTER_MS - 10_000), 71, 44);
        listening.lost();
        await postReading(72);
        assert.deepEqual(await allIncidents(), []);
      });
    });

    test('a Device that has never reported has no Offline incident', async () => {
      await registerDevice();
      assert.equal(await sweep(), 0);
    });

    test('a Device still Online opens nothing', async () => {
      await registerDevice();
      await postReading(72);
      assert.equal(await sweep(), 0);
    });
  });

  test('a restart (a new app instance on the same database) continues an open incident', async () => {
    await registerDevice();
    await postReading(85);
    await server.close();

    server = await startServer(pool, testConfig(), { sse });
    client = api(server);
    await postReading(91);
    const incident = await only();
    assert.deepEqual(incident.segments.map((s) => s.level), ['warning', 'critical'], 'the same incident, one level up');
    await postReading(72);
    await postReading(72);
    assert.notEqual((await only()).end, null);
  });

  test('deleting a Device removes its incidents and their segments', async () => {
    const device = await registerDevice();
    await postReading(91);
    await postReading(85);
    assert.equal(await countRows('incident_segments'), 2);

    assert.equal((await fetch(client.devices.url(`/${device.id}`), { ...asAdmin(), method: 'DELETE' })).status, 204);
    assert.equal(await countRows('incidents'), 0);
    assert.equal(await countRows('incident_segments'), 0);
  });

  test('resetting history removes the Device\'s incidents and leaves other Devices\' alone', async () => {
    const device = await registerDevice('ESP_A1B2C3');
    await client.devices.create(device.campus.id, 'ESP_D4E5F6', 'MDF');
    await postReading(91, 40, 'ESP_A1B2C3');
    await postReading(91, 40, 'ESP_D4E5F6');

    assert.equal((await client.devices.resetHistory(device.id)).status, 204);
    const left = await only();
    assert.equal(left.device.hostname, 'ESP_D4E5F6');
    assert.equal(await countRows('incident_segments'), 1);
  });

  test('retention prunes incidents that ended before the window, keeping ongoing ones however old', async () => {
    const device = await registerDevice();
    const now = new Date('2026-09-09T12:00:00Z');
    const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * DAY_MS);
    const incident = (start: Date, end: Date | null, condition: IncidentState['condition'] = 'Hot'): IncidentState => ({
      condition,
      level: 'warning',
      start,
      end,
      peak: { tempF: 85, humidity: 40, recordedAt: start },
      segments: [{ level: 'warning', start, end }],
      cleanReadings: 0,
      firstCleanAt: null,
    });
    await insertIncident(pool, device.id, incident(at(100), at(95)));
    await insertIncident(pool, device.id, incident(at(92), at(89)));
    await insertIncident(pool, device.id, incident(at(120), null, 'Dry'));

    await deleteReadingsPastWindow({ pool, config: testConfig({ retentionDays: 90 }), now: () => now }, { log: () => {} });

    const [rows] = await pool.query<RowDataPacket[]>('SELECT started_at AS start FROM incidents ORDER BY started_at');
    assert.deepEqual(rows.map((r) => (r.start as Date).toISOString()), [at(120).toISOString(), at(92).toISOString()]);
    assert.equal(await countRows('incident_segments'), 2, 'the pruned incident\'s segments went with it');
  });

  describe('GET /api/incidents', () => {
    const window = (query: string) => client.incidents.fetch(query);

    test('needs from and to as ISO instants, from before to, and at most eight days apart (422 otherwise)', async () => {
      const cases: [string, RegExp][] = [
        ['', /from is required/],
        ['?from=2026-10-01T00:00:00Z', /to is required/],
        ['?from=yesterday&to=2026-10-02T00:00:00Z', /from must be an ISO instant/],
        ['?from=2026-10-01T00:00:00&to=2026-10-02T00:00:00Z', /from must be an ISO instant with a zone/],
        ['?from=2026-10-02T00:00:00Z&to=2026-10-02T00:00:00Z', /from must be before to/],
        ['?from=2026-10-03T00:00:00Z&to=2026-10-02T00:00:00Z', /from must be before to/],
        ['?from=2026-10-01T00:00:00Z&to=2026-10-09T00:00:01Z', /at most 8 days/],
      ];
      for (const [query, message] of cases) {
        const response = await window(query);
        assert.equal(response.status, 422, query);
        assert.match(await errorOf(response), message, query);
      }
      const eightDays = await window('?from=2026-10-01T00:00:00Z&to=2026-10-09T00:00:00Z');
      assert.equal(eightDays.status, 200);
      assert.deepEqual(await eightDays.json(), { from: '2026-10-01T00:00:00.000Z', to: '2026-10-09T00:00:00.000Z', incidents: [] });
      const offset = await window('?from=2026-10-01T00:00:00-05:00&to=2026-10-02T00:00:00%2B01:00');
      assert.equal(offset.status, 200, 'any zone offset is an instant');
    });

    test('returns the incidents that overlap the window, ongoing ones included, oldest first', async () => {
      const device = await registerDevice();
      const t = (iso: string) => new Date(`2026-10-05T${iso}Z`);
      const incident = (condition: IncidentState['condition'], start: Date, end: Date | null): IncidentState => ({
        condition,
        level: 'warning',
        start,
        end,
        peak: { tempF: 85, humidity: 40, recordedAt: start },
        segments: [{ level: 'warning', start, end }],
        cleanReadings: 0,
        firstCleanAt: null,
      });
      await insertIncident(pool, device.id, incident('Hot', t('01:00:00'), t('02:00:00'))); // ends at the window's start: out
      await insertIncident(pool, device.id, incident('Cold', t('01:30:00'), t('03:00:00'))); // straddles the start: in
      await insertIncident(pool, device.id, incident('Dry', t('00:30:00'), null)); // ongoing since before: in
      await insertIncident(pool, device.id, incident('Hot', t('04:00:00'), t('05:00:00'))); // inside: in
      await insertIncident(pool, device.id, incident('Mold risk', t('06:00:00'), t('07:00:00'))); // starts at the window's end: out

      const log = await client.incidents.list(t('02:00:00'), t('06:00:00'));
      assert.deepEqual(log.incidents.map((i) => [i.condition, i.start]), [
        ['Dry', t('00:30:00').toISOString()],
        ['Cold', t('01:30:00').toISOString()],
        ['Hot', t('04:00:00').toISOString()],
      ]);
      assert.equal(log.incidents[0].end, null);
    });
  });

  describe('the stream', () => {
    const listen = async (): Promise<SseClient> => {
      const c = await subscribe(client.dashboard.url('/stream'));
      open.push(c);
      await c.next(); // the opening comment
      return c;
    };
    /** The next `incident` message, skipping Readings. */
    const nextIncident = async (stream: SseClient): Promise<IncidentEvent> => {
      for (;;) {
        const event = await stream.nextMessage<{ type: string }>();
        if (event.type === 'incident') return event as IncidentEvent;
      }
    };

    test('carries an unnamed `incident` message when an incident opens, changes level, and closes', async () => {
      await registerDevice();
      const stream = await listen();

      await postReading(85);
      const opened = await nextIncident(stream);
      assert.equal(opened.change, 'opened');
      assert.deepEqual(opened.incident, await only());

      await postReading(91);
      const level = await nextIncident(stream);
      assert.equal(level.change, 'level');
      assert.equal(level.incident.level, 'critical');

      await postReading(72);
      await postReading(72);
      const closed = await nextIncident(stream);
      assert.equal(closed.change, 'closed');
      assert.notEqual(closed.incident.end, null);

      // A Reading that changes nothing sends no incident message: only the Reading itself.
      await postReading(72);
      const events = await stream.collect(300);
      assert.deepEqual(events.map((e) => e.kind === 'message' && e.event), ['message']);
      assert.ok(events.every((e) => e.kind === 'message' && JSON.parse(e.data).type === 'reading'));
    });

    test('carries the Offline sweep\'s opening', async () => {
      const device = await registerDevice();
      await readingAt(device.id, new Date(Date.now() - 5 * MINUTE));
      const stream = await listen();
      await sweep();
      const opened = await nextIncident(stream);
      assert.equal(opened.change, 'opened');
      assert.equal(opened.incident.condition, 'Offline');
    });
  });
});

describe('replayIncidents (what the demo writes for its backfilled week)', () => {
  const rules = { reportIntervalSeconds: 30, thresholds: DEFAULT_THRESHOLDS };
  const start = new Date('2026-10-01T00:00:00Z').getTime();
  const reading = (seconds: number, tempF: number, humidity = 40) => ({ tempF, humidity, recordedAt: new Date(start + seconds * 1000) });

  test('opens, changes level, and closes as ingest would', () => {
    const incidents = replayIncidents([reading(0, 72), reading(30, 85), reading(60, 91), reading(90, 72), reading(120, 72), reading(150, 72)], rules);
    assert.equal(incidents.length, 1);
    const [hot] = incidents;
    assert.equal(hot.level, 'critical');
    assert.deepEqual(hot.start, new Date(start + 30_000));
    assert.deepEqual(hot.end, new Date(start + 90_000));
    assert.deepEqual(hot.segments.map((s) => s.level), ['warning', 'critical']);
    assert.equal(hot.peak.tempF, 91);
  });

  test('a gap longer than the allowed missed reports is an Offline incident the next Reading closes', () => {
    const incidents = replayIncidents([reading(0, 72), reading(30, 72), reading(600, 72)], rules);
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].condition, 'Offline');
    assert.deepEqual(incidents[0].start, new Date(start + 30_000 + 91_000));
    assert.deepEqual(incidents[0].end, new Date(start + 600_000));
  });

  test('a silence after the last Reading counts up to `until`, and stays open', () => {
    const incidents = replayIncidents([reading(0, 72)], rules, new Date(start + 600_000));
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].end, null);
  });

  const fault = (seconds: number): TimedReport => ({ fault: 'sensor', recordedAt: new Date(start + seconds * 1000) });

  test('fault reports among the Readings: Sensor fault opens on the third, peaking at the last good Reading, and two good Readings close it', () => {
    const incidents = replayIncidents([reading(0, 72), fault(30), fault(60), fault(90), fault(120), reading(150, 72), reading(180, 72)], rules);
    assert.equal(incidents.length, 1);
    const [sensor] = incidents;
    assert.equal(sensor.condition, 'Sensor fault');
    assert.equal(sensor.level, 'critical');
    assert.deepEqual(sensor.start, new Date(start + 90_000));
    assert.deepEqual(sensor.end, new Date(start + 150_000));
    assert.deepEqual(sensor.peak, reading(0, 72));
  });

  test('a Reading clears the count of fault reports in a row, and a board that never sent a Reading opens nothing', () => {
    assert.deepEqual(replayIncidents([reading(0, 72), fault(30), fault(60), reading(90, 72), fault(120), fault(150)], rules), []);
    assert.deepEqual(replayIncidents([fault(0), fault(30), fault(60), fault(90)], rules, new Date(start + 600_000)), []);
  });

  test('silence counts from the last report, a fault report included, and the peak is the last good Reading', () => {
    const incidents = replayIncidents([reading(0, 72), fault(30), fault(60), reading(600, 72)], rules);
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].condition, 'Offline');
    assert.deepEqual(incidents[0].start, new Date(start + 60_000 + 91_000));
    assert.deepEqual(incidents[0].end, new Date(start + 600_000));
    assert.deepEqual(incidents[0].peak, reading(0, 72));
  });
});

describe('replayIncidents agrees with ingest (the demo cannot drift from it)', () => {
  const rules = { reportIntervalSeconds: 30, thresholds: DEFAULT_THRESHOLDS };
  const start = Date.UTC(2026, 9, 1, 12, 0, 0);
  const at = (seconds: number) => new Date(start + seconds * 1000);
  let pool: Pool;
  let server: RunningServer;
  let sse: ReturnType<typeof createBroadcaster>;

  before(() => {
    pool = createTestPool();
  });
  beforeEach(async () => {
    await resetDatabase(pool);
    // Ingest stamps each report with the server's clock, so the test holds that clock.
    mock.timers.enable({ apis: ['Date'], now: start });
    sse = createBroadcaster({ heartbeatMs: 60_000 });
    server = await startServer(pool, testConfig(), { sse });
  });
  afterEach(async () => {
    mock.timers.reset();
    await server.close();
  });
  after(() => pool.end());

  const logged = ({ condition, level, start, end, peak, segments }: Incident) => ({
    condition,
    level,
    start,
    end,
    peak: { tempF: peak.tempF, humidity: peak.humidity, recordedAt: peak.recordedAt },
    segments,
  });
  const replayed = ({ condition, level, start, end, peak, segments }: IncidentState) => ({
    condition,
    level,
    start: start.toISOString(),
    end: end?.toISOString() ?? null,
    peak: { tempF: peak.tempF, humidity: peak.humidity, recordedAt: peak.recordedAt.toISOString() },
    segments: segments.map((s) => ({ level: s.level, start: s.start.toISOString(), end: s.end?.toISOString() ?? null })),
  });

  test('a mixed stream of Readings and fault reports replays to the incidents ingest and the Offline sweep record', async () => {
    const client = api(server);
    const campus = await client.campuses.create();
    await client.devices.create(campus.id, 'ESP_A1B2C3', 'IDF 2');
    // Seconds into the stream, and the Reading's °F or a fault report.
    const stream: [number, number | 'fault'][] = [
      [0, 72],
      [30, 85], // Hot opens
      [60, 'fault'],
      [90, 'fault'],
      [120, 'fault'], // Sensor fault opens on the third, peaking at 85 °F; Hot is left as it was
      [150, 'fault'], // then silence, counted from this report: Offline from 241
      [330, 72], // heard again: Offline ends, and a clean Reading each for Hot and Sensor fault
      [361, 'fault'], // Sensor fault's clean count starts over; Hot's is frozen
      [389, 72], // Hot's second clean Reading: it ends at 330
      [420, 72], // Sensor fault ends at 389
      [450, 86], // Hot again, still open at the end
      [480, 72],
    ];
    const until = 500;
    const reports: TimedReport[] = [];
    // The sweep runs once every Report interval, as it does live; here halfway between reports.
    let sweptTo = 15;
    const sweepUntil = async (seconds: number) => {
      for (; sweptTo < seconds; sweptTo += 30) await runOfflineSweep({ pool, config: testConfig(), sse, now: () => at(sweptTo) });
    };
    for (const [seconds, value] of stream) {
      await sweepUntil(seconds);
      mock.timers.setTime(at(seconds).getTime());
      const response = await client.readings.add(value === 'fault' ? { device: 'ESP_A1B2C3', fault: 'sensor' } : { device: 'ESP_A1B2C3', temp: value, humidity: 40 });
      assert.equal(response.status, value === 'fault' ? 202 : 201, await response.clone().text());
      reports.push(value === 'fault' ? { fault: 'sensor', recordedAt: at(seconds) } : { tempF: value, humidity: 40, recordedAt: at(seconds) });
    }
    await sweepUntil(until);

    const live = (await client.incidents.list(at(-60), at(until))).incidents.map(logged);
    assert.deepEqual(
      live.map((i) => [i.condition, i.start, i.end]),
      [
        ['Hot', at(30).toISOString(), at(330).toISOString()],
        ['Sensor fault', at(120).toISOString(), at(389).toISOString()],
        ['Offline', at(241).toISOString(), at(330).toISOString()],
        ['Hot', at(450).toISOString(), null],
      ],
      'the stream makes what it says it does',
    );
    assert.deepEqual(replayIncidents(reports, rules, at(until)).map(replayed), live);
  });
});

describe('fault reports (the rules alone, docs/adr/0009)', () => {
  const rules = { reportIntervalSeconds: 30, thresholds: DEFAULT_THRESHOLDS };
  const start = new Date('2026-10-01T00:00:00Z').getTime();
  const at = (seconds: number) => new Date(start + seconds * 1000);
  const reading = (seconds: number, tempF: number, humidity = 40) => ({ tempF, humidity, recordedAt: at(seconds) });
  const fault = (open: IncidentState[], seconds: number, sensorFaults: number, last: TimedReading | null = reading(0, 72)) =>
    applyFaultReport(open, { at: at(seconds), sensorFaults }, last, rules);
  const stillOpen = (steps: IncidentStep[]) => steps.map((s) => s.incident).filter((i) => i.end === null);

  test('two in a row open nothing; the third opens Sensor fault at critical, peaking at the last good Reading', () => {
    const last = reading(0, 72);
    assert.deepEqual(fault([], 30, 1, last), []);
    assert.deepEqual(fault([], 60, 2, last), []);
    const [step] = fault([], 90, 3, last);
    assert.equal(step.change, 'opened');
    assert.equal(step.incident.condition, 'Sensor fault');
    assert.equal(step.incident.level, 'critical');
    assert.deepEqual(step.incident.start, at(90));
    assert.deepEqual(step.incident.peak, last);
    assert.equal(peakValue('Sensor fault', last), null);
  });

  test('a Device that has never sent a Reading has nothing to peak at, so no incident (the Condition still shows)', () => {
    assert.deepEqual(fault([], 90, 3, null), []);
  });

  test('two good Readings close it, ending at the first; a fault report between them starts the count again', () => {
    let open = stillOpen(fault([], 90, 3));
    open = stillOpen(fault(open, 120, 4));
    assert.equal(open.length, 1, 'later fault reports continue the one incident');
    open = stillOpen(applyReading(open, reading(150, 72), rules));
    open = stillOpen(fault(open, 180, 1));
    open = stillOpen(applyReading(open, reading(210, 72), rules));
    assert.equal(open.length, 1, 'good, fault, good is not two good Readings in a row');
    const [closed] = applyReading(open, reading(240, 72), rules);
    assert.equal(closed.change, 'closed');
    assert.deepEqual(closed.incident.end, at(210));
  });

  test('a value incident open when the sensor died keeps its clean count frozen, and closes once Readings resume', () => {
    let open = stillOpen(applyReading([], reading(0, 85), rules));
    open = stillOpen(applyReading(open, reading(30, 72), rules));
    assert.equal(open[0].cleanReadings, 1);
    for (let n = 1; n <= 5; n += 1) {
      const steps = fault(open, 30 + n * 30, n, reading(30, 72));
      assert.ok(steps.filter((s) => s.incident.condition === 'Hot').every((s) => !s.dirty && s.change === null), `fault report ${n} leaves Hot alone`);
      open = stillOpen(steps);
    }
    const hot = open.find((i) => i.condition === 'Hot');
    assert.equal(hot?.cleanReadings, 1);
    assert.deepEqual(hot?.firstCleanAt, at(30));
    const steps = applyReading(open, reading(300, 72), rules);
    assert.deepEqual(steps.find((s) => s.incident.condition === 'Hot')?.incident.end, at(30), 'the second clean Reading closes it, ending at the first');
  });

  test('a fault report ends an open Offline incident: the board is heard from', () => {
    const offline = offlineIncident({ at: at(0), reading: reading(0, 72) }, at(200), rules);
    assert.ok(offline !== null);
    const [step] = fault([offline.incident], 300, 1);
    assert.equal(step.change, 'closed');
    assert.deepEqual(step.incident.end, at(300));
  });

  test('silence counts from the last report, fault reports included, and the peak is still the last good Reading', () => {
    const last = { at: at(300), reading: reading(0, 72) };
    assert.equal(offlineIncident(last, at(390), rules), null, 'three intervals after the last fault report is still Online');
    const offline = offlineIncident(last, at(391), rules);
    assert.deepEqual(offline?.incident.start, at(391));
    assert.deepEqual(offline?.incident.peak, reading(0, 72));
    const missed = missedOffline(last, at(395), rules, 30);
    assert.deepEqual(missed?.incident.start, at(391));
    assert.deepEqual(missed?.incident.end, at(395));
    assert.equal(missedOffline(last, at(380), rules, 30), null, 'back before Offline began');
  });
});
