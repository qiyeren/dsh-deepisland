// HTTP handler regression with in-memory request/server doubles: no sockets.
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createIsolatedModule } from './isolated-module.mjs';
import { isolateBridgeEnvironment } from './bridge-sandbox.mjs';

const sandbox = isolateBridgeEnvironment();
const fixture = createIsolatedModule();
const originalCreate = http.createServer;
const originalRequest = http.request;
let handler;
let bridge;
try {
  http.request = () => {
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => request.emit('error', new Error('mock absent')));
    request.setTimeout = () => request;
    request.destroy = () => request;
    return request;
  };
  http.createServer = (fn) => {
    handler = fn;
    const server = new EventEmitter();
    server.listen = () => queueMicrotask(() => server.emit('listening'));
    server.close = (done) => done?.();
    return server;
  };
  const { startBridge } = await fixture.importModule();
  let ackCount = 0;
  const items = [{ id: 'snapshot-a' }];
  bridge = await startBridge({ port: 32001, nudges: {
    list: () => items, rev: () => 'rev', config: () => ({}),
    ack: ids => { ackCount++; return ids.includes('snapshot-a') ? 1 : 0; },
    ackAll: () => { ackCount++; return items.length; },
  } });
  assert.ok(bridge && handler);
  const request = body => new Promise(resolve => {
    const req = new EventEmitter();
    Object.assign(req, { method: 'POST', url: '/nudge/ack', headers: { host: '127.0.0.1:32001', 'content-type': 'application/json' }, destroy() {} });
    const res = { writeHead(status) { this.status = status; }, end(raw) { resolve({ status: this.status, body: JSON.parse(raw) }); } };
    handler(req, res);
    queueMicrotask(() => { req.emit('data', Buffer.from(body)); req.emit('end'); });
  });
  assert.equal((await request('{"all":true}')).status, 400, 'unconditional acknowledge-all rejected');
  assert.equal((await request('{broken')).status, 400, 'malformed payload rejected');
  assert.equal((await request('{"ids":[]}')).status, 400, 'empty acknowledgement rejected');
  assert.equal(ackCount, 0, 'invalid requests must not mutate any queue');
  const valid = await request('{"ids":["snapshot-a"]}');
  assert.equal(valid.status, 200);
  assert.equal(valid.body.removed, 1);
  assert.equal(ackCount, 1);
  console.log('in-memory HTTP acknowledgement regression: passed');
} finally {
  await bridge?.close();
  http.createServer = originalCreate;
  http.request = originalRequest;
  fixture.cleanup();
  sandbox.cleanup();
}
