import type { DatabaseConfig } from './db';
import { DEFAULT_THRESHOLDS, type Thresholds } from './conditions';
import { isTimeZone } from './localDay';
import { parseDailyWindow, type QuietHours } from './quietHours';

/** Everything the backend reads from the environment, read once at startup. */
export interface Config {
  port: number;
  /** Browser origin allowed by CORS. Undefined means no browser origin is allowed. */
  corsOrigin: string | undefined;
  database: DatabaseConfig;
  /** Shared secret that authorises changes to Devices, Campuses, and history. */
  adminToken: string;
  /** Shared secret every Device sends with each Reading. */
  deviceToken: string;
  /**
   * The Device token before a rotation, still accepted until every board is reflashed with the
   * new one (docs/adr/0003). Undefined when no rotation is under way.
   */
  deviceTokenPrevious: string | undefined;
  /** How often a healthy Device sends a Reading. */
  reportIntervalSeconds: number;
  /** How long raw Readings are kept before the retention job deletes them. */
  retentionDays: number;
  /** Where Hot, Cold, Dry, and Offline begin. Mold risk is a fixed rule (see conditions.ts). */
  thresholds: Thresholds;
  /** Where Incident emails go and through which relay (docs/adr/0008). Undefined when SMTP_HOST is unset: notifications are off. */
  notifications: NotificationsConfig | undefined;
}

/** How the connection to the relay is secured: STARTTLS on a plain port, TLS from the first byte, or not at all. */
export type SmtpSecurity = 'starttls' | 'tls' | 'none';
const SMTP_SECURITY: readonly SmtpSecurity[] = ['starttls', 'tls', 'none'];

