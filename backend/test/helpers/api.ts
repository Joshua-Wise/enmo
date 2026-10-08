import type { RunningServer } from './server';
import { TEST_ADMIN_TOKEN, TEST_DEVICE_TOKEN } from './server';

export interface Campus {
  id: number;
  name: string;
  shortcode: string;
}

export interface Device {
  id: number;
  hostname: string;
  closet: string;
  campus: Campus;
}

export interface Reading {
  tempF: number;
  humidity: number | null;
  recordedAt: string;
}

export interface RecordedReading {
  device: string;
  reading: Reading;
}

export interface Condition {
  name: 'Hot' | 'Cold' | 'Dry' | 'Mold risk' | 'Sensor fault' | 'Offline';
  level: 'critical' | 'high' | 'warning' | 'moderate';
}

export interface DashboardDevice {
  id: number;
  hostname: string;
  campus: Campus;
  closet: string;
  closetType: 'IDF' | 'MDF' | null;
  latestReading: Reading | null;
  online: boolean;
  secondsSinceReading: number | null;
  /** When the board last reported, a Reading or a fault report; null when it never has. */
  lastReportAt: string | null;
  secondsSinceReport: number | null;
  /** Every Condition the Device is in, worst first. */
  conditions: Condition[];
  /** Its incidents still open, oldest first, each with who acknowledged it. */
  openIncidents: OpenIncident[];
  /** The board said it is on its fallback network (firmware 7 and later): a note on its card, never a Condition. */
  onFallbackNetwork: boolean;
}

/** Who said they are on an incident, and when (POST /api/incidents/:id/acknowledge). */
export interface Acknowledgement {
  by: string;
  at: string;
}

/** An open incident as a Dashboard card carries it. */
export interface OpenIncident {
  id: number;
  condition: Condition['name'];
  level: Condition['level'];
  start: string;
  acknowledgement: Acknowledgement | null;
}

export interface DaySummary {
  min: number;
  max: number;
  /** To one decimal place. */
  avg: number;
}

/** One local day of a Device's Readings, oldest first, with the day's numbers. */
export interface History {
  device: {
    id: number;
    hostname: string;
    closet: string;
    closetType: 'IDF' | 'MDF' | null;
    campus: Campus;
    /** The sensor its board last said it carries (firmware 6 and later); null until one has. */
    sensor: 'DHT11' | 'DHT22' | 'SHT31' | null;
  };
  /** The day asked for, YYYY-MM-DD. */
  date: string;
  /** The IANA zone the day was cut in. */
  timeZone: string;
  /** The day's bounds as UTC instants: from inclusive, to exclusive. */
  from: string;
  to: string;
  readings: Reading[];
  /** True when the day held more Readings than the row limit and only the first ones are here. */
  truncated: boolean;
  /** How many days Readings are kept: the longest range the CSV download takes. */
  retentionDays: number;
  summary: {
    tempF: DaySummary | null;
    humidity: DaySummary | null;
  };
}

export interface Dashboard {
  reportIntervalSeconds: number;
  /** Three Report intervals: how long without a Reading before a Device is Offline. */
  offlineAfterSeconds: number;
  devices: DashboardDevice[];
}

export interface IncidentSegment {
  level: Condition['level'];
  start: string;
  end: string | null;
}

/** One incident as GET /api/incidents and the stream send it. */
export interface Incident {
  id: number;
  device: { id: number; hostname: string; closet: string; campus: Campus };
  condition: Condition['name'];
  level: Condition['level'];
  start: string;
  end: string | null;
  peak: { value: number | null; tempF: number; humidity: number | null; recordedAt: string };
  segments: IncidentSegment[];
  acknowledgement: Acknowledgement | null;
}

export interface IncidentLog {
  from: string;
  to: string;
  incidents: Incident[];
}

/** A JSON request carrying a bearer token, with any header overridable. */
const asBearer =
  (token: string) =>
  (init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...init.headers },
  });

/** A JSON request as the admin (Settings page) would send it. */
export const asAdmin = asBearer(TEST_ADMIN_TOKEN);

