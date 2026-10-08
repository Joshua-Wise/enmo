/**
 * Server-Sent Events to open dashboards (docs/adr/0001). One in-process set of connected
 * responses: the backend runs as a single process, so a Reading that arrives anywhere is
 * seen by every browser. A heartbeat comment keeps proxies from closing an idle stream;
 * reconnecting after a drop is the browser's EventSource doing what it does by default.
 * Every message is unnamed, its `data` a JSON object whose `type` says what it is: a `reading`,
 * a `fault` report, an `incident`, or `firmware`, a signal that firmware status can have changed.
 * A stopping server ends every stream, telling the browser to come back in 2 s (shutdown.ts).
 * Opening one needs a session or the Admin token (auth.ts); a stream opened by a session closes
 * when that session ends (sessions.ts), and the browser's reconnect is then refused.
 *
 * The response carries only the headers SSE needs. CORS is the shared middleware's job.
 */
import type { Request, RequestHandler, Response } from 'express';
import type { Condition, ConditionLevel, ConditionName } from './conditions';
import type { IncidentChange } from './incidents';
import type { Session } from './sessions';

/** A Reading as the API sends it: the dashboard payload, the 201 on ingest, and the stream all use this shape. */
export interface ReadingPayload {
  tempF: number;
  humidity: number | null;
  /** ISO instant in UTC. */
  recordedAt: string;
}

/** What every open dashboard receives when a Device posts a Reading. */
export interface ReadingEvent {
  type: 'reading';
  /** The Device's hostname; the browser matches its card on this. */
  device: string;
  reading: ReadingPayload;
  online: boolean;
  /** Worst first, as the dashboard payload carries them. */
  conditions: Condition[];
  /** ISO instant in UTC: this Reading is the Device's last report. */
  lastReportAt: string;
  /** The board is on its fallback network (firmware 7), as the dashboard payload says. */
  onFallbackNetwork: boolean;
}

/**
 * What every open dashboard receives when a Device posts a fault report (docs/adr/0009): its
 * sensor is not answering. No Reading came, so the card keeps its last one; its Conditions and
 * Online are new.
 */
export interface FaultEvent {
  type: 'fault';
  device: string;
  fault: 'sensor';
  online: boolean;
  /** Worst first, as the dashboard payload carries them. */
  conditions: Condition[];
  /** ISO instant in UTC: when the fault report arrived. */
  lastReportAt: string;
  /** The board is on its fallback network (firmware 7), as the dashboard payload says. */
  onFallbackNetwork: boolean;
}

/** An incident as the API sends it: GET /api/incidents and the stream's `incident` message both use this shape. */
export interface IncidentPayload {
  id: number;
  device: {
    id: number;
    hostname: string;
    closet: string;
    campus: { id: number; name: string; shortcode: string };
  };
  condition: ConditionName;
  /** The worst level the incident reached. */
  level: ConditionLevel;
  /** ISO instants in UTC; `end` is null while the incident is ongoing. */
  start: string;
  end: string | null;
  /** The worst Reading during the incident; for Offline and Sensor fault, the last good Reading before it. */
  peak: {
    /** °F for Hot and Cold, percent for Dry and Mold risk, null for Offline and Sensor fault. */
    value: number | null;
    tempF: number;
    humidity: number | null;
    recordedAt: string;
  };
  /** Oldest first; only the last can be open. */
  segments: { level: ConditionLevel; start: string; end: string | null }[];
  /** Who said they are on it, and when (ISO instant in UTC); null until someone does. */
  acknowledgement: AcknowledgementPayload | null;
}

/** An Acknowledgement as the API sends it: a free-text name or short note, and when it was given. */
export interface AcknowledgementPayload {
  by: string;
  at: string;
}

/**
 * What every open dashboard receives when an incident opens, changes level, or closes
 * (docs/adr/0006), or when someone acknowledges it.
 */
export interface IncidentEvent {
  type: 'incident';
  change: IncidentChange | 'acknowledged';
  incident: IncidentPayload;
}

/**
 * What every open dashboard receives when firmware status can have changed (docs/adr/0007): the
 * signal and nothing more. The status names WiFi networks and is an Admin's, while the stream is
 * every signed-in user's, so an open Firmware tab reads GET /api/firmware/status again.
 */
export interface FirmwareEvent {
  type: 'firmware';
}

/** Every message the stream carries, told apart by `type`. */
export type StreamEvent = ReadingEvent | FaultEvent | IncidentEvent | FirmwareEvent;

/** Whose a stream is: the session that opened it (auth.ts leaves it in res.locals.session). None for the Admin token. */
export interface StreamOwner {
  sessionId: string;
  userId: number;
}

export interface Broadcaster {
  /** Express handler for GET /api/dashboard/stream. */
  readonly handler: RequestHandler;
  /** Send one event to every connected client. */
  broadcast(event: StreamEvent): void;
  /**
   * Firmware status can have changed: a release published, widened, withdrawn or held, a board's
   * update check answered, a report moving where a board is on the way to it. One `firmware` event
   * goes out `firmwareEveryMs` after the first such change and says every change made until then,
   * so a fleet's Readings never flood the stream. Nothing while no one is listening.
   */
  firmwareChanged(): void;
  readonly firmwareEveryMs: number;
  /** How many dashboards are connected right now. */
  readonly clientCount: number;
  /** Close the streams opened by the sessions `which` picks, at once. Returns how many. */
  endStreams(which: (owner: StreamOwner) => boolean): number;
  /** Every session holding a stream open, once each. */
  streamSessions(): string[];
  readonly heartbeatMs: number;
  /** End every stream with a 2 s retry and refuse new ones, as the server stops (shutdown.ts). */
  close(): void;
}

