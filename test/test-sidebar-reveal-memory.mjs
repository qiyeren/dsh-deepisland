// Synthetic browser and in-memory bridge only: no real page, reminders or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

test('a jump opens the session without automatically scrolling the sidebar', async () => {
  let api, nextTimer = 0, scrolls = 0;
  const opened = [], timers = new Map();
  const target = {
    isConnected: true,
    getAttribute: name => name === 'data-row-key' ? 'session:fixture-1' : name === 'aria-selected' ? 'true' : null,
    scrollIntoView: () => { scrolls++; },
  };
  const sandbox = {
    window: { __ModuleLoader__: { load: ({ factory }) => { api = factory(name => { if (name === 'react') return {}; throw Error(name); }); } } },
    document: { querySelectorAll: () => [target] },
    fetch: async () => ({ ok: true, json: async () => ({ items: [{ sessionId: 'fixture-1' }] }) }),
    AbortController, AbortSignal, console: { log() {}, warn() {} },
    localStorage: { getItem() { return null; }, setItem() {} },
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id),
  };
  vm.runInNewContext(source, sandbox);
  const bridge = api.startJumpBridge({ get: () => ({ openSession: id => opened.push(id) }) });
  const first = [...timers.entries()].find(([, timer]) => timer.delay === 0);
  assert.ok(first, 'initial bridge poll is scheduled');
  timers.delete(first[0]); first[1].fn(); await flush();
  const immediate = [...timers.entries()].filter(([, timer]) => timer.delay === 0);
  for (const [id, timer] of immediate) { timers.delete(id); timer.fn(); }
  await flush();
  assert.deepEqual(opened, ['fixture-1']);
  assert.equal(scrolls, 0, 'jump must not automatically scroll a selected session');
  bridge.stop();
  assert.equal(timers.size, 0);
});