export interface NotificationsConfig {
  smtp: {
    host: string;
    port: number;
    secure: SmtpSecurity;
    /** Undefined when the relay accepts mail from the server's address without a login. */
    auth: { user: string; password: string } | undefined;
  };
  /** The sender the relay allows, a bare address. */
  from: string;
  /**
   * At least one bare address; a distribution list keeps who receives alerts out of `.env`. The
   * default recipients: a Campus without its own list emails these.
   */
  to: string[];
  /** True when `to` receives every email, a Campus with its own list included (NOTIFY_TO_ALL). */
  toAll: boolean;
  /** The address technicians open the dashboard at, without a trailing slash, for links in emails. */
  publicUrl: string;
  /** How long the sender waits after the first pending notification before sending one email for all of them. */
  coalesceSeconds: number;
  /**
   * How many hours an Incident stays open and unacknowledged before it is emailed again, and again
   * every as many hours after (docs/adr/0008). 0: no reminders.
   */
  remindHours: number;
  /**
   * True when a report on the month just ended goes to NOTIFY_TO on the 1st of each month
   * (NOTIFY_MONTHLY_REPORT; docs/adr/0008). Off by default.
   */
  monthlyReport: boolean;
  /**
   * When warning emails wait, on the server's clock (NOTIFY_QUIET_HOURS, NOTIFY_QUIET_WEEKENDS;
   * docs/adr/0008): held until the quiet ends, then sent together. No window and no weekends by
   * default: nothing waits.
   */
  quietHours: QuietHours;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const REQUIRED = ['DB_USER', 'DB_PASSWORD', 'DB_NAME', 'ADMIN_TOKEN', 'DEVICE_TOKEN'] as const;

type Env = Record<string, string | undefined>;

function present(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value.trim() === '' ? undefined : value;
}

function required(env: Env, name: string): string {
  const value = present(env, name);
  if (value === undefined) throw new ConfigError(`Missing required environment variable: ${name}`);
  return value;
}

/** An integer from the environment, or the fallback when unset. `min` rejects anything below it. */
function integer(env: Env, name: string, fallback: number, { min }: { min?: number } = {}): number {
  const raw = present(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || (min !== undefined && value < min)) {
    const kind = min === 1 ? 'a positive integer' : min === undefined ? 'an integer' : `an integer of at least ${min}`;
    throw new ConfigError(`${name} must be ${kind}, got "${raw}"`);
  }
  return value;
}

const positiveInteger = (env: Env, name: string, fallback: number): number => integer(env, name, fallback, { min: 1 });

/** Thresholds from the environment, each defaulting to the agreed number. Hot critical must sit above Hot warning, and Cold below it. */
function thresholds(env: Env): Thresholds {
  const t: Thresholds = {
    hotWarningF: integer(env, 'HOT_WARNING_F', DEFAULT_THRESHOLDS.hotWarningF),
    hotCriticalF: integer(env, 'HOT_CRITICAL_F', DEFAULT_THRESHOLDS.hotCriticalF),
    coldWarningF: integer(env, 'COLD_WARNING_F', DEFAULT_THRESHOLDS.coldWarningF),
    dryWarningPercent: integer(env, 'DRY_WARNING_PERCENT', DEFAULT_THRESHOLDS.dryWarningPercent),
    missedReportsBeforeOffline: positiveInteger(env, 'MISSED_REPORTS_BEFORE_OFFLINE', DEFAULT_THRESHOLDS.missedReportsBeforeOffline),
  };
  if (t.hotCriticalF <= t.hotWarningF) {
    throw new ConfigError(`HOT_CRITICAL_F (${t.hotCriticalF}) must be above HOT_WARNING_F (${t.hotWarningF})`);
  }
  if (t.coldWarningF >= t.hotWarningF) {
    throw new ConfigError(`COLD_WARNING_F (${t.coldWarningF}) must be below HOT_WARNING_F (${t.hotWarningF})`);
  }
  return t;
}

/** A bare address, `name@host.tld`: no display name, no spaces, nothing a header could be split on. */
const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

/**
 * A comma-separated recipient list, as NOTIFY_TO and a Campus's own list are written: its
 * addresses trimmed, empty entries dropped, and any entry that is not a bare address.
 */
export function parseAddressList(raw: string): { addresses: string[]; bad: string[] } {
  const addresses = raw
    .split(',')
    .map((address) => address.trim())
    .filter((address) => address !== '');
  return { addresses, bad: addresses.filter((address) => !EMAIL.test(address)) };
}

/**
 * Settings that only mean something with SMTP_HOST and have no default, so one set without it is a
 * mistake, not "off". The port, security mode, and window may sit at their defaults in a template.
 */
const NOTIFY_SETTINGS = ['SMTP_USER', 'SMTP_PASSWORD', 'NOTIFY_FROM', 'NOTIFY_TO'] as const;

/** The longest NOTIFY_REMIND_HOURS: a week. */
export const MAX_REMIND_HOURS = 168;

/**
 * Email notifications from the environment (docs/adr/0008): off without SMTP_HOST, and a half-set
 * group refuses to start, naming every problem at once. The SMTP password is never in a message.
 */
function notifications(env: Env): NotificationsConfig | undefined {
  const host = present(env, 'SMTP_HOST');
  if (host === undefined) {
    const stray = NOTIFY_SETTINGS.filter((name) => present(env, name) !== undefined);
    if (stray.length > 0) {
      throw new ConfigError(`${stray.join(', ')} ${stray.length > 1 ? 'are' : 'is'} set but SMTP_HOST is not: set SMTP_HOST to turn email notifications on, or clear ${stray.length > 1 ? 'them' : 'it'}`);
    }
    return undefined;
  }

  const problems: string[] = [];
  const secureRaw = present(env, 'SMTP_SECURE')?.trim().toLowerCase() ?? 'starttls';
  const secure = SMTP_SECURITY.find((mode) => mode === secureRaw);
  if (secure === undefined) problems.push(`SMTP_SECURE must be starttls, tls, or none, got "${secureRaw}"`);
  // Implicit TLS lives on 465; STARTTLS and plain submission on 587.
  const port = integer(env, 'SMTP_PORT', secure === 'tls' ? 465 : 587, { min: 1 });
  if (port > 65535) problems.push(`SMTP_PORT must be a port number, got "${port}"`);

  const user = present(env, 'SMTP_USER');
  const password = present(env, 'SMTP_PASSWORD');
  if ((user === undefined) !== (password === undefined)) {
    problems.push(`SMTP_USER and SMTP_PASSWORD must be set together (${user === undefined ? 'SMTP_PASSWORD' : 'SMTP_USER'} is set alone); leave both empty for a relay that needs no login`);
  }

  const from = present(env, 'NOTIFY_FROM')?.trim();
  if (from === undefined) problems.push('NOTIFY_FROM is required with SMTP_HOST: the sender address the relay allows');
  else if (!EMAIL.test(from)) problems.push(`NOTIFY_FROM must be a bare address like alarms@district.example, got "${from}"`);

  const { addresses: to, bad: badTo } = parseAddressList(present(env, 'NOTIFY_TO') ?? '');
  if (to.length === 0) problems.push('NOTIFY_TO is required with SMTP_HOST: at least one recipient address, comma-separated');
  else if (badTo.length > 0) problems.push(`NOTIFY_TO must be comma-separated addresses; not an address: ${badTo.map((a) => `"${a}"`).join(', ')}`);

  const publicUrlRaw = present(env, 'PUBLIC_URL')?.trim();
  let publicUrl: string | undefined;
  if (publicUrlRaw === undefined) {
    problems.push('PUBLIC_URL is required with SMTP_HOST: the address technicians open the dashboard at, for links in emails');
  } else {
    publicUrl = httpUrl(publicUrlRaw);
    if (publicUrl === undefined) problems.push(`PUBLIC_URL must be an http:// or https:// address like https://alarms.district.example, got "${publicUrlRaw}"`);
  }

  const coalesceSeconds = integer(env, 'NOTIFY_COALESCE_SECONDS', 60, { min: 0 });
  // Empty or 0 is off. A week at most: a longer period would hardly remind anyone of anything.
  const remindHours = integer(env, 'NOTIFY_REMIND_HOURS', 0, { min: 0 });
  if (remindHours > MAX_REMIND_HOURS) problems.push(`NOTIFY_REMIND_HOURS must be 0 (off) to ${MAX_REMIND_HOURS} hours, got "${remindHours}"`);
  // Empty or false: a Campus with its own list emails only that list.
  const toAllRaw = present(env, 'NOTIFY_TO_ALL')?.trim().toLowerCase() ?? 'false';
  if (toAllRaw !== 'true' && toAllRaw !== 'false') problems.push(`NOTIFY_TO_ALL must be true or false, got "${toAllRaw}"`);
  // Empty or false is off.
  const monthlyRaw = present(env, 'NOTIFY_MONTHLY_REPORT')?.trim().toLowerCase() ?? 'false';
  if (monthlyRaw !== 'true' && monthlyRaw !== 'false') problems.push(`NOTIFY_MONTHLY_REPORT must be true or false, got "${monthlyRaw}"`);
  // Empty: no daily window. Two 24-hour times on the server's clock; the end may come before the start, past midnight.
  const quietRaw = present(env, 'NOTIFY_QUIET_HOURS')?.trim();
  const daily = quietRaw === undefined ? null : parseDailyWindow(quietRaw);
  if (daily === undefined) problems.push(`NOTIFY_QUIET_HOURS must be two different 24-hour times like 18:00-07:00, got "${quietRaw}"`);
  // Empty or false: weekends are like any other day.
  const weekendsRaw = present(env, 'NOTIFY_QUIET_WEEKENDS')?.trim().toLowerCase() ?? 'false';
  if (weekendsRaw !== 'true' && weekendsRaw !== 'false') problems.push(`NOTIFY_QUIET_WEEKENDS must be true or false, got "${weekendsRaw}"`);

  if (problems.length > 0 || secure === undefined || from === undefined || publicUrl === undefined || daily === undefined) {
    throw new ConfigError(`Email notifications are half-configured: ${problems.join('; ')}`);
  }
  return {
    smtp: { host: host.trim(), port, secure, auth: user !== undefined && password !== undefined ? { user, password } : undefined },
    from,
    to,
    toAll: toAllRaw === 'true',
    publicUrl,
    coalesceSeconds,
    remindHours,
    monthlyReport: monthlyRaw === 'true',
    quietHours: { daily, weekends: weekendsRaw === 'true' },
  };
}

/** An http(s) URL without its trailing slash, or undefined when the text is not one. */
function httpUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  return url.href.replace(/\/+$/, '');
}

