#!/usr/bin/env node
/**
 * Demo mode: a living dashboard with no boards attached. The `demo` service of
 * compose.demo.yaml runs this; `deploy/deploy.sh demo` (or deploy.ps1 demo) starts it.
 *
 *  1. Seeds Campuses and Devices through the API with the Admin token, as an Admin would in
 *     Settings. Anything already there is left alone, so a restart is safe.
 *  2. Backfills seven days of history per Device. The API stamps every Reading with the server's
 *     own clock and has no backfill route (nor should it), so these rows go straight into the
 *     `readings` table (backend/src/migrations/0001-initial-schema.ts) over a MySQL connection.
 *     The scripted closets had a bad hour or two during the week, the silent one a power cut, and
 *     the faulty one an hour of fault reports, its sensor not answering (docs/adr/0009). The
 *     incidents those reports make are found by replaying the backend's own incident rules over
 *     them (replayIncidents, docs/adr/0006, fault reports and all) and written with
 *     the backend's own insert, so the log can never disagree with the History.
 *  3. Posts a live Reading per Device every Report interval with the Device token, on a scripted
 *     loop of about ten minutes in which one closet heats up through Hot warning to Hot critical,
 *     one dries out, one sits in Mold risk moderate then high, one goes cold overnight, one goes
 *     silent (late, then Offline) and comes back, and one sends fault reports for a few minutes
 *     (Sensor fault from the third) before its sensor answers again. The rest stay calm. The api
 *     opens and closes the live incidents from these reports itself, as it would for real boards.
 *
 * The thresholds and the Report interval are the api's own: this reads the same environment
 * through the backend's loadConfig, and every target value is found by asking the backend's
 * conditionsFor which Reading lands in which Condition. No rule is repeated here.
 *
 * Deterministic from DEMO_SEED: the hostnames, the noise, and the loop are the same each run.
 *
 * Environment: everything the api reads (DB_*, ADMIN_TOKEN, DEVICE_TOKEN, thresholds), plus
 *   API_URL         backend origin, default http://api:3001
 *   DEMO_SEED       any string, default "closets"
 *   DEMO_TIME_ZONE  IANA zone the closets' days follow, default the container's own
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let backend;
try {
  backend = {
    ...require('../dist/config.js'),
    ...require('../dist/conditions.js'),
    ...require('../dist/incidents.js'),
    ...require('../dist/incidentStore.js'),
  };
} catch {
  console.error('demo: needs the built backend (dist/); run `npm run build` first, or use the demo service');
  process.exit(1);
}
const { loadConfig, conditionsFor, replayIncidents, insertIncident } = backend;
const mysql = require('mysql2/promise');

const config = loadConfig(process.env);
const { thresholds, reportIntervalSeconds: interval } = config;
const API = (process.env.API_URL ?? 'http://api:3001').replace(/\/$/, '');
const SEED = process.env.DEMO_SEED ?? 'closets';
const TIME_ZONE = process.env.DEMO_TIME_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
const HISTORY_DAYS = 7;
/** The script below is written for ten minutes; a long Report interval stretches it. */
const LOOP_SECONDS = Math.max(600, 20 * interval);
const scale = LOOP_SECONDS / 600;

const log = (...parts) => console.log('demo:', ...parts);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));

