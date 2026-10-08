import { Router, type Request } from 'express';
import { parseAcknowledgement } from '../acknowledgementInput';
import type { RouteDeps } from '../deps';
import { acknowledgeIncident, incidentsById, incidentsOverlapping } from '../incidentStore';

/** The longest window one request may ask for: a week, and a day to spare for the edges. */
export const MAX_WINDOW_DAYS = 8;
const DAY_MS = 86_400_000;

interface Window {
  from: Date;
  to: Date;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function instant(query: Request['query'], name: string): Date | { error: string } {
  const raw = query[name];
  if (typeof raw !== 'string' || raw.trim() === '') return { error: `${name} is required, an ISO instant like 2026-10-05T06:00:00Z` };
  const value = raw.trim();
  const date = new Date(value);
  if (!ISO_INSTANT.test(value) || Number.isNaN(date.getTime())) return { error: `${name} must be an ISO instant with a zone, like 2026-10-05T06:00:00Z; got ${value}` };
  return date;
}

/** The window asked for by `?from=` and `?to=`, at most `maxDays` long, or the message explaining why there is none. */
export function parseWindow(query: Request['query'], maxDays = MAX_WINDOW_DAYS): Window | { error: string } {
  const from = instant(query, 'from');
  if ('error' in from) return from;
  const to = instant(query, 'to');
  if ('error' in to) return to;
  if (from.getTime() >= to.getTime()) return { error: 'from must be before to' };
  if (to.getTime() - from.getTime() > maxDays * DAY_MS) return { error: `The window can be at most ${maxDays} days` };
  return { from, to };
}

/** The largest BIGINT UNSIGNED a JavaScript number holds exactly; any id past it names no incident. */
const MAX_ID = Number.MAX_SAFE_INTEGER;

/**
 * Incident log (GET /api/incidents?from=&to=): every incident that overlaps the window, the
 * ongoing ones included, oldest first. Public, like the dashboard.
 *
 * Acknowledge (POST /api/incidents/:id/acknowledge, an Admin, `{by}`): a technician says they
 * are on an open incident. The first acknowledgement stands; a repeat answers the incident as it
 * is. Every open dashboard hears of it on the stream.
 */
export function incidentsRouter({ pool, config, sse, auth, now = () => new Date() }: RouteDeps): Router {
  const router = Router();
  const adminOnly = auth.admin;

  router.get('/', async (req, res, next) => {
    const window = parseWindow(req.query);
    if ('error' in window) {
      res.status(422).json({ error: window.error });
      return;
    }
    try {
      const incidents = await incidentsOverlapping(pool, window.from, window.to);
      res.json({ from: window.from.toISOString(), to: window.to.toISOString(), incidents });
    } catch (error) {
      next(error);
    }
  });

  router.post('/:id/acknowledge', adminOnly, async (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0 || id > MAX_ID) {
      res.status(404).json({ error: 'Incident not found' });
      return;
    }
    const parsed = parseAcknowledgement(req.body);
    if ('error' in parsed) {
      res.status(422).json({ error: parsed.error });
      return;
    }
    try {
      // To the second, as the incident's own times are stored.
      const at = new Date(Math.floor(now().getTime() / 1000) * 1000);
      const result = await acknowledgeIncident(pool, id, parsed.by, at);
      if (result === 'missing') {
        res.status(404).json({ error: 'Incident not found' });
        return;
      }
      if (result === 'ended') {
        res.status(409).json({ error: 'This incident has ended, so there is nothing left to acknowledge' });
        return;
      }
      const [incident] = await incidentsById(pool, [id]);
      if (incident === undefined) {
        // Its Device was deleted in between.
        res.status(404).json({ error: 'Incident not found' });
        return;
      }
      if (result === 'acknowledged') sse.broadcast({ type: 'incident', change: 'acknowledged', incident });
      res.json(incident);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