/** Build the config from an environment, throwing a ConfigError that names every problem. */
export function loadConfig(env: Env = process.env): Config {
  const missing = REQUIRED.filter((name) => present(env, name) === undefined);
  if (missing.length > 0) {
    throw new ConfigError(`Missing required environment variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
  }
  // The server's zone (localDay.ts): quiet hours, email times, and the monthly report's months. A
  // zone Node does not know would silently be UTC.
  const tz = present(env, 'TZ');
  if (tz !== undefined && !isTimeZone(tz)) throw new ConfigError(`TZ must be an IANA time zone like America/Chicago, got "${tz}"`);
  if (required(env, 'ADMIN_TOKEN') === required(env, 'DEVICE_TOKEN')) {
    // Every board's flash holds the Device token, so it must not also open Settings.
    throw new ConfigError('ADMIN_TOKEN and DEVICE_TOKEN must differ: every Device carries the Device token');
  }
  const previous = present(env, 'DEVICE_TOKEN_PREVIOUS');
  if (previous !== undefined && previous === required(env, 'DEVICE_TOKEN')) {
    throw new ConfigError('DEVICE_TOKEN_PREVIOUS must differ from DEVICE_TOKEN: it is the token being retired, so clear it when no rotation is under way');
  }
  if (previous !== undefined && previous === required(env, 'ADMIN_TOKEN')) {
    // Every board still on it carries it in its flash, so it must not also open Settings.
    throw new ConfigError('DEVICE_TOKEN_PREVIOUS and ADMIN_TOKEN must differ: every Device still on it carries it');
  }
  return {
    port: positiveInteger(env, 'PORT', 3001),
    corsOrigin: present(env, 'CORS_ORIGIN'),
    database: {
      host: present(env, 'DB_HOST') ?? 'localhost',
      port: positiveInteger(env, 'DB_PORT', 3306),
      user: required(env, 'DB_USER'),
      password: required(env, 'DB_PASSWORD'),
      database: required(env, 'DB_NAME'),
    },
    adminToken: required(env, 'ADMIN_TOKEN'),
    deviceToken: required(env, 'DEVICE_TOKEN'),
    deviceTokenPrevious: previous,
    reportIntervalSeconds: positiveInteger(env, 'REPORT_INTERVAL_SECONDS', 30),
    retentionDays: positiveInteger(env, 'RETENTION_DAYS', 90),
    thresholds: thresholds(env),
    notifications: notifications(env),
  };
}

/** deploy.sh generates 64 hex characters; a token much shorter than that can be guessed (docs/adr/0003). */
export const MIN_TOKEN_LENGTH = 32;

/** A line for the log about each token shorter than MIN_TOKEN_LENGTH, naming it but never printing it. */
export function tokenWarnings({
  adminToken,
  deviceToken,
  deviceTokenPrevious,
}: Pick<Config, 'adminToken' | 'deviceToken'> & Partial<Pick<Config, 'deviceTokenPrevious'>>): string[] {
  const tokens: Array<[string, string | undefined]> = [
    ['ADMIN_TOKEN', adminToken],
    ['DEVICE_TOKEN', deviceToken],
    ['DEVICE_TOKEN_PREVIOUS', deviceTokenPrevious],
  ];
  return tokens
    .filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1].length < MIN_TOKEN_LENGTH)
    .map(([name, token]) => `${name} is ${token.length} characters; use at least ${MIN_TOKEN_LENGTH} (openssl rand -hex 32)`);
}