// --- deterministic randomness ------------------------------------------------------------
/** A 32-bit hash of the seed and the keys, so the same question always gets the same answer. */
function hash(...keys) {
  let h = 2166136261;
  for (const ch of [SEED, ...keys].join('|')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  return h >>> 0;
}
/** In [-1, 1). */
const noise = (...keys) => hash(...keys) / 2 ** 31 - 1;
/** A seeded sequence in [0, 1), for the backfill's long runs. */
function sequence(...keys) {
  let a = hash(...keys);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

// --- the district ------------------------------------------------------------------------
// Fictional schools. Closets are named the way CONTEXT.md describes: role and number, with
// the wing in brackets. `scenario` marks the six closets the loop scripts.
const CAMPUSES = [
  {
    name: 'Riverside High School',
    shortcode: 'RHS',
    closets: ['MDF', 'IDF 1 (Main Office)', 'IDF 2 (Library)', 'IDF 3 (Gym)', 'IDF 4 (Science Wing)', 'IDF 5 (Fine Arts)', 'IDF 6 (Field House)', 'IDF 7 (Portables)'],
  },
  {
    name: 'Cedar Ridge Middle School',
    shortcode: 'CRMS',
    closets: ['MDF', 'IDF 1 (Cafeteria)', 'IDF 2 (A Hall)', 'IDF 3 (B Hall)', 'IDF 4 (Band Hall)', 'IDF 5 (Gym)'],
  },
  {
    name: 'Willow Creek Elementary',
    shortcode: 'WCE',
    closets: ['MDF', 'IDF 1 (Front Office)', 'IDF 2 (Kinder Wing)', 'IDF 3 (Library)', 'IDF 4 (Annex)'],
  },
  {
    name: 'Northgate Career Center',
    shortcode: 'NGCC',
    closets: ['MDF', 'IDF 1 (Auto Shop)', 'IDF 2 (Culinary)', 'IDF 3 (Health Science)', 'IDF 4 (Welding Bay)'],
  },
];
const SCENARIO_CLOSETS = {
  'RHS/IDF 3 (Gym)': 'hot',
  'WCE/IDF 4 (Annex)': 'dry',
  'CRMS/IDF 1 (Cafeteria)': 'mold',
  'RHS/IDF 7 (Portables)': 'cold',
  'NGCC/IDF 1 (Auto Shop)': 'silent',
  'CRMS/IDF 4 (Band Hall)': 'fault',
};

/** Each closet's character: where it sits and how far it swings over a day. */
function closetModel(campus, closet, index) {
  const scenario = SCENARIO_CLOSETS[`${campus.shortcode}/${closet}`] ?? null;
  const mdf = closet.startsWith('MDF');
  const model = {
    scenario,
    temp: (mdf ? 73 : 69.5) + noise('temp', index) * 2.5,
    humidity: 41 + noise('humidity', index) * 6,
    tempSwing: 1.5 + (noise('swing', index) + 1) * 1.2,
    humiditySwing: 3 + (noise('hswing', index) + 1) * 2,
    weekendF: 1 + (noise('weekend', index) + 1),
    phase: (noise('phase', index) + 1) * Math.PI,
  };
  // Their weeks look like their troubles, short of tripping anything.
  if (scenario === 'hot') Object.assign(model, { temp: 75, tempSwing: 3, weekendF: 1.5 });
  if (scenario === 'dry') Object.assign(model, { humidity: 28, humiditySwing: 4 });
  if (scenario === 'mold') Object.assign(model, { temp: 73, humidity: 52, humiditySwing: 5 });
  if (scenario === 'cold') Object.assign(model, { temp: 63, tempSwing: 5, weekendF: -1 });
  return model;
}

/** ESP_ plus six hex digits, from the seed, unique across the district. */
function hostnames(count) {
  const names = new Set();
  for (let i = 0; names.size < count; i++) {
    names.add(`ESP_${(hash('hostname', i) & 0xffffff).toString(16).toUpperCase().padStart(6, '0')}`);
  }
  return [...names];
}

const DISTRICT = (() => {
  const all = CAMPUSES.flatMap((campus) => campus.closets.map((closet) => ({ campus, closet })));
  const names = hostnames(all.length);
  return all.map(({ campus, closet }, index) => ({ hostname: names[index], campus, closet, index, ...closetModel(campus, closet, index) }));
})();

// --- the closets' days -------------------------------------------------------------------
const clockFormat = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: 'numeric', weekday: 'short', hourCycle: 'h23' });
const clockCache = new Map();
/** Local hour (fractional) and whether it is a weekend, cached per minute. */
function localClock(ms) {
  const minute = Math.floor(ms / 60000);
  let clock = clockCache.get(minute);
  if (clock === undefined) {
    const parts = Object.fromEntries(clockFormat.formatToParts(new Date(minute * 60000)).map((p) => [p.type, p.value]));
    clock = { hour: Number(parts.hour) + Number(parts.minute) / 60, weekend: parts.weekday === 'Sat' || parts.weekday === 'Sun' };
    if (clockCache.size > 20000) clockCache.clear();
    clockCache.set(minute, clock);
  }
  return clock;
}

/** The closet with nothing wrong: warmest mid-afternoon, warmer at weekends when the HVAC sets back, and a slow drift of weather across days. */
function calm(device, ms) {
  const { hour, weekend } = localClock(ms);
  const day = Math.sin((2 * Math.PI * (hour - 9)) / 24);
  const weather = Math.sin((2 * Math.PI * ms) / (4.1 * 86400000) + device.phase);
  return {
    tempF: device.temp + device.tempSwing * day + (weekend ? device.weekendF : 0) + weather,
    humidity: device.humidity - device.humiditySwing * day + (weekend ? 2 : 0) + weather * 3,
  };
}