/** A JSON request as a Device would send it. */
export const asDevice = asBearer(TEST_DEVICE_TOKEN);

export const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

export const errorOf = async (response: Response): Promise<string> => (await json<{ error: string }>(response)).error;

/** The API as the tests drive it: every call goes over HTTP against the running server, reads with the Admin token (docs/adr/0010). */
export function api(server: RunningServer) {
  const post = (path: string, body: unknown, init: RequestInit = asAdmin()) =>
    fetch(`${server.url}${path}`, { ...init, method: 'POST', body: JSON.stringify(body) });
  return {
    campuses: {
      url: (path = '') => `${server.url}/api/campuses${path}`,
      list: async () => json<Campus[]>(await fetch(`${server.url}/api/campuses`, asAdmin())),
      add: (body: unknown, init?: RequestInit) => post('/api/campuses', body, init),
      /** Adds a campus that is expected to succeed and returns it. */
      create: async (name = 'Central High School', shortcode = 'CHS') =>
        json<Campus>(await post('/api/campuses', { name, shortcode })),
    },
    devices: {
      url: (path = '') => `${server.url}/api/devices${path}`,
      /** The Device list without its token-mismatch hint (deviceAdoption.test.ts reads that directly). */
      list: async () =>
        (await json<Array<Device & { tokenMismatchAt?: string | null }>>(await fetch(`${server.url}/api/devices`, asAdmin()))).map(({ tokenMismatchAt: _hint, ...device }) => device),
      add: (body: unknown, init?: RequestInit) => post('/api/devices', body, init),
      /** Changes a Device's closet or campus, as the admin unless init says otherwise. */
      edit: (id: number, body: unknown, init: RequestInit = asAdmin()) =>
        fetch(`${server.url}/api/devices/${id}`, { ...init, method: 'PATCH', body: JSON.stringify(body) }),
      /** Adds a device that is expected to succeed and returns it. */
      create: async (campusId: number, hostname = 'ESP_A1B2C3', closet = 'IDF 2') =>
        json<Device>(await post('/api/devices', { hostname, campusId, closet })),
      /** One day of a Device's history. `query` is appended verbatim, e.g. `?date=2026-09-05&tz=America/Chicago`. */
      history: (id: number, query = '') => fetch(`${server.url}/api/devices/${id}/history${query}`, asAdmin()),
      /** Deletes every Reading the Device has, as the admin unless init says otherwise. */
      resetHistory: (id: number, init: RequestInit = asAdmin()) =>
        fetch(`${server.url}/api/devices/${id}/history`, { ...init, method: 'DELETE' }),
    },
    readings: {
      url: (path = '') => `${server.url}/api/readings${path}`,
      /** Posts a reading as a Device would: with the Device token unless init says otherwise. */
      add: (body: unknown, init: RequestInit = asDevice()) => post('/api/readings', body, init),
    },
    incidents: {
      /** The raw response for a window, `query` appended verbatim, e.g. `?from=...&to=...`. */
      fetch: (query = '') => fetch(`${server.url}/api/incidents${query}`, asAdmin()),
      /** The incidents overlapping [from, to), expected to succeed. */
      list: async (from: Date, to: Date) => {
        const response = await fetch(`${server.url}/api/incidents?from=${from.toISOString()}&to=${to.toISOString()}`, asAdmin());
        if (response.status !== 200) throw new Error(`GET /api/incidents: ${response.status} ${await response.text()}`);
        return json<IncidentLog>(response);
      },
      /** Acknowledges an incident, as the admin unless init says otherwise. */
      acknowledge: (id: number, body: unknown, init?: RequestInit) => post(`/api/incidents/${id}/acknowledge`, body, init),
    },
    dashboard: {
      url: (query = '') => `${server.url}/api/dashboard${query}`,
      /** The dashboard, optionally filtered by campus shortcode. */
      get: async (campus?: string) => {
        const query = campus === undefined ? '' : `?campus=${encodeURIComponent(campus)}`;
        return json<Dashboard>(await fetch(`${server.url}/api/dashboard${query}`, asAdmin()));
      },
    },
  };
}
