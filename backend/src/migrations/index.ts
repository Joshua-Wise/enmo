import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { initialSchema } from './0001-initial-schema';
import { readingsRecordedAtIndex } from './0004-readings-recorded-at-index';
import { incidentsSchema } from './0005-incidents';
import { readingsCoveringIndex } from './0006-readings-covering-index';
import { firmwareSchema } from './0007-firmware';
import { pendingDevicesSchema } from './0008-pending-devices';
import { deviceInfoSchema } from './0009-device-info';
import { deviceReportsSchema } from './0010-device-reports';
import { notificationsSchema } from './0011-notifications';
import { incidentAcknowledgementSchema } from './0012-incident-acknowledgement';
import { incidentRemindersSchema } from './0013-incident-reminders';
import { campusRecipientsSchema } from './0014-campus-recipients';
import { stagedRolloutSchema } from './0015-staged-rollout';
import { deviceSensorSchema } from './0016-device-sensor';
import { monthlyReportSchema } from './0017-monthly-report';
import { systemHealthSchema } from './0018-system-health';
import { quietHoursSchema } from './0019-quiet-hours';
import { deviceNetworkSchema } from './0020-device-network';
import { usersSchema } from './0021-users';

/** What a migration may consult and report to while it runs. */
export interface MigrationContext {
  /** Where a migration reports what it did. */
  log(line: string): void;
}

export interface Migration {
  /** Stable identifier, recorded in schema_migrations once applied. Sorted lexically. */
  id: string;
  up(conn: PoolConnection, context: MigrationContext): Promise<void>;
}

/** Every migration, in the order it applies. Add new ones at the end. */
export const migrations: Migration[] = [
  initialSchema,
  readingsRecordedAtIndex,
  incidentsSchema,
  readingsCoveringIndex,
  firmwareSchema,
  pendingDevicesSchema,
  deviceInfoSchema,
  deviceReportsSchema,
  notificationsSchema,
  incidentAcknowledgementSchema,
  incidentRemindersSchema,
  campusRecipientsSchema,
  stagedRolloutSchema,
  deviceSensorSchema,
  monthlyReportSchema,
  systemHealthSchema,
  quietHoursSchema,
  deviceNetworkSchema,
  usersSchema,
];

/** The context the running backend hands its migrations: logging to stdout. */
export const migrationContext = (): MigrationContext => ({
  log: (line) => console.log(line),
});

/** How long a second runner waits for the first before giving up; waiting it out beats failing at once. */
const LOCK_WAIT_SECONDS = 600;

/** One lock per database, held by whoever is migrating it. MySQL named locks are server-wide and at most 64 characters. */
const LOCK_NAME = "LEFT(CONCAT('temperature_alarms_migrations:', DATABASE()), 64)";

export class MigrationLockError extends Error {
  constructor(waitSeconds: number) {
    super(`Another migration run still holds the lock after ${waitSeconds} s; try again once it has finished`);
    this.name = 'MigrationLockError';
  }
}

/**
 * Run `work` holding the database's migration lock, a MySQL named lock on `conn`'s session, so
 * two backends starting at once never migrate the same database together.
 * A second runner waits for the first; past `waitSeconds` it gives up rather than run alongside.
 */
export async function withMigrationLock<T>(conn: PoolConnection, work: () => Promise<T>, waitSeconds = LOCK_WAIT_SECONDS): Promise<T> {
  const [[{ acquired }]] = await conn.query<RowDataPacket[]>(`SELECT GET_LOCK(${LOCK_NAME}, ?) AS acquired`, [waitSeconds]);
  if (acquired !== 1) throw new MigrationLockError(waitSeconds);
  try {
    return await work();
  } finally {
    await conn.query(`SELECT RELEASE_LOCK(${LOCK_NAME})`);
  }
}

interface RunOptions {
  context?: MigrationContext;
  /** How long to wait for another runner's lock. */
  lockWaitSeconds?: number;
}

/**
 * Apply any migration that has not run yet and record it. Returns the ids applied.
 * MySQL commits DDL implicitly, so each migration is recorded right after it succeeds
 * rather than inside a transaction.
 */
export async function runMigrations(
  pool: Pool,
  { list = migrations, context = migrationContext(), lockWaitSeconds }: RunOptions & { list?: Migration[] } = {},
): Promise<string[]> {
  const conn = await pool.getConnection();
  try {
    return await withMigrationLock(
      conn,
      async () => {
        await conn.query(`
          CREATE TABLE IF NOT EXISTS schema_migrations (
            id         VARCHAR(100) NOT NULL,
            applied_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        const [rows] = await conn.query<RowDataPacket[]>('SELECT id FROM schema_migrations');
        const done = new Set(rows.map((r) => r.id as string));

        const applied: string[] = [];
        for (const migration of [...list].sort((a, b) => a.id.localeCompare(b.id))) {
          if (done.has(migration.id)) continue;
          await migration.up(conn, context);
          await conn.query('INSERT INTO schema_migrations (id) VALUES (?)', [migration.id]);
          applied.push(migration.id);
        }
        return applied;
      },
      lockWaitSeconds,
    );
  } finally {
    conn.release();
  }
}
