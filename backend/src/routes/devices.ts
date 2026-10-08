import { Router } from 'express';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { RouteDeps } from '../deps';
import { isDuplicateKey, isMissingForeignRow } from '../db';
import { parseDevice, parseDeviceEdit } from '../deviceInput';
import { forgetPending, HOSTNAME, listPending, setIgnored } from '../pendingDevices';

export interface DeviceRow extends RowDataPacket {
  id: number;
  hostname: string;
  closet: string;
  campusId: number;
  campusName: string;
  campusShortcode: string;
  /** The sensor its board last said it carries (deviceInfo.ts); History shows it, the other routes leave it out. */
  sensor: string | null;
}

/** A Device with its Campus, as every route lists it. Append a WHERE or ORDER BY. */
export const SELECT_DEVICES = `
  SELECT d.id, d.hostname, d.closet, d.sensor,
         c.id AS campusId, c.name AS campusName, c.shortcode AS campusShortcode
  FROM devices d
  JOIN campuses c ON c.id = d.campus_id`;

export function toDevice({ id, hostname, closet, campusId, campusName, campusShortcode }: DeviceRow) {
  return { id, hostname, closet, campus: { id: campusId, name: campusName, shortcode: campusShortcode } };
}

/** Device routes: any signed-in user may list; adding, editing, deleting, and the rotation list need an Admin (auth.ts). */
export function devicesRouter({ pool, config, auth, rotation, sightings }: RouteDeps): Router {
  const router = Router();
  const adminOnly = auth.admin;

  router.get('/', async (_req, res, next) => {
    try {
      const [rows] = await pool.query<DeviceRow[]>(`${SELECT_DEVICES} ORDER BY c.name, d.closet, d.hostname`);
      res.json(rows.map((row) => ({ ...toDevice(row), tokenMismatchAt: sightings.mismatchedAt(row.hostname)?.toISOString() ?? null })));
    } catch (error) {
      next(error);
    }
  });

  // During a Device token rotation (DEVICE_TOKEN_PREVIOUS set): the Devices whose latest Reading
  // came with the previous token, and those not heard at all since the api started. Both lists
  // must be empty before the previous token is cleared (deploy.sh rotate-device-token --finish).
  router.get('/rotation', adminOnly, async (_req, res, next) => {
    const active = config.deviceTokenPrevious !== undefined;
    try {
      const [rows] = active ? await pool.query<DeviceRow[]>(`${SELECT_DEVICES} ORDER BY c.name, d.closet, d.hostname`) : [[]];
      const onPrevious = rotation.onPrevious();
      const heard = rotation.heardSince();
      res.json({
        active,
        since: rotation.since.toISOString(),
        previous: rows.filter((row) => onPrevious.has(row.hostname)).map(toDevice),
        unheard: rows.filter((row) => !heard.has(row.hostname)).map(toDevice),
      });
    } catch (error) {
      next(error);
    }
  });

  // Boards reporting with the Device token that are not registered yet (pendingDevices.ts): adopt one
  // by adding it (POST / below takes it off this list), hide it from the pop-up, or forget it.
  router.get('/pending', adminOnly, async (_req, res, next) => {
    try {
      res.json(await listPending(pool));
    } catch (error) {
      next(error);
    }
  });

  const pendingHostname = (raw: string): string | null => {
    const hostname = raw.trim().toUpperCase();
    return HOSTNAME.test(hostname) ? hostname : null;
  };

  router.patch('/pending/:hostname', adminOnly, async (req, res, next) => {
    const hostname = pendingHostname(String(req.params.hostname));
    const ignored = (req.body as Record<string, unknown> | undefined)?.ignored;
    if (typeof ignored !== 'boolean') {
      res.status(422).json({ error: 'ignored must be true or false' });
      return;
    }
    try {
      if (hostname === null || !(await setIgnored(pool, hostname, ignored))) {
        res.status(404).json({ error: 'No unregistered board with that hostname' });
        return;
      }
      res.json({ hostname, ignored });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/pending/:hostname', adminOnly, async (req, res, next) => {
    const hostname = pendingHostname(String(req.params.hostname));
    try {
      if (hostname === null || !(await forgetPending(pool, hostname))) {
        res.status(404).json({ error: 'No unregistered board with that hostname' });
        return;
      }
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.post('/', adminOnly, async (req, res, next) => {
    const parsed = parseDevice(req.body);
    if ('error' in parsed) {
      res.status(422).json({ error: parsed.error });
      return;
    }
    const { hostname, campusId, closet } = parsed;
    try {
      const [result] = await pool.query<ResultSetHeader>(
        'INSERT INTO devices (hostname, campus_id, closet) VALUES (?, ?, ?)',
        [hostname, campusId, closet],
      );
      const [rows] = await pool.query<DeviceRow[]>(`${SELECT_DEVICES} WHERE d.id = ?`, [result.insertId]);
      // Adopted: it is a Device now, no longer a board waiting.
      await forgetPending(pool, hostname);
      res.status(201).json(toDevice(rows[0]));
    } catch (error) {
      if (isDuplicateKey(error)) {
        res.status(409).json({ error: `A device with the hostname ${hostname} already exists` });
        return;
      }
      if (isMissingForeignRow(error)) {
        res.status(422).json({ error: 'That campus does not exist' });
        return;
      }
      next(error);
    }
  });

  // A Device's closet or campus can be corrected without losing its Readings. The hostname
  // cannot: it is how the board identifies itself, so a replaced board is a new Device.
  router.patch('/:id', adminOnly, async (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    const parsed = parseDeviceEdit(req.body);
    if ('error' in parsed) {
      res.status(422).json({ error: parsed.error });
      return;
    }
    const assignments: string[] = [];
    const values: Array<string | number> = [];
    if (parsed.closet !== undefined) {
      assignments.push('closet = ?');
      values.push(parsed.closet);
    }
    if (parsed.campusId !== undefined) {
      assignments.push('campus_id = ?');
      values.push(parsed.campusId);
    }
    try {
      const [result] = await pool.query<ResultSetHeader>(`UPDATE devices SET ${assignments.join(', ')} WHERE id = ?`, [
        ...values,
        id,
      ]);
      if (result.affectedRows === 0) {
        res.status(404).json({ error: 'Device not found' });
        return;
      }
      const [rows] = await pool.query<DeviceRow[]>(`${SELECT_DEVICES} WHERE d.id = ?`, [id]);
      res.json(toDevice(rows[0]));
    } catch (error) {
      if (isMissingForeignRow(error)) {
        res.status(422).json({ error: 'That campus does not exist' });
        return;
      }
      next(error);
    }
  });

  router.delete('/:id', adminOnly, async (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    try {
      // Readings go with the device: fk_readings_device is ON DELETE CASCADE.
      const [result] = await pool.query<ResultSetHeader>('DELETE FROM devices WHERE id = ?', [id]);
      if (result.affectedRows === 0) {
        res.status(404).json({ error: 'Device not found' });
        return;
      }
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
