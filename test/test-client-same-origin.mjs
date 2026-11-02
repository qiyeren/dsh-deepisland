import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const CONFIG = '/api/dsh-vibe-island/config';
const NEXT = '/api/dsh-vibe-island/next';
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function setup(handler, initial = {}) {
  const calls = [], timers = new Map(), data = new Map(Object.entries(initial));
  let nextTimer = 0, exported, updates = 0;
  const cleanups = [];
  const fetch = (url, options = {}) => {
    assert.ok(url === CONFIG || url === NEXT, `unexpected network: ${url}`);
    assert.equal(options.credentials, 'same-origin');
    calls.push({ url, options });
    return handler(url, options, calls);
  };
  const react = { createElement: (type, props, children) => ({ type, props: props || {}, children }),
    useState: (value) => [value, () => { updates++; }], useEffect: (f) => { const cleanup = f(); if (typeof cleanup === 'function') cleanups.push(cleanup); }, useMemo: (f) => f(), useSyncExternalStore: () => ({}) };
  const sandbox = { window: { __ModuleLoader__: { load: ({ factory }) => { exported = factory((name) => { if (name === 'react') return react; throw Error(name); }); } } },
    fetch, AbortController, AbortSignal, console: { log() {}, warn() {} },
    localStorage: { getItem: (k) => data.get(k) || null, setItem: (k, v) => data.set(k, v) },
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay, once: true }); return id; },
    clearTimeout: (id) => timers.delete(id), setInterval: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay, once: false }); return id; }, clearInterval: (id) => timers.delete(id) };
  vm.runInNewContext(source, sandbox, { filename: 'client.js' });
  return { api: exported, calls, timers, data, cleanups, get updates() { return updates; }, tick: () => { for (const [id, timer] of [...timers]) { if (!timers.has(id)) continue; if (timer.once) timers.delete(id); timer.fn(); } } };
}

test('settings card uses theme colors for text, surface and controls', () => {
  const env = setup(() => Promise.resolve(response({ config: { bridgeEnabled: false } })));
  let card;
  env.api.apply({ slots: { inject: (_name, fn) => fn(), register: (spec, component) => { if (spec.id === 'dsh-vibe-island-settings') card = component; } }, on() {} });
  assert.equal(typeof card, 'function');
  const styles = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (typeof node.type === 'function') return walk(node.type(node.props));
    if (node.props?.style) styles.push(node.props.style);
    walk(node.children);
  };
  walk(card({}));
  assert.ok(styles.some(s => s.background?.includes('--dsw-alias-settings-card-fill')));
  assert.ok(styles.filter(s => s.color).every(s => s.color.includes('--dsw-alias-')), 'every explicit text color follows theme');
  assert.ok(styles.filter(s => s.background).every(s => s.background.includes('--dsw-alias-')), 'controls follow theme background');
});

test('configuration uses same-origin independently of bridge and reports failure', async () => {
  const env = setup((url, options) => Promise.resolve(options.method === 'POST' ? response({ error: 'denied' }, 403) : response({ ok: true, config: { notchEnabled: false } })));
  assert.equal((await env.api.loadConfig(null)).notchEnabled, false);
  const failed = await env.api.saveConfig({ notchEnabled: true }, { notchEnabled: true });
  assert.equal(failed.ok, false); assert.equal(failed.error, 'denied');
  assert.equal(env.api.readScopeConfig(null).notchEnabled, true);
  assert.deepEqual(env.calls.map(c => [c.url, c.options.method || 'GET']), [[CONFIG, 'GET'], [CONFIG, 'POST']]);
});

test('slow config load merges later field edits without losing server fields', async () => {
  const load = deferred();
  const env = setup((url, options) => options.method === 'POST' ? Promise.resolve(response({ ok: true })) : load.promise,
    { 'dsh-vibe-island.config': JSON.stringify({ notchEnabled: true, nudgeEnabled: true }) });
  const pending = env.api.loadConfig(null);
  await env.api.saveConfig({ notchEnabled: false }, { notchEnabled: false, nudgeEnabled: true });
  load.resolve(response({ ok: true, config: { notchEnabled: true, nudgeEnabled: false } }));
  const cfg = await pending;
  assert.equal(cfg.notchEnabled, false); assert.equal(cfg.nudgeEnabled, false);
});

test('queue is not consumed without workspace and has at most one request in flight', async () => {
  let workspace = null; const opened = [], pending = deferred();
  const env = setup(() => pending.promise);
  const bridge = env.api.startJumpBridge({ get: () => workspace });
  env.tick(); await flush(); assert.equal(env.calls.length, 0);
  workspace = { openSession: (id) => opened.push(id) };
  env.tick(); env.tick(); await flush(); assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].url, NEXT); assert.equal(env.calls[0].options.method, 'POST');
  pending.resolve(response({ ok: true, items: [{ sessionId: 'session-1' }] })); await flush();
  assert.deepEqual(opened, ['session-1']); bridge.stop(); assert.equal(env.timers.size, 0);
});

