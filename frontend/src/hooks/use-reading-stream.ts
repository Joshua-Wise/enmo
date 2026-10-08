import { useEffect, useRef, useState } from 'react';
import { getSession, openDashboardStream } from '@/api';
import { setSession } from '@/lib/session';
import { routeStreamMessage, type StreamHandlers } from '@/lib/streamMessage';

/**
 * connecting: no stream yet. live: Readings arrive as they happen.
 * reconnecting: the stream dropped and the browser is retrying; what is on screen may be behind.
 */
export type StreamStatus = 'connecting' | 'live' | 'reconnecting';

interface ReadingStreamHandlers extends StreamHandlers {
  /** The stream is open again after a drop. Reload, because anything sent meanwhile was missed. */
  onReconnect: () => void;
}

/** How long to wait before opening a new stream when the browser gave up on the old one. */
const REOPEN_AFTER_MS = 5_000;
/** At most one session check per this long, however often the stream drops. */
const CHECK_SESSION_EVERY_MS = 10_000;

/**
 * Subscribe to the live stream of Readings (and incidents, and firmware changes) for as long as the
 * component is mounted. Each message goes to the handler for its type; a page ignores the rest.
 * The browser's EventSource retries a dropped connection by itself; the one case it
 * gives up on (a non-200 answer, as from a proxy mid-restart) is reopened here after a
 * pause, so a dashboard on a wall screen never needs a hand. The server also ends the stream of a
 * session that has ended (signed out, disabled, expired), and refuses its reconnect: each drop asks
 * who is signed in, and a 401 takes the page to sign-in (api.ts).
 */
export function useReadingStream({ onReading, onFault, onIncident, onFirmware, onReconnect }: ReadingStreamHandlers): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>('connecting');
  // Handlers change identity on every render; the stream must not.
  const handlers = useRef({ onReading, onFault, onIncident, onFirmware, onReconnect });
  useEffect(() => {
    handlers.current = { onReading, onFault, onIncident, onFirmware, onReconnect };
  });

  useEffect(() => {
    let stream: EventSource | undefined;
    let reopenTimer: ReturnType<typeof setTimeout> | undefined;
    let dropped = false;
    let checkedAt = 0;
    const checkSession = () => {
      if (Date.now() - checkedAt < CHECK_SESSION_EVERY_MS) return;
      checkedAt = Date.now();
      getSession().then(setSession, () => {
        // A 401 has already ended the session; a server that did not answer is the stream's own retry to wait out.
      });
    };

    const open = () => {
      stream = openDashboardStream();
      stream.onopen = () => {
        setStatus('live');
        if (dropped) {
          dropped = false;
          handlers.current.onReconnect();
        }
      };
      stream.onmessage = (message: MessageEvent<string>) => routeStreamMessage(message.data, handlers.current);
      stream.onerror = () => {
        dropped = true;
        setStatus('reconnecting');
        checkSession();
        if (stream?.readyState === EventSource.CLOSED) {
          reopenTimer = setTimeout(open, REOPEN_AFTER_MS);
        }
      };
    };
    open();

    return () => {
      clearTimeout(reopenTimer);
      stream?.close();
    };
  }, []);

  return status;
}
