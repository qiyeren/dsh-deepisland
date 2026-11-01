'use strict';
// Execute the real IPC/renderer handlers in an isolated VM; no Electron or sockets.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = (file) => fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
const mod = { exports: {} };
vm.runInNewContext(src('nudges.js'), { module: mod, exports: mod.exports, Buffer,
  require(name) { if (name === 'node:http' || name === 'http') return { request() { throw Error('socket forbidden'); } };
    if (name === './bridge.js') return { bridgePort() { throw Error('profile forbidden'); } }; throw Error(name); } });
const main = src('main.js').replace(/\r\n/g, '\n');
function section(start, end) { const a = main.indexOf(start), b = main.indexOf(end, a); assert.ok(a >= 0 && b > a); return main.slice(a, b); }
async function run() {
  const pendingJump = deferred();
  const handlers = {}; let fetched = []; let acknowledgements = 0; let revision = 0;
  const context = { ipcMain: { handle(name, fn) { handlers[name] = fn; } },
    nudges: { acknowledgeItems: mod.exports.acknowledgeItems,
      ack: async () => { acknowledgements++; return { ok: true, removed: 0 }; },
      fetchNudges: async () => ({ ok: true, rev: String(++revision), items: fetched }) },
    config: { load: () => ({ nudgeMaxItems: 2, jumpEnabled: true }) },
    performJump: () => pendingJump.promise, shell: {}, clipboard: {}, bridge: {}, console,
    poke() {}, Date };
  vm.createContext(context);
  vm.runInContext("let nudgeItems = [{id:'old', sessionId:'s', kind:'completed', severity:2, ts:1, title:'Old'}]; let lastPayload = {nudges:[{id:'old', sessionId:'s'}]}; let nudgeRev = ''; let nudgeFetchEpoch = 0; let nudgeWarnKey = ''; let nudgeAckInFlight = 0; let lastJump = null; const retainedNudges = new Map();", context);
  vm.runInContext(section('function retainNudge(item)', '\nlet nudgeAckInFlight') + '\n' + section('function probeNudges(cfg)', '\n/**') + '\n' + section("ipcMain.handle('island:jump'", '\n\n/**') + '\n' + section("ipcMain.handle('island:nudge-ack'", '\n\n/**'), context);
  const renderer = src('renderer.js');
  const start = renderer.indexOf('async function handleNudgeClick('), end = renderer.indexOf('  /* ───────────── 会话行', start);
  assert.ok(start >= 0 && end > start);
  const state = { nudges: [{id:'old', sessionId:'s'}, {id:'keep'}], nudgeInFlight: new Set() };
  const ui = { window: { island: { jump: (p) => handlers['island:jump'](null, p), nudgeAck: (p) => handlers['island:nudge-ack'](null, p) } }, state, render() {}, updateHint() {}, clearTimeout() {}, setTimeout() {}, RESULT_HOLD_MS: 0 };
  const click = vm.runInNewContext('(' + renderer.slice(start, end).trim() + ')', ui);
  const waiting = click(state.nudges[0]);
  assert.equal(acknowledgements, 0, 'no acknowledgement before jump settles');
  vm.runInContext('probeNudges({nudgeMaxItems:2})', context); await Promise.resolve();
  fetched = [{id:'successor',sessionId:'s',kind:'completed',severity:2,ts:2}];
  vm.runInContext('probeNudges({nudgeMaxItems:2})', context); await Promise.resolve();
  pendingJump.resolve({ kind: 'bridged', isSuccess: true, brief: '' }); await waiting;
  await Promise.resolve();
  assert.equal(acknowledgements, 1);
  assert.deepEqual(Array.from(vm.runInContext('nudgeItems', context), (x) => x.id), ['successor','old'], 'failed ack must retain clicked item without deleting successor');
  fetched = [{id:'new1',severity:0,ts:3}, {id:'new2',severity:1,ts:2}];
  vm.runInContext("retainNudge({id:'held2',severity:0,ts:9}); nudgeRev=''; probeNudges({nudgeMaxItems:2})", context); await Promise.resolve();
  assert.deepEqual(Array.from(vm.runInContext('nudgeItems', context), (x) => x.id), ['new1','new2'], 'fresh live items have priority within display cap');
  assert.equal(vm.runInContext('retainedNudges.size', context), 2, 'cap must not delete retained reminders');
  fetched = [];
  vm.runInContext('probeNudges({nudgeMaxItems:2})', context); await Promise.resolve();
  assert.deepEqual(Array.from(vm.runInContext('nudgeItems', context), (x) => x.id), ['held2', 'old'], 'fallback entries reappear once live slots free up');
  console.log('通过 2 / 失败 0');
}
run().catch((e) => { console.error(e); process.exitCode = 1; });