export interface BroadcasterOptions {
  /** How often to send a heartbeat comment. Under most proxies' idle timeout. */
  heartbeatMs?: number;
  /** Streams one address may hold open; past it, 429. */
  maxStreamsPerAddress?: number;
  /** Streams the server holds open in all; past it, 503. */
  maxStreams?: number;
  /** The shortest time between two `firmware` events. */
  firmwareEveryMs?: number;
}

const DEFAULT_HEARTBEAT_MS = 25_000;
/** At most one `firmware` event a second: each costs every open Firmware tab a request. */
const DEFAULT_FIRMWARE_EVERY_MS = 1_000;
/**
 * A browser holds at most six HTTP/1.1 connections to one origin, so one technician's tabs fit with
 * room to spare. Per address, room for a wall of screens behind one NAT, or every browser behind a
 * TLS proxy before TRUST_PROXY is set: the load test held 60 streams with SSE adding 1 to 2 ms
 * (.scratch/prodtest/load.md). nginx's limit_conn matches it. Each stream is a socket here and two
 * in nginx, whose 1024 worker connections are the tighter bound, so the total stays well under that.
 */
export const DEFAULT_MAX_STREAMS_PER_ADDRESS = 60;
export const DEFAULT_MAX_STREAMS = 400;
/** How soon a dashboard whose stream a stop ended reconnects, to the next process. Browsers wait 3 to 5 s by default. */
const RECONNECT_AFTER_STOP_MS = 2_000;

export function createBroadcaster({
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  maxStreamsPerAddress = DEFAULT_MAX_STREAMS_PER_ADDRESS,
  maxStreams = DEFAULT_MAX_STREAMS,
  firmwareEveryMs = DEFAULT_FIRMWARE_EVERY_MS,
}: BroadcasterOptions = {}): Broadcaster {
  /** Each open stream, the address it counts against, and the session that opened it. */
  const clients = new Map<Response, { address: string; owner: StreamOwner | undefined }>();
  /** Open streams per address, as app.ts's trust proxy setting resolves it. */
  const perAddress = new Map<string, number>();
  let heartbeat: NodeJS.Timeout | undefined;
  /** Set while a `firmware` event is due: it says every change made before it goes. */
  let firmwareDue: NodeJS.Timeout | undefined;
  let closed = false;

  // The timer runs only while someone is listening, so an idle server holds no timer at all.
  const startHeartbeat = () => {
    if (heartbeat !== undefined) return;
    heartbeat = setInterval(() => {
      for (const res of clients.keys()) res.write(': heartbeat\n\n');
    }, heartbeatMs);
    heartbeat.unref();
  };
  const stopHeartbeatIfIdle = () => {
    if (clients.size > 0 || heartbeat === undefined) return;
    clearInterval(heartbeat);
    heartbeat = undefined;
  };

  // Once per stream, whether it closed from the browser's end or this one's.
  const drop = (res: Response) => {
    const client = clients.get(res);
    if (client === undefined) return;
    clients.delete(res);
    const left = (perAddress.get(client.address) ?? 1) - 1;
    if (left > 0) perAddress.set(client.address, left);
    else perAddress.delete(client.address);
    stopHeartbeatIfIdle();
  };

  const handler = (req: Request, res: Response) => {
    if (closed) {
      res.status(503).json({ error: 'The server is stopping; try again shortly.' });
      return;
    }
    const address = req.ip ?? '';
    const held = perAddress.get(address) ?? 0;
    if (held >= maxStreamsPerAddress) {
      res.status(429).json({ error: 'Too many open streams from this address; close a tab and try again.' });
      return;
    }
    if (clients.size >= maxStreams) {
      res.status(503).json({ error: 'The server is holding as many streams as it can; try again shortly.' });
      return;
    }
    perAddress.set(address, held + 1);

    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // nginx would otherwise buffer the stream and nothing would arrive until it closed.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    // A first comment so the browser's `open` event fires at once, before any Reading.
    res.write(': connected\n\n');

    const session = res.locals.session as Session | undefined;
    clients.set(res, { address, owner: session === undefined ? undefined : { sessionId: session.id, userId: session.user.id } });
    startHeartbeat();
    req.on('close', () => drop(res));
  };

  const broadcast = (event: StreamEvent) => {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients.keys()) res.write(frame);
  };

  return {
    handler,
    heartbeatMs,
    firmwareEveryMs,
    get clientCount() {
      return clients.size;
    },
    endStreams(which) {
      let ended = 0;
      for (const [res, { owner }] of clients) {
        if (owner === undefined || !which(owner)) continue;
        res.end();
        drop(res);
        ended += 1;
      }
      return ended;
    },
    streamSessions() {
      return [...new Set([...clients.values()].flatMap(({ owner }) => (owner === undefined ? [] : [owner.sessionId])))];
    },
    broadcast,
    firmwareChanged() {
      if (closed || clients.size === 0 || firmwareDue !== undefined) return;
      // At the end of the window, not its start, so a burst is one event, sent once all of it has committed.
      firmwareDue = setTimeout(() => {
        firmwareDue = undefined;
        broadcast({ type: 'firmware' });
      }, firmwareEveryMs);
      firmwareDue.unref();
    },
    close() {
      closed = true;
      for (const res of clients.keys()) res.end(`retry: ${RECONNECT_AFTER_STOP_MS}\n\n`);
      // At once, not as each socket closes: a Reading or a sweep pass still in flight broadcasts after this.
      clients.clear();
      if (heartbeat !== undefined) clearInterval(heartbeat);
      heartbeat = undefined;
      clearTimeout(firmwareDue);
      firmwareDue = undefined;
    },
  };
}
