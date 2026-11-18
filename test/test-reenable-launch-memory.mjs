// Isolated production host/route integration; fake filesystem, process, and spawn.
// Never uses the real bridge, reminders, app, network or profile.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const hostSource = fs.readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8');
const browserSource = fs.readFileSync(fileURLToPath(new URL('../lib/browser-api.js', import.meta.url)), 'utf8');
const expectedHash = hostSource.match(/const WINDOWS_PAIRED_ASAR_SHA256 = '([a-f0-9]{64})'/)[1];
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture({ paired = true, bridge = false } = {}) {
  const files = new Map();
  let loseOwner;
  const lost = new Promise(resolve => { loseOwner = resolve; });
  let holdImport = false, releaseImport, importReached;
  let enteredImport = Promise.resolve();
  let importGate = Promise.resolve();
  const configPath = path.join('V:\\fixture-roaming', 'DSHNotch', 'client-config.json');
  files.set(configPath, JSON.stringify({ notchEnabled: true, hideWhenIdle: false }));
  const launches = [];
  const fakeFS = {
    existsSync: () => true, mkdirSync() {}, appendFileSync() {},
    readFileSync(file) { return files.get(file) ?? '{}'; },
    writeFileSync(file, value) { files.set(file, String(value)); },
    renameSync(from, to) { if (!files.has(from)) throw new Error('fake missing file'); files.set(to, files.get(from)); files.delete(from); },
    statSync() { return { isFile: () => true, isDirectory: () => true }; },
  };
  const fakeSpawn = (...args) => { launches.push(args); return { on() {}, unref() {} }; };
  const fakeProcess = { platform: 'win32', arch: 'x64', version: 'test', pid: 123, env: { APPDATA: 'V:\\fixture-roaming', LOCALAPPDATA: 'V:\\fixture-local' }, noAsar: false };
  const node = () => new Proxy({}, { get: () => () => node() });
  const schema = new Proxy({}, { get: () => () => node() });
  const context = vm.createContext({ process: fakeProcess, console: { log() {} }, URL, Buffer, setTimeout, clearTimeout, Response, Request, TextDecoder,
    __testStartBridge: async () => ({ close: async () => {} }) });
  const values = {
    'node:crypto': { createHash: () => ({ update: () => ({ digest: () => paired ? expectedHash : '0'.repeat(64) }) }) },
    'node:fs': { default: fakeFS }, 'node:fs/promises': { default: {} }, 'node:path': { default: path },
    'node:os': { default: { homedir: () => 'V:\\fixture-home', tmpdir: () => 'V:\\fixture-temp' } },
    'node:child_process': { default: { spawn: fakeSpawn } },
    'node:module': { createRequire: () => name => ({ 'node:fs': fakeFS, 'node:path': path, 'node:os': { homedir: () => 'V:\\fixture-home' }, 'node:tls': {} })[name] },
    '@deepseek-ai/schemastery': { default: schema },
    './nudge.js': { NudgeCenter: class { constructor() { this.config = {}; } dispose() {} }, attachNudges: () => ({ dispose() {} }) },
    './bridge-owner.js': { acquireBridgeOwner: async () => ({ lost, close: async () => {} }), BRIDGE_OWNER_PORT: 47312 },
  };
  const modules = new Map();
  function moduleFor(name) {
    if (name === './browser-api.js') {
      if (!modules.has(name)) modules.set(name, new vm.SourceTextModule(browserSource, { context }));
    } else {
      const value = values[name]; if (!value) throw new Error('unexpected dependency: ' + name);
      if (!modules.has(name)) modules.set(name, new vm.SyntheticModule(Object.keys(value), function () { for (const [key, val] of Object.entries(value)) this.setExport(key, val); }, { context }));
    }
    return modules.get(name);
  }
  const vmSource = bridge
    ? hostSource.replace('export async function startBridge(', 'export async function unusedStartBridge(') + '\nconst startBridge = globalThis.__testStartBridge;\n'
    : hostSource;
  const mod = new vm.SourceTextModule(vmSource, {
    context, initializeImportMeta(meta) { meta.url = 'file:///virtual/index.js'; },
    async importModuleDynamically(name) {
      if (holdImport && name === 'node:fs/promises') { holdImport = false; importReached(); await importGate; }
      const dep = moduleFor(name);
      if (dep.status === 'unlinked') await dep.link(() => { throw new Error('unexpected nested import'); });
      if (dep.status === 'linked') await dep.evaluate();
      return dep;
    },
  });
  await mod.link(name => moduleFor(name)); await mod.evaluate();
  const routes = new Map();
  const connection = { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } } };
  const ctx = { inject(_deps, callback) { callback({ connection, effect(fn) { fn(); } }); } };
  mod.namespace.apply(ctx, { autoInstallApp: false, bridgeEnabled: bridge, appInstallDir: 'V:\\fixture-app' });
  await ctx.vibeIsland.bridgeReady;
  for (let i = 0; i < 100 && ['pending', 'checking'].includes(ctx.vibeIsland.installResult().status); i++) await tick();
  assert.equal(ctx.vibeIsland.installResult().status, paired ? 'present' : 'pair-mismatch');
  const route = routes.get('/api/dsh-vibe-island/config'); assert.ok(route);
  return {
    launches,
    route,
    loseOwner() { loseOwner(new Error('synthetic owner loss')); },
    holdNextLaunch() {
      holdImport = true;
      enteredImport = new Promise(resolve => { importReached = resolve; });
      importGate = new Promise(resolve => { releaseImport = resolve; });
      return enteredImport;
    },
    releaseLaunch() { releaseImport?.(); },
    async set(patch) {
      const req = new Request('http://fixture.invalid/api/dsh-vibe-island/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
      const res = await route.fetch(req); const body = await res.json();
      return { status: res.status, body };
    },
    async stop() { await mod.namespace.dispose(ctx); },
  };
}

