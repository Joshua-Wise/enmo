import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { createTestPool, resetDatabase, tableNames } from './helpers/database';
import { MigrationLockError, runMigrations, withMigrationLock } from '../src/migrations';

let pool: Pool;

before(() => {
  pool = createTestPool();
});
after(() => pool.end());

async function insertCampus(name = 'Central High', shortcode = 'CHS'): Promise<number> {
  const [result] = await pool.query<ResultSetHeader>('INSERT INTO campuses (name, shortcode) VALUES (?, ?)', [name, shortcode]);
  return result.insertId;
}

async function insertDevice(campusId: number, hostname = 'ESP_A1B2C3', closet = 'IDF 2'): Promise<number> {
  const [result] = await pool.query<ResultSetHeader>(
    'INSERT INTO devices (hostname, campus_id, closet) VALUES (?, ?, ?)',
    [hostname, campusId, closet],
  );
  return result.insertId;
}

/** Every secondary index on readings, as index name to its columns in order. */
async function readingsIndexes(): Promise<Map<string, string[]>> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT index_name AS indexName, seq_in_index AS seq, column_name AS columnName
       FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = 'readings' AND index_name <> 'PRIMARY'
      ORDER BY index_name, seq_in_index`,
  );
  const byIndex = new Map<string, string[]>();
  for (const r of rows) {
    byIndex.set(r.indexName, [...(byIndex.get(r.indexName) ?? []), r.columnName]);
  }
  return byIndex;
}

describe('migration runner', () => {
  beforeEach(() => resetDatabase(pool));

  test('creates the schema tables and records the applied migrations', async () => {
    assert.deepEqual(await tableNames(pool), ['campuses', 'devices', 'firmware_release', 'incident_segments', 'incidents', 'last_backup', 'monthly_reports', 'notifications', 'pending_devices', 'readings', 'schema_migrations']);
    const [rows] = await pool.query<RowDataPacket[]>('SELECT id FROM schema_migrations ORDER BY id');
    assert.deepEqual(rows.map((r) => r.id), [
      '0001-initial-schema',
      '0004-readings-recorded-at-index',
      '0005-incidents',
      '0006-readings-covering-index',
      '0007-firmware',
      '0008-pending-devices',
      '0009-device-info',
      '0010-device-reports',
      '0011-notifications',
      '0012-incident-acknowledgement',
      '0013-incident-reminders',
      '0014-campus-recipients',
      '0015-staged-rollout',
      '0016-device-sensor',
      '0017-monthly-report',
      '0018-system-health',
      '0019-quiet-hours',
      '0020-device-network',
    ]);
  });

  test('running again applies nothing', async () => {
    const applied = await runMigrations(pool);
    assert.deepEqual(applied, []);
    const [rows] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM schema_migrations');
    assert.equal(rows[0].n, 18);
  });

  test('applies only migrations that have not run yet, in order', async () => {
    const extra = [
      { id: '0001-initial-schema', up: async () => { throw new Error('must not rerun'); } },
      {
        id: '0002-extra',
        up: async (conn: import('mysql2/promise').PoolConnection) => {
          await conn.query('CREATE TABLE extra (id INT PRIMARY KEY)');
        },
      },
    ];
    const applied = await runMigrations(pool, { list: extra });
    assert.deepEqual(applied, ['0002-extra']);
    assert.ok((await tableNames(pool)).includes('extra'));
  });

  // MySQL commits DDL as it goes, so a run can die after a schema change and before recording it.
  test('a migration whose change landed but was never recorded runs again cleanly', async () => {
    await pool.query(
      "DELETE FROM schema_migrations WHERE id IN ('0001-initial-schema', '0004-readings-recorded-at-index', '0005-incidents', '0006-readings-covering-index', '0011-notifications', '0012-incident-acknowledgement', '0013-incident-reminders', '0014-campus-recipients', '0015-staged-rollout', '0016-device-sensor', '0017-monthly-report', '0018-system-health', '0019-quiet-hours', '0020-device-network')",
    );
    const applied = await runMigrations(pool);
    assert.deepEqual(applied, ['0001-initial-schema', '0004-readings-recorded-at-index', '0005-incidents', '0006-readings-covering-index', '0011-notifications', '0012-incident-acknowledgement', '0013-incident-reminders', '0014-campus-recipients', '0015-staged-rollout', '0016-device-sensor', '0017-monthly-report', '0018-system-health', '0019-quiet-hours', '0020-device-network']);
    assert.deepEqual(await tableNames(pool), ['campuses', 'devices', 'firmware_release', 'incident_segments', 'incidents', 'last_backup', 'monthly_reports', 'notifications', 'pending_devices', 'readings', 'schema_migrations']);
    assert.deepEqual((await readingsIndexes()).get('ix_readings_recorded'), ['recorded_at']);
  });
});

describe('0010-device-reports', () => {
  beforeEach(() => resetDatabase(pool));

  test('backfills each Device\'s last report from its latest Reading and starts every fault count at zero', async () => {
    // As a database migrated to 0009 had it: no report columns, Readings already in.
    await pool.query('ALTER TABLE devices DROP COLUMN last_report_at, DROP COLUMN sensor_faults');
    await pool.query("DELETE FROM schema_migrations WHERE id = '0010-device-reports'");
    const campusId = await insertCampus();
    const reported = await insertDevice(campusId, 'ESP_A1B2C3');
    const silent = await insertDevice(campusId, 'ESP_D4E5F6');
    await pool.query('INSERT INTO readings (device_id, temp_f, humidity, recorded_at) VALUES ?', [
      [
        [reported, 72, 40, new Date('2026-10-05T10:00:00Z')],
        [reported, 73, 41, new Date('2026-10-05T10:00:30Z')],
        [reported, 71, 40, new Date('2026-10-05T09:59:30Z')],
      ],
    ]);

    assert.deepEqual(await runMigrations(pool), ['0010-device-reports']);
    const [rows] = await pool.query<RowDataPacket[]>('SELECT id, last_report_at AS lastReportAt, sensor_faults AS sensorFaults FROM devices ORDER BY id');
    assert.deepEqual(
      rows.map((r) => [r.id, r.lastReportAt === null ? null : (r.lastReportAt as Date).toISOString(), r.sensorFaults]),
      [
        [reported, '2026-10-05T10:00:30.000Z', 0],
        [silent, null, 0],
      ],
    );
  });

  test('a run that landed but was never recorded runs again cleanly, keeping later reports', async () => {
    const campusId = await insertCampus();
    const device = await insertDevice(campusId);
    await pool.query('INSERT INTO readings (device_id, temp_f, humidity, recorded_at) VALUES (?, 72, 40, ?)', [device, new Date('2026-10-05T10:00:00Z')]);
    await pool.query('UPDATE devices SET last_report_at = ?, sensor_faults = 2 WHERE id = ?', [new Date('2026-10-05T10:05:00Z'), device]);
    await pool.query("DELETE FROM schema_migrations WHERE id = '0010-device-reports'");

    assert.deepEqual(await runMigrations(pool), ['0010-device-reports']);
    const [rows] = await pool.query<RowDataPacket[]>('SELECT last_report_at AS lastReportAt, sensor_faults AS sensorFaults FROM devices');
    assert.equal((rows[0].lastReportAt as Date).toISOString(), '2026-10-05T10:05:00.000Z');
    assert.equal(rows[0].sensorFaults, 2);
  });
});

describe('0017-monthly-report', () => {
  beforeEach(() => resetDatabase(pool));

  const kindType = async (): Promise<string> => {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT column_type AS type FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'notifications' AND column_name = 'kind'",
    );
    return rows[0].type as string;
  };

  test('adds the report kind beside every kind the outbox has, keeping a queued hold, and repeats harmlessly', async () => {
    // As a database migrated to 0016 had it: no report kind, and a hold waiting to be sent.
    await pool.query("ALTER TABLE notifications MODIFY COLUMN kind ENUM('opened', 'worse', 'closed', 'reminder', 'hold') NOT NULL");
    await pool.query("DELETE FROM schema_migrations WHERE id = '0017-monthly-report'");
    const device = await insertDevice(await insertCampus());
    await pool.query("INSERT INTO notifications (incident_id, device_id, kind, level, created_at, next_attempt_at) VALUES (NULL, ?, 'hold', 'warning', NOW(3), NOW(3))", [device]);

    assert.deepEqual(await runMigrations(pool), ['0017-monthly-report']);
    assert.equal(await kindType(), "enum('opened','worse','closed','reminder','hold','report')");
    await pool.query("DELETE FROM schema_migrations WHERE id = '0017-monthly-report'");
    assert.deepEqual(await runMigrations(pool), ['0017-monthly-report']);
    assert.equal(await kindType(), "enum('opened','worse','closed','reminder','hold','report')");
    const [rows] = await pool.query<RowDataPacket[]>('SELECT kind, device_id AS deviceId FROM notifications');
    assert.deepEqual(rows.map((r) => [r.kind, r.deviceId]), [['hold', device]]);
  });
});

describe('migration lock', () => {
  beforeEach(() => resetDatabase(pool));

  const extraTable = (id: string, table: string) => ({
    id,
    up: async (conn: PoolConnection) => {
      await conn.query(`CREATE TABLE ${table} (id INT PRIMARY KEY)`);
    },
  });

  /** A first runner that holds the lock until `release` is called. */
  async function holdLock(): Promise<{ release: () => Promise<void> }> {
    const conn = await pool.getConnection();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let acquired!: () => void;
    const holding = new Promise<void>((resolve) => (acquired = resolve));
    const run = withMigrationLock(conn, async () => {
      acquired();
      await gate;
    }).finally(() => conn.release());
    await holding;
    return {
      release: async () => {
        open();
        await run;
      },
    };
  }

  test('a second runner waits for the first to finish, then runs', async () => {
    const first = await holdLock();
    let settled = false;
    const second = runMigrations(pool, { list: [extraTable('0005-extra', 'extra')], lockWaitSeconds: 10 }).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(settled, false, 'the second runner is still waiting');
    assert.ok(!(await tableNames(pool)).includes('extra'));

    await first.release();
    assert.deepEqual(await second, ['0005-extra']);
    assert.ok((await tableNames(pool)).includes('extra'));
  });

  test('a second runner gives up after the wait rather than run alongside the first', async () => {
    const first = await holdLock();
    try {
      await assert.rejects(runMigrations(pool, { list: [extraTable('0005-extra', 'extra')], lockWaitSeconds: 1 }), MigrationLockError);
      assert.ok(!(await tableNames(pool)).includes('extra'));
    } finally {
      await first.release();
    }
  });

  test('the lock is released after a migration fails, so the next run is not blocked', async () => {
    const failing = { id: '0005-broken', up: async () => { throw new Error('boom'); } };
    await assert.rejects(runMigrations(pool, { list: [failing], lockWaitSeconds: 1 }), /boom/);
    assert.deepEqual(await runMigrations(pool, { list: [extraTable('0005-extra', 'extra')], lockWaitSeconds: 1 }), ['0005-extra']);
  });
});

describe('initial schema', () => {
  beforeEach(() => resetDatabase(pool));

  test('campus shortcode is unique, case-insensitively', async () => {
    await insertCampus('Central High', 'CHS');
    await assert.rejects(insertCampus('Other', 'chs'), /ER_DUP_ENTRY|Duplicate entry/);
  });

  test('device hostname is unique', async () => {
    const campus = await insertCampus();
    await insertDevice(campus, 'ESP_A1B2C3');
    await assert.rejects(insertDevice(campus, 'ESP_A1B2C3', 'MDF'), /ER_DUP_ENTRY|Duplicate entry/);
  });

  test('a device must belong to an existing campus, and a campus with devices cannot be deleted', async () => {
    await assert.rejects(insertDevice(9999), /foreign key/i);
    const campus = await insertCampus();
    await insertDevice(campus);
    await assert.rejects(pool.query('DELETE FROM campuses WHERE id = ?', [campus]), /foreign key/i);
  });

  test('deleting a device cascades to its readings', async () => {
    const campus = await insertCampus();
    const device = await insertDevice(campus);
    await pool.query('INSERT INTO readings (device_id, temp_f, humidity, recorded_at) VALUES (?, 72, 40, ?)', [device, new Date()]);
    await pool.query('DELETE FROM devices WHERE id = ?', [device]);
    const [rows] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM readings');
    assert.equal(rows[0].n, 0);
  });

  test('readings are indexed on device and recorded time', async () => {
    const byIndex = await readingsIndexes();
    assert.ok(
      [...byIndex.values()].some((cols) => cols[0] === 'device_id' && cols[1] === 'recorded_at'),
      `no (device_id, recorded_at) index; found ${JSON.stringify([...byIndex])}`,
    );
  });

  test('timestamps round-trip as UTC', async () => {
    const campus = await insertCampus();
    const device = await insertDevice(campus);
    const recordedAt = new Date('2026-01-15T23:30:00.000Z');
    await pool.query('INSERT INTO readings (device_id, temp_f, humidity, recorded_at) VALUES (?, 70, 35, ?)', [device, recordedAt]);

    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT recorded_at, DATE_FORMAT(recorded_at, '%Y-%m-%dT%H:%i:%s') AS raw, @@session.time_zone AS tz, UTC_TIMESTAMP() = NOW() AS session_is_utc FROM readings",
    );
    assert.equal((rows[0].recorded_at as Date).toISOString(), recordedAt.toISOString());
    assert.equal(rows[0].raw, '2026-01-15T23:30:00', 'stored value must be the UTC wall-clock time');
    assert.equal(rows[0].tz, '+00:00');
    assert.equal(rows[0].session_is_utc, 1);
  });

  test('a device created_at defaults to the current UTC time', async () => {
    const campus = await insertCampus();
    const device = await insertDevice(campus);
    const [rows] = await pool.query<RowDataPacket[]>('SELECT created_at FROM devices WHERE id = ?', [device]);
    const createdAt = rows[0].created_at as Date;
    assert.ok(Math.abs(createdAt.getTime() - Date.now()) < 5_000, `created_at ${createdAt.toISOString()} is not now`);
  });
});

describe('0004 readings recorded_at index', () => {
  beforeEach(() => resetDatabase(pool));

  test('readings are indexed on recorded time alone, for the retention job (docs/adr/0004)', async () => {
    const byIndex = await readingsIndexes();
    assert.ok(
      [...byIndex.values()].some((cols) => cols.length === 1 && cols[0] === 'recorded_at'),
      `no (recorded_at) index; found ${JSON.stringify([...byIndex])}`,
    );
  });
});

describe('0006 readings covering index', () => {
  beforeEach(() => resetDatabase(pool));

  test('the per-Device index carries id and temp_f, so a day maximum reads the index alone, and the old one is gone', async () => {
    const byIndex = await readingsIndexes();
    // id before temp_f: every latest-Reading query orders by (device_id, recorded_at, id), which must stay the index order.
    assert.deepEqual(byIndex.get('ix_readings_device_recorded_temp'), ['device_id', 'recorded_at', 'id', 'temp_f']);
    assert.equal(byIndex.has('ix_readings_device_recorded'), false, `found ${JSON.stringify([...byIndex])}`);
  });

  test('a run that died between adding the new index and dropping the old one finishes cleanly', async () => {
    await pool.query("DELETE FROM schema_migrations WHERE id = '0006-readings-covering-index'");
    await pool.query('ALTER TABLE readings ADD INDEX ix_readings_device_recorded (device_id, recorded_at)');
    assert.deepEqual(await runMigrations(pool), ['0006-readings-covering-index']);
    const byIndex = await readingsIndexes();
    assert.equal(byIndex.has('ix_readings_device_recorded'), false);
    assert.deepEqual(byIndex.get('ix_readings_device_recorded_temp'), ['device_id', 'recorded_at', 'id', 'temp_f']);
  });

  test('a database from before 0006 keeps its Readings and still cascades a Device delete', async () => {
    await pool.query("DELETE FROM schema_migrations WHERE id = '0006-readings-covering-index'");
    await pool.query(
      'ALTER TABLE readings ADD INDEX ix_readings_device_recorded (device_id, recorded_at), DROP INDEX ix_readings_device_recorded_temp',
    );
    const campus = await insertCampus();
    const device = await insertDevice(campus);
    await pool.query('INSERT INTO readings (device_id, temp_f, humidity, recorded_at) VALUES (?, 72, 40, ?), (?, 73, 41, ?)', [
      device,
      new Date('2026-10-01T00:00:00Z'),
      device,
      new Date('2026-10-01T00:00:30Z'),
    ]);
    assert.deepEqual(await runMigrations(pool), ['0006-readings-covering-index']);
    const [rows] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM readings');
    assert.equal(rows[0].n, 2);
    await pool.query('DELETE FROM devices WHERE id = ?', [device]);
    const [after] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM readings');
    assert.equal(after[0].n, 0);
  });
});
