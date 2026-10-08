import type { Migration } from './index';
import { indexExists } from './introspect';

/**
 * The retention job deletes by `recorded_at` alone. Without this index each batch would walk
 * the clustered index, and old rows are scattered through it, one
 * block per Device (docs/adr/0002), so the walk would cover most of the table.
 * Guarded, so a run that built the index and died before being recorded can repeat.
 */
export const readingsRecordedAtIndex: Migration = {
  id: '0004-readings-recorded-at-index',
  async up(conn) {
    if (await indexExists(conn, 'readings', 'ix_readings_recorded')) return;
    await conn.query('CREATE INDEX ix_readings_recorded ON readings (recorded_at)');
  },
};
