import { Router, type Request, type RequestHandler } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { deviceTokenOf, requireAdminToken } from '../auth';
import type { RouteDeps } from '../deps';
import { closetType } from '../closet';
import { SELECT_DEVICES, toDevice, type DeviceRow } from './devices';
import { conditionsFor, isOffline, LEVELS_WORST_FIRST, offlineAfterSeconds, worstLevel, type Condition, type ConditionRules } from '../conditions';
import type { Config } from '../config';
import { isTimeZone, localDay, serverTimeZone, todayIn, type LocalDay } from '../localDay';
import type { ReadingPayload } from '../sse';
import { MonotonicStore } from '../monotonicStore';
import { LATEST_READING_ID, lastReportAt, latestAllowed } from '../latestReading';
import { notePending } from '../pendingDevices';
import { onFallbackNetwork, parseDeviceInfo } from '../deviceInfo';
import { cachedRelease, holdOnReport, offers } from '../firmwareStore';
import { cleanReportsAfter, reportMovesRollout } from '../rollout';
import type { DeviceSightings } from '../deviceSightings';
import type { TimedReading } from '../incidents';
import {
  broadcastIncidentChanges,
  deleteDeviceIncidents,
  latestReadingOf,
  openIncidentsByDevice,
  recordFaultIncidents,
  recordReadingIncidents,
  type ChangedIncident,
  type OpenIncidentPayload,
} from '../incidentStore';
import { enqueueNotifications } from '../outboxStore';
import { WEAK_SIGNAL_DBM } from '../systemHealth';

interface DeviceIdRow extends RowDataPacket {
  id: number;
  hostname: string;
  lastReportAt: Date | null;
  sensorFaults: number;
  firmwareVersion: number | null;
  cleanReports: number;
  sentAt: Date | null;
  updateResult: string | null;
  wifiNetwork: number | null;
}

interface ReadingInput {
  hostname: string;
  tempF: number;
  humidity: number;
}

/** A board saying its sensor did not answer this Report interval (firmware 5 and later, docs/adr/0009). */
interface FaultInput {
  hostname: string;
  fault: 'sensor';
}

/**
 * The ESP8266 core names a board `ESP-XXXXXX` while Devices are registered as `ESP_XXXXXX`,
 * so a posted hostname has its hyphens turned into underscores, as the old server did.
 */
function normaliseHostname(device: string): string {
  return device.trim().replace(/-/g, '_').toUpperCase();
}

function isNumeric(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * What a working sensor can report. Wider than the DHT11's own range (32 to 122 °F, 20 to 90
 * percent) so another sensor still fits; anything outside is a fault, not a Reading.
 */
const TEMP_F_RANGE = { min: -40, max: 200 } as const;
const HUMIDITY_RANGE = { min: 0, max: 100 } as const;

const within = (value: number, { min, max }: { min: number; max: number }): boolean => value >= min && value <= max;

/**
 * Normalised reading input, or a fault report (`fault: "sensor"` and no values), or the message
 * explaining why the body is neither.
 */
function parseReading(body: unknown): ReadingInput | FaultInput | { error: string } {
  const { device, temp, humidity, fault } = (body ?? {}) as Record<string, unknown>;
  const hostname = typeof device === 'string' ? normaliseHostname(device) : '';
  if (hostname === '') return { error: 'A reading needs the device hostname' };
  if (fault !== undefined) {
    if (fault !== 'sensor') return { error: 'fault must be "sensor"' };
    if (temp !== undefined || humidity !== undefined) return { error: 'A fault report carries no temp or humidity' };
    return { hostname, fault };
  }
  if (!isNumeric(temp)) return { error: 'temp must be a number' };
  if (!within(temp, TEMP_F_RANGE)) return { error: `temp must be between ${TEMP_F_RANGE.min} and ${TEMP_F_RANGE.max} °F` };
  if (!isNumeric(humidity)) return { error: 'humidity must be a number' };
  if (!within(humidity, HUMIDITY_RANGE)) {
    return { error: `humidity must be between ${HUMIDITY_RANGE.min} and ${HUMIDITY_RANGE.max} percent` };
  }
  // DHT11 resolution is a whole degree and a whole percent; the table stores integers.
  return { hostname, tempF: Math.round(temp), humidity: Math.round(humidity) };
}

