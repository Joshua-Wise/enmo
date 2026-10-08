import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, ConfigError, MIN_TOKEN_LENGTH, tokenWarnings } from '../src/config';
import { DEFAULT_THRESHOLDS } from '../src/conditions';

const complete = {
  DB_USER: 'temp',
  DB_PASSWORD: 'secret',
  DB_NAME: 'temperature_alarms',
  ADMIN_TOKEN: 'admin-secret',
  DEVICE_TOKEN: 'device-secret',
};

describe('loadConfig', () => {
  test('reads required values and applies defaults', () => {
    const config = loadConfig(complete);
    assert.equal(config.port, 3001);
    assert.equal(config.corsOrigin, undefined);
    assert.deepEqual(config.database, {
      host: 'localhost',
      port: 3306,
      user: 'temp',
      password: 'secret',
      database: 'temperature_alarms',
    });
    assert.equal(config.adminToken, 'admin-secret');
    assert.equal(config.deviceToken, 'device-secret');
    assert.equal(config.reportIntervalSeconds, 30);
    assert.equal(config.retentionDays, 90);
    assert.deepEqual(config.thresholds, DEFAULT_THRESHOLDS);
  });

  test('honours every optional override', () => {
    const config = loadConfig({
      ...complete,
      PORT: '4000',
      CORS_ORIGIN: 'https://example.test',
      DB_HOST: 'db.internal',
      DB_PORT: '3307',
      REPORT_INTERVAL_SECONDS: '60',
      RETENTION_DAYS: '30',
      HOT_WARNING_F: '80',
      HOT_CRITICAL_F: '95',
      COLD_WARNING_F: '-10',
      DRY_WARNING_PERCENT: '25',
      MISSED_REPORTS_BEFORE_OFFLINE: '5',
    });
    assert.equal(config.port, 4000);
    assert.equal(config.corsOrigin, 'https://example.test');
    assert.equal(config.database.host, 'db.internal');
    assert.equal(config.database.port, 3307);
    assert.equal(config.reportIntervalSeconds, 60);
    assert.equal(config.retentionDays, 30);
    assert.deepEqual(config.thresholds, { hotWarningF: 80, hotCriticalF: 95, coldWarningF: -10, dryWarningPercent: 25, missedReportsBeforeOffline: 5 });
  });

  test('TZ, the server\'s zone, may be any zone the runtime knows, and is refused otherwise rather than silently UTC', () => {
    for (const tz of ['America/Chicago', 'UTC', 'Etc/UTC']) assert.doesNotThrow(() => loadConfig({ ...complete, TZ: tz }), tz);
    assert.doesNotThrow(() => loadConfig({ ...complete, TZ: '' }), 'empty is unset');
    for (const tz of ['America/Chicgo', 'Central', ':/etc/localtime']) {
      assert.throws(() => loadConfig({ ...complete, TZ: tz }), (err: unknown) => err instanceof ConfigError && /TZ must be an IANA time zone/.test(err.message), tz);
    }
  });

  test('rejects thresholds that are not integers or are out of order', () => {
    assert.throws(() => loadConfig({ ...complete, HOT_WARNING_F: 'warm' }), /HOT_WARNING_F/);
    assert.throws(() => loadConfig({ ...complete, MISSED_REPORTS_BEFORE_OFFLINE: '0' }), /MISSED_REPORTS_BEFORE_OFFLINE/);
    assert.throws(() => loadConfig({ ...complete, HOT_CRITICAL_F: '82' }), /HOT_CRITICAL_F \(82\) must be above HOT_WARNING_F \(82\)/);
    assert.throws(() => loadConfig({ ...complete, COLD_WARNING_F: '82' }), /COLD_WARNING_F \(82\) must be below HOT_WARNING_F \(82\)/);
  });

  test('names every missing required variable in one message', () => {
    assert.throws(
      () => loadConfig({ DB_USER: 'temp', DB_NAME: 'x' }),
      (err: unknown) =>
        err instanceof ConfigError &&
        /DB_PASSWORD/.test(err.message) &&
        /ADMIN_TOKEN/.test(err.message) &&
        /DEVICE_TOKEN/.test(err.message),
    );
  });

  test('treats an empty string as missing', () => {
    assert.throws(() => loadConfig({ ...complete, ADMIN_TOKEN: '   ' }), /ADMIN_TOKEN/);
  });

  test('refuses an Admin token equal to the Device token: every board would carry the Admin token in its flash', () => {
    assert.throws(
      () => loadConfig({ ...complete, ADMIN_TOKEN: 'same-secret-value', DEVICE_TOKEN: 'same-secret-value' }),
      (err: unknown) => err instanceof ConfigError && /ADMIN_TOKEN/.test(err.message) && /DEVICE_TOKEN/.test(err.message) && !/same-secret-value/.test(err.message),
    );
  });

  test('DEVICE_TOKEN_PREVIOUS is optional, and read when set (a rotation under way)', () => {
    assert.equal(loadConfig(complete).deviceTokenPrevious, undefined);
    assert.equal(loadConfig({ ...complete, DEVICE_TOKEN_PREVIOUS: '  ' }).deviceTokenPrevious, undefined);
    assert.equal(loadConfig({ ...complete, DEVICE_TOKEN_PREVIOUS: 'old-device-secret' }).deviceTokenPrevious, 'old-device-secret');
  });

  test('refuses a DEVICE_TOKEN_PREVIOUS equal to the Device token or the Admin token, never printing it', () => {
    assert.throws(
      () => loadConfig({ ...complete, DEVICE_TOKEN_PREVIOUS: 'device-secret' }),
      (err: unknown) => err instanceof ConfigError && /DEVICE_TOKEN_PREVIOUS/.test(err.message) && /DEVICE_TOKEN\b/.test(err.message) && !/device-secret/.test(err.message),
    );
    assert.throws(
      () => loadConfig({ ...complete, DEVICE_TOKEN_PREVIOUS: 'admin-secret' }),
      (err: unknown) => err instanceof ConfigError && /DEVICE_TOKEN_PREVIOUS/.test(err.message) && /ADMIN_TOKEN/.test(err.message) && !/admin-secret/.test(err.message),
    );
  });

  test('warns about a token too short to resist guessing, naming it but never printing it', () => {
    const strong = 'a'.repeat(MIN_TOKEN_LENGTH);
    assert.deepEqual(tokenWarnings(loadConfig({ ...complete, ADMIN_TOKEN: strong, DEVICE_TOKEN: `b${strong}` })), []);
    const warnings = tokenWarnings(loadConfig(complete));
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /ADMIN_TOKEN/);
    assert.match(warnings[1], /DEVICE_TOKEN/);
    for (const warning of warnings) assert.ok(!warning.includes('admin-secret') && !warning.includes('device-secret'), warning);
    const rotating = tokenWarnings(loadConfig({ ...complete, ADMIN_TOKEN: strong, DEVICE_TOKEN: `b${strong}`, DEVICE_TOKEN_PREVIOUS: 'old' }));
    assert.equal(rotating.length, 1);
    assert.match(rotating[0], /DEVICE_TOKEN_PREVIOUS/);
  });

  test('rejects a non-numeric or non-positive number', () => {
    assert.throws(() => loadConfig({ ...complete, PORT: 'abc' }), /PORT/);
    assert.throws(() => loadConfig({ ...complete, RETENTION_DAYS: '0' }), /RETENTION_DAYS/);
  });
});