test('stop aborts outstanding request and prevents late navigation', async () => {
  const pending = deferred(), opened = [];
  const env = setup(() => pending.promise);
  const bridge = env.api.startJumpBridge({ get: () => ({ openSession: id => opened.push(id) }) });
  env.tick(); await flush(); const signal = env.calls[0].options.signal;
  bridge.stop(); assert.equal(signal.aborted, true); assert.equal(env.timers.size, 0);
  pending.resolve(response({ items: [{ sessionId: 'late' }] })); await flush(); assert.deepEqual(opened, []);
});

test('apply waits for async config before queue polling and honors disabled bridge', async () => {
  const load = deferred(); let dispose;
  const env = setup((url) => url === CONFIG ? load.promise : Promise.resolve(response({ items: [] })));
  env.api.apply({ get: () => ({ openSession() {} }), on: (event, fn) => { if (event === 'dispose') dispose = fn; } });
  env.tick(); assert.equal(env.calls.length, 1);
  load.resolve(response({ config: { bridgeEnabled: false, notchEnabled: false } })); await flush();
  env.tick(); assert.equal(env.calls.length, 1); assert.equal(env.api.readScopeConfig(null).notchEnabled, false);
  dispose(); assert.equal(env.timers.size, 0);
});

test('initial config failure retries without overlap, preserves edits and starts polling', async () => {
  const retry = deferred(); let dispose, gets = 0;
  const env = setup((url, options) => {
    if (url === NEXT) return Promise.resolve(response({ items: [] }));
    if (options.method === 'POST') return Promise.resolve(response({ error: 'not ready' }, 404));
    return ++gets === 1 ? Promise.resolve(response({}, 404)) : retry.promise;
  });
  env.api.apply({ get: () => ({ openSession() {} }), on: (event, fn) => { if (event === 'dispose') dispose = fn; } });
  await flush(); assert.equal(gets, 1);
  await env.api.saveConfig({ notchEnabled: false }, { notchEnabled: false });
  assert.equal(env.timers.size, 1, 'one retry timer scheduled');
  const timer = [...env.timers.values()][0];
  assert.ok(timer.delay >= 100 && timer.delay <= 30000, 'retry interval is bounded');
  env.tick(); await flush(); assert.equal(gets, 2);
  env.tick(); await flush(); assert.equal(gets, 2, 'no overlapping config loads');
  await env.api.saveConfig({ nudgeEnabled: false }, { ...env.api.readScopeConfig(null), nudgeEnabled: false });
  retry.resolve(response({ config: { bridgeEnabled: true, notchEnabled: true, nudgeEnabled: true, placement: 'floating' } }));
  await flush();
  const cfg = env.api.readScopeConfig(null);
  assert.equal(cfg.notchEnabled, false); assert.equal(cfg.nudgeEnabled, false); assert.equal(cfg.placement, 'floating');
  env.tick(); await flush(); assert.equal(env.calls.filter(c => c.url === NEXT).length, 1);
  assert.equal(gets, 2, 'success stops config retries');
  dispose(); assert.equal(env.timers.size, 0);
});

test('repeated failures retry until disabled config loads without polling', async () => {
  let dispose, gets = 0;
  const env = setup((url) => {
    assert.equal(url, CONFIG);
    return Promise.resolve(++gets < 3 ? response({}, 404) : response({ config: { bridgeEnabled: false } }));
  });
  env.api.apply({ get: () => ({ openSession() {} }), on: (event, fn) => { if (event === 'dispose') dispose = fn; } });
  await flush(); env.tick(); await flush(); env.tick(); await flush();
  assert.equal(gets, 3); assert.equal(env.timers.size, 0);
  env.tick(); await flush(); assert.equal(env.calls.length, 3);
  dispose();
});

test('disposal cancels scheduled retry and late failed load cannot reschedule', async () => {
  let dispose;
  const env = setup(() => Promise.resolve(response({}, 404)));
  env.api.apply({ on: (event, fn) => { if (event === 'dispose') dispose = fn; } });
  await flush(); assert.equal(env.timers.size, 1);
  dispose(); assert.equal(env.timers.size, 0); env.tick(); await flush(); assert.equal(env.calls.length, 1);

  const load = deferred(); let disposePending;
  const pending = setup(() => load.promise);
  pending.api.apply({ on: (event, fn) => { if (event === 'dispose') disposePending = fn; } });
  disposePending(); load.resolve(response({}, 404)); await flush();
  assert.equal(pending.timers.size, 0); assert.equal(pending.calls.length, 1);
});

