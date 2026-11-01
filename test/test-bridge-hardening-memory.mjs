// All HTTP is emulated in memory; no socket may be opened.
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createIsolatedModule } from './isolated-module.mjs';
import { isolateBridgeEnvironment } from './bridge-sandbox.mjs';
const sandbox = isolateBridgeEnvironment();
const fixture = createIsolatedModule();
const originalCreate = http.createServer, originalRequest = http.request;
let bridge, handler, listens = [];
try {
  http.request = () => {
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => req.emit('error', Object.assign(new Error('closed'), { code: 'ECONNREFUSED' })));
    req.setTimeout = () => req; req.destroy = () => req; return req;
  };
  http.createServer = (fn) => {
    handler = fn;
    const server = new EventEmitter();
    server.listen = port => { listens.push(port); queueMicrotask(() => server.emit('listening')); };
    server.close = done => done?.(); return server;
  };
  const { startBridge } = await fixture.importModule();
  bridge = await startBridge({ port: 32008, nudges: { list() { throw new Error('simulated read failure'); } } });
  assert.ok(bridge);
  const call = (url, { method = 'GET', headers = {}, body = '' } = {}) => new Promise(resolve => {
    const req = new EventEmitter();
    Object.assign(req, { method, url, headers: { host: '127.0.0.1:32008', ...headers }, destroy() {} });
    const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(raw = '') { resolve({ status: this.status, headers: this.headers, raw }); } };
    handler(req, res);
    queueMicrotask(() => { req.emit('data', Buffer.from(body)); req.emit('end'); });
  });
  assert.equal((await call('/next')).status, 404, 'old destructive browser queue endpoint is gone');
  assert.equal((await call('/config')).status, 404, 'old unauthenticated config endpoint is gone');
  const failedRead = await call('/nudges');
  assert.equal(failedRead.status, 503, 'provider failure is not an authoritative empty list');
  assert.equal(JSON.parse(failedRead.raw).ok, false);
  assert.equal((await call('/config', { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await call('/health', { headers: { host: 'evil.example:32008' } })).status, 403);
  assert.equal((await call('/health', { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call('/health', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  const readme = await call('/readme');
  assert.equal(readme.headers['Access-Control-Allow-Origin'], undefined, 'native readme must not advertise wildcard CORS');
  assert.doesNotMatch(readme.raw, /\{ "all": true \}/, 'readme must not advertise forbidden bulk acknowledgement');
  const health = await call('/health');
  assert.equal(health.status, 200);
  assert.equal(health.headers['Access-Control-Allow-Origin'], undefined);
  assert.deepEqual(await startBridge({ port: 32008 }), { existingOwner: true }, 'second owner must not silently reuse first owner');
  assert.deepEqual(listens, [32008]);
  console.log('in-memory bridge hardening regression: passed');
} finally {
  await bridge?.close(); http.createServer = originalCreate; http.request = originalRequest;
  fixture.cleanup(); sandbox.cleanup();
}