// --- Conditions, asked of the backend ----------------------------------------------------
const conditionsOf = (tempF, humidity) =>
  conditionsFor({ reading: { tempF, humidity }, secondsSinceReport: 0, reportIntervalSeconds: interval, thresholds });
const label = (conditions) => (conditions.length === 0 ? 'calm' : conditions.map((c) => `${c.name} ${c.level}`).join(', '));

/**
 * The Reading nearest `from` that is in exactly the one Condition asked for, and stays in it
 * a degree and two percent either way, so sensor noise cannot knock it out.
 */
function findReading(name, level, from) {
  const holds = (t, h) => {
    for (let dt = -1; dt <= 1; dt++) {
      for (let dh = -2; dh <= 2; dh++) {
        const c = conditionsOf(t + dt, h + dh);
        if (c.length !== 1 || c[0].name !== name || c[0].level !== level) return false;
      }
    }
    return true;
  };
  let best = null;
  for (let t = 20; t <= 120; t++) {
    for (let h = 5; h <= 95; h++) {
      const distance = Math.abs(t - from.tempF) + Math.abs(h - from.humidity) / 2;
      if ((best === null || distance < best.distance) && holds(t, h)) best = { tempF: t, humidity: h, distance };
    }
  }
  return best && { tempF: best.tempF, humidity: best.humidity };
}

/** A calm closet that would trip something (odd thresholds) is pulled back to its own middle. */
function settle(device, reading) {
  return conditionsOf(Math.round(reading.tempF), Math.round(reading.humidity)).length === 0
    ? reading
    : { tempF: device.temp, humidity: device.humidity };
}

// --- the loop ----------------------------------------------------------------------------
// Keyframes in seconds of a ten-minute loop; values between them are interpolated. 'base' is
// the closet's calm value at that moment; anything else names a target found above.
const SCRIPTS = {
  hot: [[0, 'base'], [60, 'base'], [150, 'hotWarning'], [240, 'hotWarning'], [300, 'hotCritical'], [390, 'hotCritical'], [480, 'base']],
  dry: [[0, 'base'], [120, 'base'], [210, 'dry'], [420, 'dry'], [510, 'base']],
  mold: [[0, 'base'], [30, 'base'], [90, 'moldModerate'], [240, 'moldModerate'], [300, 'moldHigh'], [450, 'moldHigh'], [540, 'base']],
  cold: [[0, 'base'], [270, 'base'], [360, 'cold'], [510, 'cold'], [570, 'base']],
};
/** The silent closet sends nothing in this window: late after one interval, Offline after three. */
const SILENT = [90, 300];
/** The faulty closet's sensor does not answer in this window: fault reports, Sensor fault from the third. */
const FAULT = [360, 570];
const TARGET_CONDITIONS = {
  hotWarning: ['Hot', 'warning'],
  hotCritical: ['Hot', 'critical'],
  dry: ['Dry', 'warning'],
  moldModerate: ['Mold risk', 'moderate'],
  moldHigh: ['Mold risk', 'high'],
  cold: ['Cold', 'warning'],
};

function resolveTargets() {
  const targets = {};
  for (const [scenario, script] of Object.entries(SCRIPTS)) {
    const device = DISTRICT.find((d) => d.scenario === scenario);
    for (const [, key] of script) {
      if (key === 'base' || key in targets) continue;
      const [name, level] = TARGET_CONDITIONS[key];
      const found = findReading(name, level, { tempF: device.temp, humidity: device.humidity });
      if (found === null) log(`no Reading lands in ${name} ${level} alone with these thresholds; ${device.closet} stays calm there`);
      targets[key] = found;
    }
  }
  return targets;
}
const TARGETS = resolveTargets();

