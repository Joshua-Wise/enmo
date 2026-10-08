import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'mysql2/promise';
import { createTestPool, resetDatabase } from './helpers/database';
import { startServer, testConfig, type RunningServer } from './helpers/server';
import { api, asAdmin, json, type RecordedReading } from './helpers/api';
import { subscribe, type SseClient } from './helpers/sse';
import { createBroadcaster, type FaultEvent, type ReadingEvent } from '../src/sse';

describe('GET /api/dashboard/stream', () => {
  let pool: Pool;
  let server: RunningServer;
  let client: ReturnType<typeof api>;
  let sse: ReturnType<typeof createBroadcaster>;
  const open: SseClient[] = [];

  before(() => {
    pool = createTestPool();
  });
  beforeEach(async () => {
    await resetDatabase(pool);
    // A short heartbeat so the test does not wait 25 seconds for one.
    sse = createBroadcaster({ heartbeatMs: 100 });
    server = await startServer(pool, testConfig(), { sse });
    client = api(server);
  });
  afterEach(async () => {
    for (const c of open.splice(0)) c.close();
    await server.close();
  });
  after(() => pool.end());

  const streamUrl = () => client.dashboard.url('/stream');
  const listen = async (headers?: Record<string, string>): Promise<SseClient> => {
    const c = await subscribe(streamUrl(), headers);
    open.push(c);
    return c;
  };
  const registerDevice = async (hostname = 'ESP_A1B2C3') => {
    const campus = await client.campuses.create();
    return client.devices.create(campus.id, hostname);
  };
  const postReading = async (device: string, temp: number, humidity: number): Promise<RecordedReading> => {
    const response = await client.readings.add({ device, temp, humidity });
    assert.equal(response.status, 201);
    return json<RecordedReading>(response);
  };

  test('is an event stream that stays open, with no wildcard CORS header', async () => {
    const stream = await listen();
    assert.equal(stream.response.status, 200);
    assert.match(stream.response.headers.get('content-type') ?? '', /^text\/event-stream/);
    assert.equal(stream.response.headers.get('cache-control'), 'no-cache');
    assert.equal(stream.response.headers.get('access-control-allow-origin'), null, 'no ad hoc wildcard: CORS comes from the shared middleware');
    // The first bytes are a comment so the browser sees the connection open at once.
    const first = await stream.next();
    assert.equal(first.kind, 'comment');
  });

  test('answers CORS through the shared middleware: the configured origin passes, others are refused', async () => {
    await server.close();
    server = await startServer(pool, testConfig({ corsOrigin: 'http://dashboard.example' }), { sse });
    client = api(server);

    const allowed = await listen({ Origin: 'http://dashboard.example' });
    assert.equal(allowed.response.status, 200);
    assert.equal(allowed.response.headers.get('access-control-allow-origin'), 'http://dashboard.example');

    const refused = await fetch(streamUrl(), { headers: { Origin: 'http://elsewhere.example' } });
    assert.equal(refused.status, 403);
  });

  test('sends a heartbeat comment on the configured interval', async () => {
    const stream = await listen();
    await stream.next(); // the opening comment
    const started = Date.now();
    const beat = await stream.next(1000);
    assert.equal(beat.kind, 'comment');
    assert.ok(Date.now() - started < 1000, 'the heartbeat arrived within the interval');
  });

  test('defaults to a heartbeat every 25 seconds', () => {
    assert.equal(createBroadcaster().heartbeatMs, 25_000);
  });

  test('broadcasts each ingested Reading with its Device, online flag and Conditions', async () => {
    await registerDevice('ESP_A1B2C3');
    const stream = await listen();
    await stream.next();

    const posted = await postReading('ESP_A1B2C3', 72, 40);
    const event = await stream.nextMessage<ReadingEvent>();
    assert.deepEqual(event, {
      type: 'reading',
      device: 'ESP_A1B2C3',
      reading: posted.reading,
      online: true,
      conditions: [],
      lastReportAt: posted.reading.recordedAt,
      onFallbackNetwork: false,
    });

    // A Reading in a Condition carries it, so the card can update its badges without a fetch.
    await postReading('ESP_A1B2C3', 91, 40);
    const hot = await stream.nextMessage<ReadingEvent>();
    assert.equal(hot.reading.tempF, 91);
    assert.deepEqual(hot.conditions, [{ name: 'Hot', level: 'critical' }]);
  });

  test('a Reading or fault report says whether the board is on its fallback network, so its card notes it at once', async () => {
    await registerDevice('ESP_A1B2C3');
    const stream = await listen();
    await stream.next();
    const add = async (body: Record<string, unknown>) => (await client.readings.add({ device: 'ESP_A1B2C3', ...body })).arrayBuffer();
    // The first says a version the server did not know, so a `firmware` event follows it a second later (firmwareStream.test.ts).
    const next = async <T extends { type: string }>(): Promise<T> => {
      for (;;) {
        const message = await stream.nextMessage<T>();
        if (message.type !== 'firmware') return message;
      }
    };

    await add({ temp: 72, humidity: 40, fw: 7, ssid: 'CISD-MAC', network: 2 });
    const reading = await next<ReadingEvent>();
    assert.equal(reading.onFallbackNetwork, true);
    assert.ok(!JSON.stringify(reading).includes('CISD-MAC'), 'the name stays behind the Admin token');

    await add({ fault: 'sensor', fw: 7, ssid: 'CISD-MAC', network: 2 });
    assert.equal((await next<FaultEvent>()).onFallbackNetwork, true);

    // A board that says nothing about itself (firmware 1 or 2) leaves what the server knows as it was.
    await add({ temp: 72, humidity: 40 });
    assert.equal((await next<ReadingEvent>()).onFallbackNetwork, true);

    await add({ temp: 72, humidity: 40, fw: 7, ssid: 'closet-net', network: 1 });
    assert.equal((await next<ReadingEvent>()).onFallbackNetwork, false);
  });

  test('every subscriber receives the same Reading from the one client set', async () => {
    await registerDevice('ESP_A1B2C3');
    const first = await listen();
    const second = await listen();
    await Promise.all([first.next(), second.next()]);
    assert.equal(sse.clientCount, 2);

    const posted = await postReading('ESP_A1B2C3', 70, 35);
    const [a, b] = await Promise.all([first.nextMessage<ReadingEvent>(), second.nextMessage<ReadingEvent>()]);
    assert.deepEqual(a, b);
    assert.deepEqual(a.reading, posted.reading);
  });

  test('a closed tab is dropped from the client set and later Readings still reach the rest', async () => {
    await registerDevice('ESP_A1B2C3');
    const leaving = await listen();
    const staying = await listen();
    await Promise.all([leaving.next(), staying.next()]);
    assert.equal(sse.clientCount, 2);

    leaving.close();
    await waitFor(() => sse.clientCount === 1, 'the closed connection to be removed');

    const posted = await postReading('ESP_A1B2C3', 70, 35);
    assert.deepEqual((await staying.nextMessage<ReadingEvent>()).reading, posted.reading);
  });

  test('a rejected Reading is not broadcast', async () => {
    await registerDevice('ESP_A1B2C3');
    const stream = await listen();
    await stream.next();

    assert.equal((await client.readings.add({ device: 'ESP_FFFFFF', temp: 70, humidity: 35 })).status, 404);
    assert.equal((await client.readings.add({ device: 'ESP_A1B2C3', temp: 'warm', humidity: 35 })).status, 422);
    // Over the next few heartbeats, nothing but heartbeats.
    const events = await stream.collect(400);
    assert.ok(events.length > 0, 'the stream is still alive');
    assert.ok(events.every((e) => e.kind === 'comment'), `unexpected ${JSON.stringify(events)}`);
  });

  test('close ends every stream, telling the browser to reconnect in 2 s, and refuses new ones (shutdown.ts)', async () => {
    await registerDevice('ESP_A1B2C3');
    const first = await listen();
    const second = await listen();
    await Promise.all([first.next(), second.next()]);

    sse.close();
    for (const stream of [first, second]) {
      assert.deepEqual(await stream.next(), { kind: 'retry', ms: 2000 });
      await stream.ended;
    }
    assert.equal(sse.clientCount, 0);

    const refused = await fetch(streamUrl(), asAdmin());
    assert.equal(refused.status, 503);
    assert.deepEqual(await refused.json(), { error: 'The server is stopping; try again shortly.' });
    // A Reading in flight at the stop still reaches the broadcaster, which has no one left to write to.
    await postReading('ESP_A1B2C3', 70, 35);
  });
});

async function waitFor(condition: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
