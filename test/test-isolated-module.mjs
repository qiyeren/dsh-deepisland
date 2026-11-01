// Offline regression for dependency and artifact isolation. No bridge or network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolatedModule } from './isolated-module.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'deepisland-isolation-check-'));
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
  const installed = await mod.ensureAppInstalled({
    installDir: full, platform: 'win32', existingOnly: true, launch: true, log() {},
    spawnImpl: (...args) => { calls.push(args); return { on() {}, unref() {} }; },
  });
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
  fs.rmSync(outer, { recursive: true, force: true });
}
