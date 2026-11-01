'use strict';
// Real main-process handlers, fake clock and transport; never load Electron or open sockets.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const text = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8').replace(/\r\n/g, '\n');
const moduleMock = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/nudges.js'), 'utf8'), {
  module: moduleMock, exports: moduleMock.exports, Buffer,
  require(name) {
    if (name === 'node:http' || name === 'http') return { request() { throw Error('socket forbidden'); } };
    if (name === './bridge.js') return { bridgePort() { throw Error('profile forbidden'); } };
    throw Error('unexpected require ' + name);
  },
});
function section(start, end) { const a = text.indexOf(start), b = text.indexOf(end, a); assert.ok(a >= 0 && b > a); return text.slice(a, b); }
let now = 1000, fetched = [], revision = 'same', offline = false;
const handlers = {};
const context = {
  Date: { now: () => now }, console: { warn() {} }, poke() {},
  ipcMain: { handle(name, fn) { handlers[name] = fn; } },
  config: { load: () => ({ nudgeMaxItems: 8 }) },
  nudges: {
    fetchNudges: async () => offline ? ({ ok: false, reason: 'offline' }) : ({ ok: true, rev: revision, items: fetched }),
    ack: async () => ({ ok: true, removed: 0 }),
    acknowledgeItems: moduleMock.exports.acknowledgeItems,
  },
};
vm.createContext(context);
vm.runInContext("let nudgeItems=[]; let nudgeRev=''; let nudgeFetchEpoch=0; let nudgeWarnKey=''; let nudgeAckInFlight=0; const retainedNudges=new Map();", context);
vm.runInContext(section('function retainNudge(item)', '\nlet nudgeAckInFlight') + '\n' + section('function probeNudges(cfg)', '\n/**') + '\n' + section("ipcMain.handle('island:nudge-ack'", '\n\n/**'), context);
async function probe() { vm.runInContext('probeNudges({nudgeMaxItems:8})', context); await Promise.resolve(); }
const ids = () => Array.from(vm.runInContext('nudgeItems', context), x => x.id);
(async () => {
  vm.runInContext("nudgeItems=[{id:'old',sessionId:'s',severity:1,ts:1}]", context);
  await handlers['island:nudge-ack'](null, { ids: ['old'] }); await Promise.resolve();
  assert.deepEqual(ids(), ['old'], 'zero ack retains the old item initially');
  fetched = [{id:'new',sessionId:'s',severity:1,ts:2}]; revision = 'next'; await probe();
  assert.deepEqual(ids(), ['new','old'], 'successor is never removed');
  now += 12 * 60 * 60 * 1000;
  await handlers['island:nudge-ack'](null, { ids: ['old'] }); await Promise.resolve();
  now += 12 * 60 * 60 * 1000 + 1;
  offline = true; await probe();
  assert.deepEqual(ids(), ['new','old'], 'offline failure never erases visible alerts');
  offline = false; await probe();
  assert.deepEqual(ids(), ['new'], 'retries do not extend expiry; retire even if server revision is unchanged');
  assert.equal(vm.runInContext('retainedNudges.size', context), 0);
  // A live alert matching a retained ID must not be removed by local retirement.
  vm.runInContext("nudgeItems=[{id:'live',severity:1,ts:3}]", context);
  fetched = [{id:'live',severity:1,ts:3}]; revision = 'live';
  await handlers['island:nudge-ack'](null, { ids: ['live'] }); await Promise.resolve();
  now += 24 * 60 * 60 * 1000 + 1; await probe();
  assert.deepEqual(ids(), ['live']);
  // Bounded memory even if each failed acknowledgement has a distinct ID.
  fetched = []; revision = 'empty';
  for (let i = 0; i < 140; i++) {
    context.item = {id:'id'+i, severity:1, ts:i};
    vm.runInContext('nudgeItems=[item]', context);
    await handlers['island:nudge-ack'](null, { ids: [context.item.id] }); await Promise.resolve();
  }
  assert.equal(vm.runInContext('retainedNudges.size', context), 128, 'retained fallback cache has a hard bound');
  assert.equal(vm.runInContext("retainedNudges.has('id0')", context), false, 'oldest copy is evicted');
  assert.equal(vm.runInContext("retainedNudges.has('id139')", context), true, 'newest copy is retained');
  console.log('通过 4 / 失败 0');
})().catch(error => { console.error(error); process.exitCode = 1; });