/** What a Device reads at `ms`, `second` seconds into the loop; null while it is silent, 'fault' while its sensor does not answer. */
function liveReading(device, ms, second) {
  if (device.scenario === 'silent' && second >= SILENT[0] * scale && second < SILENT[1] * scale) return null;
  if (device.scenario === 'fault' && second >= FAULT[0] * scale && second < FAULT[1] * scale) return 'fault';
  const tick = Math.floor(second / interval);
  const base = settle(device, calm(device, ms));
  let value = base;
  const script = SCRIPTS[device.scenario];
  if (script !== undefined) {
    const at = (key) => (key === 'base' ? base : (TARGETS[key] ?? base));
    const frames = [...script, [600, 'base']].map(([s, key]) => [s * scale, at(key)]);
    const i = frames.findIndex(([s], n) => n + 1 < frames.length && second >= s && second < frames[n + 1][0]);
    const [s0, v0] = frames[i];
    const [s1, v1] = frames[i + 1];
    const f = (second - s0) / (s1 - s0);
    value = { tempF: v0.tempF + (v1.tempF - v0.tempF) * f, humidity: v0.humidity + (v1.humidity - v0.humidity) * f };
  }
  // DHT11 noise, the same each loop.
  return {
    temp: Math.round(value.tempF + noise('t', device.index, tick) * 0.3),
    humidity: Math.round(Math.min(95, Math.max(5, value.humidity + noise('h', device.index, tick) * 0.6))),
  };
}

// --- the API -----------------------------------------------------------------------------
async function api(method, path, token, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : JSON.parse(text) };
}

async function waitForApi() {
  for (let attempt = 1; ; attempt++) {
    try {
      if ((await api('GET', '/api/health')).status === 200) return;
    } catch {
      // not up yet
    }
    if (attempt === 1) log(`waiting for ${API}/api/health`);
    if (attempt > 90) throw new Error(`${API} did not answer for three minutes`);
    await sleep(2000);
  }
}

/** Campuses and Devices through the API with the Admin token. Fills in whatever is missing. */
async function seed() {
  const admin = config.adminToken;
  const campuses = (await api('GET', '/api/campuses', admin)).body;
  const ours = new Set(CAMPUSES.map((c) => c.shortcode));
  const foreign = campuses.filter((c) => !ours.has(c.shortcode));
  if (foreign.length > 0) {
    // A real install's database: the demo writes nothing into it.
    log(`this database already has Campuses the demo did not make (${foreign.map((c) => c.shortcode).join(', ')}); refusing to seed it.`);
    log('Run the demo under its own project: deploy/deploy.sh demo');
    process.exit(0);
  }
  const campusIds = new Map(campuses.map((c) => [c.shortcode, c.id]));
  for (const campus of CAMPUSES) {
    if (campusIds.has(campus.shortcode)) continue;
    const created = await api('POST', '/api/campuses', admin, { name: campus.name, shortcode: campus.shortcode });
    if (created.status !== 201) throw new Error(`adding Campus ${campus.shortcode}: ${created.status} ${JSON.stringify(created.body)}`);
    campusIds.set(campus.shortcode, created.body.id);
    log(`Campus ${campus.shortcode} (${campus.name}) added`);
  }
  const devices = new Map((await api('GET', '/api/devices', admin)).body.map((d) => [d.hostname, d.id]));
  let added = 0;
  for (const device of DISTRICT) {
    if (devices.has(device.hostname)) {
      device.id = devices.get(device.hostname);
      continue;
    }
    const body = { hostname: device.hostname, campusId: campusIds.get(device.campus.shortcode), closet: device.closet };
    const created = await api('POST', '/api/devices', admin, body);
    if (created.status !== 201) throw new Error(`adding Device ${device.hostname}: ${created.status} ${JSON.stringify(created.body)}`);
    device.id = created.body.id;
    added += 1;
  }
  log(`${CAMPUSES.length} Campuses, ${DISTRICT.length} Devices${added > 0 ? ` (${added} added)` : ', all there already'}`);
}

// --- history -----------------------------------------------------------------------------
/** The pool the api itself uses: UTC both ways, so recorded_at means the same thing. */
function openDatabase() {
  const pool = mysql.createPool({ ...config.database, connectionLimit: 2, timezone: 'Z' });
  pool.on('connection', (connection) => connection.query("SET time_zone = '+00:00'"));
  return pool;
}

/** Each Device's earliest Reading, read before the live loop starts so the backfill ends where it began. */
async function earliestReadings(pool) {
  const [rows] = await pool.query('SELECT device_id AS id, MIN(recorded_at) AS first FROM readings GROUP BY device_id');
  return new Map(rows.map((r) => [r.id, r.first]));
}

/**
 * The scripted closets' bad stretches during the week, as [days ago, hours before that moment,
 * how many hours, target]. The value eases from calm to the target, holds, and eases back, so
 * it crosses the warning line on the way up and down like a real closet would.
 */
