/**
 * Daily deletion of Readings past the retention window (docs/adr/0004), and of the incidents
 * that ended before it (docs/adr/0006): an incident is kept exactly as long as its Readings.
 * Notifications sent or given up on are kept a week, for the Settings status (docs/adr/0008).
 *
 * The window is `config.retentionDays` before now. Readings go in bounded batches, with a
 * short pause between full ones, so no single DELETE holds the table for long while Devices
 * keep writing. Nothing is rolled up first.
 */
import type { ResultSetHeader } from 'mysql2/promise';
import type { AppDeps } from './deps';
import { deleteIncidentsEndedBefore } from './incidentStore';
import { deleteNotificationsBefore, NOTIFICATION_KEEP_DAYS } from './outboxStore';

const DAY_MS = 86_400_000;
const DEFAULT_BATCH_SIZE = 5_000;
const DEFAULT_INTERVAL_MS = DAY_MS;
/** Breathing room for Device writes between one full batch and the next. */
const BATCH_PAUSE_MS = 100;

export interface RetentionOptions {
  /** Readings removed per DELETE statement. */
  batchSize?: number;
  /** How often a pass runs. Once a day. */
  intervalMs?: number;
  /** Where each pass reports how many Readings it removed. */
  log?: (line: string) => void;
  /** Where a failed pass is reported. The next pass still runs. */
  onError?: (error: unknown) => void;
}

export interface RetentionJob {
  /**
   * Stop the schedule, and a pass in flight after the batch it is deleting; resolves once it has.
   * A long pass (the first after a long outage) would otherwise outlast a shutdown.
   */
  stop(): Promise<void>;
}

type RetentionDeps = Pick<AppDeps, 'pool' | 'config' | 'now'>;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The instant before which a Reading is past the window. A Reading exactly at it stays. */
export function retentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * DAY_MS);
}

/**
 * Delete every Reading past the window, then every incident that ended before it (an ongoing
 * one stays however old), `batchSize` at a time, then every notification sent or given up on
 * more than a week ago, and log the totals. Returns the Readings removed. Once `signal` aborts,
 * the pass ends after the batch in flight; the next pass removes the rest.
 */
export async function deleteReadingsPastWindow(
  { pool, config, now = () => new Date() }: RetentionDeps,
  { batchSize = DEFAULT_BATCH_SIZE, log = console.log, signal }: Pick<RetentionOptions, 'batchSize' | 'log'> & { signal?: AbortSignal } = {},
): Promise<number> {
  const at = now();
  const cutoff = retentionCutoff(at, config.retentionDays);
  const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  /** Run `deleteBatch` until a batch comes up short or the pass is stopped; the total removed. */
  const inBatches = async (deleteBatch: () => Promise<number>): Promise<number> => {
    let total = 0;
    while (signal?.aborted !== true) {
      const affected = await deleteBatch();
      total += affected;
      if (affected < batchSize) break;
      await pause(BATCH_PAUSE_MS);
    }
    return total;
  };
  const removed = await inBatches(async () => {
    const [result] = await pool.query<ResultSetHeader>('DELETE FROM readings WHERE recorded_at < ? LIMIT ?', [cutoff, batchSize]);
    return result.affectedRows;
  });
  const incidents = await inBatches(() => deleteIncidentsEndedBefore(pool, cutoff, batchSize));
  if (signal?.aborted === true) {
    log(`retention: stopped after removing ${plural(removed, 'reading')}; the next pass removes the rest`);
    return removed;
  }
  // A week's worth is a few hundred rows at most, so one statement.
  const notifications = await deleteNotificationsBefore(pool, retentionCutoff(at, NOTIFICATION_KEEP_DAYS));
  log(
    `retention: removed ${plural(removed, 'reading')} and ${plural(incidents, 'incident')} older than ${cutoff.toISOString()} (${config.retentionDays} days), ` +
      `and ${plural(notifications, 'notification')} sent or given up on more than ${NOTIFICATION_KEEP_DAYS} days ago`,
  );
  return removed;
}

/**
 * Run a pass now and then once every interval. The pass at start means a backend that is
 * restarted daily still deletes daily. The timer never keeps the process alive on its own.
 */
export function startRetentionJob(deps: RetentionDeps, options: RetentionOptions = {}): RetentionJob {
  const { intervalMs = DEFAULT_INTERVAL_MS, onError = (error) => console.error('retention: pass failed:', error) } = options;
  const stopping = new AbortController();
  let inFlight: Promise<unknown> | undefined;

  // Passes never overlap: a tick during a long pass (the first after a long outage) is skipped.
  const tick = () => {
    if (inFlight !== undefined) return;
    inFlight = deleteReadingsPastWindow(deps, { ...options, signal: stopping.signal })
      .catch(onError)
      .finally(() => {
        inFlight = undefined;
      });
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();

  return {
    stop: async () => {
      clearInterval(timer);
      stopping.abort();
      await inFlight;
    },
  };
}