/** Now, to the second, since the readings table stores DATETIME without fractional seconds. */
function serverNow(): Date {
  return new Date(Math.floor(Date.now() / 1000) * 1000);
}

/** The part of the configuration the Conditions module needs. */
const conditionRules = ({ reportIntervalSeconds, thresholds }: Config): ConditionRules => ({ reportIntervalSeconds, thresholds });

export { DEVICE_AUTH_FAILURE_LIMIT } from '../deviceAuth';

/**
 * Reading ingest (POST /api/readings): a Device posts `{device, temp, humidity}` with the
 * Device token. Each recorded Reading is broadcast to every open dashboard. A board whose sensor
 * did not answer (firmware 5) posts `{device, fault: "sensor"}` instead: a fault report, 202,
 * keeping it Online and counting toward Sensor fault, with no Reading written (docs/adr/0009).
 */
export function readingsRouter({ pool, config, sse, ingest, listening, rotation, sightings, deviceAuth }: RouteDeps): Router {
  const router = Router();
  const rules = conditionRules(config);

  // A Device reports every Report interval, so a healthy one never approaches this. The key is the
  // hostname, not the address: every Device on a campus can sit behind one NAT, and one address's
  // twelve boards must not share one allowance. Only requests carrying a Device token (either, during a rotation) get this far.
  // Windows on the monotonic clock: a host clock step must not lock a Device out for its length.
  const writeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    store: new MonotonicStore(),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const device = (req.body as Record<string, unknown> | undefined)?.device;
      return typeof device === 'string' && device.trim() !== '' ? normaliseHostname(device) : ipKeyGenerator(req.ip ?? '');
    },
    message: { error: 'Too many Readings from this Device, please try again later.' },
    validate: false,
  });

  router.post('/', ...deviceAuth, writeLimiter, async (req, res, next) => {
    const parsed = parseReading(req.body);
    if ('error' in parsed) {
      res.status(422).json({ error: parsed.error });
      return;
    }
    const { hostname } = parsed;
    // Null for a fault report: the sensor did not answer, so there is nothing to record.
    const values = 'fault' in parsed ? null : { tempF: parsed.tempF, humidity: parsed.humidity };
    const info = parseDeviceInfo(req.body);
    // To the millisecond, unlike the Reading's own time: a staged release tells a report from the download just after it.
    const arrivedAt = new Date();
    try {
      // The report and what it does to the Device's incidents commit together, under the Device's
      // row lock, so two reports of one Device are never judged at once (docs/adr/0006, 0009).
      const conn = await pool.getConnection();
      let device: DeviceIdRow | undefined;
      let recordedAt: Date;
      let sensorFaults: number;
      let cleanReports: number;
      let lastReading: TimedReading | null = null;
      let changed: ChangedIncident[];
      try {
        await conn.beginTransaction();
        const [devices] = await conn.query<DeviceIdRow[]>(
          `SELECT id, hostname, last_report_at AS lastReportAt, sensor_faults AS sensorFaults, firmware_version AS firmwareVersion,
                  firmware_clean_reports AS cleanReports, firmware_sent_at AS sentAt, update_result AS updateResult, wifi_network AS wifiNetwork
           FROM devices WHERE hostname = ? FOR UPDATE`,
          [hostname],
        );
        device = devices[0];
        if (device === undefined) {
          await conn.rollback();
          // A board with the Device token that nobody has registered: listed in Settings to be adopted.
          await notePending(pool, { hostname, reading: values, address: req.ip ?? null }).catch((error: unknown) =>
            console.error('Could not list an unregistered board:', error instanceof Error ? error.message : error),
          );
          res.status(404).json({ error: `No device is registered with the hostname ${hostname}` });
          return;
        }
        recordedAt = serverNow();
        // The database answers again: a silence before this is the server's, not the Device's (listening.ts).
        listening?.regained(recordedAt);
        if (values !== null) {
          await conn.query<ResultSetHeader>(
            'INSERT INTO readings (device_id, temp_f, humidity, recorded_at) VALUES (?, ?, ?, ?)',
            [device.id, values.tempF, values.humidity, recordedAt],
          );
        } else {
          // What the card keeps showing, and the peak a Sensor fault incident reports.
          lastReading = await latestReadingOf(conn, device.id, recordedAt);
        }
        // Either is a report, so the Device is heard from now. A Reading clears the fault count; a fault report adds one.
        sensorFaults = values === null ? device.sensorFaults + 1 : 0;
        // And a good Reading on the version of the one before counts toward a staged release's "Release to all" (rollout.ts).
        cleanReports = cleanReportsAfter(
          { version: device.firmwareVersion, cleanReports: device.cleanReports, lastReportAt: device.lastReportAt },
          { version: info?.firmwareVersion ?? null, reading: values !== null, at: recordedAt },
          config.reportIntervalSeconds,
        );
        await conn.query('UPDATE devices SET last_report_at = ?, sensor_faults = ?, firmware_clean_reports = ? WHERE id = ?', [
          recordedAt,
          sensorFaults,
          cleanReports,
          device.id,
        ]);
        // What the board says about itself (firmware 3 and later), kept beside the Device for the Firmware
        // tab, its sensor (firmware 6) for History too, and its network (firmware 7) for the card's note.
        // A signal under WEAK_SIGNAL_DBM keeps when it fell there, for Settings, System; a better one, or none, clears it.
        if (info !== null) {
          await conn.query(
            `UPDATE devices SET firmware_version = COALESCE(?, firmware_version), rssi = ?, uptime_s = ?, free_heap = ?,
               reset_reason = ?, update_result = ?, sensor = ?, wifi_ssid = ?, wifi_network = ?, info_at = ?,
               weak_signal_since = IF(? < ?, COALESCE(weak_signal_since, ?), NULL) WHERE id = ?`,
            [
              info.firmwareVersion, info.rssi, info.uptimeSeconds, info.freeHeap, info.resetReason, info.updateResult, info.sensor,
              info.ssid, info.network, recordedAt, info.rssi, WEAK_SIGNAL_DBM, recordedAt, device.id,
            ],
          );
        }
        changed =
          values === null
            ? await recordFaultIncidents(conn, device.id, { at: recordedAt, sensorFaults }, lastReading, device.lastReportAt, rules, listening?.since())
            : await recordReadingIncidents(conn, device.id, { ...values, recordedAt }, device.lastReportAt, rules, listening?.since());
        // Queued with the change it reports, so neither commits without the other (docs/adr/0008).
        if (config.notifications !== undefined) await enqueueNotifications(conn, changed, recordedAt);
        await conn.commit();
      } catch (error) {
        await conn.rollback();
        throw error;
      } finally {
        conn.release();
      }
      // Only a Reading proves the readings table takes writes (ingestHealth.ts); a fault report wrote none.
      if (values !== null) ingest.succeeded();
      // Only for a registered Device, so neither the log nor the list can be filled with made-up hostnames.
      rotation.heard(device.hostname, deviceTokenOf(res));
      sightings.accepted(device.hostname);
      const release = await cachedRelease(pool).catch(() => null);
      // One of a staged release's named Devices failing it holds the release, before this answer could
      // nudge anyone toward it. Its own failure never costs the board its report.
      const held = await holdOnReport(
        pool,
        release,
        {
          hostname: device.hostname,
          sentAt: device.sentAt,
          version: info?.firmwareVersion ?? device.firmwareVersion,
          updateResult: info?.updateResult ?? null,
          arrivedAt,
          incidentsChanged: changed.length > 0,
        },
        recordedAt,
        config.notifications !== undefined,
      ).catch((error: unknown) => {
        console.error('firmware: could not check the staged release:', error instanceof Error ? error.message : error);
        return null;
      });
      // A newer build waiting for this board: said in a header, so the board checks for it now instead
      // of at its hourly check. Only for a board that says its version, the firmware that can act on it.
      // A board with a dead sensor gets it too: it can still be updated.
      if (info?.firmwareVersion != null && held === null && release !== null && offers(release, device.hostname, info.firmwareVersion)) {
        res.set('X-Firmware-Available', String(release.version));
      }
      const reportedAt = recordedAt.toISOString();
      // The network as the server now holds it: this report's, or the last one a board said (older firmware says none).
      const fallback = onFallbackNetwork(info === null ? device.wifiNetwork : info.network);
      if (values === null) {
        // 202: heard, and nothing created.
        res.status(202).json({ device: device.hostname, fault: 'sensor' });
        // Heard from just now; the last good Reading is judged only until the count reaches a Sensor fault.
        const conditions = conditionsFor({ reading: lastReading, secondsSinceReport: 0, sensorFaults, ...rules });
        sse.broadcast({
          type: 'fault',
          device: device.hostname,
          fault: 'sensor',
          online: !isOffline(conditions),
          conditions,
          lastReportAt: reportedAt,
          onFallbackNetwork: fallback,
        });
      } else {
        const reading: ReadingPayload = { ...values, recordedAt: reportedAt };
        res.status(201).json({ device: device.hostname, reading });
        // It just arrived, so it is zero seconds old: the Conditions are those of the Reading alone.
        const conditions = conditionsFor({ reading: values, secondsSinceReport: 0, ...rules });
        sse.broadcast({
          type: 'reading',
          device: device.hostname,
          reading,
          online: !isOffline(conditions),
          conditions,
          lastReportAt: reportedAt,
          onFallbackNetwork: fallback,
        });
      }
      // An open Firmware tab reads the status again when the hold, or this report, moved what it shows (rollout.ts).
      const offered = release !== null && (release.only === null || release.only.includes(device.hostname));
      const before = { version: device.firmwareVersion, updateResult: device.updateResult, cleanReports: device.cleanReports };
      const after = { version: info?.firmwareVersion ?? device.firmwareVersion, updateResult: info === null ? device.updateResult : info.updateResult, cleanReports };
      if (held !== null || reportMovesRollout(before, after, offered)) sse.firmwareChanged();
      await broadcastIncidentChanges(pool, sse, changed);
    } catch (error) {
      // Only before the 201 or 202: a failed broadcast afterwards is not a report lost.
      if (!res.headersSent) {
        ingest.failed();
        listening?.lost();
      }
      next(error);
    }
  });

  return router;
}