test('mounted settings are notified of async load and save failure', async () => {
  const load = deferred(), registrations = []; let dispose;
  const env = setup((url, options) => options.method === 'POST' ? Promise.resolve(response({ error: 'denied' }, 403)) : load.promise);
  env.api.apply({ on: (name, fn) => { if (name === 'dispose') dispose = fn; },
    slots: { inject: (name, fn) => fn(), register: (meta, component) => registrations.push({ meta, component }) } });
  const settings = registrations.find(r => r.meta.id === 'dsh-vibe-island-settings');
  const card = settings.component({ inject: settings.meta.inject });
  const checkbox = card.children.find(child => child && child.props && child.props.key === 'opt-notch').children[1];
  load.resolve(response({ config: { notchEnabled: false, bridgeEnabled: false } })); await flush();
  assert.ok(env.updates > 0, 'asynchronous load should trigger UI updates');
  const before = env.updates;
  checkbox.props.onChange({ target: { checked: true } }); await flush();
  assert.ok(env.updates > before, 'failed save should trigger UI feedback');
  env.cleanups.forEach(fn => fn()); dispose();
});

test('disposing before config load finishes prevents late state and polling', async () => {
  const load = deferred(); let dispose;
  const env = setup(() => load.promise);
  env.api.apply({ get: () => ({ openSession() {} }), on: (event, fn) => { if (event === 'dispose') dispose = fn; } });
  dispose();
  load.resolve(response({ config: { notchEnabled: false } })); await flush();
  assert.equal(env.api.readScopeConfig(null).notchEnabled, undefined);
  assert.equal(env.calls.length, 1); assert.equal(env.timers.size, 0);
});

test('dispose aborts current save and does not start queued saves', async () => {
  const pending = deferred(); let dispose;
  const env = setup((url, options) => options.method === 'POST' ? pending.promise : Promise.resolve(response({ config: { bridgeEnabled: false } })));
  env.api.apply({ on: (event, fn) => { if (event === 'dispose') dispose = fn; } }); await flush();
  const first = env.api.saveConfig({ x: 1 }, { x: 1 });
  const second = env.api.saveConfig({ y: 2 }, { x: 1, y: 2 }); await flush();
  const saves = env.calls.filter(c => c.options.method === 'POST'); assert.equal(saves.length, 1);
  dispose(); assert.equal(saves[0].options.signal.aborted, true);
  pending.resolve(response({ ok: true }));
  assert.equal((await first).ok, false); assert.equal((await second).ok, false);
  assert.equal(env.calls.filter(c => c.options.method === 'POST').length, 1);
});

test('failed dirty values can be retried without overwriting newer edits', async () => {
  let dispose, fail = true;
  const env = setup((url, options) => Promise.resolve(options.method === 'POST' ? (fail ? response({ error: 'offline' }, 503) : response({ ok: true })) : response({ config: { bridgeEnabled: false, x: 0 } })));
  env.api.apply({ on: (event, fn) => { if (event === 'dispose') dispose = fn; } }); await flush();
  await env.api.saveConfig({ x: 1 }, { x: 1 });
  fail = false;
  await env.api.saveConfig({ y: 2 }, { x: 1, y: 2 });
  assert.equal((await env.api.retryFailedSaves()).ok, true);
  const posts = env.calls.filter(c => c.options.method === 'POST').map(c => JSON.parse(c.options.body));
  assert.deepEqual(posts, [{ x: 1 }, { y: 2 }, { x: 1 }]);
  dispose(); await env.api.retryFailedSaves(); await env.api.saveConfig({ z: 3 }, {});
  assert.equal(env.calls.filter(c => c.options.method === 'POST').length, 3);
});

test('mute range validation prevents incomplete settings from being sent', async () => {
  const env = setup(() => Promise.resolve(response({ ok: true })));
  assert.equal(env.api.isValidMuteRanges('22:00-08:00,12:00-13:00'), true);
  for (const value of ['', '22:', '22:00-', '24:00-08:00', '22:60-08:00', '22:00-08:00,']) {
    assert.equal(env.api.isValidMuteRanges(value), false, value);
  }
});

