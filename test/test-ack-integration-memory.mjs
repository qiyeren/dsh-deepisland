// Real Windows acknowledgement client + real host handler + real queue.
// Fake in-memory HTTP only. No sockets, profile, or real reminders.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createIsolatedModule } from './isolated-module.mjs';
import { isolateBridgeEnvironment } from './bridge-sandbox.mjs';
import { NudgeCenter } from '../lib/nudge.js';
const sandbox = isolateBridgeEnvironment();
const fixture = createIsolatedModule();
const origCreate = http.createServer, origRequest = http.request;
let handler, bridge;
try {
  http.request = () => { const req = new EventEmitter(); req.end = () => queueMicrotask(() => req.emit('error', new Error('no probe'))); req.setTimeout = () => req; req.destroy = () => req; return req; };
  http.createServer = fn => { handler = fn; const server = new EventEmitter(); server.listen = () => queueMicrotask(() => server.emit('listening')); server.close = cb => cb?.(); return server; };
  const { startBridge } = await fixture.importModule();
  const center = new NudgeCenter({});
  const item = center.push('completed', { sessionId: 'session-test', detail: 'fixture' });
  bridge = await startBridge({ port: 32001, nudges: { list: () => center.list(), rev: () => center.rev(), config: () => ({}), ack: ids => center.ack(ids) } });
  assert.ok(bridge && handler);
  const transport = { request(opts, cb) {
    const client = new EventEmitter(), incoming = new EventEmitter();
    incoming.method = opts.method; incoming.url = opts.path;
    incoming.headers = { host: '127.0.0.1:32001', 'content-type': opts.headers['Content-Type'] };
    incoming.destroy = () => {};
    let body = '';
    client.write = chunk => { body += chunk; };
    client.end = () => queueMicrotask(() => {
      const response = new EventEmitter();
      const outgoing = { writeHead(status) { response.statusCode = status; }, end(data) { cb(response); queueMicrotask(() => { if (data) response.emit('data', data); response.emit('end'); }); } };
      handler(incoming, outgoing);
      queueMicrotask(() => { if (body) incoming.emit('data', Buffer.from(body)); incoming.emit('end'); });
    });
    client.destroy = () => {};
    return client;
  } };
  const win = { exports: {} }; const localRequire = createRequire(import.meta.url);
  vm.runInNewContext(fs.readFileSync(new URL('../windows/src/nudges.js', import.meta.url), 'utf8'), { module: win, exports: win.exports, Buffer, console, require(name) { if (name === './bridge.js') return { bridgePort: () => 32001 }; return localRequire(name); } });
  const listed = await win.exports.fetchNudges({ httpImpl: transport });
  assert.equal(listed.ok, true, 'Windows fetch must accept the host response');
  assert.equal(listed.items[0].id, item.id, 'ID must survive transfer');
  const result = await win.exports.ack([listed.items[0].id], { httpImpl: transport });
  assert.equal(result.ok, true, 'Windows ack must accept the host response');
  assert.equal(result.removed, 1, 'exactly the selected reminder should be removed');
  assert.equal(center.list().length, 0);

  // A newer merged generation may replace the ID while the user is clicking.
  // Exercise the actual queue, host HTTP handler, and Windows diagnostics using
  // synthetic data only. This reproduces a possible symptom, not its live cause.
  center.push('completed', { sessionId: 'synthetic-race', detail: 'first' });
  const stale = (await win.exports.fetchNudges({ httpImpl: transport })).items[0];
  center.push('completed', { sessionId: 'synthetic-race', detail: 'second' });
  const current = center.list()[0];
  assert.notEqual(current.id, stale.id, 'merge must rotate the generation ID');
  const merged = (await win.exports.fetchNudges({ httpImpl: transport })).items[0];
  assert.match(stale.lineageId, /^[0-9a-f-]{36}$/i, 'lineage survives the HTTP boundary');
  assert.equal(merged.lineageId, stale.lineageId, 'merged generations share their opaque lineage');
  assert.equal(merged.generation, stale.generation + 1, 'merged generation advances');
  const other = new NudgeCenter({});
  assert.notEqual(other.push('completed', { sessionId: 'synthetic-race' }).lineageId, stale.lineageId, 'independent centers never reuse a lineage');
  other.dispose();
  let local = [stale];
  const diagnostic = await win.exports.acknowledgeItems([stale.id], {
    getItems: () => local,
    setItems: items => { local = items; },
    ack: ids => win.exports.ack(ids, { httpImpl: transport }),
    confirmed() {}, retain() {}, invalidate() {}, notify() {}, refresh() {}, warn() {},
  });
  assert.equal(diagnostic.ok, false);
  assert.equal(diagnostic.reason, 'not-found');
  assert.equal(local.length, 1, 'unconfirmed stale copy remains locally visible');
  assert.equal(center.list()[0].id, current.id, 'new server generation must survive');

  // Exercise the real Windows main-process reconciliation with the real
  // client + host handler over fake in-memory HTTP. No renderer or sockets.
  const mainSource = fs.readFileSync(new URL('../windows/src/main.js', import.meta.url), 'utf8');
  const begin = mainSource.indexOf('function probeNudges(cfg)');
  const end = mainSource.indexOf('\n/**', begin);
  assert.ok(begin >= 0 && end > begin, 'probe entry point must exist');
  let reconcileDone;
  const reconciled = new Promise(resolve => { reconcileDone = resolve; });
  const main = vm.createContext({
    Date, console,
    nudges: { fetchNudges: () => win.exports.fetchNudges({ httpImpl: transport }) },
    poke: () => reconcileDone(),
    stale,
  });
  vm.runInContext("let nudgeItems=[stale]; let nudgeRev=''; let nudgeFetchEpoch=0; let nudgeWarnKey=''; let nudgeAckInFlight=0; const retainedNudges=new Map([[stale.id,{...stale,_retainedAt:Date.now()}]]);", main);
  vm.runInContext(mainSource.slice(begin, end), main);
  vm.runInContext('probeNudges({nudgeMaxItems:8})', main);
  let timeout;
  try {
    await Promise.race([reconciled, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('reconciliation did not produce an updated snapshot')), 1000); })]);
  } finally { clearTimeout(timeout); }
  assert.deepEqual(Array.from(vm.runInContext('nudgeItems', main), entry => entry.id), [current.id], 'new generation replaces only the synthetic stale local copy');
  assert.equal(center.list()[0].id, current.id, 'reconciliation does not acknowledge the new generation');

  // A second explicit click on the fresh synthetic generation must succeed,
  // but the already-retained old local copy is a distinct ID and remains.
  local.push((await win.exports.fetchNudges({ httpImpl: transport })).items[0]);
  const fresh = await win.exports.acknowledgeItems([current.id], {
    getItems: () => local,
    setItems: items => { local = items; },
    ack: ids => win.exports.ack(ids, { httpImpl: transport }),
    confirmed() {}, retain() {}, invalidate() {}, notify() {}, refresh() {}, warn() {},
  });
  assert.equal(fresh.ok, true, 'fresh generation is acknowledged');
  assert.equal(center.list().length, 0, 'fresh generation leaves the server queue');
  assert.deepEqual(local.map(entry => entry.id), [stale.id], 'old copy still remains locally');
  console.log('in-memory Windows → host → queue normal and stale-generation cases: passed');
} finally {
  await bridge?.close(); http.createServer = origCreate; http.request = origRequest; fixture.cleanup(); sandbox.cleanup();
}