interface DashboardRow extends RowDataPacket {
  id: number;
  hostname: string;
  closet: string;
  campusId: number;
  campusName: string;
  campusShortcode: string;
  tempF: number | null;
  humidity: number | null;
  recordedAt: Date | null;
  lastReportAt: Date | null;
  sensorFaults: number;
  wifiNetwork: number | null;
}

/** Every Device with its latest Reading, in one statement: one step back along the index per Device (latestReading.ts). */
const SELECT_DASHBOARD = `
  SELECT d.id, d.hostname, d.closet,
         c.id AS campusId, c.name AS campusName, c.shortcode AS campusShortcode,
         r.temp_f AS tempF, r.humidity, r.recorded_at AS recordedAt,
         d.last_report_at AS lastReportAt, d.sensor_faults AS sensorFaults, d.wifi_network AS wifiNetwork
  FROM devices d
  JOIN campuses c ON c.id = d.campus_id
  LEFT JOIN readings r ON r.id = (${LATEST_READING_ID})`;
const ORDER_DASHBOARD = 'ORDER BY c.name, d.closet, d.hostname';

/** Whole seconds from `then` to `now` by the server's clock, never negative; null with no `then`. */
const secondsSince = (then: Date | null, now: Date): number | null =>
  then === null ? null : Math.max(0, Math.floor((now.getTime() - then.getTime()) / 1000));

