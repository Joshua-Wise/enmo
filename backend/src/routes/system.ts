import { Router } from 'express';
import type { RouteDeps } from '../deps';
import { measureDisk, systemHealth } from '../systemHealth';

const iso = (at: Date | null): string | null => (at === null ? null : at.toISOString());

/** When this process started, from its own uptime. */
const processStart = (): Date => new Date(Date.now() - Math.round(process.uptime() * 1000));

/**
 * GET /api/system — is the system itself OK (systemHealth.ts), for an Admin: what
 * /api/health, /api/notifications/status and /api/firmware/status know, plus the database's size,
 * free disk, the last backup, boards with weak WiFi, and the server's uptime and version. Each line
 * carries its status; the Settings page words it. 500 when the database cannot be read at all.
 */
export function systemRouter({ config, pool, auth, ingest, now = () => new Date(), diskSpace = () => measureDisk(), version, startedAt = processStart() }: RouteDeps): Router {
  const router = Router();
  router.get('/', auth.admin, async (_req, res, next) => {
    try {
      const health = await systemHealth({
        pool,
        now: now(),
        storing: !ingest.failing(),
        notificationsEnabled: config.notifications !== undefined,
        diskSpace,
        version,
        startedAt,
      });
      const { notifications, firmware, wifi } = health;
      res.json({
        ...health,
        checkedAt: health.checkedAt.toISOString(),
        backup: { ...health.backup, at: iso(health.backup.at) },
        notifications: {
          ...notifications,
          lastSent: notifications.lastSent === null ? null : { ...notifications.lastSent, at: notifications.lastSent.at.toISOString() },
          lastFailure: notifications.lastFailure === null ? null : { ...notifications.lastFailure, at: notifications.lastFailure.at.toISOString() },
        },
        firmware: { ...firmware, release: firmware.release === null ? null : { ...firmware.release, publishedAt: firmware.release.publishedAt.toISOString() } },
        wifi: { ...wifi, weak: wifi.weak.map((d) => ({ ...d, since: d.since.toISOString() })) },
        server: { ...health.server, startedAt: health.server.startedAt.toISOString() },
      });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