test('mute input only saves valid blur or explicit clear', async () => {
  let dispose; const registrations = [];
  const env = setup((url, options) => Promise.resolve(options.method === 'POST' ? response({ ok: true }) : response({ config: { bridgeEnabled: false, nudgeMuteRanges: '22:00-08:00' } })));
  env.api.apply({ on: (event, fn) => { if (event === 'dispose') dispose = fn; }, slots: { inject: (name, fn) => fn(), register: (meta, component) => registrations.push({ meta, component }) } });
  await flush();
  const settings = registrations.find(r => r.meta.id === 'dsh-vibe-island-settings');
  const card = settings.component({ inject: settings.meta.inject });
  const control = card.children.find(c => c && c.props.key === 'opt-mute').children[1];
  const input = control.type(control.props);
  input.children[0].props.onChange({ target: { value: '22:' } });
  input.children[0].props.onBlur({ target: { value: '22:' } });
  input.children[0].props.onBlur({ target: { value: '' } });
  await flush(); assert.equal(env.calls.filter(c => c.options.method === 'POST').length, 0);
  input.children[0].props.onBlur({ target: { value: '21:30-07:15' } }); await flush();
  input.children[2].props.onClick(); await flush();
  const posts = env.calls.filter(c => c.options.method === 'POST').map(c => JSON.parse(c.options.body));
  assert.deepEqual(posts, [{ nudgeMuteRanges: '21:30-07:15' }, { nudgeMuteRanges: '' }]);
  env.cleanups.forEach(fn => fn()); dispose();
});

test('retries are bounded by backoff and recover without overlap', async () => {
  let dispose, count = 0; const delays = [];
  const env = setup(() => Promise.resolve(++count <= 8 ? response({}, 503) : response({ config: { bridgeEnabled: false } })));
  env.api.apply({ on: (event, fn) => { if (event === 'dispose') dispose = fn; } });
  await flush();
  for (let i = 0; i < 8; i++) { assert.equal(env.timers.size, 1); delays.push([...env.timers.values()][0].delay); env.tick(); await flush(); }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  assert.equal(count, 9); assert.equal(env.timers.size, 0); dispose();
});

test('failed jump polling backs off to a cap and resets after recovery', async () => {
  let count = 0;
  const env = setup(() => Promise.resolve(++count <= 8 ? response({}, 503) : response({ items: [] })));
  const bridge = env.api.startJumpBridge({ get: () => ({ openSession() {} }) });
  const delays = [];
  for (let i = 0; i < 9; i++) { env.tick(); await flush(); delays.push([...env.timers.values()][0].delay); }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 500]);
  bridge.stop(); assert.equal(env.timers.size, 0);
});

test('retry queued before a later edit cannot overwrite it', async () => {
  let fail = true, dispose; const retry = deferred();
  const env = setup((url, options) => {
    if (options.method !== 'POST') return Promise.resolve(response({ config: { bridgeEnabled: false } }));
    if (fail) { fail = false; return Promise.resolve(response({}, 503)); }
    return env.calls.filter(c => c.options.method === 'POST').length === 2 ? retry.promise : Promise.resolve(response({ ok: true }));
  });
  env.api.apply({ on: (event, fn) => { if (event === 'dispose') dispose = fn; } }); await flush();
  await env.api.saveConfig({ x: 1 }, {});
  const first = env.api.retryFailedSaves(); await flush();
  const newer = env.api.saveConfig({ x: 2 }, { x: 2 }); await flush();
  assert.equal(env.calls.filter(c => c.options.method === 'POST').length, 2);
  retry.resolve(response({ ok: true })); await first; await newer;
  const posts = env.calls.filter(c => c.options.method === 'POST').map(c => JSON.parse(c.options.body));
  assert.deepEqual(posts, [{ x: 1 }, { x: 1 }, { x: 2 }]);
  assert.equal(env.api.readScopeConfig(null).x, 2); dispose();
});

test('saves are serialized and malformed or rejected responses fail honestly', async () => {
  const first = deferred();
  const env = setup((url, options, calls) => calls.length === 1 ? first.promise : Promise.resolve(response({ ok: true })));
  const a = env.api.saveConfig({ a: 1 }, { a: 1 });
  const b = env.api.saveConfig({ b: 2 }, { a: 1, b: 2 });
  await flush(); assert.equal(env.calls.length, 1);
  first.resolve(response({ ok: false, error: 'rejected' }));
  assert.equal((await a).ok, false); assert.equal((await b).ok, true);
  assert.equal(env.calls.length, 2);
  const malformed = setup(() => Promise.resolve(response({})));
  assert.equal((await malformed.api.saveConfig({ x: 1 }, {})).ok, false);
  await assert.rejects(malformed.api.loadConfig(null), /Invalid config response/);
  const partial = setup(() => Promise.resolve(response({ ok: true, rejected: [{ key: 'bad' }] })));
  const rejected = await partial.api.saveConfig({ good: true, bad: true }, {});
  assert.equal(rejected.ok, false); assert.match(rejected.error, /bad/);
});