function toDashboardDevice(row: DashboardRow, now: Date, rules: ConditionRules, sightings: DeviceSightings, openIncidents: OpenIncidentPayload[]) {
  const { id, hostname, closet, campusId, campusName, campusShortcode, tempF, humidity, recordedAt, sensorFaults } = row;
  const latest = recordedAt === null || tempF === null ? null : { tempF, humidity, recordedAt };
  const secondsSinceReading = secondsSince(latest?.recordedAt ?? null, now);
  const reportedAt = lastReportAt(row.lastReportAt, latest?.recordedAt ?? null, now);
  const secondsSinceReport = secondsSince(reportedAt, now);
  const conditions = conditionsFor({ reading: latest, secondsSinceReport, sensorFaults, ...rules });
  return {
    id,
    hostname,
    campus: { id: campusId, name: campusName, shortcode: campusShortcode },
    closet,
    closetType: closetType(closet),
    latestReading: latest === null ? null : ({ ...latest, recordedAt: latest.recordedAt.toISOString() } satisfies ReadingPayload),
    online: !isOffline(conditions),
    secondsSinceReading,
    /** When the board last reported, a Reading or a fault report (docs/adr/0009); Online and Offline count from it. */
    lastReportAt: reportedAt?.toISOString() ?? null,
    /** By the server's clock, so the browser ages it from when it fetched, never against its own clock. */
    secondsSinceReport,
    /** Worst first; the browser renders these and computes none of its own. */
    conditions,
    /** When the board was last refused for its Device token, within the last 15 minutes; null otherwise. */
    tokenMismatchAt: sightings.mismatchedAt(hostname)?.toISOString() ?? null,
    /** Its incidents still open, oldest first, each with who acknowledged it: the card says who is on them. */
    openIncidents,
    /** The board said it is on its fallback network (firmware 7): a note on its card, never a Condition. Not its name: that is for the Admin. */
    onFallbackNetwork: onFallbackNetwork(row.wifiNetwork),
  };
}

