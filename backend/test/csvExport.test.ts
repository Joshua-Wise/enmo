import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'mysql2/promise';
import { createTestPool, resetDatabase } from './helpers/database';
import { startServer, testConfig, type RunningServer } from './helpers/server';
import { api, asAdmin, errorOf, type Device } from './helpers/api';
import { csvCell, csvRow, fileNamePart } from '../src/csv';
import { CSV_PAGE_ROWS } from '../src/routes/csvExports';
import { incidentsOverlappingPage, insertIncident } from '../src/incidentStore';
import type { IncidentState } from '../src/incidents';

/** Chicago is on CDT in September, five hours behind UTC, so its 5 September starts at 05:00Z. */
const CHICAGO = 'America/Chicago';
const DAY_START = '2026-09-05T05:00:00Z';
const NEXT_DAY_START = '2026-09-06T05:00:00Z';
/** 14:30 Chicago time on 5 September. */
const NOW = new Date('2026-09-05T19:30:00Z');

describe('csv cells', () => {
  test('numbers are bare, a negative one too, and nothing is an empty cell', () => {
    assert.equal(csvCell(72), '72');
    assert.equal(csvCell(-10), '-10');
    assert.equal(csvCell(22.2), '22.2');
    assert.equal(csvCell(null), '');
  });

  test('text is quoted only when it holds a comma, a quote, or a line break, with its quotes doubled', () => {
    assert.equal(csvCell('IDF 2'), 'IDF 2');
    assert.equal(csvCell('IDF 2, upstairs'), '"IDF 2, upstairs"');
    assert.equal(csvCell('the "new" MDF'), '"the ""new"" MDF"');
    assert.equal(csvCell('two\nlines'), '"two\nlines"');
  });

  test('text a spreadsheet would run as a formula is prefixed with a quote mark and quoted', () => {
    assert.equal(csvCell('=1+2'), `"'=1+2"`);
    assert.equal(csvCell('+1'), `"'+1"`);
    assert.equal(csvCell('-2+3'), `"'-2+3"`);
    assert.equal(csvCell('@SUM(A1)'), `"'@SUM(A1)"`);
    assert.equal(csvCell('\t=1'), `"'\t=1"`);
    assert.equal(csvCell('\r=1'), `"'\r=1"`);
    assert.equal(csvCell('=HYPERLINK("http://x.example","go")'), `"'=HYPERLINK(""http://x.example"",""go"")"`);
    // Only at the start: a formula character inside the text is harmless.
    assert.equal(csvCell('IDF 2 = MDF'), 'IDF 2 = MDF');
  });

  test('a row ends in CRLF', () => {
    assert.equal(csvRow(['MDF', 72, null]), 'MDF,72,\r\n');
  });

  test('a name in a file name keeps letters, digits, dots, and hyphens', () => {
    assert.equal(fileNamePart('IDF 2'), 'IDF-2');
    assert.equal(fileNamePart(`=cmd|' /C calc'!A0`), 'cmd-C-calc-A0');
    assert.equal(fileNamePart('../MDF_1'), 'MDF-1');
  });
});

/** The body of a CSV response: it starts with a UTF-8 byte order mark, which this checks and removes. */
async function csvText(response: Response): Promise<string> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'starts with the UTF-8 byte order mark');
  return new TextDecoder('utf-8').decode(bytes.subarray(3));
}

const lines = (text: string): string[] => {
  assert.ok(text.endsWith('\r\n'), 'the last line ends in CRLF');
  const out = text.slice(0, -2).split('\r\n');
  assert.ok(out.every((line) => !line.includes('\n')), 'every line ends in CRLF, none in a bare LF');
  return out;
};

const READINGS_HEADER = 'Local time (America/Chicago),UTC time,Temperature (F),Temperature (C),Humidity (%)';
const INCIDENTS_HEADER =
  'Campus,Closet,Hostname,Condition,Level,Started (America/Chicago),Started (UTC),Ended (America/Chicago),Ended (UTC),Duration (minutes),' +
  'Peak temperature (F),Peak temperature (C),Peak humidity (%),Peak at (America/Chicago),Acknowledged by,Acknowledged at (America/Chicago)';

