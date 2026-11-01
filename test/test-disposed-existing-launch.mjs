// Isolated lifecycle regression. Run: node --experimental-vm-modules test/test-disposed-existing-launch.mjs
// Executes the unmodified host module in a VM with fake process, filesystem,
// dependencies and spawn. No sockets, network, profile writes or node_modules.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const source = fs.readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8');
const schemaNode = () => new Proxy({}, { get: () => () => schemaNode() });
const schema = new Proxy({}, { get: () => () => schemaNode() });
const tick = () => new Promise(resolve => setImmediate(resolve));

async function run(platform, scenario) {
  const launches = [];
  const imports = [];
  let releaseImport;
  let importReached;
  const reached = new Promise(resolve => { importReached = resolve; });
  const gate = new Promise(resolve => { releaseImport = resolve; });
  const fakeFs = {
    mkdirSync() {}, appendFileSync() {}, writeFileSync() {},
    existsSync: () => true,
    readFileSync: () => '{}',
    statSync: name => ({ isFile: () => !name.endsWith('DSHNotch.app'), isDirectory: () => name.endsWith('DSHNotch.app') }),
  };
  const fakeOs = { homedir: () => '/fake/home', tmpdir: () => '/fake/tmp' };
  const fakeSpawn = (...args) => { launches.push(args); return { on() {}, unref() {} }; };
  const fakeProcess = { platform, arch: 'x64', version: 'test', env: {}, noAsar: false };
  const context = vm.createContext({ process: fakeProcess, console: { log() {} }, URL, Buffer, setTimeout, clearTimeout });
  const values = {
    'node:crypto': { createHash: () => ({ update: () => ({ digest: () => source.match(/const WINDOWS_PAIRED_ASAR_SHA256 = '([a-f0-9]{64})'/)[1] }) }) },
    'node:fs': { default: fakeFs },
    'node:fs/promises': { default: {} },
    'node:path': { default: path },
    'node:os': { default: fakeOs },
    'node:child_process': { default: { spawn: fakeSpawn } },
    'node:module': { createRequire: () => name => {
      if (name === 'node:fs') return fakeFs;
      if (name === 'node:path') return path;
      if (name === 'node:os') return fakeOs;
      if (name === 'node:tls') return {};
      throw new Error('unexpected require: ' + name);
    } },
    '@deepseek-ai/schemastery': { default: schema },
    './nudge.js': { NudgeCenter: class { constructor() { this.config = {}; } dispose() {} }, attachNudges: () => { throw new Error('unexpected nudge setup'); } },
    './browser-api.js': { registerBrowserApi: () => { throw new Error('unexpected browser API'); } },
    './bridge-owner.js': { acquireBridgeOwner: () => { throw new Error('unexpected socket'); }, BRIDGE_OWNER_PORT: 47312 },
  };
  const modules = new Map();
  const makeModule = name => {
    const value = values[name];
    if (!value) throw new Error('unexpected module: ' + name);
    if (!modules.has(name)) modules.set(name, new vm.SyntheticModule(Object.keys(value), function () {
      for (const [key, val] of Object.entries(value)) this.setExport(key, val);
    }, { context }));
    return modules.get(name);
  };
  const mod = new vm.SourceTextModule(source, {
    context,
    initializeImportMeta(meta) { meta.url = 'file:///virtual/index.js'; },
    async importModuleDynamically(name) {
      imports.push(name);
      if (scenario === 'during-import' && name === 'node:fs/promises') {
        importReached();
        await gate;
      }
      const dep = makeModule(name);
      if (dep.status === 'unlinked') await dep.link(() => { throw new Error('unexpected nested import'); });
      if (dep.status === 'linked') await dep.evaluate();
      return dep;
    },
  });
  await mod.link(name => makeModule(name));
  await mod.evaluate();
  const ctx = {};
  mod.namespace.apply(ctx, { autoInstallApp: false, bridgeEnabled: false, appInstallDir: '/fake/installed' });
  if (scenario === 'immediate') {
    await mod.namespace.dispose(ctx);
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(launches.length, 0, `${platform}: no launch after immediate disposal`);
    assert.equal(imports.length, 0, `${platform}: no startup imports after immediate disposal`);
    return;
  }
  if (scenario === 'during-import') {
    await Promise.race([reached, new Promise((_, reject) => setTimeout(() => reject(new Error('import gate not reached')), 1000))]);
    await mod.namespace.dispose(ctx);
    releaseImport();
  }
  for (let i = 0; i < 100 && ['pending', 'checking'].includes(ctx.vibeIsland.installResult().status); i++) await tick();
  const result = ctx.vibeIsland.installResult();
  assert.equal(result.status, 'present', `${platform}: installed app detected`);
  assert.equal(launches.length, scenario === 'normal' ? 1 : 0, `${platform}: launch count (${scenario})`);
  assert.equal(result.launched, scenario === 'normal');
  if (scenario === 'normal') {
    assert.equal(launches[0][0], platform === 'win32' ? path.join('/fake/installed', 'DSHNotch.exe') : 'open');
    await mod.namespace.dispose(ctx);
  }
}

for (const platform of ['win32', 'darwin']) {
  for (const scenario of ['immediate', 'during-import', 'normal']) {
    await run(platform, scenario);
    console.log(`${platform} ${scenario}: ok`);
  }
}
