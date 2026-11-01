import test from 'node:test';
import assert from 'node:assert/strict';
import { registerBrowserApi } from '../lib/browser-api.js';

const CONFIG = '/api/dsh-vibe-island/config';
const NEXT = '/api/dsh-vibe-island/next';

function registry({ failAt = 0, failDispose = false } = {}) {
  const routes = new Map();
  const removed = [];
  let attempts = 0;
  return {
    routes, removed,
    connection: { fetch: { register(route) {
      if (++attempts === failAt) throw new Error('register failed');
      if (routes.has(route.path)) throw new Error('duplicate');
      routes.set(route.path, route);
      return async () => {
        removed.push(route.path);
        routes.delete(route.path);
        if (failDispose) throw new Error('unregister failed');
      };
    } } },
  };
}

const callbacks = (overrides = {}) => ({
  readConfig: () => ({ notchEnabled: true }),
  writeConfig: raw => ({ ok: true, raw }),
  getBridge: () => ({ drain: () => [{ seq: 1 }] }),
  ...overrides,
});

function request(path, method, body, headers = {}) {
  return new Request('https://example.invalid' + path, { method, ...(body === undefined ? {} : { body }), headers });
}

async function call(route, req) {
  const response = await route.fetch(req);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-type'), /^application\/json/);
  return { status: response.status, body: await response.json() };
}

test('registers exact protected-carrier routes and disposes once in reverse order', async () => {
  const r = registry();
  const dispose = await registerBrowserApi(r.connection, callbacks());
  assert.deepEqual([...r.routes.keys()], [CONFIG, NEXT]);
  assert.deepEqual(r.routes.get(CONFIG).methods, ['GET', 'POST']);
  assert.deepEqual(r.routes.get(NEXT).methods, ['POST']);
  for (const route of r.routes.values()) assert.equal(route.requestBody, 'buffered');
  await Promise.all([dispose(), dispose()]);
  assert.deepEqual(r.removed, [NEXT, CONFIG]);
  assert.equal(r.routes.size, 0);
});

test('GET reads current config and errors do not leak', async () => {
  const r = registry();
  let n = 0;
  await registerBrowserApi(r.connection, callbacks({ readConfig: () => ({ n: ++n }) }));
  const route = r.routes.get(CONFIG);
  assert.deepEqual(await call(route, request(CONFIG, 'GET')), { status: 200, body: { ok: true, config: { n: 1 } } });
  assert.deepEqual(await call(route, request(CONFIG, 'GET')), { status: 200, body: { ok: true, config: { n: 2 } } });
  const broken = registry();
  await registerBrowserApi(broken.connection, callbacks({ readConfig: () => { throw new Error('secret'); } }));
  assert.deepEqual(await call(broken.routes.get(CONFIG), request(CONFIG, 'GET')), { status: 500, body: { ok: false, error: 'internal error' } });
});

test('POST passes exact raw JSON and preserves write result and failure', async () => {
  const r = registry();
  const raw = '{ "notchEnabled": true }';
  const result = { ok: true, config: { notchEnabled: true }, rejected: [{ key: 'x', why: 'unknown' }] };
  await registerBrowserApi(r.connection, callbacks({ writeConfig: value => { assert.equal(value, raw); return result; } }));
  assert.deepEqual(await call(r.routes.get(CONFIG), request(CONFIG, 'POST', raw, { 'content-type': 'Application/JSON; charset=utf-8' })), { status: 200, body: result });
  const failed = registry();
  const rejection = { ok: false, error: 'denied', rejected: [{ key: 'x' }] };
  await registerBrowserApi(failed.connection, callbacks({ writeConfig: async () => rejection }));
  assert.deepEqual(await call(failed.routes.get(CONFIG), request(CONFIG, 'POST', '{}', { 'content-type': 'application/json' })), { status: 400, body: rejection });
});

test('POST rejects wrong media type, invalid JSON and byte limits before write', async () => {
  const r = registry();
  let writes = 0;
  await registerBrowserApi(r.connection, callbacks({ writeConfig: () => { writes++; return { ok: true }; } }));
  const route = r.routes.get(CONFIG);
  const send = (body, headers) => call(route, request(CONFIG, 'POST', body, headers));
  assert.equal((await send('{}', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await send('{}', { 'content-type': 'application/jsonp' })).status, 415);
  assert.equal((await send('{', { 'content-type': 'application/json' })).status, 400);
  assert.equal((await send(new Uint8Array([0xff]), { 'content-type': 'application/json' })).status, 400);
  assert.equal((await send('"' + 'a'.repeat(65535) + '"', { 'content-type': 'application/json' })).status, 413);
  assert.equal((await send('{}', { 'content-type': 'application/json', 'content-length': '9999999999999999999999' })).status, 413);
  assert.equal(writes, 0);
  assert.equal((await send('"' + 'a'.repeat(65534) + '"', { 'content-type': 'application/json' })).status, 200);
  assert.equal(writes, 1);
  assert.equal((await send('"' + '中'.repeat(21845) + '"', { 'content-type': 'application/json' })).status, 413);
});

test('next drains only a ready owned bridge; no-op reused bridge is unavailable', async () => {
  const r = registry();
  let current = null;
  let drains = 0;
  await registerBrowserApi(r.connection, callbacks({ getBridge: () => current }));
  const route = r.routes.get(NEXT);
  const send = () => call(route, request(NEXT, 'POST'));
  assert.equal((await send()).status, 503);
  current = {};
  assert.equal((await send()).status, 503);
  current = { reused: true, drain: () => { drains++; return []; } };
  assert.equal((await send()).status, 503);
  assert.equal(drains, 0);
  current = { drain: () => { drains++; return [{ seq: drains }]; } };
  assert.deepEqual(await send(), { status: 200, body: { ok: true, items: [{ seq: 1 }] } });
  current = { drain: () => null };
  assert.equal((await send()).status, 503);
  current = { drain: () => { throw new Error('failure'); } };
  assert.equal((await send()).status, 503);
  assert.equal((await call(route, request(NEXT, 'GET'))).status, 405);
});

test('failed registration rolls back; cleanup failures remain visible', async () => {
  const first = registry({ failAt: 1 });
  await assert.rejects(registerBrowserApi(first.connection, callbacks()), /register failed/);
  assert.equal(first.routes.size, 0);
  const second = registry({ failAt: 2 });
  await assert.rejects(registerBrowserApi(second.connection, callbacks()), /register failed/);
  assert.deepEqual(second.removed, [CONFIG]);
  assert.equal(second.routes.size, 0);
  const broken = registry({ failAt: 2, failDispose: true });
  await assert.rejects(registerBrowserApi(broken.connection, callbacks()), error => error instanceof AggregateError && error.errors.length === 2);
  assert.equal(broken.routes.size, 0);
});

test('disposal attempts every unregister even when one fails', async () => {
  const r = registry({ failDispose: true });
  const dispose = await registerBrowserApi(r.connection, callbacks());
  await assert.rejects(dispose(), error => error instanceof AggregateError && error.errors.length === 2);
  assert.deepEqual(r.removed, [NEXT, CONFIG]);
  assert.equal(r.routes.size, 0);
  await assert.rejects(dispose());
  assert.equal(r.removed.length, 2);
});
