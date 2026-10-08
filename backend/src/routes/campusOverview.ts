import { Router, type Request } from 'express';
import type { RowDataPacket } from 'mysql2/promise';
import type { RouteDeps } from '../deps';
import { closetType } from '../closet';
import { conditionsFor, isOffline, LEVELS_WORST_FIRST, worstLevel, type Condition, type ConditionLevel, type ConditionName } from '../conditions';
import { isTimeZone, localDay, serverTimeZone, todayIn, type LocalDay } from '../localDay';
import type { ReadingPayload } from '../sse';
import { LATEST_READING_ID, lastReportAt, latestAllowed } from '../latestReading';

/** How many local days the overview's chart covers, today (partial) included. */
export const OVERVIEW_DAYS = 7;
const DAY_MS = 86_400_000;

interface CampusRow extends RowDataPacket {
  id: number;
  name: string;
  shortcode: string;
}

interface DeviceRow extends RowDataPacket {
  id: number;
  hostname: string;
  closet: string;
  campusId: number;
  tempF: number | null;
  humidity: number | null;
  recordedAt: Date | null;
  lastReportAt: Date | null;
  sensorFaults: number;
}

interface DayMaxRow extends RowDataPacket {
  deviceId: number;
  day: number;
  maxTempF: number;
}

interface IncidentSpanRow extends RowDataPacket {
  campusId: number;
  /** A stretch of an incident at one level: its segment. */
  level: ConditionLevel;
  startedAt: Date;
  endedAt: Date | null;
}

interface LastIncidentRow extends RowDataPacket {
  campusId: number;
  lastEnd: Date | null;
  openSince: Date | null;
}

/** Every Device with its latest Reading, one step back along the index each (latestReading.ts). */
const SELECT_DEVICES = `
  SELECT d.id, d.hostname, d.closet, d.campus_id AS campusId,
         r.temp_f AS tempF, r.humidity, r.recorded_at AS recordedAt,
         d.last_report_at AS lastReportAt, d.sensor_faults AS sensorFaults
  FROM devices d
  LEFT JOIN readings r ON r.id = (${LATEST_READING_ID})
  ORDER BY d.closet, d.hostname`;

/**
 * Each Device's highest temperature on each of the days, in one statement, or null when there are
 * no Devices. The Devices are named, not joined: MySQL runs a join on device_id as a lookup over
 * each Device's whole history, filtered row by row, where an IN list is one range of the index per
 * Device. The index carries temp_f, so no row is read: 0.75 s for a week of 100 Devices at 26 M
 * Readings, against 5.6 s joined on the old index, and 30 ms for today against 2.6 s
 * (.scratch/prodtest/load.md, B1). The CASE puts each Reading in its day, whose bounds are the
 * zone's midnights, so a day the clocks change on is cut where it should be. `first` is the index
 * the first of `days` has in the overview's seven; `until`, if earlier, ends the last day early.
 */
export function selectDayMaxima(deviceIds: number[], days: LocalDay[], first: number, until?: Date): { sql: string; params: unknown[] } | null {
  if (deviceIds.length === 0) return null;
  const cases = days.slice(0, -1).map((_, i) => `WHEN r.recorded_at < ? THEN ${first + i}`);
  const day = cases.length === 0 ? `${first}` : `CASE ${cases.join(' ')} ELSE ${first + days.length - 1} END`;
  const to = days[days.length - 1].to;
  return {
    sql: `
      SELECT r.device_id AS deviceId, ${day} AS day, MAX(r.temp_f) AS maxTempF
      FROM readings r FORCE INDEX (ix_readings_device_recorded_temp)
      WHERE r.device_id IN (?) AND r.recorded_at >= ? AND r.recorded_at < ?
      GROUP BY r.device_id, day`,
    params: [...days.slice(0, -1).map((d) => d.to), deviceIds, days[0].from, until !== undefined && until < to ? until : to],
  };
}

/**
 * How long the completed days' maxima are reused. A week of Readings is most of what the overview
 * reads (about 20,000 a Device), and a finished day only changes when a history is reset or rows
 * are written straight to the table (the demo's backfill), so a few minutes stale
 * is the price of not reading them on every request. Today is always read fresh.
 */
export const PAST_DAYS_CACHE_MS = 5 * 60_000;

/** How many zones' completed days are kept at once; a district's browsers share one or two. */
export const PAST_DAYS_CACHE_ZONES = 8;

/** The dates, YYYY-MM-DD, of the `count` days ending with `today`, oldest first. */
function lastDates(today: string, count: number): string[] {
  const [year, month, day] = today.split('-').map(Number);
  return Array.from({ length: count }, (_, i) => new Date(Date.UTC(year, month - 1, day - (count - 1 - i))).toISOString().slice(0, 10));
}

/** The zone asked for by `?tz=`, the server's own by default, or the message explaining why it is not one. */
function parseZone(query: Request['query']): string | { error: string } {
  const tz = typeof query.tz === 'string' && query.tz.trim() !== '' ? query.tz.trim() : serverTimeZone();
  return isTimeZone(tz) ? tz : { error: `Unknown time zone ${tz}; use an IANA name like America/Chicago` };
}

