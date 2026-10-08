import cors from 'cors';
import type { Request, RequestHandler } from 'express';
import type { Config } from './config';

/**
 * The one CORS policy for every route, SSE included. Requests without an Origin
 * (curl, firmware, monitors) pass. Browsers pass from the configured origin, and
 * from the API's own origin: behind the stack's nginx the page and `/api/` share
 * one host (docs/adr/0005), so no CORS_ORIGIN is needed there.
 */
export function corsMiddleware(config: Config): RequestHandler {
  return cors<Request>((req, callback) => {
    const origin = req.headers.origin;
    if (!origin || origin === config.corsOrigin || isOwnOrigin(origin, req.headers.host)) {
      callback(null, {
        origin: true,
        // The session cookie goes with a request from the allowed origin (the Vite dev server on
        // its own port); only from there, since every other origin is refused above.
        credentials: true,
        methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
      });
    } else {
      callback(new CorsError(origin));
    }
  });
}

/** True when the browser's Origin names the very host the request was sent to. */
function isOwnOrigin(origin: string, host: string | undefined): boolean {
  if (host === undefined) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export class CorsError extends Error {
  constructor(origin: string) {
    super(`Origin ${origin} is not allowed`);
    this.name = 'CorsError';
  }
}
