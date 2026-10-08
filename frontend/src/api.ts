import type { Device, DeviceRotation, PendingDevice, FirmwareRelease, FirmwareStatus, Campus, CampusRecipients, Dashboard, DashboardOrder, History, Incident, Incidents, MonthlyReportQueued, NotificationStatus, Overview, SessionInfo, SystemHealth, TestEmailResult, User, UserRole } from './types';
import { apiBaseUrl } from './lib/apiBase';
import { sessionEnded } from './lib/session';

const API_BASE_URL = apiBaseUrl(import.meta.env.VITE_API_URL);

/** A request the server answered with an error, or one that never reached it (status 0). */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** No one is signed in any more: the session ended, expired, or was never there. The page goes to sign-in. */
export class UnauthorisedError extends ApiError {
  constructor() {
    super(401, 'Your session has ended. Sign in again.');
    this.name = 'UnauthorisedError';
  }
}

/** Signed in, but not allowed: a Viewer asking for a change, say. Carries the server's sentence. */
export class ForbiddenError extends ApiError {
  constructor(message: string) {
    super(403, message);
    this.name = 'ForbiddenError';
  }
}

/** A message a person can act on, whatever was thrown. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** A file sent as it is (application/octet-stream) instead of a JSON body. */
  raw?: Blob;
  /** A 401 here is an answer, not a session ending (signing in, changing a password). */
  quietUnauthorised?: boolean;
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error !== '') return body.error;
  } catch {
    // Not JSON; fall through to the status line.
  }
  return `The server answered ${response.status} ${response.statusText}`.trim();
}

/**
 * The one place requests are made, each with the session cookie. Every change is sent as JSON, body
 * or not, since the server refuses a change made with the cookie in any form a page on another site
 * could send (docs/adr/0010). A 401 means the session is over: the session store hears it and the
 * page goes to sign-in.
 */
async function request<T>(path: string, { method = 'GET', body, raw, quietUnauthorised = false }: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['Content-Type'] = raw === undefined ? 'application/json' : 'application/octet-stream';

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      credentials: 'include',
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
  } catch (error) {
    throw new ApiError(0, 'Could not reach the server', { cause: error });
  }

  if (response.status === 401 && !quietUnauthorised) {
    sessionEnded();
    throw new UnauthorisedError();
  }
  if (response.status === 403) throw new ForbiddenError(await errorMessage(response));
  if (!response.ok) throw new ApiError(response.status, await errorMessage(response));
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

// ==================== SESSION ====================

/** Who is signed in in this browser; an UnauthorisedError when no one is. */
export const getSession = (): Promise<SessionInfo> => request('/api/session');

/** Sign in. A refusal ("Wrong username or password", or too many tries) is an ApiError with the server's sentence. */
export const signIn = (username: string, password: string): Promise<SessionInfo> =>
  request('/api/session', { method: 'POST', body: { username, password }, quietUnauthorised: true });

export const signOut = (): Promise<void> => request('/api/session', { method: 'DELETE', quietUnauthorised: true });

/** Change the signed-in user's own password; the current one is required. Their other sessions end. */
export const changeOwnPassword = (currentPassword: string, newPassword: string): Promise<SessionInfo> =>
  request('/api/session/password', { method: 'POST', body: { currentPassword, newPassword } });

// ==================== USERS ====================

/** Everyone who may sign in. An Admin only. */
export const getUsers = (): Promise<User[]> => request('/api/users');

/** Add a user with a starting password. An Admin only. */
export const addUser = (username: string, role: UserRole, password: string): Promise<User> =>
  request('/api/users', { method: 'POST', body: { username, role, password } });

/** What an Admin may change about a user. */
export interface UserEdit {
  role?: UserRole;
  disabled?: boolean;
  password?: string;
}

/** Change a role, disable or enable, or set a new password (their sessions end). An Admin only. */
export const updateUser = (id: number, changes: UserEdit): Promise<User> => request(`/api/users/${id}`, { method: 'PATCH', body: changes });