const EPISODES = {
  hot: [[1, 4, 2.5, 'hotWarning'], [3, 5, 1.5, 'hotCritical']],
  dry: [[4, 14, 6, 'dry']],
  mold: [[2, 10, 3, 'moldHigh']],
  cold: [[5, 16, 8, 'cold']],
};
/** The faulty closet's hour without its sensor, as [days ago, hours before that moment]: a fault report every interval, no Readings. */
const FAULT_HOUR = [3, 9];

/** The closet's value at `ms`, pulled toward an episode's target while one is under way. */
function backfillValue(device, ms, until) {
  const value = calm(device, ms);
  for (const [days, before, hours, key] of EPISODES[device.scenario] ?? []) {
    const target = TARGETS[key];
    const start = until - days * 86400000 - before * 3600000;
    const f = (ms - start) / (hours * 3600000);
    if (target === null || f < 0 || f > 1) continue;
    // Steep enough that sensor noise crosses the line once or twice on the way, not for an hour.
    const pull = Math.min(1, 10 * Math.sin(Math.PI * f));
    return { tempF: value.tempF + (target.tempF - value.tempF) * pull, humidity: value.humidity + (target.humidity - value.humidity) * pull };
  }
  return value;
}

/**
 * The incidents a Device's backfilled reports make, Readings and fault reports alike, by the
 * backend's own replay (replayIncidents: ingest's rules, oldest first), written with the
 * backend's own insert. One still open at the end of the backfill is left out: the live reports
 * that follow are the api's to judge, and it never saw that one open.
 */
async function backfillIncidents(pool, device, reports) {
  const rules = { reportIntervalSeconds: interval, thresholds };
  // Oldest first: at a Report interval of a second or two, jitter can swap neighbours.
  const incidents = replayIncidents(reports.sort((a, b) => a.recordedAt - b.recordedAt), rules);
  let written = 0;
  for (const incident of incidents) {
    if (incident.end === null) continue;
    await insertIncident(pool, device.id, incident);
    written += 1;
  }
  return written;
}

/**
 * Seven days of Readings for every Device that has none older than six days, up to its first
 * live one. One every Report interval, a second or two of jitter, the odd sample lost to the
 * sensor, a lunchtime power cut two days ago for the closet that goes silent, an hour of fault
 * reports for the faulty one (FAULT_HOUR), and the scripted closets' bad stretches (EPISODES).
 * Then the incidents those reports make. A fault report writes no Reading, so the fault hour is a
 * gap in History, as it is for a real board. devices.last_report_at and sensor_faults are left to
 * the live loop, already reporting: every backfilled report is older than its first, and the
 * Readings after the fault hour cleared the count (ingest's rule) long before it.
 */
async function backfill(pool, earliest, until) {
  const step = interval * 1000;
  const start = until - HISTORY_DAYS * 86400000;
  let total = 0;
  let incidents = 0;
  const began = Date.now();
  for (const device of DISTRICT) {
    const first = earliest.get(device.id);
    if (first !== undefined && first.getTime() <= until - (HISTORY_DAYS - 1) * 86400000) continue;
    const end = first === undefined ? until : Math.min(until, first.getTime());
    const random = sequence('history', device.index);
    const gap = device.scenario === 'silent' ? [until - 2 * 86400000 - 3 * 3600000, until - 2 * 86400000 - 20 * 60000] : null;
    const faultFrom = until - FAULT_HOUR[0] * 86400000 - FAULT_HOUR[1] * 3600000;
    const faultHour = device.scenario === 'fault' ? [faultFrom, faultFrom + 3600000] : null;
    let rows = [];
    /** Everything the Device sent, as the replay takes it: a Reading, or a fault report with no values. */
    const reports = [];
    let dropped = false;
    for (let t = start; t < end; t += step) {
      const r = random();
      const jitter = Math.round((random() - 0.5) * 3000);
      if (gap !== null && t >= gap[0] && t < gap[1]) continue;
      if (faultHour !== null && t >= faultHour[0] && t < faultHour[1]) {
        reports.push({ fault: 'sensor', recordedAt: new Date(Math.floor((t + jitter) / 1000) * 1000) });
        continue;
      }
      // Never two lost in a row: with jitter, that gap can pass three intervals and read as Offline.
      if (r < 0.01 && !dropped) {
        dropped = true;
        continue;
      }
      dropped = false;
      const v = backfillValue(device, t, until);
      const temp = Math.round(v.tempF + (random() - 0.5) * 0.5);
      const humidity = Math.round(Math.min(95, Math.max(5, v.humidity + (random() - 0.5) * 1.2)));
      const recordedAt = new Date(Math.floor((t + jitter) / 1000) * 1000);
      rows.push([device.id, temp, humidity, recordedAt]);
      reports.push({ tempF: temp, humidity, recordedAt });
      if (rows.length === 2000) {
        await pool.query('INSERT INTO readings (device_id, temp_f, humidity, recorded_at) VALUES ?', [rows]);
        total += rows.length;
        rows = [];
      }
    }
    if (rows.length > 0) {
      await pool.query('INSERT INTO readings (device_id, temp_f, humidity, recorded_at) VALUES ?', [rows]);
      total += rows.length;
    }
    incidents += await backfillIncidents(pool, device, reports);
  }
  if (total === 0) log('history: every Device already has its week; nothing backfilled');
  else log(`history: ${total} Readings and ${incidents} incidents over ${HISTORY_DAYS} days written straight to MySQL in ${Math.round((Date.now() - began) / 1000)} s`);
}

