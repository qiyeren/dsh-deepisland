// Temporary module and fake processes only; never access the actual DSH profile.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
test('Windows starts only a paired archive and never downloads an unpaired one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'island-pair-'));
  const saved = { local: process.env.LOCALAPPDATA, req: http.request, https: https.request, get: https.get, fetch: globalThis.fetch };
  try {
    fs.mkdirSync(path.join(dir, 'lib'));
    for (const file of ['index.js', 'nudge.js', 'browser-api.js', 'bridge-owner.js']) fs.copyFileSync(path.join(root, 'lib', file), path.join(dir, 'lib', file));
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
    const shim = path.join(dir, 'node_modules', '@deepseek-ai', 'schemastery');
    fs.mkdirSync(shim, { recursive: true });
    fs.writeFileSync(path.join(shim, 'package.json'), '{"type":"module","main":"index.js"}');
    fs.writeFileSync(path.join(shim, 'index.js'), "const n=()=>{const s={};for(const k of ['default','description','step','min','max','readonly'])s[k]=()=>s;return s};export default {object:n,union:n,boolean:n,number:n,natural:n,string:n,const:n};");
    const index = path.join(dir, 'lib', 'index.js');
    const source = fs.readFileSync(index, 'utf8');
    const digest = createHash('sha256').update('paired').digest('hex');
    assert.match(source, /const WINDOWS_PAIRED_ASAR_SHA256 = '[a-f0-9]{64}'/);
    fs.writeFileSync(index, source.replace(/const WINDOWS_PAIRED_ASAR_SHA256 = '[a-f0-9]{64}'/, `const WINDOWS_PAIRED_ASAR_SHA256 = '${digest}'`));
    process.env.LOCALAPPDATA = path.join(dir, 'local');
    const deny = () => { throw Error('network forbidden'); };
    http.request = https.request = https.get = globalThis.fetch = deny;
    const mod = await import(pathToFileURL(index));
    const app = path.join(dir, 'app');
    fs.mkdirSync(path.join(app, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(app, 'DSHNotch.exe'), 'fixture');
    const asar = path.join(app, 'resources', 'app.asar');
    let launches = 0;
    const launchedPaths = [];
    const spawnImpl = exe => { launches++; launchedPaths.push(exe); return { on() {}, unref() {} }; };
    const opts = { platform: 'win32', installDir: app, spawnImpl, nodeArch: 'x64' };
    fs.writeFileSync(asar, 'old');
    for (const existingOnly of [true, false]) {
      const r = await mod.ensureAppInstalled({ ...opts, existingOnly });
      assert.equal(r.launched, false); assert.equal(r.status, 'pair-mismatch');
      assert.equal(launches, 0);
    }
    fs.writeFileSync(asar, 'paired');
    assert.equal((await mod.ensureAppInstalled({ ...opts, existingOnly: true })).launched, true);
    assert.equal(launches, 1);
    assert.equal((await mod.ensureAppInstalled({ ...opts, existingOnly: false, shouldLaunch: () => false })).launched, false);
    assert.equal(launches, 1);
    const missing = path.join(dir, 'missing');
    const r = await mod.ensureAppInstalled({ ...opts, installDir: missing, existingOnly: false });
    assert.equal(r.status, 'pair-missing');
    assert.equal(fs.existsSync(missing), false);
    assert.equal(launches, 1);

    // If the standard copy is mismatched/locked, an independently installed
    // matching copy can start without overwriting or downloading anything.
    const standard = path.join(process.env.LOCALAPPDATA, 'Programs', 'DSHNotch');
    const parallel = path.join(process.env.LOCALAPPDATA, 'Programs', 'DSHNotch-paired');
    for (const [folder, content] of [[standard, 'old'], [parallel, 'paired']]) {
      fs.mkdirSync(path.join(folder, 'resources'), { recursive: true });
      fs.writeFileSync(path.join(folder, 'DSHNotch.exe'), 'fixture');
      fs.writeFileSync(path.join(folder, 'resources', 'app.asar'), content);
    }
    const alternate = await mod.ensureAppInstalled({ ...opts, installDir: missing, existingOnly: true });
    assert.equal(alternate.status, 'present');
    assert.equal(alternate.launched, true);
    assert.equal(launchedPaths.at(-1), path.join(parallel, 'DSHNotch.exe'));
    fs.writeFileSync(path.join(parallel, 'resources', 'app.asar'), 'not-paired');
    assert.equal((await mod.ensureAppInstalled({ ...opts, installDir: missing, existingOnly: true })).status, 'pair-mismatch');
    assert.equal(launches, 2, 'a mismatched alternate cannot start');
    fs.writeFileSync(path.join(standard, 'resources', 'app.asar'), 'paired');
    fs.writeFileSync(path.join(parallel, 'resources', 'app.asar'), 'paired');
    await mod.ensureAppInstalled({ ...opts, installDir: missing, existingOnly: true });
    assert.equal(launchedPaths.at(-1), path.join(standard, 'DSHNotch.exe'), 'standard matching install keeps priority');
    await mod.ensureAppInstalled({ ...opts, existingOnly: true });
    assert.equal(launchedPaths.at(-1), path.join(app, 'DSHNotch.exe'), 'explicit matching install keeps highest priority');

    // A hash-versioned runtime remains independently addressable when both
    // existing archives are in use, and it is still rejected if unpaired.
    const versioned = path.join(process.env.LOCALAPPDATA, 'Programs', `DSHNotch-${digest.slice(0, 16)}`);
    fs.mkdirSync(path.join(versioned, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(versioned, 'DSHNotch.exe'), 'fixture');
    fs.writeFileSync(path.join(versioned, 'resources', 'app.asar'), 'not-paired');
    for (const folder of [standard, parallel]) fs.writeFileSync(path.join(folder, 'resources', 'app.asar'), 'old');
    const beforeVersioned = launches;
    assert.equal((await mod.ensureAppInstalled({ ...opts, installDir: missing, existingOnly: true })).status, 'pair-mismatch');
    assert.equal(launches, beforeVersioned, 'a mismatched versioned archive cannot start');
    fs.writeFileSync(path.join(versioned, 'resources', 'app.asar'), 'paired');
    const isolated = await mod.ensureAppInstalled({ ...opts, installDir: missing, existingOnly: true });
    assert.equal(isolated.status, 'present');
    assert.equal(isolated.launched, true);
    assert.equal(launchedPaths.at(-1), path.join(versioned, 'DSHNotch.exe'));
    assert.equal(launches, beforeVersioned + 1);
  } finally {
    if (saved.local === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = saved.local;
    http.request = saved.req; https.request = saved.https; https.get = saved.get; globalThis.fetch = saved.fetch;
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('island-pair-')) {
      throw new Error('refusing to remove an unexpected synthetic test directory');
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
