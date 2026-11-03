// Synthetic browser only: no actual DSH page, reminders, or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function fixture(initialRows = []) {
  let api, id = 0, queue = [{ sessionId: 'fixture-1' }];
  const timers = new Map(), opened = [], rows = initialRows;
  const sandbox = {
    window: { __ModuleLoader__: { load: ({factory}) => { api = factory(name => { if (name === 'react') return {}; throw Error(name); }); } } },
    document: { querySelectorAll: (selector) => { assert.equal(selector, '[role="treeitem"][data-row-key]'); return rows; } },
    fetch: async () => ({ ok: true, json: async () => ({ items: queue.splice(0) }) }),
    AbortController, AbortSignal, console: { log() {}, warn() {} },
    localStorage: { getItem() { return null; }, setItem() {} },
    setTimeout: (fn, delay) => { const n = ++id; timers.set(n, {fn, delay}); return n; }, clearTimeout: (n) => timers.delete(n),
  };
  vm.runInNewContext(source, sandbox);
  const bridge = api.startJumpBridge({ get: () => ({ openSession: sid => opened.push(sid) }) });
  async function runTimer(delay) {
    const entry = [...timers.entries()].find(([,t]) => t.delay === delay);
    assert.ok(entry, `timer at ${delay}ms exists`);
    timers.delete(entry[0]); entry[1].fn(); await flush();
  }
  return { bridge, opened, rows, timers, runTimer, enqueue: sid => queue.push({ sessionId: sid }) };
}
function row(id, selected = true) {
  const r = { count: 0, isConnected: true, selected,
    getAttribute(name) { return name === 'data-row-key' ? `session:${id}` : name === 'aria-selected' ? String(r.selected) : null; },
    scrollIntoView(options) { r.count++; assert.equal(options.block, 'nearest'); assert.equal(options.inline, 'nearest'); } };
  return r;
}
test('a selected rendered jump target is revealed in the sidebar', async () => {
  const target = row('fixture-1'), other = row('fixture-2');
  const f = fixture([other, target]); await f.runTimer(0); await f.runTimer(0);
  assert.deepEqual(f.opened, ['fixture-1']); assert.equal(target.count, 1); assert.equal(other.count, 0); f.bridge.stop();
});
test('waits briefly for rendering and never scrolls a different selected session', async () => {
  const target = row('fixture-1', false), other = row('fixture-2');
  const f = fixture([other, target]); await f.runTimer(0); await f.runTimer(0);
  assert.equal(target.count, 0); assert.equal(other.count, 0);
  target.selected = true; await f.runTimer(100); assert.equal(target.count, 1); f.bridge.stop();
});
test('ambiguous duplicate rows fail closed without retry or scrolling', async () => {
  const a = row('fixture-1'), b = row('fixture-1');
  const f = fixture([a,b]); await f.runTimer(0); await f.runTimer(0);
  assert.equal(a.count + b.count, 0); assert.equal([...f.timers.values()].some(t => t.delay === 100), false); f.bridge.stop();
});
test('a later jump cancels a stale pending reveal', async () => {
  const old = row('fixture-1', false), next = row('fixture-2');
  const f = fixture([old, next]); await f.runTimer(0); await f.runTimer(0);
  f.enqueue('fixture-2');
  const poll = [...f.timers.values()].find(t => t.delay !== 100);
  assert.ok(poll, 'next bridge poll exists');
  await f.runTimer(poll.delay); old.selected = true; await f.runTimer(0);
  assert.equal(old.count, 0); assert.equal(next.count, 1);
  assert.deepEqual(f.opened, ['fixture-1', 'fixture-2']); f.bridge.stop();
});
test('missing rows stop retrying after ten attempts; stopping cancels pending reveal', async () => {
  const f = fixture(); await f.runTimer(0); await f.runTimer(0);
  for (let i = 0; i < 9; i++) await f.runTimer(100);
  assert.equal([...f.timers.values()].some(t => t.delay === 100), false); f.bridge.stop();
  const g = fixture(); await g.runTimer(0); g.bridge.stop();
  assert.equal(g.timers.size, 0);
});