/** Delete a user; their sessions end. An Admin only. */
export const deleteUser = (id: number): Promise<void> => request(`/api/users/${id}`, { method: 'DELETE' });

// ==================== CAMPUSES ====================

export const getCampuses = (): Promise<Campus[]> => request('/api/campuses');

/** Add a Campus, with its own recipients (comma-separated) or none to email NOTIFY_TO. An Admin only. */
export const addCampus = (name: string, shortcode: string, notifyTo = ''): Promise<Campus> =>
  request('/api/campuses', { method: 'POST', body: { name, shortcode, notifyTo } });

/** Every Campus's own recipients, empty for one that emails NOTIFY_TO. An Admin only. */
export const getCampusRecipients = (): Promise<CampusRecipients[]> => request('/api/campuses/recipients');

/** Replace a Campus's own recipients (comma-separated); empty sends its email to NOTIFY_TO. An Admin only. */
export const setCampusRecipients = (id: number, notifyTo: string): Promise<Campus & CampusRecipients> =>
  request(`/api/campuses/${id}`, { method: 'PATCH', body: { notifyTo } });

export const deleteCampus = (id: number): Promise<void> =>
  request(`/api/campuses/${id}`, { method: 'DELETE' });

/** Every Campus worst first, with its last seven days cut in this browser's zone. */
export const getCampusOverview = (): Promise<Overview> =>
  request(`/api/campuses/overview?${new URLSearchParams({ tz: browserTimeZone() })}`);

// ==================== DEVICES ====================

export const getDevices = (): Promise<Device[]> => request('/api/devices');

export const addDevice = (hostname: string, campusId: number, closet: string): Promise<Device> =>
  request('/api/devices', { method: 'POST', body: { hostname, campusId, closet } });

/** What an edit may change. The hostname is not editable: a replaced board is a new Device. */
export interface DeviceEdit {
  closet?: string;
  campusId?: number;
}

/** Correct a Device's Closet or move it to another Campus; its Readings stay. An Admin only. */
export const editDevice = (id: number, changes: DeviceEdit): Promise<Device> =>
  request(`/api/devices/${id}`, { method: 'PATCH', body: changes });

export const deleteDevice = (id: number): Promise<void> => request(`/api/devices/${id}`, { method: 'DELETE' });

/** Boards reporting with the Device token that nobody has registered yet. An Admin only. */
export const getPendingDevices = (): Promise<PendingDevice[]> => request('/api/devices/pending');

/** Hide a waiting board from the pop-up (or show it again). An Admin only. */
export const setPendingIgnored = (hostname: string, ignored: boolean): Promise<unknown> =>
  request(`/api/devices/pending/${encodeURIComponent(hostname)}`, { method: 'PATCH', body: { ignored } });

/** Drop a waiting board from the list until it reports again. An Admin only. */
export const forgetPendingDevice = (hostname: string): Promise<void> =>
  request(`/api/devices/pending/${encodeURIComponent(hostname)}`, { method: 'DELETE' });

/** The published firmware release and the version each Device last reported. An Admin only. */
export const getFirmwareStatus = (): Promise<FirmwareStatus> => request('/api/firmware/status');

/** Publish a signed build (the .bin.signed) to every Device, or only to `only`. An Admin only. */
export const publishFirmware = (image: Blob, only: string[] = []): Promise<FirmwareRelease> =>
  request(`/api/firmware${only.length > 0 ? `?${new URLSearchParams({ only: only.join(',') })}` : ''}`, { method: 'POST', raw: image });

/** "Release to all": offer a staged build to every Device. Refused (409) while it is held. An Admin only. */
export const widenFirmware = (): Promise<FirmwareRelease> => request('/api/firmware/widen', { method: 'POST' });

/** Stop offering the published build; boards keep what they run. An Admin only. */
export const withdrawFirmware = (): Promise<void> => request('/api/firmware', { method: 'DELETE' });