/** The largest of the values, or null when there are none. */
const highest = (values: number[]): number | null => (values.length === 0 ? null : Math.max(...values));

/** A level's place in the worst-first order; none sorts after moderate. */
const rankOf = (level: ConditionLevel | null): number => (level === null ? LEVELS_WORST_FIRST.length : LEVELS_WORST_FIRST.indexOf(level));

/** An incident is a Condition at warning or worse (docs/adr/0006); moderate is a heads-up. */
const atWarningOrWorse = (level: ConditionLevel): boolean => rankOf(level) <= rankOf('warning');

interface ConditionCount {
  name: ConditionName;
  level: ConditionLevel;
  count: number;
}

/** How many Devices are in each Condition at each level, worst first, ties in the Conditions module's order. */
function countConditions(conditions: Condition[]): ConditionCount[] {
  const counts: ConditionCount[] = [];
  for (const { name, level } of conditions) {
    const found = counts.find((c) => c.name === name && c.level === level);
    if (found === undefined) counts.push({ name, level, count: 1 });
    else found.count += 1;
  }
  return counts.sort((a, b) => rankOf(a.level) - rankOf(b.level));
}

/**
 * Campus overview (GET /api/campuses/overview?tz=America/Chicago), for IT leadership: every
 * Campus, worst first, with what its closets are in now, its worst closet, each of the last
 * seven local days' highest temperature and whether an incident touched it, and its last
 * incident. Public, like the dashboard. A fixed handful of statements, however many Campuses.
 */