describe('CSV downloads', () => {
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

  let hostnames = 0;
  const registerDevice = async (closet = 'IDF 2', campusId?: number): Promise<Device> => {
    const id = campusId ?? (await client.campuses.create()).id;
    return client.devices.create(id, `ESP_${(0xa00000 + ++hostnames).toString(16).toUpperCase()}`, closet);
  };
  // Ingest stamps the server's time, so a Reading at a chosen instant can only be arranged by writing the row directly.
  const readingAt = async (deviceId: number, recordedAt: string, tempF = 72, humidity: number | null = 40) => {
    await pool.query('INSERT INTO readings (device_id, temp_f, humidity, recorded_at) VALUES (?, ?, ?, ?)', [deviceId, tempF, humidity, new Date(recordedAt)]);
  };
  // The downloads need what History and the Incidents log need: a session or the Admin token (docs/adr/0010).
  const readingsCsv = (id: number | string, query: string) => fetch(`${server.url}/api/devices/${id}/readings.csv${query}`, asAdmin());
  const incidentsCsv = (query: string) => fetch(`${server.url}/api/incidents.csv${query}`, asAdmin());

  describe('GET /api/devices/:id/readings.csv', () => {
    test('one row per Reading of the day, oldest first: local time, UTC time, °F, °C, and humidity, unformatted, under a header row', async () => {
      const device = await registerDevice();
      await readingAt(device.id, '2026-09-05T04:59:59Z', 60); // 23:59:59 the night before
      await readingAt(device.id, '2026-09-06T04:59:59Z', 95, 55); // 23:59:59, the last second of the day
      await readingAt(device.id, DAY_START, 72, 40); // midnight
      await readingAt(device.id, '2026-09-05T19:30:00Z', 14, null); // 2:30 PM, freezing, no humidity
      await readingAt(device.id, NEXT_DAY_START, 64); // midnight the next day

      const response = await readingsCsv(device.id, `?from=2026-09-05&to=2026-09-05&tz=${CHICAGO}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'text/csv; charset=utf-8');
      assert.equal(response.headers.get('content-disposition'), 'attachment; filename="CHS_IDF-2_readings_2026-09-05.csv"');
      assert.deepEqual(lines(await csvText(response)), [
        READINGS_HEADER,
        '2026-09-05 00:00:00,2026-09-05 05:00:00,72,22.2,40',
        // A negative °C stays a number: only text is guarded against formulas.
        '2026-09-05 14:30:00,2026-09-05 19:30:00,14,-10,',
        '2026-09-05 23:59:59,2026-09-06 04:59:59,95,35,55',
      ]);
    });

    test('a range takes every day from the first to the last, and names both in the file name', async () => {
      const device = await registerDevice('MDF');
      await readingAt(device.id, '2026-09-03T12:00:00Z', 70); // the day before the range
      await readingAt(device.id, '2026-09-04T05:00:00Z', 71); // the first second of the range
      await readingAt(device.id, '2026-09-06T04:59:59Z', 73); // the last
      await readingAt(device.id, '2026-09-06T05:00:00Z', 74); // the day after

      const response = await readingsCsv(device.id, `?from=2026-09-04&to=2026-09-05&tz=${CHICAGO}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-disposition'), 'attachment; filename="CHS_MDF_readings_2026-09-04_to_2026-09-05.csv"');
      assert.deepEqual(
        lines(await csvText(response)).slice(1).map((line) => line.split(',')[2]),
        ['71', '73'],
      );
    });

    test('is streamed a page at a time, every Reading once and in order across the pages, ties in a second included', async () => {
      const device = await registerDevice();
      // A page and two more, the last three sharing a second, so the first page ends inside a tie.
      const count = CSV_PAGE_ROWS + 2;
      const start = Date.parse(DAY_START);
      const rows = Array.from({ length: count }, (_, i) => [device.id, i, 40, new Date(start + Math.min(i, CSV_PAGE_ROWS - 1) * 1000)]);
      await pool.query('INSERT INTO readings (device_id, temp_f, humidity, recorded_at) VALUES ?', [rows]);

      const response = await readingsCsv(device.id, `?from=2026-09-05&to=2026-09-05&tz=${CHICAGO}`);
      assert.equal(response.status, 200);
      // Sent as it is read: chunked, with no length known up front.
      assert.equal(response.headers.get('transfer-encoding'), 'chunked');
      assert.equal(response.headers.get('content-length'), null);
      const temps = lines(await csvText(response)).slice(1).map((line) => Number(line.split(',')[2]));
      assert.deepEqual(temps, Array.from({ length: count }, (_, i) => i));
    });

    test('a Device with no Readings is the header row alone', async () => {
      const device = await registerDevice();
      const response = await readingsCsv(device.id, `?from=2026-09-01&to=2026-09-05&tz=${CHICAGO}`);
      assert.equal(response.status, 200);
      assert.deepEqual(lines(await csvText(response)), [READINGS_HEADER]);
    });

    test('the range is capped at the Retention window: 90 days are sent, 91 are refused (422)', async () => {
      const device = await registerDevice();
      await readingAt(device.id, '2026-06-08T05:00:00Z', 70); // the first second of the 90 days
      const ninety = await readingsCsv(device.id, `?from=2026-06-08&to=2026-09-05&tz=${CHICAGO}`);
      assert.equal(ninety.status, 200);
      assert.deepEqual(lines(await csvText(ninety)), [READINGS_HEADER, '2026-06-08 00:00:00,2026-06-08 05:00:00,70,21.1,40']);

      const ninetyOne = await readingsCsv(device.id, `?from=2026-06-07&to=2026-09-05&tz=${CHICAGO}`);
      assert.equal(ninetyOne.status, 422);
      assert.match(await errorOf(ninetyOne), /at most 90 days/);
    });

    test('refuses a missing, malformed, or backwards range and an unknown zone (422)', async () => {
      const device = await registerDevice();
      for (const query of ['', '?from=2026-09-05', '?to=2026-09-05', '?from=2026-09-31&to=2026-10-01', '?from=09/05/2026&to=2026-09-05', '?from=2026-09-05&to=2026-09-04']) {
        const response = await readingsCsv(device.id, `${query}${query === '' ? '?' : '&'}tz=${CHICAGO}`);
        assert.equal(response.status, 422, query);
        assert.ok((await errorOf(response)).length > 0, query);
      }
      const zone = await readingsCsv(device.id, '?from=2026-09-05&to=2026-09-05&tz=Mars/Olympus_Mons');
      assert.equal(zone.status, 422);
      assert.match(await errorOf(zone), /Unknown time zone/);
    });

    test('an unknown Device is a 404', async () => {
      for (const id of ['9999', 'abc', '0', '1.5']) {
        const response = await readingsCsv(id, `?from=2026-09-05&to=2026-09-05&tz=${CHICAGO}`);
        assert.equal(response.status, 404, id);
        assert.equal(await errorOf(response), 'Device not found');
      }
    });

    test('a Closet name that is a formula is kept out of the file name', async () => {
      const device = await registerDevice(`=cmd|' /C calc'!A0`);
      const response = await readingsCsv(device.id, `?from=2026-09-05&to=2026-09-05&tz=${CHICAGO}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-disposition'), 'attachment; filename="CHS_cmd-C-calc-A0_readings_2026-09-05.csv"');
      await response.arrayBuffer();
    });
  });

  describe('GET /api/incidents.csv', () => {
    const incident = (
      condition: IncidentState['condition'],
      level: IncidentState['level'],
      start: string,
      end: string | null,
      peak: { tempF: number; humidity: number | null; recordedAt: string },
    ): IncidentState => ({
      condition,
      level,
      start: new Date(start),
      end: end === null ? null : new Date(end),
      peak: { ...peak, recordedAt: new Date(peak.recordedAt) },
      segments: [{ level, start: new Date(start), end: end === null ? null : new Date(end) }],
      cleanReadings: 0,
      firstCleanAt: null,
    });
    const acknowledge = (id: number, by: string, at: string) =>
      pool.query('UPDATE incidents SET acknowledged_by = ?, acknowledged_at = ? WHERE id = ?', [by, new Date(at), id]);
    const DAY_WINDOW = `?from=${DAY_START}&to=${NEXT_DAY_START}&tz=${CHICAGO}`;

    test('one row per incident overlapping the window, oldest first, with its Device, times, duration, peak, and acknowledgement', async () => {
      const device = await registerDevice();
      // Ended the day before: outside the window.
      await insertIncident(pool, device.id, incident('Dry', 'warning', '2026-09-04T10:00:00Z', '2026-09-04T11:00:00Z', { tempF: 70, humidity: 18, recordedAt: '2026-09-04T10:30:00Z' }));
      const hot = await insertIncident(pool, device.id, incident('Hot', 'critical', '2026-09-05T07:00:00Z', '2026-09-05T08:20:00Z', { tempF: 93, humidity: 40, recordedAt: '2026-09-05T07:40:00Z' }));
      await acknowledge(hot, 'Sam', '2026-09-05T07:10:00Z');
      // Still going: no end, and its duration runs to now.
      await insertIncident(pool, device.id, incident('Offline', 'warning', '2026-09-05T18:00:00Z', null, { tempF: 72, humidity: null, recordedAt: '2026-09-05T17:58:30Z' }));

      const response = await incidentsCsv(DAY_WINDOW);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'text/csv; charset=utf-8');
      assert.equal(response.headers.get('content-disposition'), 'attachment; filename="incidents_2026-09-05.csv"');
      assert.deepEqual(lines(await csvText(response)), [
        INCIDENTS_HEADER,
        `Central High School,IDF 2,${device.hostname},Hot,critical,2026-09-05 02:00:00,2026-09-05 07:00:00,2026-09-05 03:20:00,2026-09-05 08:20:00,80,93,33.9,40,2026-09-05 02:40:00,Sam,2026-09-05 02:10:00`,
        `Central High School,IDF 2,${device.hostname},Offline,warning,2026-09-05 13:00:00,2026-09-05 18:00:00,,,90,72,22.2,,2026-09-05 12:58:30,,`,
      ]);
    });

    test('Closet, Campus, and acknowledgement text that starts with =, +, -, or @ is escaped', async () => {
      const campus = await client.campuses.create('=1+2 Elementary', 'ESC');
      const closets = ['=HYPERLINK("http://x.example","go")', '+1', '-2+3', '@SUM(A1)'];
      const ids: number[] = [];
      for (const [i, closet] of closets.entries()) {
        const device = await registerDevice(closet, campus.id);
        const start = new Date(Date.parse(DAY_START) + (i + 1) * 3_600_000).toISOString();
        ids.push(await insertIncident(pool, device.id, incident('Hot', 'warning', start, null, { tempF: 85, humidity: 40, recordedAt: start })));
      }
      await acknowledge(ids[0], '@channel on it', '2026-09-05T19:00:00Z');

      const rows = lines(await csvText(await incidentsCsv(DAY_WINDOW))).slice(1);
      assert.equal(rows.length, 4);
      assert.ok(rows.every((row) => row.startsWith(`"'=1+2 Elementary",`)), rows.join('\n'));
      assert.ok(rows[0].includes(`,"'=HYPERLINK(""http://x.example"",""go"")",`), rows[0]);
      assert.ok(rows[1].includes(`,"'+1",`), rows[1]);
      assert.ok(rows[2].includes(`,"'-2+3",`), rows[2]);
      assert.ok(rows[3].includes(`,"'@SUM(A1)",`), rows[3]);
      assert.ok(rows[0].includes(`,"'@channel on it",`), rows[0]);
    });

    test('takes the Incidents log\'s window, and with device= only that Device\'s, named by its Campus, Closet, and days', async () => {
      const campus = await client.campuses.create();
      const idf = await registerDevice('IDF 2', campus.id);
      const mdf = await registerDevice('MDF', campus.id);
      const peak = { tempF: 86, humidity: 40, recordedAt: '2026-09-05T02:00:00Z' };
      await insertIncident(pool, idf.id, incident('Hot', 'warning', '2026-09-05T01:00:00Z', '2026-09-05T03:00:00Z', peak));
      await insertIncident(pool, mdf.id, incident('Hot', 'warning', '2026-09-05T02:00:00Z', '2026-09-05T04:00:00Z', peak));
      // Overnight: 18:00 on the 4th to 08:00 on the 5th, Chicago time.
      const overnight = `?from=2026-09-04T23:00:00Z&to=2026-09-05T13:00:00Z&tz=${CHICAGO}`;

      const both = await incidentsCsv(overnight);
      assert.equal(both.headers.get('content-disposition'), 'attachment; filename="incidents_2026-09-04_to_2026-09-05.csv"');
      assert.deepEqual(lines(await csvText(both)).slice(1).map((row) => row.split(',')[1]), ['IDF 2', 'MDF']);

      const one = await incidentsCsv(`${overnight}&device=${mdf.id}`);
      assert.equal(one.status, 200);
      assert.equal(one.headers.get('content-disposition'), 'attachment; filename="CHS_MDF_incidents_2026-09-04_to_2026-09-05.csv"');
      assert.deepEqual(lines(await csvText(one)).slice(1).map((row) => row.split(',')[1]), ['MDF']);
    });

    test('a page of incidents starts after the last one of the page before, ties in a second included', async () => {
      const device = await registerDevice();
      const peak = { tempF: 86, humidity: 40, recordedAt: DAY_START };
      // Three starting in the same second, then a later one: the first page of two ends inside the tie.
      // All ended, since a Device has one open incident per Condition at most.
      const ids: number[] = [];
      for (const start of [DAY_START, DAY_START, DAY_START, '2026-09-05T06:00:00Z']) {
        ids.push(await insertIncident(pool, device.id, incident('Hot', 'warning', start, '2026-09-05T07:00:00Z', peak)));
      }
      const [from, to] = [new Date(DAY_START), new Date(NEXT_DAY_START)];

      const first = await incidentsOverlappingPage(pool, from, to, { limit: 2 });
      const last = first[first.length - 1];
      const second = await incidentsOverlappingPage(pool, from, to, { limit: 2, after: { start: new Date(last.start), id: last.id } });
      const third = await incidentsOverlappingPage(pool, from, to, { limit: 2, after: { start: new Date(second[1].start), id: second[1].id } });
      assert.deepEqual([...first, ...second, ...third].map((i) => i.id), ids);
      assert.deepEqual(third, []);
    });

    test('no incidents is the header row alone', async () => {
      const device = await registerDevice();
      const response = await incidentsCsv(`${DAY_WINDOW}&device=${device.id}`);
      assert.equal(response.status, 200);
      assert.deepEqual(lines(await csvText(response)), [INCIDENTS_HEADER]);
    });

    test('the window may run past the log\'s week, up to the Retention window and a day: 91 days are sent, more are refused (422)', async () => {
      const to = new Date(NEXT_DAY_START);
      const daysBefore = (days: number) => new Date(to.getTime() - days * 86_400_000).toISOString();
      const ninetyOne = await incidentsCsv(`?from=${daysBefore(91)}&to=${to.toISOString()}&tz=${CHICAGO}`);
      assert.equal(ninetyOne.status, 200);
      assert.deepEqual(lines(await csvText(ninetyOne)), [INCIDENTS_HEADER]);

      const longer = await incidentsCsv(`?from=${daysBefore(92)}&to=${to.toISOString()}&tz=${CHICAGO}`);
      assert.equal(longer.status, 422);
      assert.match(await errorOf(longer), /at most 91 days/);
    });

    test('refuses a missing or backwards window and an unknown zone (422), and an unknown Device (404)', async () => {
      for (const query of [`?to=${NEXT_DAY_START}`, `?from=${DAY_START}`, `?from=${NEXT_DAY_START}&to=${DAY_START}`, '?from=2026-09-05&to=2026-09-06']) {
        const response = await incidentsCsv(query);
        assert.equal(response.status, 422, query);
      }
      const zone = await incidentsCsv(`?from=${DAY_START}&to=${NEXT_DAY_START}&tz=Mars/Olympus_Mons`);
      assert.equal(zone.status, 422);
      for (const device of ['9999', 'abc', '']) {
        const response = await incidentsCsv(`${DAY_WINDOW}&device=${device}`);
        assert.equal(response.status, 404, device);
        assert.equal(await errorOf(response), 'Device not found');
      }
    });
  });
});
