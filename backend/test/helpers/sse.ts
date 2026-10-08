/**
 * A minimal Server-Sent Events client over fetch, so tests can subscribe to the stream
 * exactly as a browser's EventSource would see it: headers first, then a sequence of
 * comments and messages separated by blank lines.
 */

import { TEST_ADMIN_TOKEN } from './server';

export type SseEvent = { kind: 'comment'; text: string } | { kind: 'message'; event: string; data: string } | { kind: 'retry'; ms: number };

export interface SseClient {
  readonly response: Response;
  /** The next event on the stream, or a rejection if none arrives within the timeout. */
  next(timeoutMs?: number): Promise<SseEvent>;
  /** The next message (skipping comments), parsed as JSON. */
  nextMessage<T>(timeoutMs?: number): Promise<T>;
  /** Every event that arrives during the window. */
  collect(windowMs: number): Promise<SseEvent[]>;
  /** Resolves when the stream ends, the server's doing or close(). */
  readonly ended: Promise<void>;
  /** Drop the connection, as a closed tab would. */
  close(): void;
}

function parseBlock(block: string): SseEvent {
  let event = 'message';
  const data: string[] = [];
  const comments: string[] = [];
  let retry: number | undefined;
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) comments.push(line.slice(1).trim());
    else if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    else if (line.startsWith('retry:')) retry = Number(line.slice(6).trim());
  }
  if (data.length === 0 && retry !== undefined) return { kind: 'retry', ms: retry };
  if (data.length === 0) return { kind: 'comment', text: comments.join('\n') };
  return { kind: 'message', event, data: data.join('\n') };
}

/**
 * Open the stream at `url` and wait until the response headers arrive. It needs a credential
 * (docs/adr/0010): the Admin token, unless `headers` carries a session cookie or its own Authorization.
 */
export async function subscribe(url: string, headers: Record<string, string> = {}): Promise<SseClient> {
  const controller = new AbortController();
  const credential = 'Cookie' in headers || 'Authorization' in headers ? {} : { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` };
  const response = await fetch(url, { headers: { Accept: 'text/event-stream', ...credential, ...headers }, signal: controller.signal });
  if (response.body === null) throw new Error('The stream has no body');

  const queue: SseEvent[] = [];
  const waiters: Array<(event: SseEvent) => void> = [];
  let buffer = '';
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();

  const deliver = (event: SseEvent) => {
    const waiter = waiters.shift();
    if (waiter) waiter(event);
    else queue.push(event);
  };

  const ended = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value.replace(/\r\n/g, '\n');
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          deliver(parseBlock(buffer.slice(0, boundary)));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // Aborted by close(); nothing more will arrive.
    }
  })();

  const next = (timeoutMs = 2000): Promise<SseEvent> => {
    const queued = queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const waiter = (event: SseEvent) => {
        clearTimeout(timer);
        resolve(event);
      };
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error(`No SSE event within ${timeoutMs}ms`));
      }, timeoutMs);
      waiters.push(waiter);
    });
  };

  return {
    response,
    next,
    ended,
    async nextMessage<T>(timeoutMs?: number): Promise<T> {
      for (;;) {
        const event = await next(timeoutMs);
        if (event.kind === 'message') return JSON.parse(event.data) as T;
      }
    },
    async collect(windowMs: number): Promise<SseEvent[]> {
      const events: SseEvent[] = [];
      const deadline = Date.now() + windowMs;
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return events;
        try {
          events.push(await next(remaining));
        } catch {
          return events;
        }
      }
    },
    close: () => controller.abort(),
  };
}
