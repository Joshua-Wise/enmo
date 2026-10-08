import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'mysql2/promise';
import { createTestPool, resetDatabase } from './helpers/database';
import { startServer, type RunningServer } from './helpers/server';
import { api, asAdmin, errorOf, json, type Campus } from './helpers/api';

describe('/api/campuses', () => {
  let pool: Pool;
  let server: RunningServer;
  let client: ReturnType<typeof api>;

  before(async () => {
    pool = createTestPool();
    server = await startServer(pool);
    client = api(server);
  });
  beforeEach(() => resetDatabase(pool));
  after(async () => {
    await server.close();
    await pool.end();
  });

  const url = (path = '') => client.campuses.url(path);
  const listed = () => client.campuses.list();
  const addCampus = (body: unknown, init?: RequestInit) => client.campuses.add(body, init);

  test('lists nothing on a fresh database', async () => {
    const response = await fetch(url(), asAdmin());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  });

  test('adds a campus with the Admin token and lists it back in camelCase', async () => {
    const created = await addCampus({ name: 'Central High School', shortcode: 'CHS' });
    assert.equal(created.status, 201);
    const body = await json<Campus>(created);
    assert.equal(typeof body.id, 'number');
    assert.deepEqual(body, { id: body.id, name: 'Central High School', shortcode: 'CHS' });

    assert.deepEqual(await listed(), [{ id: body.id, name: 'Central High School', shortcode: 'CHS' }]);
  });

  test('accepts a browser on the same origin with no CORS_ORIGIN configured, and still refuses another origin', async () => {
    // Behind the stack's nginx the page and /api/ share one origin, so the browser's Origin
    // names the very host it is talking to. That must pass without any CORS setting.
    const sameOrigin = await addCampus({ name: 'Central High School', shortcode: 'CHS' }, asAdmin({ headers: { Origin: server.url } }));
    assert.equal(sameOrigin.status, 201);
    const elsewhere = await addCampus({ name: 'Other', shortcode: 'OTH' }, asAdmin({ headers: { Origin: 'http://elsewhere.example' } }));
    assert.equal(elsewhere.status, 403);
    assert.equal((await listed()).length, 1);
  });

  test('rejects an add with no session or token with a distinct 401', async () => {
    const response = await addCampus({ name: 'Central High School', shortcode: 'CHS' }, {
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'Sign in first' });
    assert.deepEqual(await listed(), []);
  });

  test('rejects an add with the wrong token with 401', async () => {
    const response = await addCampus({ name: 'Central High School', shortcode: 'CHS' }, {
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' },
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'Not authorised' });
  });

  test('rejects a missing or blank name or shortcode with 422', async () => {
    for (const body of [{}, { name: 'X' }, { shortcode: 'X' }, { name: '  ', shortcode: 'X' }, { name: 'X', shortcode: '' }]) {
      const response = await addCampus(body);
      assert.equal(response.status, 422, JSON.stringify(body));
      assert.equal(typeof (await errorOf(response)), 'string');
    }
    assert.deepEqual(await listed(), []);
  });

  test('trims and upper-cases the shortcode', async () => {
    const response = await addCampus({ name: '  Central High School ', shortcode: ' chs ' });
    assert.equal(response.status, 201);
    const body = await json<Campus>(response);
    assert.equal(body.name, 'Central High School');
    assert.equal(body.shortcode, 'CHS');
  });

  test('rejects a duplicate shortcode with 409', async () => {
    await addCampus({ name: 'Central High School', shortcode: 'CHS' });
    const response = await addCampus({ name: 'Chester High', shortcode: 'chs' });
    assert.equal(response.status, 409);
    assert.match(await errorOf(response), /shortcode/i);
    assert.equal((await listed()).length, 1);
  });

  describe('recipients per Campus (docs/adr/0008)', () => {
    interface Recipients {
      id: number;
      notifyTo: string[];
    }
    const recipients = async () => json<Recipients[]>(await fetch(url('/recipients'), asAdmin()));
    const setRecipients = (id: number, notifyTo: unknown, init: RequestInit = asAdmin()) =>
      fetch(url(`/${id}`), { ...init, method: 'PATCH', body: JSON.stringify({ notifyTo }) });

    test('a campus may be added with its own list, read back only with the Admin token', async () => {
      const response = await addCampus({ name: 'Central High School', shortcode: 'CHS', notifyTo: ' chs-techs@district.example, ,lead@district.example ' });
      assert.equal(response.status, 201);
      const { id } = await json<Campus>(response);
      const other = await json<Campus>(await addCampus({ name: 'Maple High School', shortcode: 'MHS' }));
      assert.deepEqual(await recipients(), [
        { id, notifyTo: ['chs-techs@district.example', 'lead@district.example'] },
        { id: other.id, notifyTo: [] },
      ]);
      assert.deepEqual(await listed(), [
        { id, name: 'Central High School', shortcode: 'CHS' },
        { id: other.id, name: 'Maple High School', shortcode: 'MHS' },
      ], 'the list carries no addresses');
      assert.equal((await fetch(url('/recipients'))).status, 401);
    });

    test('a list is replaced by PATCH, as a comma-separated string or an array, and emptied to fall back on NOTIFY_TO', async () => {
      const { id } = await client.campuses.create();
      let response = await setRecipients(id, 'chs-techs@district.example');
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { id, name: 'Central High School', shortcode: 'CHS', notifyTo: ['chs-techs@district.example'] });
      response = await setRecipients(id, ['a@district.example', ' b@district.example ']);
      assert.deepEqual(await response.json(), { id, name: 'Central High School', shortcode: 'CHS', notifyTo: ['a@district.example', 'b@district.example'] });
      response = await setRecipients(id, '');
      assert.deepEqual(await response.json(), { id, name: 'Central High School', shortcode: 'CHS', notifyTo: [] });
      assert.deepEqual(await recipients(), [{ id, notifyTo: [] }]);
    });

    test('refuses anything that is not a bare address, as NOTIFY_TO does, and a list too long to store', async () => {
      const { id } = await client.campuses.create();
      for (const notifyTo of ['techs@district.example, not-an-address', 'Techs <techs@district.example>', 'a@b', 42, [1], { to: 'a@district.example' }]) {
        const response = await setRecipients(id, notifyTo);
        assert.equal(response.status, 422, JSON.stringify(notifyTo));
        assert.equal(typeof (await errorOf(response)), 'string');
      }
      assert.match(await errorOf(await setRecipients(id, 'techs@district.example, not-an-address')), /not an address: "not-an-address"/);
      assert.equal((await fetch(url(`/${id}`), { ...asAdmin(), method: 'PATCH', body: '{}' })).status, 422, 'no list at all is not taken as an empty one');
      const long = Array.from({ length: 60 }, (_, i) => `technician-${i}@district.example`).join(', ');
      assert.match(await errorOf(await setRecipients(id, long)), /1000 characters/);
      const added = await addCampus({ name: 'Maple High School', shortcode: 'MHS', notifyTo: 'nope' });
      assert.equal(added.status, 422);
      assert.deepEqual(await recipients(), [{ id, notifyTo: [] }], 'nothing stored, and no campus added');
    });

    test('needs the Admin token, and answers 404 for an unknown campus', async () => {
      const { id } = await client.campuses.create();
      assert.equal((await setRecipients(id, 'a@district.example', { headers: { 'Content-Type': 'application/json' } })).status, 401);
      assert.equal((await setRecipients(id + 1, 'a@district.example')).status, 404);
      assert.equal((await setRecipients(0, 'a@district.example')).status, 404);
      assert.deepEqual(await recipients(), [{ id, notifyTo: [] }]);
    });
  });

  describe('DELETE /api/campuses/:id', () => {
    const createId = async () => (await json<Campus>(await addCampus({ name: 'Central High School', shortcode: 'CHS' }))).id;

    test('deletes a campus with the Admin token', async () => {
      const id = await createId();
      const response = await fetch(url(`/${id}`), asAdmin({ method: 'DELETE' }));
      assert.equal(response.status, 204);
      assert.deepEqual(await listed(), []);
    });

    test('requires the Admin token', async () => {
      const id = await createId();
      const missing = await fetch(url(`/${id}`), { method: 'DELETE' });
      assert.equal(missing.status, 401);
      const wrong = await fetch(url(`/${id}`), { method: 'DELETE', headers: { Authorization: 'Bearer nope' } });
      assert.equal(wrong.status, 401);
      assert.equal((await listed()).length, 1);
    });

    test('returns 404 for an unknown or malformed id', async () => {
      assert.equal((await fetch(url('/999'), asAdmin({ method: 'DELETE' }))).status, 404);
      assert.equal((await fetch(url('/abc'), asAdmin({ method: 'DELETE' }))).status, 404);
    });

    test('refuses with 409 while devices still belong to the campus', async () => {
      const id = await createId();
      const device = await client.devices.add({ hostname: 'ESP_ABC123', campusId: id, closet: 'IDF 1' });
      assert.equal(device.status, 201);
      const response = await fetch(url(`/${id}`), asAdmin({ method: 'DELETE' }));
      assert.equal(response.status, 409);
      assert.match(await errorOf(response), /device/i);
      assert.equal((await listed()).length, 1);
    });
  });
});
