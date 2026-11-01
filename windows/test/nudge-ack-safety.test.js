'use strict';
// Pure mock tests: no sockets, Electron, bridge file, profile, or runtime.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = (name) => fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');
const nudgesModule = { exports: {} };
vm.runInNewContext(src('nudges.js'), {
  module: nudgesModule, exports: nudgesModule.exports, Buffer,
  require(name) {
    if (name === 'node:http' || name === 'http') return { request() { throw Error('socket forbidden'); } };
    if (name === './bridge.js') return { bridgePort() { return 12345; } };
    throw Error('unexpected require ' + name);
  },
});
const { acknowledgeItems } = nudgesModule.exports;
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
function fixture(ack) {
  let items = [{ id: 'old' }, { id: 'keep' }];
  const calls = [];
  const effects = {
    getItems: () => items,
    setItems: (value) => { items = value; },
    ack,
    confirmed: () => {},
    retain: () => {},
    invalidate: () => calls.push('invalidate'),
    notify: () => calls.push('notify'),
    refresh: () => calls.push('refresh'),
    warn: () => calls.push('warn'),
  };
  return { effects, calls, get items() { return items; }, set items(value) { items = value; } };
}
async function testWireCounts() {
  const { EventEmitter } = require('node:events');
  function fakeHttp(removed) {
    return { request(options, callback) {
      assert.equal(options.path, '/nudge/ack');
      const req = new EventEmitter();
      req.write = () => {};
      req.end = () => {
        const res = new EventEmitter(); res.statusCode = 200; callback(res);
        res.emit('data', JSON.stringify({ plugin: nudgesModule.exports.PLUGIN_NAME, ok: true, removed, remaining: 0 }));
        res.emit('end');
      };
      return req;
    } };
  }
  assert.equal((await nudgesModule.exports.ack(['x'], { httpImpl: fakeHttp(1) })).removed, 1);
  for (const bad of [undefined, 1.5, -1, '1']) {
    assert.equal((await nudgesModule.exports.ack(['x'], { httpImpl: fakeHttp(bad) })).ok, false);
  }
}
async function testMainPolicy() {
  for (const response of [{ ok: false, reason: 'network' }, { ok: true, removed: 0 }, { ok: true }, null]) {
    const f = fixture(async () => response);
    const result = await acknowledgeItems(['old'], f.effects);
    assert.equal(result.ok, false);
    assert.deepEqual(Array.from(f.items, (x) => x.id), ['old', 'keep']);
    assert.deepEqual(f.calls, ['invalidate', 'warn', 'invalidate', 'notify', 'refresh']);
  }
  const missing = fixture(async () => ({ ok: true, removed: 0 }));
  assert.equal((await acknowledgeItems(['old'], missing.effects)).reason, 'not-found');
  const disconnected = fixture(async () => ({ ok: false, reason: 'network' }));
  assert.equal((await acknowledgeItems(['old'], disconnected.effects)).reason, 'network');
  const waiting = deferred();
  const f = fixture(async () => waiting.promise);
  const pending = acknowledgeItems(['old'], f.effects);
  assert.deepEqual(Array.from(f.items, (x) => x.id), ['old', 'keep']);
  // A fresh merge/replacement arrives while the original ack is in flight.
  f.items = [{ id: 'new-generation' }, { id: 'keep' }];
  waiting.resolve({ ok: true, removed: 1 });
  assert.equal((await pending).ok, true);
  assert.deepEqual(Array.from(f.items, (x) => x.id), ['new-generation', 'keep']);
  const seen = [];
  const g = fixture(async (ids) => { seen.push(Array.from(ids)); return { ok: true, removed: ids[0] === 'old' ? 1 : 0 }; });
  const r = await acknowledgeItems(['old', 'keep'], g.effects);
  assert.equal(r.ok, false);
  assert.deepEqual(seen, [['old'], ['keep']]);
  assert.deepEqual(Array.from(g.items, (x) => x.id), ['keep']);
  const h = fixture(async () => { throw Error('offline'); });
  assert.equal((await acknowledgeItems(['old'], h.effects)).ok, false);
  assert.deepEqual(Array.from(h.items, (x) => x.id), ['old', 'keep']);
}
async function testMainWiring() {
  const text = src('main.js').replace(/\r\n/g, '\n');
  const startProbe = text.indexOf('function probeNudges(cfg)');
  const endProbe = text.indexOf('\n/**', startProbe);
  const startIpc = text.indexOf("ipcMain.handle('island:nudge-ack'");
  const endIpc = text.indexOf('\n\n/**', startIpc);
  assert.ok(startProbe >= 0 && endProbe > startProbe && startIpc >= 0 && endIpc > startIpc);
  let handler; let fetches = 0;
  let fetched = [];
  const context = {
    ipcMain: { handle(name, fn) { handler = fn; } },
    nudges: { acknowledgeItems, ack: async () => ({ ok: true, removed: 0 }),
      fetchNudges: async () => { fetches++; return { ok: true, rev: 'same-rev', items: fetched }; } },
    config: { load: () => ({ nudgeMaxItems: 8 }) }, console, poke() {},
  };
  vm.createContext(context);
  vm.runInContext("let nudgeItems = [{id:'old', sessionId:'s', kind:'completed', severity:2, ts:1}]; let nudgeRev = 'same-rev'; let nudgeFetchEpoch = 0; let nudgeWarnKey = ''; let nudgeAckInFlight = 0; const retainedNudges = new Map();", context);
  const helperStart = text.indexOf('function retainNudge(item)');
  const helperEnd = text.indexOf('\nlet nudgeAckInFlight', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  vm.runInContext(text.slice(helperStart, helperEnd) + '\n' + text.slice(startProbe, endProbe) + '\n' + text.slice(startIpc, endIpc), context);
  const r = await handler(null, { ids: ['old'] });
  await Promise.resolve();
  assert.equal(r.ok, false);
  assert.equal(fetches, 1);
  assert.equal(vm.runInContext('nudgeItems[0].id', context), 'old');
  // Session/kind do not prove ownership: retain old without deleting the new generation.
  fetched = [{ id: 'new', sessionId: 's', kind: 'completed', severity: 2, ts: 2 }];
  vm.runInContext("nudgeRev = ''; probeNudges({nudgeMaxItems:8})", context);
  await Promise.resolve();
  assert.deepEqual(Array.from(vm.runInContext('nudgeItems', context), (item) => item.id), ['new', 'old']);
}
function rendererFixture(jump, ack) {
  const text = src('renderer.js');
  const start = text.indexOf('async function handleNudgeClick(');
  const end = text.indexOf('  /* ───────────── 会话行', start);
  assert.ok(start >= 0 && end > start);
  const state = { nudges: [{ id: 'old' }, { id: 'keep' }], nudgeInFlight: new Set() };
  const context = { window: { island: { jump, nudgeAck: ack } }, state, render() {}, updateHint() {}, clearTimeout() {}, setTimeout() {}, RESULT_HOLD_MS: 0 };
  return { click: vm.runInNewContext('(' + text.slice(start, end).trim() + ')', context), state };
}
async function testRenderer() {
  const gate = deferred(); const calls = [];
  const a = rendererFixture(() => { calls.push('jump'); return gate.promise; }, async () => { calls.push('ack'); return { ok: true }; });
  a.state.nudges[0].sessionId = 'session';
  const pending = a.click(a.state.nudges[0]);
  assert.deepEqual(calls, ['jump']);
  gate.resolve({ kind: 'bridged', nudgeCaptured: true }); await pending;
  assert.deepEqual(calls, ['jump', 'ack']);
  assert.deepEqual(Array.from(a.state.nudges, (x) => x.id), ['keep']);
  for (const result of [{ kind: 'opened' }, { kind: 'failed' }, { ok: true }, null]) {
    let acked = false;
    const b = rendererFixture(async () => result, async () => { acked = true; });
    await b.click({ id: 'old', sessionId: 'session' });
    assert.equal(acked, false);
    assert.equal(b.state.nudges.length, 2);
  }
  for (const jump of [async () => { throw Error('offline'); }, async () => ({ kind: 'bridged', nudgeCaptured: true })]) {
    const c = rendererFixture(jump, async () => ({ ok: false }));
    await c.click({ id: 'old', sessionId: 'session' });
    assert.equal(c.state.nudges.length, 2);
  }
  const diagnose = rendererFixture(async () => ({ kind: 'bridged', nudgeCaptured: true }), async () => ({ok: false, reason: 'not-found'}));
  await diagnose.click({id: 'old', sessionId: 'session'});
  assert.match(diagnose.state.dshHint, /编号不存在/);
  let rejectedAck = false;
  const stale = rendererFixture(async () => ({ kind: 'bridged', nudgeCaptured: false }), async () => { rejectedAck = true; });
  await stale.click({ id: 'old', sessionId: 'session' });
  assert.equal(rejectedAck, false, 'uncaptured reminder must never be acknowledged');
  assert.match(stale.state.dshHint, /提醒已变化/);
  const ackGate = deferred();
  const successor = rendererFixture(async () => ({ kind: 'bridged', nudgeCaptured: true }), () => ackGate.promise);
  successor.state.nudges[0].sessionId = 'session';
  const ackPending = successor.click(successor.state.nudges[0]);
  await Promise.resolve();
  successor.state.nudges = [{id: 'new-generation'}];
  ackGate.resolve({ok: true});
  await ackPending;
  assert.deepEqual(Array.from(successor.state.nudges, (x) => x.id), ['new-generation']);
  let called = false;
  const d = rendererFixture(async () => { called = true; }, async () => { called = true; });
  await d.click({ id: 'old' });
  assert.equal(called, false);
}
(async () => {
  await testWireCounts();
  await testMainPolicy();
  await testMainWiring();
  await testRenderer();
  console.log('nudge acknowledgement safety: passed (pure mocks)');
  console.log('通过 4 / 失败 0');
})().catch((error) => { console.error(error); process.exitCode = 1; });
