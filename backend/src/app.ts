import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { AppDeps, RouteDeps } from './deps';
import { createBroadcaster } from './sse';
import { createIngestHealth } from './ingestHealth';
import { createTokenRotation } from './tokenRotation';
import { createDeviceAuth } from './deviceAuth';
import { createAuth } from './auth';
import { createSessions } from './sessions';
import { createDeviceSightings } from './deviceSightings';
import { MonotonicStore } from './monotonicStore';
import { corsMiddleware, CorsError } from './cors';
import { healthRouter } from './routes/health';
import { campusesRouter } from './routes/campuses';
import { campusOverviewRouter } from './routes/campusOverview';
import { devicesRouter } from './routes/devices';
import { readingsRouter, dashboardRouter, historyRouter } from './routes/readings';
import { incidentsRouter } from './routes/incidents';
import { csvExportsRouter } from './routes/csvExports';
import { firmwareRouter } from './routes/firmware';
import { notificationsRouter } from './routes/notifications';
import { systemRouter } from './routes/system';
import { sessionRouter } from './routes/session';
import { usersRouter } from './routes/users';
import { createMailer } from './mailer';

/**
 * Per address per 15 minutes on /api/. Reads: 30 Campuses tabs, the busiest page, make about
 * 2,800 (.scratch/prodtest/security.md, TRUST_PROXY), so 6,000 leaves room for a wall of them.
 * Changes: everything that is not a GET or HEAD, apart from Readings.
 */
export const READ_LIMIT = 6000;
export const WRITE_LIMIT = 500;

/** The Express app, without a listening socket, so tests can drive it directly. */
export function createApp(appDeps: AppDeps): Express {
  const sightings = appDeps.sightings ?? createDeviceSightings();
  const sse = appDeps.sse ?? createBroadcaster();
  const sessions = createSessions({ pool: appDeps.pool, sse, now: appDeps.now });
  const deps: RouteDeps = {
    ...appDeps,
    sse,
    // Two Report intervals: long enough that a failure is seen by the next healthcheck, short enough to clear on its own.
    ingest: appDeps.ingest ?? createIngestHealth(2 * appDeps.config.reportIntervalSeconds * 1000),
    rotation: appDeps.rotation ?? createTokenRotation(),
    sightings,
    deviceAuth: createDeviceAuth(appDeps.config, sightings),
    mailer: appDeps.mailer ?? (appDeps.config.notifications === undefined ? undefined : createMailer(appDeps.config.notifications)),
    sessions,
    auth: createAuth(appDeps.config, sessions),
  };
  const app = express();
  // Naming the framework only helps someone matching it to an advisory.
  app.disable('x-powered-by');
  // One hop: nginx (the stack's web service, or the manual install's). nginx appends the address it
  // saw to whatever X-Forwarded-For the client sent, so only that last entry can be believed.
  app.set('trust proxy', 1);
  app.use(corsMiddleware(deps.config));
  app.use(express.json());

  // Two allowances per address. Reads are what open tabs make on their own: a Campuses tab reloads
  // up to every 10 s, about 90 requests per 15 minutes, so an office behind one NAT, or every
  // browser behind a TLS proxy without TRUST_PROXY, would exhaust a shared 500 with a handful of
  // tabs and see blank pages. Changes come from people at Settings and stay tight.
  // Both count on the monotonic clock, so a host clock step neither locks browsers out nor lets them off (monotonicStore.ts).
  const isRead = (req: Request) => req.method === 'GET' || req.method === 'HEAD';
  app.use(
    '/api/',
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: READ_LIMIT,
      store: new MonotonicStore(),
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Too many requests from this IP, please try again later.' },
      validate: false,
      skip: (req) => !isRead(req),
    }),
  );
  app.use(
    '/api/',
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: WRITE_LIMIT,
      store: new MonotonicStore(),
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Too many requests from this IP, please try again later.' },
      validate: false,
      // Readings have their own limit per Device (routes/readings.ts). Sixteen boards behind one
      // campus address would exhaust a per-address allowance at one Reading each per 30 seconds.
      skip: (req) => isRead(req) || (req.method === 'POST' && req.path === '/readings'),
    }),
  );

  app.use('/api/health', healthRouter(deps));
  app.use('/api/session', sessionRouter(deps));
  // Everything the pages read needs a signed-in user, or the Admin token (docs/adr/0010); each change
  // also an Admin, route by route. Readings and the firmware check take the Device token instead,
  // and health stays open to monitors. A new route under none of these prefixes is open: add it here.
  app.use(
    ['/api/campuses', '/api/devices', '/api/dashboard', '/api/incidents', '/api/incidents.csv', '/api/notifications', '/api/system', '/api/users'],
    deps.auth.signedIn,
  );
  app.use('/api/users', usersRouter(deps));
  app.use('/api/campuses/overview', campusOverviewRouter(deps));
  app.use('/api/campuses', campusesRouter(deps));
  // The CSV downloads sit beside the routes they export, not under them: /api/incidents.csv is not in /api/incidents.
  app.use('/api', csvExportsRouter(deps));
  app.use('/api/devices/:id/history', historyRouter(deps));
  app.use('/api/devices', devicesRouter(deps));
  app.use('/api/readings', readingsRouter(deps));
  app.use('/api/dashboard', dashboardRouter(deps));
  app.use('/api/incidents', incidentsRouter(deps));
  app.use('/api/firmware', firmwareRouter(deps));
  app.use('/api/notifications', notificationsRouter(deps));
  app.use('/api/system', systemRouter(deps));

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof CorsError) {
      res.status(403).json({ error: err.message });
      return;
    }
    if (err instanceof SyntaxError && 'status' in err && err.status === 400) {
      res.status(400).json({ error: 'Malformed JSON body' });
      return;
    }
    if (isClientHttpError(err)) {
      // The body parser's own refusals (413 too large, 415 unsupported charset, ...) keep their status.
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

/** An http-errors 4xx, as the body parser throws them, whose message is meant for the client. */
function isClientHttpError(err: unknown): err is { status: number; message: string } {
  if (typeof err !== 'object' || err === null) return false;
  const { status, expose } = err as { status?: unknown; expose?: unknown };
  return expose === true && typeof status === 'number' && status >= 400 && status < 500;
}