describe('loadConfig: email notifications', () => {
  const smtp = {
    ...complete,
    SMTP_HOST: 'relay.example.test',
    NOTIFY_FROM: 'alarms@example.test',
    NOTIFY_TO: 'techs@example.test',
    PUBLIC_URL: 'https://alarms.example.test',
  };

  test('off without SMTP_HOST', () => {
    assert.equal(loadConfig(complete).notifications, undefined);
    assert.equal(loadConfig({ ...complete, SMTP_HOST: '  ' }).notifications, undefined);
  });

  test('on with SMTP_HOST, applying defaults: port 587, STARTTLS, no login, a 60 s coalescing window, no reminders, no monthly report, no quiet hours', () => {
    assert.deepEqual(loadConfig(smtp).notifications, {
      smtp: { host: 'relay.example.test', port: 587, secure: 'starttls', auth: undefined },
      from: 'alarms@example.test',
      to: ['techs@example.test'],
      publicUrl: 'https://alarms.example.test',
      coalesceSeconds: 60,
      remindHours: 0,
      toAll: false,
      monthlyReport: false,
      quietHours: { daily: null, weekends: false },
    });
  });

  test('honours every override, and reads a comma-separated recipient list', () => {
    const notifications = loadConfig({
      ...smtp,
      SMTP_PORT: '2525',
      SMTP_SECURE: 'none',
      SMTP_USER: 'svc-alarms',
      SMTP_PASSWORD: 'smtp-secret',
      NOTIFY_TO: ' techs@example.test, oncall@example.test ,',
      PUBLIC_URL: 'http://10.0.0.5:8080/',
      NOTIFY_COALESCE_SECONDS: '0',
      NOTIFY_REMIND_HOURS: '4',
      NOTIFY_TO_ALL: 'true',
      NOTIFY_MONTHLY_REPORT: 'true',
      NOTIFY_QUIET_HOURS: ' 18:00-07:00 ',
      NOTIFY_QUIET_WEEKENDS: 'true',
    }).notifications;
    assert.deepEqual(notifications, {
      smtp: { host: 'relay.example.test', port: 2525, secure: 'none', auth: { user: 'svc-alarms', password: 'smtp-secret' } },
      from: 'alarms@example.test',
      to: ['techs@example.test', 'oncall@example.test'],
      publicUrl: 'http://10.0.0.5:8080',
      coalesceSeconds: 0,
      remindHours: 4,
      toAll: true,
      monthlyReport: true,
      quietHours: { daily: { start: 18 * 60, end: 7 * 60 }, weekends: true },
    });
  });

  test('reminders are off when NOTIFY_REMIND_HOURS is empty or 0, and up to a week apart', () => {
    assert.equal(loadConfig({ ...smtp, NOTIFY_REMIND_HOURS: '' }).notifications?.remindHours, 0);
    assert.equal(loadConfig({ ...smtp, NOTIFY_REMIND_HOURS: '0' }).notifications?.remindHours, 0);
    assert.equal(loadConfig({ ...smtp, NOTIFY_REMIND_HOURS: '168' }).notifications?.remindHours, 168);
    // Like the window, it may sit in a template while email is off: only SMTP_HOST turns anything on.
    assert.equal(loadConfig({ ...complete, NOTIFY_REMIND_HOURS: '4' }).notifications, undefined);
  });

  test('NOTIFY_TO_ALL keeps NOTIFY_TO on every email when true, in any case; empty or false is off', () => {
    assert.equal(loadConfig({ ...smtp, NOTIFY_TO_ALL: 'TRUE' }).notifications?.toAll, true);
    assert.equal(loadConfig({ ...smtp, NOTIFY_TO_ALL: 'false' }).notifications?.toAll, false);
    assert.equal(loadConfig({ ...smtp, NOTIFY_TO_ALL: '' }).notifications?.toAll, false);
    // Like the window, it may sit in a template while email is off.
    assert.equal(loadConfig({ ...complete, NOTIFY_TO_ALL: 'true' }).notifications, undefined);
  });

  test('the monthly report is on with NOTIFY_MONTHLY_REPORT=true, off when empty or false, and ignored without SMTP_HOST', () => {
    assert.equal(loadConfig({ ...smtp, NOTIFY_MONTHLY_REPORT: ' TRUE ' }).notifications?.monthlyReport, true);
    assert.equal(loadConfig({ ...smtp, NOTIFY_MONTHLY_REPORT: 'false' }).notifications?.monthlyReport, false);
    assert.equal(loadConfig({ ...smtp, NOTIFY_MONTHLY_REPORT: '' }).notifications?.monthlyReport, false);
    assert.equal(loadConfig({ ...complete, NOTIFY_MONTHLY_REPORT: 'true' }).notifications, undefined);
  });

  test('quiet hours: a daily window of two 24-hour times, weekends with NOTIFY_QUIET_WEEKENDS=true, each off when empty, and ignored without SMTP_HOST', () => {
    assert.deepEqual(loadConfig({ ...smtp, NOTIFY_QUIET_HOURS: '22:30-06:15' }).notifications?.quietHours, { daily: { start: 22 * 60 + 30, end: 6 * 60 + 15 }, weekends: false });
    assert.deepEqual(loadConfig({ ...smtp, NOTIFY_QUIET_HOURS: '12:00-13:00' }).notifications?.quietHours.daily, { start: 12 * 60, end: 13 * 60 });
    assert.deepEqual(loadConfig({ ...smtp, NOTIFY_QUIET_HOURS: '', NOTIFY_QUIET_WEEKENDS: 'TRUE' }).notifications?.quietHours, { daily: null, weekends: true });
    assert.equal(loadConfig({ ...smtp, NOTIFY_QUIET_WEEKENDS: 'false' }).notifications?.quietHours.weekends, false);
    // Like the window, they may sit in a template while email is off.
    assert.equal(loadConfig({ ...complete, NOTIFY_QUIET_HOURS: '18:00-07:00', NOTIFY_QUIET_WEEKENDS: 'true' }).notifications, undefined);
  });

  test('implicit TLS defaults to port 465', () => {
    assert.equal(loadConfig({ ...smtp, SMTP_SECURE: 'tls' }).notifications?.smtp.port, 465);
    assert.equal(loadConfig({ ...smtp, SMTP_SECURE: 'TLS', SMTP_PORT: '587' }).notifications?.smtp.port, 587);
  });

  const refuses = (env: Record<string, string>, pattern: RegExp) =>
    assert.throws(
      () => loadConfig(env),
      (err: unknown) => err instanceof ConfigError && pattern.test(err.message) && !err.message.includes('smtp-secret'),
      `expected a ConfigError matching ${pattern}`,
    );

  test('refuses a half-set group, naming what is missing', () => {
    refuses({ ...smtp, NOTIFY_TO: '' }, /NOTIFY_TO/);
    refuses({ ...smtp, NOTIFY_FROM: '' }, /NOTIFY_FROM/);
    refuses({ ...smtp, PUBLIC_URL: '' }, /PUBLIC_URL/);
    refuses({ ...smtp, SMTP_USER: 'svc-alarms' }, /SMTP_USER and SMTP_PASSWORD/);
    refuses({ ...smtp, SMTP_PASSWORD: 'smtp-secret' }, /SMTP_USER and SMTP_PASSWORD/);
    // Every problem at once, as with the required variables.
    refuses({ ...complete, SMTP_HOST: 'relay.example.test' }, /NOTIFY_FROM.*NOTIFY_TO.*PUBLIC_URL/s);
  });

  test('refuses notification settings without SMTP_HOST, rather than staying silently off', () => {
    refuses({ ...complete, NOTIFY_TO: 'techs@example.test' }, /SMTP_HOST/);
    refuses({ ...complete, SMTP_USER: 'svc-alarms', SMTP_PASSWORD: 'smtp-secret' }, /SMTP_HOST/);
  });

  test('refuses a bad address, security mode, port, URL, or window', () => {
    refuses({ ...smtp, NOTIFY_TO: 'techs@example.test, not-an-address' }, /NOTIFY_TO.*not-an-address/);
    refuses({ ...smtp, NOTIFY_TO: ' , ' }, /NOTIFY_TO/);
    refuses({ ...smtp, NOTIFY_FROM: 'Alarms <alarms@example.test>' }, /NOTIFY_FROM/);
    refuses({ ...smtp, SMTP_SECURE: 'ssl' }, /SMTP_SECURE.*starttls, tls, or none/);
    refuses({ ...smtp, SMTP_PORT: '0' }, /SMTP_PORT/);
    refuses({ ...smtp, SMTP_PORT: '70000' }, /SMTP_PORT/);
    refuses({ ...smtp, PUBLIC_URL: 'alarms.example.test' }, /PUBLIC_URL/);
    refuses({ ...smtp, PUBLIC_URL: 'ftp://alarms.example.test' }, /PUBLIC_URL/);
    refuses({ ...smtp, NOTIFY_COALESCE_SECONDS: '-1' }, /NOTIFY_COALESCE_SECONDS/);
    refuses({ ...smtp, NOTIFY_REMIND_HOURS: '-1' }, /NOTIFY_REMIND_HOURS/);
    refuses({ ...smtp, NOTIFY_REMIND_HOURS: '1.5' }, /NOTIFY_REMIND_HOURS/);
    refuses({ ...smtp, NOTIFY_REMIND_HOURS: '169' }, /NOTIFY_REMIND_HOURS.*168/);
    refuses({ ...smtp, NOTIFY_TO_ALL: 'yes' }, /NOTIFY_TO_ALL.*true or false/);
    refuses({ ...smtp, NOTIFY_MONTHLY_REPORT: 'yes' }, /NOTIFY_MONTHLY_REPORT must be true or false/);
    for (const hours of ['18:00', '18:00-18:00', '6pm-7am', '24:00-07:00', '18:00 - 07:00', 'off']) {
      refuses({ ...smtp, NOTIFY_QUIET_HOURS: hours }, /NOTIFY_QUIET_HOURS must be two different 24-hour times like 18:00-07:00/);
    }
    refuses({ ...smtp, NOTIFY_QUIET_WEEKENDS: 'yes' }, /NOTIFY_QUIET_WEEKENDS must be true or false/);
  });

  test('never prints the SMTP password', () => {
    refuses({ ...smtp, SMTP_USER: 'svc-alarms', SMTP_PASSWORD: 'smtp-secret', NOTIFY_TO: '' }, /NOTIFY_TO/);
    refuses({ ...complete, SMTP_PASSWORD: 'smtp-secret' }, /SMTP_HOST/);
  });
});

describe('startup', () => {
  test('exits with a clear message when required config is missing', () => {
    const backendDir = path.resolve(__dirname, '..');
    const result = spawnSync(
      process.execPath,
      ['--require', 'ts-node/register/transpile-only', path.join(backendDir, 'src', 'index.ts')],
      {
        // A directory with no .env so dotenv cannot fill in the blanks.
        cwd: os.tmpdir(),
        env: {
          PATH: process.env.PATH ?? '',
          NODE_PATH: path.join(backendDir, 'node_modules'),
          TS_NODE_PROJECT: path.join(backendDir, 'tsconfig.json'),
          DB_USER: 'temp',
          DB_NAME: 'temperature_alarms',
        },
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    assert.equal(result.status, 1, `stderr was: ${result.stderr}`);
    assert.match(result.stderr, /DB_PASSWORD/);
    assert.match(result.stderr, /ADMIN_TOKEN/);
    assert.match(result.stderr, /DEVICE_TOKEN/);
  });
});