/** How the Dashboard lists its Devices: worst first (the default), or by Campus name then closet. */
const DASHBOARD_ORDERS = ['worst', 'campus'] as const;
type DashboardOrder = (typeof DASHBOARD_ORDERS)[number];

const isDashboardOrder = (value: string): value is DashboardOrder => (DASHBOARD_ORDERS as readonly string[]).includes(value);

/** A Device's place in the worst-first order: its worst level's rank (Offline counts at warning), none after moderate. */
const severity = (conditions: Condition[]): number => {
  const worst = worstLevel(conditions);
  return worst === null ? LEVELS_WORST_FIRST.length : LEVELS_WORST_FIRST.indexOf(worst);
};

/**
 * Dashboard (GET /api/dashboard?campus=SHORTCODE&order=worst|campus) and its live stream
 * (GET /api/dashboard/stream), which carries every Reading as it is ingested.
 */
export function dashboardRouter({ pool, config, sse, sightings, now = () => new Date() }: RouteDeps): Router {
  const router = Router();
  const { reportIntervalSeconds, thresholds } = config;
  const rules = conditionRules(config);

  router.get('/stream', sse.handler);

  router.get('/', async (req, res, next) => {
    const order = typeof req.query.order === 'string' && req.query.order.trim() !== '' ? req.query.order.trim() : 'worst';
    if (!isDashboardOrder(order)) {
      res.status(422).json({ error: `order must be one of ${DASHBOARD_ORDERS.join(', ')}, got ${order}` });
      return;
    }
    const campus = typeof req.query.campus === 'string' ? req.query.campus.trim() : '';
    // Shortcodes match in any case, as the old filter did.
    const [where, params] = campus === '' ? ['', []] : ['WHERE LOWER(c.shortcode) = LOWER(?)', [campus]];
    try {
      const at = now();
      const [rows] = await pool.query<DashboardRow[]>(`${SELECT_DASHBOARD} ${where} ${ORDER_DASHBOARD}`, [latestAllowed(at), ...params]);
      const open = await openIncidentsByDevice(pool);
      const devices = rows.map((row) => toDashboardDevice(row, at, rules, sightings, open.get(row.id) ?? []));
      // Array sort is stable, so Devices at the same level keep the Campus and closet order of the query.
      if (order === 'worst') devices.sort((a, b) => severity(a.conditions) - severity(b.conditions));
      res.json({
        reportIntervalSeconds,
        offlineAfterSeconds: offlineAfterSeconds(reportIntervalSeconds, thresholds),
        devices,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

interface HistoryReadingRow extends RowDataPacket {
  tempF: number;
  humidity: number | null;
  recordedAt: Date;
}

interface DaySummary {
  min: number;
  max: number;
  /** To one decimal place: the table holds whole numbers, so more would be noise. */
  avg: number;
}

/** Min, max, and average of the values, or null when there are none (an empty day, or a day with no humidity). */
function summarise(values: number[]): DaySummary | null {
  if (values.length === 0) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  return { min: Math.min(...values), max: Math.max(...values), avg: Math.round((sum / values.length) * 10) / 10 };
}

/**
 * Most Readings one History response carries (docs/adr/0004: a date range and a row limit).
 * A 25-hour day at the ingest limit of 20 a minute is 30,000, so only rows the ingest route
 * never wrote (a test board) can pass it. Past it the day's first Readings
 * are sent and `truncated` says so; the summary covers what was sent.
 */
export const HISTORY_ROW_LIMIT = 30_000;

/** The day asked for by `?date=` and `?tz=`, or the message explaining why there is none. */
function parseDay(query: Request['query'], now: Date): LocalDay | { error: string } {
  const tz = typeof query.tz === 'string' && query.tz.trim() !== '' ? query.tz.trim() : serverTimeZone();
  if (!isTimeZone(tz)) return { error: `Unknown time zone ${tz}; use an IANA name like America/Chicago` };
  const date = typeof query.date === 'string' && query.date.trim() !== '' ? query.date.trim() : todayIn(now, tz);
  const day = localDay(date, tz);
  if (day === undefined) return { error: `The date must be a real day written YYYY-MM-DD, got ${date}` };
  return day;
}

/**
 * One Device's history (mounted at /api/devices/:id/history).
 * GET returns one local day of Readings with the day's numbers; never more than a day or
 * HISTORY_ROW_LIMIT rows, so the page stays fast however long the Device has been reporting.
 * DELETE resets the Device's whole history, with the Admin token.
 */
export function historyRouter({ pool, config, now = () => new Date() }: RouteDeps): Router {
  // mergeParams: the Device id is in the mount path, not this router's own, so it is untyped here.
  const router = Router({ mergeParams: true });
  const deviceIdOf = (req: Request): string => (req.params as { id?: string }).id ?? '';

  const findDevice = async (rawId: string): Promise<DeviceRow | undefined> => {
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) return undefined;
    const [rows] = await pool.query<DeviceRow[]>(`${SELECT_DEVICES} WHERE d.id = ?`, [id]);
    return rows[0];
  };

  router.get('/', async (req, res, next) => {
    const day = parseDay(req.query, now());
    if ('error' in day) {
      res.status(422).json({ error: day.error });
      return;
    }
    try {
      const device = await findDevice(deviceIdOf(req));
      if (device === undefined) {
        res.status(404).json({ error: 'Device not found' });
        return;
      }
      const [rows] = await pool.query<HistoryReadingRow[]>(
        `SELECT temp_f AS tempF, humidity, recorded_at AS recordedAt
         FROM readings
         WHERE device_id = ? AND recorded_at >= ? AND recorded_at < ?
         ORDER BY recorded_at, id
         LIMIT ?`,
        // One past the limit, to tell a day that fits from one that does not.
        [device.id, day.from, day.to, HISTORY_ROW_LIMIT + 1],
      );
      const truncated = rows.length > HISTORY_ROW_LIMIT;
      const readings: ReadingPayload[] = rows.slice(0, HISTORY_ROW_LIMIT).map(({ tempF, humidity, recordedAt }) => ({ tempF, humidity, recordedAt: recordedAt.toISOString() }));
      res.json({
        // The sensor its board last named (firmware 6), so the day's Readings are read with its accuracy in mind.
        device: { ...toDevice(device), closetType: closetType(device.closet), sensor: device.sensor },
        date: day.date,
        timeZone: day.timeZone,
        from: day.from.toISOString(),
        to: day.to.toISOString(),
        readings,
        truncated,
        // How far back Readings go, so the CSV download offers no longer a range than it would take.
        retentionDays: config.retentionDays,
        summary: {
          tempF: summarise(readings.map((r) => r.tempF)),
          humidity: summarise(readings.flatMap((r) => (r.humidity === null ? [] : [r.humidity]))),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/', requireAdminToken(config), async (req, res, next) => {
    try {
      const device = await findDevice(deviceIdOf(req));
      if (device === undefined) {
        res.status(404).json({ error: 'Device not found' });
        return;
      }
      // An incident points at Readings that are gone, so it goes too: both together, under the
      // Device's row lock, so a Reading landing meanwhile cannot open an incident between them.
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await conn.query('SELECT id FROM devices WHERE id = ? FOR UPDATE', [device.id]);
        await conn.query<ResultSetHeader>('DELETE FROM readings WHERE device_id = ?', [device.id]);
        await deleteDeviceIncidents(conn, device.id);
        await conn.commit();
      } catch (error) {
        await conn.rollback();
        throw error;
      } finally {
        conn.release();
      }
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
