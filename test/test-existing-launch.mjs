// Offline regression: all files, configuration, and mocked dependencies live in a
// fresh OS temp directory. Never touches repository node_modules or test/.tmp.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { createHash } from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-existing-launch-'));
const saved = { home: os.homedir, spawn: cp.spawn, http: http.request, https: https.request, get: https.get, fetch: globalThis.fetch, appdata: process.env.APPDATA, local: process.env.LOCALAPPDATA };
let calls = [], network = 0;
const noNetwork = () => { network++; throw new Error('unexpected network'); };
const fakeSpawn = (...args) => { calls.push(args); return { on() {}, unref() {} }; };
const put = (file, data = 'fixture') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
const windows = (dir, complete = true) => { put(path.join(dir, 'DSHNotch.exe')); if (complete) put(path.join(dir, 'resources', 'app.asar')); };
const mac = (dir, complete = true) => { put(path.join(dir, 'DSHNotch.app', 'Contents', 'MacOS', 'DSHNotch')); if (complete) put(path.join(dir, 'DSHNotch.app', 'Contents', 'Resources', 'zstdlite')); };
try {
  fs.mkdirSync(path.join(temp, 'lib'), { recursive: true });
  for (const name of ['index.js', 'nudge.js', 'browser-api.js', 'bridge-owner.js']) fs.copyFileSync(path.join(root, 'lib', name), path.join(temp, 'lib', name));
  // Only the isolated test module trusts our disposable fixture archive.
  const index = path.join(temp, 'lib', 'index.js');
  const digest = createHash('sha256').update('fixture').digest('hex');
  const src = fs.readFileSync(index, 'utf8');
  assert.match(src, /const WINDOWS_PAIRED_ASAR_SHA256 = '[a-f0-9]{64}'/);
  fs.writeFileSync(index, src.replace(/const WINDOWS_PAIRED_ASAR_SHA256 = '[a-f0-9]{64}'/, `const WINDOWS_PAIRED_ASAR_SHA256 = '${digest}'`));
  put(path.join(temp, 'package.json'), '{"type":"module"}');
  const shim = path.join(temp, 'node_modules', '@deepseek-ai', 'schemastery');
  put(path.join(shim, 'package.json'), '{"type":"module","main":"index.js"}');
  put(path.join(shim, 'index.js'), "const n=()=>{const s={};for(const k of ['default','description','step','min','max','readonly'])s[k]=()=>s;return s};export default {object:n,union:n,boolean:n,number:n,natural:n,string:n,const:n};");
  os.homedir = () => path.join(temp, 'home');
  process.env.APPDATA = path.join(temp, 'roaming');
  process.env.LOCALAPPDATA = path.join(temp, 'local');
  cp.spawn = fakeSpawn;
  http.request = https.request = https.get = globalThis.fetch = noNetwork;
  const mod = await import(pathToFileURL(path.join(temp, 'lib', 'index.js')).href);

  // Exercise apply itself on both platform branches; all config/log paths are
  // redirected to temp. No real process is launched.
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    for (const platform of ['win32', 'darwin']) {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      for (const state of ['present', 'missing', 'partial']) {
        const dir = path.join(temp, 'apply', platform, state);
        if (state !== 'missing') (platform === 'win32' ? windows : mac)(dir, state === 'present');
        calls = [];
        const ctx = {};
        mod.apply(ctx, { autoInstallApp: false, bridgeEnabled: false, appInstallDir: dir });
        for (let i = 0; i < 100 && ['pending', 'checking'].includes(ctx.vibeIsland.installResult().status); i++) await new Promise(r => setImmediate(r));
        const result = ctx.vibeIsland.installResult();
        assert.equal(result.status, state === 'partial' ? 'broken' : state);
        assert.equal(calls.length, state === 'present' ? 1 : 0);
        if (state === 'present') {
          assert.equal(result.launched, true, 'apply must request launch');
          assert.equal(calls[0][0], platform === 'win32' ? path.join(dir, 'DSHNotch.exe') : 'open');
        } else if (state === 'missing') assert.equal(fs.existsSync(dir), false);
      }
    }
  } finally { Object.defineProperty(process, 'platform', platformDescriptor); }

  // Reject any filesystem mutation while exercising existing-only decisions.
  const methods = ['mkdirSync', 'writeFileSync', 'appendFileSync', 'rmSync', 'renameSync', 'copyFileSync', 'unlinkSync'];
  const originals = new Map(methods.map(name => [name, fs[name]]));
  const asyncMethods = ['mkdir', 'writeFile', 'appendFile', 'rm', 'rename', 'copyFile', 'cp', 'unlink'];
  const asyncOriginals = new Map(asyncMethods.map(name => [name, fs.promises[name]]));
  const guard = async fn => {
    const mutations = [];
    for (const name of methods) fs[name] = () => { mutations.push(name); throw new Error('unexpected filesystem mutation: ' + name); };
    for (const name of asyncMethods) fs.promises[name] = async () => { mutations.push(name); throw new Error('unexpected filesystem mutation: ' + name); };
    try {
      const result = await fn();
      assert.deepEqual(mutations, [], 'no filesystem mutation attempts');
      return result;
    } finally {
      for (const [name, original] of originals) fs[name] = original;
      for (const [name, original] of asyncOriginals) fs.promises[name] = original;
    }
  };
  for (const platform of ['win32', 'darwin']) {
    const fixture = platform === 'win32' ? windows : mac;
    const dir = path.join(temp, platform, 'present'); fixture(dir);
    const fallback = platform === 'win32' ? path.join(temp, 'local', 'Programs', 'DSHNotch') : path.join(temp, 'home', 'Applications');
    const opts = { platform, nodeArch: 'x64', version: '1.2.3', spawnImpl: fakeSpawn };
    calls = [];
    let r = await guard(() => mod.ensureAppInstalled({ ...opts, installDir: dir, existingOnly: true }));
    assert.equal(r.status, 'present'); assert.equal(r.launched, true); assert.equal(calls.length, 1);
    assert.equal(calls[0][0], platform === 'win32' ? path.join(dir, 'DSHNotch.exe') : 'open');
    if (platform === 'darwin') assert.deepEqual(calls[0][1], [path.join(dir, 'DSHNotch.app')]);
    calls = [];
    r = await guard(() => mod.ensureAppInstalled({ ...opts, installDir: dir, dryRun: true }));
    assert.equal(r.status, 'present'); assert.equal(r.launched, false); assert.equal(calls.length, 0);
    r = await guard(() => mod.ensureAppInstalled({ ...opts, installDir: dir, existingOnly: true, dryRun: true }));
    assert.equal(r.status, 'present'); assert.equal(r.launched, false); assert.equal(calls.length, 0);
    r = await guard(() => mod.ensureAppInstalled({ ...opts, installDir: dir, existingOnly: true, launch: false }));
    assert.equal(r.launched, false); assert.equal(calls.length, 0);
    const missing = path.join(temp, platform, 'missing');
    r = await guard(() => mod.ensureAppInstalled({ ...opts, installDir: missing, existingOnly: true, version: 'latest' }));
    assert.equal(r.status, 'missing'); assert.equal(fs.existsSync(missing), false); assert.equal(fs.existsSync(fallback), false); assert.equal(calls.length, 0);
    const partial = path.join(temp, platform, 'partial'); fixture(partial, false);
    const before = fs.readFileSync(platform === 'win32' ? path.join(partial, 'DSHNotch.exe') : path.join(partial, 'DSHNotch.app', 'Contents', 'MacOS', 'DSHNotch'));
    r = await guard(() => mod.ensureAppInstalled({ ...opts, installDir: partial, existingOnly: true, version: 'latest' }));
    assert.equal(r.status, 'broken'); assert.equal(calls.length, 0);
    assert.deepEqual(fs.readFileSync(platform === 'win32' ? path.join(partial, 'DSHNotch.exe') : path.join(partial, 'DSHNotch.app', 'Contents', 'MacOS', 'DSHNotch')), before);
    assert.equal(fs.existsSync(platform === 'win32' ? path.join(partial, 'resources', 'app.asar') : path.join(partial, 'DSHNotch.app', 'Contents', 'Resources', 'zstdlite')), false);
    fixture(fallback);
    r = await guard(() => mod.ensureAppInstalled({ ...opts, installDir: missing, existingOnly: true }));
    assert.equal(r.status, 'present'); assert.equal(r.dir, fallback); assert.equal(calls.length, 1);
  }
  const unsupported = await guard(() => mod.ensureAppInstalled({ platform: 'linux', existingOnly: true }));
  assert.equal(unsupported.status, 'skip');
  assert.equal(network, 0, 'no networking in existing-only path');
  console.log('existing-only launch behavioral tests passed');
} finally {
  os.homedir = saved.home; cp.spawn = saved.spawn; http.request = saved.http; https.request = saved.https; https.get = saved.get; globalThis.fetch = saved.fetch;
  if (saved.appdata === undefined) delete process.env.APPDATA; else process.env.APPDATA = saved.appdata;
  if (saved.local === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = saved.local;
  fs.rmSync(temp, { recursive: true, force: true });
}
