// Isolated settings allowlist regression. The module and filesystem are private
// temporary fixtures; no bridge, native process or real profile is accessed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIsolatedModule } from './isolated-module.mjs';

const saved = { appdata: process.env.APPDATA, xdg: process.env.XDG_CONFIG_HOME, home: os.homedir };
const fixture = createIsolatedModule();
try {
  process.env.APPDATA = path.join(fixture.dir, 'appdata');
  process.env.XDG_CONFIG_HOME = path.join(fixture.dir, 'xdg');
  os.homedir = () => path.join(fixture.dir, 'home');
  const { writeConfig, readConfig } = await fixture.importModule();
  for (const key of ['constructor', 'toString', '__proto__']) {
    const raw = JSON.stringify({ [key]: { injected: true } });
    const result = writeConfig(raw);
    assert.equal(result.ok, false, `${key} must be rejected`);
    assert.equal(result.rejected?.[0]?.key, key);
    assert.equal(Object.hasOwn(readConfig(), key), false);
  }
  const good = writeConfig(JSON.stringify({ nudgeEnabled: false }));
  assert.equal(good.ok, true);
  assert.equal(readConfig().nudgeEnabled, false);
  console.log('config allowlist regression: passed');
} finally {
  os.homedir = saved.home;
  for (const [key, value] of [['APPDATA', saved.appdata], ['XDG_CONFIG_HOME', saved.xdg]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fixture.cleanup();
}