test('enabling through the header config route requests a paired native launch', async () => {
  const f = await fixture();
  try {
    assert.equal(f.launches.length, 1, 'startup requested one launch');
    assert.equal((await f.set({ notchEnabled: false })).status, 200);
    assert.equal((await f.set({ action: 'launch' })).body.launch.requested, false, 'disabled state cannot launch');
    assert.equal(f.launches.length, 1, 'turning off does not start the app');
    assert.equal((await f.set({ notchEnabled: true })).status, 200);
    assert.equal(f.launches.length, 1, 'saving is separate from launch');
    const response = await f.set({ action: 'launch' });
    assert.equal(response.status, 200);
    assert.equal(response.body.launch.requested, true, 'report a request, not confirmed native visibility');
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(f.launches.length, 2, 'explicit launch requests a new process after the app exits');
    assert.equal((await f.set({ scale: 1.2 })).status, 200);
    assert.equal(f.launches.length, 2, 'unrelated settings do not launch');
    assert.equal((await f.set({ notchEnabled: 'true' })).status, 400);
    assert.equal(f.launches.length, 2, 'rejected settings do not launch');
  } finally { await f.stop(); }
});

test('a quick off while the enable save is in flight prevents a native launch', async () => {
  const f = await fixture();
  let release, received;
  const gate = new Promise(resolve => { release = resolve; });
  const saved = new Promise(resolve => { received = resolve; });
  const clientSource = fs.readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');
  const storage = new Map();
  let api;
  const react = { createElement() {}, useState: value => [value, () => {}], useEffect() {}, useMemo: f => f(), useSyncExternalStore() {} };
  const sandbox = {
    window: { __ModuleLoader__: { load: ({ factory }) => { api = factory(() => react); } } },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    AbortController, AbortSignal, console: { log() {}, warn() {} }, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async (_url, options) => {
      const request = new Request('http://fixture.invalid/api/dsh-vibe-island/config', options);
      const response = await f.route.fetch(request);
      if (JSON.parse(options.body).notchEnabled === true) { received(); await gate; }
      return response;
    },
  };
  vm.runInNewContext(clientSource, sandbox);
  try {
    const enable = api.saveConfig({ notchEnabled: true }, { notchEnabled: false });
    await saved;
    const disable = api.saveConfig({ notchEnabled: false }, { notchEnabled: true });
    release();
    await Promise.all([enable, disable]);
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(f.launches.length, 1, 'later local disable prevented the app starting');
    assert.equal((await api.saveConfig({ notchEnabled: true }, { notchEnabled: false })).ok, true);
    for (let i = 0; i < 20 && f.launches.length < 2; i++) await tick();
    assert.equal(f.launches.length, 2, 'a later deliberate enable reaches the real host launch path');
  } finally { release(); await f.stop(); }
});

test('a mismatched native archive is never launched', async () => {
  const f = await fixture({ paired: false });
  try {
    assert.equal((await f.set({ notchEnabled: true })).status, 200, 'the setting itself is saved');
    const result = await f.set({ action: 'launch' });
    assert.equal(result.body.launch.requested, false);
    assert.equal(result.body.launch.status, 'pair-mismatch');
    assert.equal(f.launches.length, 0);
  } finally { await f.stop(); }
});

test('a newer disable cancels a pending enable before spawn', async () => {
  const f = await fixture();
  try {
    const entered = f.holdNextLaunch();
    const enable = f.set({ action: 'launch' });
    await entered;
    assert.equal((await f.set({ notchEnabled: false })).status, 200);
    f.releaseLaunch();
    const result = await enable;
    assert.equal(result.body.launch.requested, false);
    assert.equal(f.launches.length, 1, 'only initial launch occurred');
  } finally { f.releaseLaunch(); await f.stop(); }
});

test('losing the bridge does not disable the independent launch route', async () => {
  const f = await fixture({ bridge: true });
  try {
    f.loseOwner();
    for (let i = 0; i < 10; i++) await tick();
    assert.equal((await f.set({ notchEnabled: true })).status, 200);
    const result = await f.set({ action: 'launch' });
    assert.equal(result.body.launch.requested, true);
    assert.equal(f.launches.length, 2, 'startup and independent manual launch');
  } finally { await f.stop(); }
});

test('an aborted launch request cannot start the native app', async () => {
  const f = await fixture();
  try {
    const entered = f.holdNextLaunch();
    const controller = new AbortController();
    const request = new Request('http://fixture.invalid/api/dsh-vibe-island/config', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'launch' }), signal: controller.signal,
    });
    const launch = f.route.fetch(request);
    await entered;
    controller.abort();
    f.releaseLaunch();
    const result = await (await launch).json();
    assert.equal(result.launch.requested, false);
    assert.equal(f.launches.length, 1, 'only the initial application launch occurred');
  } finally { f.releaseLaunch(); await f.stop(); }
});

test('disposal cancels a pending enable before spawn', async () => {
  const f = await fixture();
  try {
    const entered = f.holdNextLaunch();
    const enable = f.set({ action: 'launch' });
    await entered;
    await f.stop();
    f.releaseLaunch();
    const result = await enable;
    assert.equal(result.body.launch.requested, false);
    assert.equal(f.launches.length, 1, 'only initial launch occurred');
  } finally { f.releaseLaunch(); await f.stop(); }
});
