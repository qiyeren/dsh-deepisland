'use strict';
// Real functions, in-memory dependencies only: no sockets, Electron or profile.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
function extract(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b).trim();
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function uiHarness(jump, ack, openDsh = async () => ({ ok: true })) {
  const source = read('renderer.js');
  const hint = { textContent: '', classes: new Set() };
  const state = { nudges: [], nudgeInFlight: new Set(), jump: null, dshHint: null, pinned: false };
  const context = { state, window: { island: { jump, nudgeAck: ack, openDsh } },
    $: () => hint, setText: (n, t) => { n.textContent = t; },
    setClass: (n, c, on) => { if (on) n.classes.add(c); else n.classes.delete(c); },
    setTimeout: () => 1, clearTimeout() {}, RESULT_HOLD_MS: 6000 };
  vm.createContext(context);
  vm.runInContext(extract(source, 'function updateHint()', '\n  /* ───────────────────────────── 本地秒级时钟') + '\n' +
    extract(source, 'async function handleNudgeClick(', '\n  /* ───────────── 会话行') + '\n' +
    extract(source, 'function openDsh()', '\n  function openContextMenu()') + '\n' +
    'function render() { updateHint(); }', context);
  return { state, hint, click: context.handleNudgeClick, open: context.openDsh, update: context.updateHint };
}
test('bridge result only claims the jump was queued', async () => {
  const mod = { exports: {} };
  vm.runInNewContext(read('jump.js'), { module: mod, exports: mod.exports,
    require: () => ({ postJump() { throw Error('network forbidden'); } }), console });
  const result = await mod.exports.performJump({ id: 's', label: 'Title' },
    { activate: () => true, post: async () => true });
  assert.equal(result.kind, 'bridged');
  assert.equal(result.brief, '跳转请求已入队');
});
test('failed acknowledgement overrides a queued jump with failed styling', async () => {
  const ui = uiHarness(async () => ({ kind: 'bridged', nudgeCaptured: true }), async () => ({ ok: false }));
  const item = { id: 'n1', sessionId: 's' }; ui.state.nudges = [item];
  ui.state.jump = { kind: 'bridged', brief: '跳转请求已入队' };
  await ui.click(item);
  assert.equal(ui.hint.textContent, '提醒确认失败，已保留并刷新');
  assert.equal(ui.hint.classes.has('failed'), true);
  assert.equal(ui.hint.classes.has('ok'), false);
  assert.equal(ui.state.nudges.length, 1);
});
test('rejected acknowledgement remains visible as failure', async () => {
  const ui = uiHarness(async () => ({kind:'bridged', nudgeCaptured:true}), async () => { throw Error('mock'); });
  const item = {id:'n', sessionId:'s'}; ui.state.nudges = [item];
  ui.state.jump = {kind:'bridged', brief:'跳转请求已入队'};
  await ui.click(item);
  assert.equal(ui.hint.textContent, '提醒确认失败，请刷新后重试');
  assert.equal(ui.hint.classes.has('failed'), true);
  assert.equal(ui.state.nudges.length, 1);
});
test('uncaptured reminder similarly overrides jump and remains unacknowledged', async () => {
  let count = 0;
  const ui = uiHarness(async () => ({ kind: 'bridged', nudgeCaptured: false }), async () => { count++; });
  ui.state.jump = { kind: 'bridged', brief: '跳转请求已入队' };
  await ui.click({ id: 'n', sessionId: 's' });
  assert.equal(count, 0);
  assert.equal(ui.hint.textContent, '提醒已变化，请刷新后重试');
  assert.equal(ui.hint.classes.has('failed'), true);
});
test('ordinary openDsh hint still displays as ok and does not outrank jump', async () => {
  const ui = uiHarness(() => {}, () => {});
  ui.open(); await Promise.resolve();
  assert.equal(ui.hint.textContent, '已切到 DSH');
  assert.equal(ui.hint.classes.has('ok'), true);
  ui.state.jump = { kind: 'bridged', brief: 'jump' }; ui.update();
  assert.equal(ui.hint.textContent, 'jump');
});
test('double click same id is suppressed through ack, and other IDs remain independent', async () => {
  const j1 = deferred(), a1 = deferred(); const jumps = [], acks = [];
  const ui = uiHarness((p) => { jumps.push(p.nudgeId); return p.nudgeId === 'a' ? j1.promise : Promise.resolve({kind:'bridged', nudgeCaptured:true}); },
    (p) => { acks.push(p.ids[0]); return p.ids[0] === 'a' ? a1.promise : Promise.resolve({ok:true}); });
  const a = {id:'a',sessionId:'s'}, b = {id:'b',sessionId:'s'};
  ui.state.nudges = [a,b];
  const first = ui.click(a); const duplicate = ui.click(a); await ui.click(b);
  assert.deepEqual(jumps, ['a','b']);
  await duplicate;
  j1.resolve({kind:'bridged', nudgeCaptured:true}); await Promise.resolve();
  const duringAck = ui.click(a); assert.deepEqual(jumps, ['a','b']); await duringAck;
  a1.resolve({ok:true}); await first;
  assert.deepEqual(acks, ['b','a']);
  await ui.click(a); assert.deepEqual(jumps, ['a','b','a']);
});
test('in-flight guard is released after thrown jump and failed ack', async () => {
  let attempts = 0;
  const ui = uiHarness(async () => { attempts++; if (attempts === 1) throw Error('mock'); return {kind:'bridged', nudgeCaptured:true}; }, async () => ({ok:false}));
  const item = { id:'a', sessionId:'s' };
  await ui.click(item); await ui.click(item); await ui.click(item);
  assert.equal(attempts, 3);
});
