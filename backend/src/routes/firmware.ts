import express, { Router } from 'express';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { RouteDeps } from '../deps';
import { notePending } from '../pendingDevices';
import { conditionsFor } from '../conditions';
import { onFallbackNetwork } from '../deviceInfo';
import {
  currentRelease,
  FirmwareImageError,
  holdText,
  MAX_IMAGE_BYTES,
  offeredTo,
  offers,
  publishFirmware,
  releaseImage,
  releaseProgress,
  widenRelease,
  withdrawFirmware,
  type DeviceProgress,
  type FirmwareRelease,
} from '../firmwareStore';
import { CLEAN_REPORTS_TO_WIDEN, readyFor } from '../rollout';

/** `5C:CF:7F:A1:B2:C3`, as the ESP8266 update library sends its station MAC. */
const MAC = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i;

/** The Device's hostname from its MAC: `ESP_` and the last six hex digits, as the firmware names itself. */
const hostnameOf = (mac: string): string => `ESP_${mac.replace(/:/g, '').slice(-6).toUpperCase()}`;

interface StatusRow extends RowDataPacket {
  id: number;
  hostname: string;
  closet: string;
  campusId: number;
  campusName: string;
  campusShortcode: string;
  firmwareVersion: number | null;
  checkedAt: Date | null;
  rssi: number | null;
  uptimeSeconds: number | null;
  freeHeap: number | null;
  resetReason: string | null;
  updateResult: string | null;
  sensor: string | null;
  ssid: string | null;
  wifiNetwork: number | null;
  infoAt: Date | null;
  lastReportAt: Date | null;
  sensorFaults: number;
  cleanReports: number;
}

/**
 * Over-the-air firmware (docs/adr/0007). GET /api/firmware is the boards' hourly check, behind the
 * Device token (as Basic `device:<token>`, all the ESP8266 update library can send): 304 when there is
 * nothing newer for that board, else the signed image, which the board verifies before booting it.
 * GET /api/firmware/status is the Admin's view of the release, who it is offered to and where each
 * of them is on the way to it, every Device's version, and how the named Devices of a staged release
 * are doing. POST /api/firmware publishes a signed build from the Settings page (`?only=ESP_A,ESP_B`
 * for named Devices first, each a registered Device), POST /api/firmware/widen offers a staged one to
 * every Device, and DELETE withdraws it, all as an Admin (an Admin's session or the Admin token). Publishing and widening answer
 * with the release and who it is now offered to. Each of these, and each check a board makes, tells
 * open Firmware tabs over the stream that the status can have changed (sse.ts, firmwareChanged).
 */