export function campusOverviewRouter({ pool, config, now = () => new Date() }: RouteDeps): Router {
  const router = Router();
  const { reportIntervalSeconds, thresholds, retentionDays } = config;
  const rules = { reportIntervalSeconds, thresholds };
  /**
   * The completed days' maxima per zone and first date, with when they were read. The read itself
   * is kept, not its rows, so every page that misses together (each open Campuses page once the
   * cache ages out) waits on one statement instead of running its own.
   */
  const pastDays = new Map<string, { readAt: number; rows: Promise<DayMaxRow[]> }>();

  const query = async (statement: ReturnType<typeof selectDayMaxima>): Promise<DayMaxRow[]> =>
    statement === null ? [] : (await pool.query<DayMaxRow[]>(statement.sql, statement.params))[0];

  const pastDayMaxima = (deviceIds: number[], days: LocalDay[], at: Date): Promise<DayMaxRow[]> => {
    const key = `${days[0].timeZone}|${days[0].date}`;
    const cached = pastDays.get(key);
    // A clock stepped back makes the age negative: read again rather than keep the rows for the length of the step.
    const age = cached === undefined ? -1 : at.getTime() - cached.readAt;
    if (cached !== undefined && age >= 0 && age < PAST_DAYS_CACHE_MS) return cached.rows;
    const rows = query(selectDayMaxima(deviceIds, days, 0));
    // One entry per zone in use; yesterday's keys go once today's arrive.
    for (const old of pastDays.keys()) if (old.startsWith(`${days[0].timeZone}|`)) pastDays.delete(old);
    // The endpoint is public and takes any zone: a handful of zones are kept, the oldest read going first.
    if (pastDays.size >= PAST_DAYS_CACHE_ZONES) pastDays.delete(pastDays.keys().next().value as string);
    const entry = { readAt: at.getTime(), rows };
    pastDays.set(key, entry);
    // A failed read is not kept: the next request tries again.
    rows.catch(() => {
      if (pastDays.get(key) === entry) pastDays.delete(key);
    });
    return rows;
  };

  router.get('/', async (req, res, next) => {
    const timeZone = parseZone(req.query);
    if (typeof timeZone !== 'string') {
      res.status(422).json({ error: timeZone.error });
      return;
    }
    const at = now();
    const days = lastDates(todayIn(at, timeZone), OVERVIEW_DAYS).map((date) => localDay(date, timeZone) as LocalDay);
    const windowFrom = days[0].from;
    const windowTo = days[days.length - 1].to;
    const retainedFrom = new Date(at.getTime() - retentionDays * DAY_MS);
    const notAfter = latestAllowed(at);
    try {
      // The Devices first: the day maxima name them.
      const [devices] = await pool.query<DeviceRow[]>(SELECT_DEVICES, [notAfter]);
      const deviceIds = devices.map((d) => d.id);
      const [[campuses], past, todays, [spans], [lasts]] = await Promise.all([
        pool.query<CampusRow[]>('SELECT id, name, shortcode FROM campuses ORDER BY name'),
        pastDayMaxima(deviceIds, days.slice(0, -1), at),
        query(selectDayMaxima(deviceIds, days.slice(-1), days.length - 1, notAfter)),
        pool.query<IncidentSpanRow[]>(
          // Segments, not whole incidents, so a day is marked with the level it saw, not one reached on another day.
          `SELECT d.campus_id AS campusId, s.level, s.started_at AS startedAt, s.ended_at AS endedAt
           FROM incidents i
           JOIN devices d ON d.id = i.device_id
           JOIN incident_segments s ON s.incident_id = i.id
           WHERE i.started_at < ? AND (i.ended_at IS NULL OR i.ended_at > ?)
             AND s.started_at < ? AND (s.ended_at IS NULL OR s.ended_at > ?)`,
          [windowTo, windowFrom, windowTo, windowFrom],
        ),
        pool.query<LastIncidentRow[]>(
          `SELECT d.campus_id AS campusId, MAX(i.ended_at) AS lastEnd, MIN(CASE WHEN i.ended_at IS NULL THEN i.started_at END) AS openSince
           FROM incidents i JOIN devices d ON d.id = i.device_id
           WHERE i.ended_at IS NULL OR i.ended_at >= ?
           GROUP BY d.campus_id`,
          [retainedFrom],
        ),
      ]);
      const dayMaxima = [...past, ...todays];

      const overview = campuses.map(({ id, name, shortcode }) => {
        const closets = devices
          .filter((d) => d.campusId === id)
          .map((d) => {
            const latest = d.recordedAt === null || d.tempF === null ? null : { tempF: d.tempF, humidity: d.humidity, recordedAt: d.recordedAt };
            const secondsSinceReading = latest === null ? null : Math.max(0, Math.floor((at.getTime() - latest.recordedAt.getTime()) / 1000));
            // Online and Sensor fault from the Device's reports, as the dashboard judges them (docs/adr/0009).
            const reportedAt = lastReportAt(d.lastReportAt, latest?.recordedAt ?? null, at);
            const secondsSinceReport = reportedAt === null ? null : Math.max(0, Math.floor((at.getTime() - reportedAt.getTime()) / 1000));
            const conditions = conditionsFor({ reading: latest, secondsSinceReport, sensorFaults: d.sensorFaults, ...rules });
            return { row: d, latest, secondsSinceReading, conditions, level: worstLevel(conditions) };
          });
        // Array sort is stable, so closets at the same level keep the query's closet order.
        const worst = [...closets].sort((a, b) => rankOf(a.level) - rankOf(b.level))[0];
        const all = closets.flatMap((c) => c.conditions);
        const last = lasts.find((l) => l.campusId === id);
        const campusSpans = spans.filter((s) => s.campusId === id);
        return {
          id,
          name,
          shortcode,
          closets: closets.length,
          level: worst?.level ?? null,
          now: {
            /** Each Condition at warning or worse, with how many closets are in it. */
            conditions: countConditions(all.filter((c) => atWarningOrWorse(c.level))),
            /** Moderate Mold risk: worth knowing, never an incident. */
            headsUp: countConditions(all.filter((c) => !atWarningOrWorse(c.level))),
          },
          worst:
            worst === undefined
              ? null
              : {
                  id: worst.row.id,
                  hostname: worst.row.hostname,
                  closet: worst.row.closet,
                  closetType: closetType(worst.row.closet),
                  latestReading: worst.latest === null ? null : ({ ...worst.latest, recordedAt: worst.latest.recordedAt.toISOString() } satisfies ReadingPayload),
                  level: worst.level,
                  offline: isOffline(worst.conditions),
                  /** By the server's clock, so the browser ages it from when it fetched, never against its own clock. */
                  secondsSinceReading: worst.secondsSinceReading,
                  conditions: worst.conditions,
                },
          days: days.map((day, i) => {
            const touched = campusSpans.filter((s) => s.startedAt < day.to && (s.endedAt === null || s.endedAt > day.from));
            return {
              date: day.date,
              from: day.from.toISOString(),
              to: day.to.toISOString(),
              /** Today is still going: its high so far. */
              partial: i === days.length - 1,
              maxTempF: highest(dayMaxima.filter((m) => Number(m.day) === i && closets.some((c) => c.row.id === m.deviceId)).map((m) => m.maxTempF)),
              incident: touched.length > 0,
              /** The worst level an incident reached that day, so the chart colours the day by the One Meaning Rule. */
              incidentLevel: touched.reduce<ConditionLevel | null>((worst, s) => (rankOf(s.level) < rankOf(worst) ? s.level : worst), null),
            };
          }),
          lastIncident:
            last === undefined
              ? null
              : last.openSince !== null
                ? { ongoing: true, start: last.openSince.toISOString() }
                : last.lastEnd !== null
                  ? { ongoing: false, end: last.lastEnd.toISOString() }
                  : null,
        };
      });
      // Worst first by the Campus's worst closet now, then by name (the query's order; the sort is stable).
      overview.sort((a, b) => rankOf(a.level) - rankOf(b.level));

      res.json({
        timeZone,
        threshold: { name: 'Hot', level: 'warning', tempF: thresholds.hotWarningF },
        /** How far back Readings, and so "since last incident", reach. */
        retentionDays,
        campuses: overview,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
