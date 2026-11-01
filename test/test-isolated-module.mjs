// Offline regression for dependency and artifact isolation. No bridge or network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolatedModule } from './isolated-module.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'deepisland-isolation-check-'));
const previousLocalAppData = process.env.LOCALAPPDATA;
// The installer also checks its standard fallback directory; contain it before
// importing or exercising the copied module, not merely its first candidate.
process.env.LOCALAPPDATA = path.join(outer, 'local');
try {
  const sentinel = path.join(outer, 'sentinel');
  fs.writeFileSync(sentinel, 'untouched');
  const a = createIsolatedModule();
  const b = createIsolatedModule();
  assert.notEqual(a.dir, b.dir);
  const mod = await a.importModule();
  assert.equal(typeof mod.ensureAppInstalled, 'function');
  assert.equal(typeof mod.startBridge, 'function');
  const source = fs.readFileSync(path.join(testDir, '..', 'lib', 'index.js'));
  assert.deepEqual(fs.readFileSync(path.join(a.dir, 'lib', 'index.js')), source);
  const fake = path.join(a.dir, 'node_modules', '@deepseek-ai', 'schemastery', 'index.js');
  assert.ok(fs.existsSync(fake));
  const missing = path.join(a.dir, 'missing-install');
  const result = await mod.ensureAppInstalled({ installDir: missing, platform: 'linux', log() {} });
  assert.equal(result.status, 'skip');
  assert.equal(fs.existsSync(missing), false);
  const full = path.join(a.dir, 'installed');
  fs.mkdirSync(path.join(full, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(full, 'DSHNotch.exe'), 'fake');
  fs.writeFileSync(path.join(full, 'resources', 'app.asar'), 'fake');
  const calls = [];
  const originals = { statSync: fs.statSync, readFileSync: fs.readFileSync };
  const violations = [];
  let installed;
  try {
    for (const name of Object.keys(originals)) fs[name] = (file, ...args) => {
      const resolved = path.resolve(String(file));
      const inside = dir => resolved === dir || resolved.startsWith(dir + path.sep);
      if (!inside(a.dir) && !inside(outer)) {
        violations.push(resolved);
        throw new Error('non-fixture file access forbidden');
      }
      return originals[name].call(fs, file, ...args);
    };
    installed = await mod.ensureAppInstalled({
      installDir: full, platform: 'win32', existingOnly: true, launch: true, log() {},
      spawnImpl: (...args) => { calls.push(args); return { on() {}, unref() {} }; },
    });
  } finally { Object.assign(fs, originals); }
  assert.deepEqual(violations, [], 'installer must never inspect a non-fixture path');
  assert.equal(installed.status, 'pair-mismatch');
  assert.equal(calls.length, 0);
  a.cleanup();
  a.cleanup();
  assert.equal(fs.existsSync(a.dir), false);
  assert.ok(fs.existsSync(b.dir));
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched');
  b.cleanup();
  for (const file of ['serve-bridge.mjs', 'test-bridge.mjs', 'test-bridge-client.mjs', 'test-install-dl.mjs', 'test-install-win.mjs', 'test-nudge-bridge.mjs']) {
    const text = fs.readFileSync(path.join(testDir, file), 'utf8');
    assert.match(text, /createIsolatedModule/);
    assert.doesNotMatch(text, /path\.join\(ROOT,\s*['"]node_modules['"]/);
    assert.doesNotMatch(text, /path\.join\(ROOT,\s*['"]test['"],\s*['"]\.tmp['"]/);
  }
  console.log('Isolation regression passed: separate fixtures, imported copied source, and cleanup confined to owned directories.');
} finally {
  if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = previousLocalAppData;
  fs.rmSync(outer, { recursive: true, force: true });
}