/** Which Devices still report with the previous Device token during a rotation. An Admin only. */
export const getDeviceRotation = (): Promise<DeviceRotation> => request('/api/devices/rotation');

// ==================== NOTIFICATIONS ====================

/** Whether Incidents are emailed, to whom, and how the last send went. An Admin only. */
export const getNotificationStatus = (): Promise<NotificationStatus> => request('/api/notifications/status');

/** Send a test email to the default recipients (NOTIFY_TO) now; at most one a minute. An Admin only. */
export const sendTestEmail = (): Promise<TestEmailResult> => request('/api/notifications/test', { method: 'POST' });

/** Queue the report on last month for the default recipients (NOTIFY_TO); at most one a minute. An Admin only. */
export const sendMonthlyReport = (): Promise<MonthlyReportQueued> => request('/api/notifications/report', { method: 'POST' });

// ==================== SYSTEM ====================

/** Whether the system itself is OK, line by line (Settings, System). An Admin only. */
export const getSystemHealth = (): Promise<SystemHealth> => request('/api/system');

// ==================== DASHBOARD ====================

/**
 * Every Device with its latest Reading, optionally only those at one Campus, in the server's
 * order: worst first unless `order` is 'campus' (by Campus name, then closet).
 */
export const getDashboard = (campus?: string, order: DashboardOrder = 'worst'): Promise<Dashboard> => {
  const query = new URLSearchParams();
  if (campus) query.set('campus', campus);
  if (order !== 'worst') query.set('order', order);
  const search = query.toString();
  return request(`/api/dashboard${search ? `?${search}` : ''}`);
};

/**
 * The live stream of Readings (Server-Sent Events). The browser reconnects on its own after
 * a drop; callers watch `readyState` and reload their data once it is open again.
 */
export const openDashboardStream = (): EventSource => new EventSource(`${API_BASE_URL}/api/dashboard/stream`, { withCredentials: true });

// ==================== HISTORY ====================

/** The zone this browser is in, so the server cuts the day where the technician's midnight falls. */
const browserTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** One local day of a Device's Readings with the day's numbers. Today when `date` is omitted. */
export const getHistory = (deviceId: number, date?: string): Promise<History> => {
  const query = new URLSearchParams({ tz: browserTimeZone() });
  if (date) query.set('date', date);
  return request(`/api/devices/${deviceId}/history?${query}`);
};

/**
 * Where a Device's Readings over a range of days (YYYY-MM-DD, both included, cut in this browser's
 * zone) download as CSV. A plain link, not a request: the browser saves the file as it streams in.
 */
export const readingsCsvUrl = (deviceId: number, from: string, to: string): string =>
  `${API_BASE_URL}/api/devices/${deviceId}/readings.csv?${new URLSearchParams({ from, to, tz: browserTimeZone() })}`;

/** Delete every Reading the Device has. An Admin only. */
export const resetHistory = (deviceId: number): Promise<void> =>
  request(`/api/devices/${deviceId}/history`, { method: 'DELETE' });

// ==================== INCIDENTS ====================

/** Every incident that overlaps the window, ongoing ones included, oldest first. At most eight days. */
export const getIncidents = (from: Date, to: Date): Promise<Incidents> => {
  const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  return request(`/api/incidents?${query}`);
};

/**
 * Where the incidents overlapping the window download as CSV, only one Device's when `deviceId` is
 * given, with local times in this browser's zone. A plain link, like the Readings download.
 */
export const incidentsCsvUrl = (from: Date, to: Date, deviceId?: number): string => {
  const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString(), tz: browserTimeZone() });
  if (deviceId !== undefined) query.set('device', String(deviceId));
  return `${API_BASE_URL}/api/incidents.csv?${query}`;
};

/**
 * Say who is on an open incident: a name or a short note. The first acknowledgement stands; a
 * repeat answers the incident as it is. An Admin only.
 */
export const acknowledgeIncident = (id: number, by: string): Promise<Incident> =>
  request(`/api/incidents/${id}/acknowledge`, { method: 'POST', body: { by } });