export function firmwareRouter({ pool, config, sse, auth, deviceAuth, now = () => new Date() }: RouteDeps): Router {
  const router = Router();

  router.get('/', ...deviceAuth, async (req, res, next) => {
    const mac = req.header('x-esp8266-sta-mac') ?? '';
    if (!MAC.test(mac)) {
      res.status(400).json({ error: 'A firmware check needs the x-ESP8266-STA-MAC header' });
      return;
    }
    const hostname = hostnameOf(mac);
    const reported = Number(req.header('x-esp8266-version'));
    const version = Number.isInteger(reported) && reported >= 0 ? reported : 0;
    try {
      // A board on another version than it last said starts its count of clean Readings again (rollout.ts).
      const [result] = await pool.query<ResultSetHeader>(
        `UPDATE devices SET firmware_clean_reports = IF(firmware_version <=> ?, firmware_clean_reports, 0),
           firmware_version = ?, firmware_checked_at = UTC_TIMESTAMP() WHERE hostname = ?`,
        [version, version, hostname],
      );
      if (result.affectedRows === 0) {
        await notePending(pool, { hostname, reading: null, address: req.ip ?? null });
        res.status(404).json({ error: `No device is registered with the hostname ${hostname}` });
        return;
      }
      // A check moves the board's line on the Firmware tab, whatever the answer; the event goes out a second from now.
      sse.firmwareChanged();
      const release = await currentRelease(pool);
      if (!offers(release, hostname, version)) {
        res.status(304).end();
        return;
      }
      const image = await releaseImage(pool);
      if (image === null || release === null) {
        res.status(304).end();
        return;
      }
      // When it took the build, to the millisecond: a staged release is held if it fails it from here (firmwareStore.ts).
      await pool.query('UPDATE devices SET firmware_sent_at = ? WHERE hostname = ?', [now(), hostname]);
      res.set({ 'Content-Type': 'application/octet-stream', 'x-MD5': release.md5, 'Content-Length': String(image.length) });
      res.status(200).end(image);
    } catch (error) {
      next(error);
    }
  });

  const adminOnly = auth.admin;
  const toJson = async (release: FirmwareRelease) => ({
    ...release,
    publishedAt: release.publishedAt.toISOString(),
    widenedAt: release.widenedAt?.toISOString() ?? null,
    hold: release.hold === null ? null : { ...release.hold, at: release.hold.at.toISOString() },
    offeredTo: await offeredTo(pool, release),
  });
  const iso = (at: Date | null): string | null => at?.toISOString() ?? null;
  const progressJson = ({ nextCheck, sentAt, lastReportAt, ...rest }: DeviceProgress) => ({
    ...rest,
    nextCheck: nextCheck === null ? null : { by: nextCheck.by, at: iso(nextCheck.at) },
    sentAt: iso(sentAt),
    lastReportAt: iso(lastReportAt),
  });

  router.post('/', adminOnly, express.raw({ type: 'application/octet-stream', limit: MAX_IMAGE_BYTES }), async (req, res, next) => {
    const image = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const only = typeof req.query.only === 'string' && req.query.only.trim() !== '' ? req.query.only.split(',') : undefined;
    try {
      res.status(201).json(await toJson(await publishFirmware(pool, image, only)));
      sse.firmwareChanged();
    } catch (error) {
      if (error instanceof FirmwareImageError) {
        res.status(422).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  // "Release to all" on the Firmware tab. Not gated on the named Devices being ready: the tab offers it
  // only then, and the Admin may know better; a held release is refused, since only withdrawing it or
  // publishing a higher version moves it on.
  router.post('/widen', adminOnly, async (_req, res, next) => {
    try {
      const release = await widenRelease(pool, now());
      if (release === null) {
        res.status(404).json({ error: 'No firmware is published' });
        return;
      }
      if (release.hold !== null) {
        res.status(409).json({ error: `Version ${release.version} is held: ${holdText(release.hold)}. Withdraw it, or publish a fixed build with a higher version.` });
        return;
      }
      res.json(await toJson(release));
      sse.firmwareChanged();
    } catch (error) {
      next(error);
    }
  });

  router.delete('/', adminOnly, async (_req, res, next) => {
    try {
      await withdrawFirmware(pool);
      res.status(204).end();
      sse.firmwareChanged();
    } catch (error) {
      next(error);
    }
  });

  router.get('/status', adminOnly, async (_req, res, next) => {
    try {
      const release = await currentRelease(pool);
      const [rows] = await pool.query<StatusRow[]>(`
        SELECT d.id, d.hostname, d.closet, d.firmware_version AS firmwareVersion, d.firmware_checked_at AS checkedAt,
               d.rssi, d.uptime_s AS uptimeSeconds, d.free_heap AS freeHeap, d.reset_reason AS resetReason,
               d.update_result AS updateResult, d.sensor, d.wifi_ssid AS ssid, d.wifi_network AS wifiNetwork, d.info_at AS infoAt, d.last_report_at AS lastReportAt,
               d.sensor_faults AS sensorFaults, d.firmware_clean_reports AS cleanReports,
               c.id AS campusId, c.name AS campusName, c.shortcode AS campusShortcode
        FROM devices d JOIN campuses c ON c.id = d.campus_id
        ORDER BY c.name, d.closet, d.hostname`);
      const at = now();
      const rules = { reportIntervalSeconds: config.reportIntervalSeconds, thresholds: config.thresholds };
      const byHostname = new Map(rows.map((row) => [row.hostname, row]));
      // How each named Device of a staged release is doing, held or not: what "Release to all" waits on.
      const staged =
        release === null || release.stage !== 'named' || release.staged === null
          ? null
          : release.staged.map((hostname) => {
              const row = byHostname.get(hostname);
              if (row === undefined) return { hostname, id: null, firmwareVersion: null, lastReportAt: null, conditions: null, cleanReports: 0, ready: false };
              const secondsSinceReport = row.lastReportAt === null ? null : Math.max(0, Math.floor((at.getTime() - row.lastReportAt.getTime()) / 1000));
              return {
                hostname,
                id: row.id,
                firmwareVersion: row.firmwareVersion,
                lastReportAt: row.lastReportAt?.toISOString() ?? null,
                // Its health as a hold watches it: Offline, Sensor fault, or neither (Online). No Reading
                // is judged here, so Hot, Cold, Dry and Mold risk never appear.
                conditions: conditionsFor({ reading: null, secondsSinceReport, sensorFaults: row.sensorFaults, ...rules }),
                cleanReports: row.cleanReports,
                ready: readyFor(release.version, row),
              };
            });
      const progress = release === null ? null : await releaseProgress(pool, release, at, rules);
      res.json({
        release: release === null ? null : await toJson(release),
        // Where each Device it is offered to is on the way to it, stuck ones first (rollout.ts, progressOf).
        progress: progress === null ? null : { cleanReportsToWiden: CLEAN_REPORTS_TO_WIDEN, devices: progress.map(progressJson) },
        rollout:
          release === null || staged === null
            ? null
            : { cleanReportsToWiden: CLEAN_REPORTS_TO_WIDEN, devices: staged, ready: release.hold === null && staged.every((d) => d.ready) },
        devices: rows.map(({ id, hostname, closet, campusId, campusName, campusShortcode, firmwareVersion, checkedAt, ...rest }) => ({
          id,
          hostname,
          closet,
          campus: { id: campusId, name: campusName, shortcode: campusShortcode },
          firmwareVersion,
          checkedAt: checkedAt === null ? null : checkedAt.toISOString(),
          // The latest a board said about itself with a Reading (deviceInfo.ts); null for older firmware.
          info:
            rest.infoAt === null
              ? null
              : {
                  rssi: rest.rssi,
                  uptimeSeconds: rest.uptimeSeconds,
                  freeHeap: rest.freeHeap,
                  resetReason: rest.resetReason,
                  updateResult: rest.updateResult,
                  sensor: rest.sensor,
                  // The network it is on (firmware 7), and whether that is its fallback; null before.
                  ssid: rest.ssid,
                  fallback: rest.wifiNetwork === null ? null : onFallbackNetwork(rest.wifiNetwork),
                  at: rest.infoAt.toISOString(),
                },
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