// --- live --------------------------------------------------------------------------------
function startLive(startedAt) {
  const deviceToken = config.deviceToken;
  const last = new Map();
  const post = async (device) => {
    const now = Date.now();
    const second = ((now - startedAt) / 1000) % LOOP_SECONDS;
    const reading = liveReading(device, now, second);
    const where = `${device.campus.shortcode} ${device.closet}`;
    const state =
      reading === null
        ? 'silent (late, then Offline)'
        : reading === 'fault'
          ? 'fault reports (Sensor fault from the third)'
          : label(conditionsOf(reading.temp, reading.humidity));
    if (device.scenario !== null && last.get(device.hostname) !== state) {
      log(`${String(Math.floor(second)).padStart(3)} s into the loop: ${where} -> ${state}${reading === null || reading === 'fault' ? '' : ` (${reading.temp} F, ${reading.humidity} %)`}`);
    }
    last.set(device.hostname, state);
    if (reading === null) return;
    try {
      // A fault report is accepted with 202: nothing was created (docs/adr/0009).
      const body = reading === 'fault' ? { device: device.hostname, fault: 'sensor' } : { device: device.hostname, ...reading };
      const response = await api('POST', '/api/readings', deviceToken, body);
      if (response.status === 404) {
        log(`${device.hostname} (${where}) is no longer registered; adding it back`);
        await seed();
      } else if (response.status !== (reading === 'fault' ? 202 : 201)) {
        log(`${device.hostname}: report ${response.status} ${JSON.stringify(response.body)}`);
      }
    } catch (error) {
      log(`${device.hostname}: report failed (${error.cause?.code ?? error.message})`);
    }
  };
  // Boards boot at different moments, so their reports are spread across the interval.
  for (const device of DISTRICT) {
    const offset = Math.floor((device.index / DISTRICT.length) * interval * 1000);
    setTimeout(() => {
      void post(device);
      setInterval(() => void post(device), interval * 1000);
    }, offset);
  }
  log(`live: ${DISTRICT.length} Devices report every ${interval} s; the scenarios loop every ${Math.round(LOOP_SECONDS / 60)} minutes`);
  log('sign in to the site as admin / admin and choose a new password (a fresh database starts with that user)');
}

async function main() {
  log(`seed "${SEED}", closets keep ${TIME_ZONE} hours`);
  log(
    'thresholds from the backend config:',
    `Hot ${thresholds.hotWarningF}/${thresholds.hotCriticalF} F, Cold ${thresholds.coldWarningF} F, Dry ${thresholds.dryWarningPercent} %, Offline after ${thresholds.missedReportsBeforeOffline} missed reports`,
  );
  log(
    'targets:',
    Object.entries(TARGETS)
      .map(([key, v]) => `${key} ${v === null ? 'none' : `${v.tempF} F/${v.humidity} %`}`)
      .join(', '),
  );
  await waitForApi();
  await seed();
  const pool = openDatabase();
  const earliest = await earliestReadings(pool);
  const startedAt = Date.now();
  startLive(startedAt);
  await backfill(pool, earliest, startedAt);
  await pool.end();
}

main().catch((error) => {
  console.error('demo:', error);
  process.exit(1);
});
