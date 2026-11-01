// Offline lifecycle integration: copied production modules, private fixtures,
// fake Connection routes and in-memory HTTP. Never open a socket or run an app.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedPaths = ['/api/dsh-vibe-island/config', '/api/dsh-vibe-island/next'];
const tick = () => new Promise(resolve => setImmediate(resolve));

async function withFixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepisland-apply-memory-'));
  const envKeys = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME'];
  const env = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const old = {
    homedir: os.homedir, createServer: http.createServer, request: http.request,
    get: http.get, httpsRequest: https.request, httpsGet: https.get,
    netConnect: net.connect, netCreateConnection: net.createConnection,
    netListen: net.Server.prototype.listen, netCreateServer: net.createServer, tlsConnect: tls.connect,
    spawn: childProcess.spawn, fetch: globalThis.fetch,
  };
  const initialExitListeners = process.listeners('exit');
  const servers = [];
  const owners = [];
  const reservations = new Set();
  const controls = { holdBridgeListen: false, holdOwnerListen: false };
  let probes = 0;
  const deny = () => { throw new Error('offline test: external I/O forbidden'); };
  try {
    fs.mkdirSync(path.join(dir, 'lib'));
    for (const name of ['index.js', 'nudge.js', 'browser-api.js', 'bridge-owner.js']) {
      fs.copyFileSync(path.join(root, 'lib', name), path.join(dir, 'lib', name));
    }
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
    const shim = path.join(dir, 'node_modules', '@deepseek-ai', 'schemastery');
    fs.mkdirSync(shim, { recursive: true });
    fs.writeFileSync(path.join(shim, 'package.json'), '{"type":"module","main":"index.js"}');
    fs.writeFileSync(path.join(shim, 'index.js'), `const node = () => { const s = {}; for (const m of ['default','description','step','min','max','readonly']) s[m] = () => s; return s; };\nexport default { object: node, union: node, boolean: node, number: node, natural: node, string: node, const: node };\n`);
    for (const key of envKeys) process.env[key] = path.join(dir, key.toLowerCase());
    os.homedir = () => path.join(dir, 'home');
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    http.request = () => {
      probes++;
      const req = new EventEmitter();
      req.end = () => queueMicrotask(() => req.emit('error', Object.assign(new Error('offline'), { code: 'ECONNREFUSED' })));
      req.setTimeout = req.destroy = () => req;
      return req;
    };
    http.get = https.request = https.get = net.connect = net.createConnection =
      net.Server.prototype.listen = tls.connect = childProcess.spawn = globalThis.fetch = deny;
    net.createServer = () => {
      const server = new EventEmitter();
      server.listen = options => {
        assert.deepEqual(options, { host: '127.0.0.1', port: 47312, exclusive: true });
        const complete = () => {
          if (controls.ownerFailure) return server.emit('error', controls.ownerFailure);
          if (reservations.has(options.port)) return server.emit('error', Object.assign(new Error('owned'), { code: 'EADDRINUSE' }));
          reservations.add(options.port); server.listening = true; server.emit('listening');
        };
        if (controls.holdOwnerListen) { controls.finishOwnerListen = complete; controls.onOwnerListen?.(); } else queueMicrotask(complete);
        return server;
      };
      server.close = callback => {
        if (!server.listening) { queueMicrotask(() => callback?.(new Error('not listening'))); return server; }
        server.listening = false; reservations.delete(47312);
        queueMicrotask(() => { server.emit('close'); callback?.(); }); return server;
      };
      owners.push(server); return server;
    };
    syncBuiltinESMExports();
    http.createServer = handler => {
      const server = new EventEmitter();
      server.handler = handler;
      server.listening = false;
      server.listen = (port, host) => {
        assert.equal(host, '127.0.0.1');
        server.port = port;
        const complete = () => { server.listening = true; server.emit('listening'); };
        if (controls.holdBridgeListen) { controls.finishBridgeListen = complete; controls.onBridgeListen?.(); } else queueMicrotask(complete);
        return server;
      };
      server.close = callback => {
        server.listening = false;
        queueMicrotask(() => callback?.());
        return server;
      };
      server.closeAllConnections = () => {};
      servers.push(server);
      return server;
    };
    const module = await import(pathToFileURL(path.join(dir, 'lib', 'index.js')).href);
    await run({ dir, module, importAlternate: () => import(pathToFileURL(path.join(dir, 'lib', 'index.js')).href + '?alternate'), servers, owners, reservations, controls, probes: () => probes, initialExitListeners });
  } finally {
    // Remove only listeners introduced by this private module, even on failure.
    for (const fn of process.listeners('exit')) if (!initialExitListeners.includes(fn)) process.removeListener('exit', fn);
    Object.defineProperty(process, 'platform', platform);
    for (const key of envKeys) env[key] === undefined ? delete process.env[key] : process.env[key] = env[key];
    os.homedir = old.homedir;
    http.createServer = old.createServer; http.request = old.request; http.get = old.get;
    https.request = old.httpsRequest; https.get = old.httpsGet;
    net.connect = old.netConnect; net.createConnection = old.netCreateConnection;
    net.Server.prototype.listen = old.netListen; net.createServer = old.netCreateServer; tls.connect = old.tlsConnect;
    syncBuiltinESMExports();
    childProcess.spawn = old.spawn; globalThis.fetch = old.fetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function context(withConnection = true) {
  const routes = new Map();
  const registrations = [];
  const removals = [];
  const connection = { fetch: { register(route) {
    if (ctx.failRegistrationAt === route.path) throw new Error('fake registration failure');
    assert.equal(routes.has(route.path), false, 'duplicate route');
    routes.set(route.path, route);
    registrations.push(route.path);
    return async () => {
      if (ctx.unregisterGate) await ctx.unregisterGate;
      if (ctx.failUnregister) throw new Error('fake unregister failure');
      routes.delete(route.path); removals.push(route.path);
    };
  } } };
  const listeners = new Set();
  let mount;
  let effects = null;
  const ctx = {
    routes, registrations, removals, listeners,
    get(name) { return name === 'connection' && withConnection ? connection : undefined; },
    on(name, fn) {
      if (name === 'session/event') listeners.add(fn);
      return () => listeners.delete(fn);
    },
    inject(deps, callback) {
      assert.deepEqual(deps, ['connection']);
      mount = () => {
        const local = [];
        const child = Object.create(ctx);
        child.connection = connection;
        child.effect = fn => { const cleanup = fn(); local.push(cleanup); return cleanup; };
        effects = local;
        callback(child);
      };
      if (withConnection) mount();
    },
    appear() { assert.equal(effects, null); withConnection = true; mount(); },
    remove() {
      withConnection = false;
      const old = effects; effects = null;
      return Promise.all((old || []).slice().reverse().map(fn => fn()));
    },
  };
  return ctx;
}

const config = { bridgeEnabled: true, bridgePort: 32177, autoInstallApp: false };

test('apply ownership and authenticated browser route lifecycle, fully offline', async () => {
  await withFixture(async ({ module, servers, probes, initialExitListeners }) => {
    const owner = context();
    const other = context();
    let bridge;
    try {
      module.apply(owner, config);
      bridge = await owner.vibeIsland.bridgeReady;
      assert.ok(bridge, 'first apply owns a bridge');
      assert.equal(owner.vibeIsland.cfg.autoInstallApp, false);
      assert.deepEqual([...owner.routes.keys()].sort(), expectedPaths);
      assert.equal(owner.registrations.length, 2);
      assert.equal(servers.filter(s => s.listening).length, 1);
      assert.ok(probes() > 0, 'sibling probes used fake HTTP');
      const configRoute = owner.routes.get('/api/dsh-vibe-island/config');
      const configResponse = await configRoute.fetch(new Request('http://test.invalid/api/dsh-vibe-island/config'));
      assert.equal(configResponse.status, 200);
      assert.equal((await configResponse.json()).config.notchEnabled, true);
      const route = owner.routes.get('/api/dsh-vibe-island/next');
      bridge.enqueue({ sessionId: 'session-test', title: 'Offline' });
      const response = await route.fetch(new Request('http://test.invalid/api/dsh-vibe-island/next', { method: 'POST' }));
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.ok, true);
      assert.equal(payload.items.length, 1);
      assert.equal(payload.items[0].sessionId, 'session-test');
      module.apply(other, config);
      assert.equal(await other.vibeIsland.bridgeReady, null, 'second apply must not acquire the owner bridge');
      assert.deepEqual(other.registrations.slice().sort(), expectedPaths, 'independent authenticated carrier keeps settings on ownership conflict');
      assert.equal(servers.filter(s => s.listening).length, 1);
      module.dispose(other);
      await tick();
      assert.equal(servers.filter(s => s.listening).length, 1, 'disposing non-owner preserves owner');
    } finally {
      module.dispose(owner);
      await tick(); await tick();
    }
    assert.equal(owner.routes.size, 0, 'owner routes unregistered on disposal');
    assert.deepEqual(owner.removals.slice().sort(), expectedPaths);
    assert.equal(servers.filter(s => s.listening).length, 0, 'no bridge server remains listening');
    assert.deepEqual(process.listeners('exit'), initialExitListeners, 'no process exit listeners leaked');
  });
});

test('independent module instances and different bridge ports still conflict', async () => {
  await withFixture(async ({ module, importAlternate, servers }) => {
    const alternate = await importAlternate(); const one = context(), two = context();
    module.apply(one, config); alternate.apply(two, { ...config, bridgePort: 32277 });
    const result = await Promise.all([one.vibeIsland.bridgeReady, two.vibeIsland.bridgeReady]);
    assert.equal(result.filter(Boolean).length, 1);
    assert.equal(servers.filter(s => s.listening).length, 1);
    const loser = result[0] ? two : one;
    assert.equal((await loser.routes.get(expectedPaths[0]).fetch(new Request('http://test.invalid/config'))).status, 200);
    await Promise.all([module.dispose(one), alternate.dispose(two)]);
    assert.equal(servers.filter(s => s.listening).length, 0);
  });
});

test('sibling and cache existingOwner sentinels do not poison future starts', async () => {
  await withFixture(async ({ module }) => {
    const original = http.request;
    try {
      http.request = (_options, callback) => {
        const req = new EventEmitter(); req.setTimeout = req.destroy = () => req;
        req.end = () => queueMicrotask(() => {
          const res = new EventEmitter(); res.statusCode = 200; callback(res);
          res.emit('data', Buffer.from(JSON.stringify({ ok: true, plugin: 'dsh-vibe-island' }))); res.emit('end');
        });
        return req;
      };
      assert.deepEqual(await module.startBridge({ port: 32071 }), { existingOwner: true });
      http.request = original;
      const bridge = await module.startBridge({ port: 32071 });
      assert.ok(bridge?.close, 'sibling sentinel is removed from the cache');
      assert.deepEqual(await module.startBridge({ port: 32071 }), { existingOwner: true });
      await bridge.close();
      const again = await module.startBridge({ port: 32071 });
      assert.ok(again?.close); await again.close();
    } finally { http.request = original; }
  });
});

test('owner loss after readiness automatically stops active bridge', async () => {
  await withFixture(async ({ module, servers, owners, reservations }) => {
    const ctx = context(); module.apply(ctx, config);
    assert.ok(await ctx.vibeIsland.bridgeReady);
    let finish; servers[0].close = cb => { finish = () => { servers[0].listening = false; cb(); }; };
    owners[0].emit('error', new Error('sentinel failure'));
    await tick();
    assert.equal(typeof finish, 'function', 'loss itself initiates bridge close');
    assert.equal(reservations.size, 1, 'owner remains held while bridge closes');
    finish(); await tick(); await tick();
    assert.equal(reservations.size, 0);
    assert.equal(servers.filter(s => s.listening).length, 0);
    assert.equal((await ctx.routes.get(expectedPaths[0]).fetch(new Request('http://test.invalid/config'))).status, 200, 'settings remain available after owner loss');
    await module.dispose(ctx);
    assert.equal(ctx.routes.size, 0);
  });
});

test('non-conflict owner bind failure fails closed without hiding settings', async () => {
  await withFixture(async ({ module, controls, servers, reservations }) => {
    controls.ownerFailure = Object.assign(new Error('access denied'), { code: 'EACCES' });
    const ctx = context(); module.apply(ctx, config);
    assert.equal(await ctx.vibeIsland.bridgeReady, null);
    assert.equal(servers.length, 0); assert.equal(reservations.size, 0);
    assert.equal((await ctx.routes.get(expectedPaths[0]).fetch(new Request('http://test.invalid/config'))).status, 200);
    await module.dispose(ctx);
  });
});

test('reserved owner port fails closed while authenticated settings remain usable', async () => {
  await withFixture(async ({ dir, module, servers, owners, probes }) => {
    const { BRIDGE_OWNER_PORT } = await import(pathToFileURL(path.join(dir, 'lib', 'bridge-owner.js')).href);
    const ctx = context();
    const messages = [];
    const originalLog = console.log;
    console.log = (...args) => messages.push(args.join(' '));
    try {
      module.apply(ctx, { ...config, bridgePort: BRIDGE_OWNER_PORT });
      assert.equal(await ctx.vibeIsland.bridgeReady, null);
      assert.equal(owners.length, 0, 'invalid data port must not reserve ownership');
      assert.equal(servers.length, 0, 'invalid data port must not create or bind a data server');
      assert.equal(probes(), 0, 'invalid data port must not probe or select another port');
      assert.ok(messages.some(message => message.includes(String(BRIDGE_OWNER_PORT)) &&
        message.includes('bridgePort') && message.includes('保留')), 'diagnostic identifies the reserved port and correction');
      assert.deepEqual([...ctx.routes.keys()].sort(), expectedPaths);
      const route = ctx.routes.get(expectedPaths[0]);
      const post = await route.fetch(new Request('http://test.invalid/config', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hideWhenIdle: true }),
      }));
      assert.equal(post.status, 200);
      assert.equal((await post.json()).config.hideWhenIdle, true);
      const get = await route.fetch(new Request('http://test.invalid/config'));
      assert.equal(get.status, 200);
      assert.equal((await get.json()).config.hideWhenIdle, true);
      const next = await ctx.routes.get(expectedPaths[1]).fetch(new Request('http://test.invalid/next', { method: 'POST' }));
      assert.equal(next.status, 503);
      const directLogs = [];
      assert.equal(await module.startBridge({ port: BRIDGE_OWNER_PORT, log: message => directLogs.push(message) }), null);
      assert.ok(directLogs.some(message => message.includes(String(BRIDGE_OWNER_PORT)) && message.includes('bridgePort')));
      assert.equal(servers.length, 0, 'direct start must also reject the sentinel as a data port');
      assert.equal(probes(), 0);
    } finally {
      await module.dispose(ctx);
      console.log = originalLog;
    }
    assert.equal(ctx.routes.size, 0);
  });
});

test('disabled bridge keeps authenticated settings and returns unavailable queue', async () => {
  await withFixture(async ({ module, servers, owners }) => {
    const ctx = context();
    module.apply(ctx, { ...config, bridgeEnabled: false });
    assert.equal(await ctx.vibeIsland.bridgeReady, null);
    assert.equal(owners.length, 0);
    assert.equal(servers.length, 0);
    assert.deepEqual([...ctx.routes.keys()].sort(), expectedPaths);
    assert.equal((await ctx.routes.get(expectedPaths[0]).fetch(new Request('http://test.invalid/config'))).status, 200);
    assert.equal((await ctx.routes.get(expectedPaths[1]).fetch(new Request('http://test.invalid/next', { method: 'POST' }))).status, 503);
    await module.dispose(ctx);
    assert.equal(ctx.routes.size, 0);
  });
});

test('loss during startup closes late bridge, and concurrent dispose waits for close before releasing ownership', async () => {
  await withFixture(async ({ module, servers, owners, reservations }) => {
    const ctx = context();
    module.apply(ctx, config);
    await tick();
    assert.equal(owners.length, 1);
    owners[0].emit('error', new Error('owner lost'));
    const one = module.dispose(ctx), two = module.dispose(ctx);
    await Promise.all([one, two]);
    assert.equal(await ctx.vibeIsland.bridgeReady, null);
    assert.equal(servers.filter(s => s.listening).length, 0);
    assert.equal(reservations.size, 0);
    assert.equal(ctx.routes.size, 0);
  });
});

test('dispose during acquisition waits and never starts bridge', async () => {
  await withFixture(async ({ module, controls, reservations, servers }) => {
    controls.holdOwnerListen = true;
    const listening = new Promise(resolve => { controls.onOwnerListen = resolve; });
    const ctx = context(); module.apply(ctx, config); await listening;
    let finished = false; const stopping = module.dispose(ctx).then(() => { finished = true; });
    await tick(); assert.equal(finished, false);
    controls.finishOwnerListen(); await stopping;
    assert.equal(reservations.size, 0); assert.equal(servers.length, 0);
    assert.equal(await ctx.vibeIsland.bridgeReady, null);
  });
});

test('ownership loss while bridge listen is pending closes late listener', async () => {
  await withFixture(async ({ dir, module, controls, owners, servers }) => {
    controls.holdBridgeListen = true;
    const listening = new Promise(resolve => { controls.onBridgeListen = resolve; });
    const ctx = context(); module.apply(ctx, config); await listening;
    owners[0].emit('error', new Error('lost during listen'));
    await tick(); controls.finishBridgeListen();
    assert.equal(await ctx.vibeIsland.bridgeReady, null);
    await module.dispose(ctx);
    assert.equal(servers.filter(s => s.listening).length, 0);
    assert.equal(fs.existsSync(path.join(dir, 'xdg_config_home', 'DSHNotch', 'bridge.json')), false, 'lost startup never publishes a port');
    assert.equal(ctx.routes.size, 0);
  });
});

test('bridge close failure retains acquired sentinel', async () => {
  await withFixture(async ({ module, servers, reservations, owners }) => {
    const ctx = context(); module.apply(ctx, config);
    assert.ok(await ctx.vibeIsland.bridgeReady);
    servers[0].close = callback => queueMicrotask(() => callback(new Error('close failed')));
    await module.dispose(ctx);
    assert.equal(reservations.size, 1, 'must not release owner while bridge may still be listening');
    assert.equal(servers[0].listening, true);
    await new Promise(resolve => owners[0].close(resolve));
    servers[0].listening = false;
  });
});

test('active bridge closes before ownership is released and disposal is awaitable', async () => {
  await withFixture(async ({ module, servers, owners, reservations }) => {
    const ctx = context(); module.apply(ctx, config);
    assert.ok(await ctx.vibeIsland.bridgeReady);
    const server = servers[0]; let finish;
    server.close = cb => { finish = () => { server.listening = false; cb(); }; };
    const first = module.dispose(ctx), second = module.dispose(ctx);
    await tick();
    assert.equal(typeof finish, 'function');
    assert.equal(reservations.size, 1, 'sentinel held while bridge close is pending');
    finish(); await Promise.all([first, second]);
    assert.equal(reservations.size, 0);
    assert.equal(owners[0].listening, false);
  });
});

test('late service, loss and rapid reappearance serialize routes and collectors', async () => {
  await withFixture(async ({ module, servers, reservations }) => {
    const ctx = context(false);
    let settings = 0;
    ctx.settings = { register() { settings++; return {}; } };
    module.apply(ctx, config);
    assert.equal(settings, 1);
    assert.equal(await ctx.vibeIsland.bridgeReady, null);
    assert.equal(ctx.routes.size, 0);
    ctx.appear();
    assert.ok(await ctx.vibeIsland.bridgeReady);
    assert.equal(ctx.listeners.size, 1);
    const firstCenter = ctx.vibeIsland.nudges;
    for (const listener of ctx.listeners) listener({ header: { id: 'retained-session' } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
    const reminderId = firstCenter.list()[0]?.id;
    assert.ok(reminderId, 'a real captured reminder exists before connection loss');
    let finishClose;
    servers[0].close = cb => { finishClose = () => { servers[0].listening = false; cb(); }; };
    const removed = ctx.remove();
    await tick();
    assert.equal(ctx.listeners.size, 0);
    assert.equal(reservations.size, 1);
    ctx.appear();
    const next = ctx.vibeIsland.bridgeReady;
    await tick();
    assert.equal(ctx.registrations.length, 2, 'new routes wait for previous teardown');
    assert.equal(ctx.listeners.size, 0);
    finishClose();
    await removed;
    assert.ok(await next);
    assert.equal(ctx.vibeIsland.nudges, firstCenter);
    assert.equal(ctx.vibeIsland.nudges.list()[0]?.id, reminderId, 'pending reminder survives connection churn');
    assert.equal(ctx.listeners.size, 1);
    assert.equal(ctx.routes.size, 2);
    assert.equal(servers.filter(s => s.listening).length, 1);
    assert.equal(settings, 1, 'connection churn never re-registers settings');
    await ctx.remove();
    await module.dispose(ctx);
    assert.equal(ctx.routes.size, 0);
    assert.equal(ctx.listeners.size, 0);
    assert.equal(reservations.size, 0);
  });
});

test('immediate service loss cancels activation before any route registration', async () => {
  await withFixture(async ({ module, servers, owners }) => {
    const ctx = context(false); module.apply(ctx, config); ctx.appear();
    const first = ctx.vibeIsland.bridgeReady;
    await ctx.remove();
    assert.equal(await first, null);
    assert.equal(ctx.registrations.length, 0);
    assert.equal(servers.length, 0);
    assert.equal(owners.length, 0);
    ctx.appear(); assert.ok(await ctx.vibeIsland.bridgeReady);
    await ctx.remove(); await module.dispose(ctx);
  });
});

test('removal during async registration rollback waits before reactivation', async () => {
  await withFixture(async ({ module, owners }) => {
    const ctx = context(false);
    let release;
    ctx.unregisterGate = new Promise(resolve => { release = resolve; });
    ctx.failRegistrationAt = expectedPaths[1];
    module.apply(ctx, config); ctx.appear();
    const first = ctx.vibeIsland.bridgeReady;
    await tick();
    assert.equal(ctx.routes.size, 1);
    let finished = false;
    const removed = ctx.remove().then(() => { finished = true; });
    ctx.failRegistrationAt = null;
    ctx.appear(); const second = ctx.vibeIsland.bridgeReady;
    await tick();
    assert.equal(finished, false);
    assert.equal(ctx.registrations.length, 1);
    assert.equal(owners.length, 0);
    release(); await removed;
    assert.equal(await first, null);
    assert.ok(await second);
    assert.equal(ctx.routes.size, 2);
    await ctx.remove(); await module.dispose(ctx);
    assert.equal(ctx.routes.size, 0);
  });
});

test('failed route removal blocks reactivation rather than duplicating routes', async () => {
  await withFixture(async ({ module, servers }) => {
    const ctx = context(false); module.apply(ctx, config); ctx.appear();
    assert.ok(await ctx.vibeIsland.bridgeReady);
    ctx.failUnregister = true;
    await ctx.remove();
    const count = ctx.registrations.length;
    ctx.appear();
    assert.equal(await ctx.vibeIsland.bridgeReady, null);
    assert.equal(ctx.registrations.length, count);
    assert.equal(ctx.listeners.size, 0);
    assert.equal(servers.filter(s => s.listening).length, 0);
    await ctx.remove(); await module.dispose(ctx);
  });
});

test('failed registration rollback blocks future routes', async () => {
  await withFixture(async ({ module, owners }) => {
    const ctx = context(false); module.apply(ctx, config);
    ctx.failRegistrationAt = expectedPaths[1]; ctx.failUnregister = true;
    ctx.appear(); assert.equal(await ctx.vibeIsland.bridgeReady, null);
    await ctx.remove();
    const count = ctx.registrations.length;
    ctx.failRegistrationAt = null; ctx.failUnregister = false;
    ctx.appear(); assert.equal(await ctx.vibeIsland.bridgeReady, null);
    assert.equal(ctx.registrations.length, count);
    assert.equal(owners.length, 0);
    await ctx.remove(); await module.dispose(ctx);
  });
});

test('service removal during pending listen closes it before releasing owner', async () => {
  await withFixture(async ({ module, controls, reservations, servers }) => {
    controls.holdBridgeListen = true;
    const reached = new Promise(resolve => { controls.onBridgeListen = resolve; });
    const ctx = context(false); module.apply(ctx, config); ctx.appear();
    const first = ctx.vibeIsland.bridgeReady;
    await reached;
    let finished = false;
    const removed = ctx.remove().then(() => { finished = true; });
    await tick(); assert.equal(finished, false); assert.equal(reservations.size, 1);
    controls.finishBridgeListen(); await removed;
    assert.equal(await first, null);
    assert.equal(servers.filter(s => s.listening).length, 0);
    assert.equal(reservations.size, 0);
    await module.dispose(ctx);
  });
});

test('service removal during owner acquisition waits and later reactivates', async () => {
  await withFixture(async ({ module, controls, reservations, servers }) => {
    controls.holdOwnerListen = true;
    const reached = new Promise(resolve => { controls.onOwnerListen = resolve; });
    const ctx = context(false); module.apply(ctx, config); ctx.appear();
    const first = ctx.vibeIsland.bridgeReady;
    await reached;
    let finished = false;
    const removed = ctx.remove().then(() => { finished = true; });
    await tick(); assert.equal(finished, false);
    controls.finishOwnerListen(); await removed;
    assert.equal(await first, null);
    assert.equal(reservations.size, 0);
    assert.equal(servers.length, 0);
    controls.holdOwnerListen = false;
    ctx.appear(); assert.ok(await ctx.vibeIsland.bridgeReady);
    await ctx.remove(); await module.dispose(ctx);
    assert.equal(ctx.routes.size, 0);
    assert.equal(reservations.size, 0);
  });
});

test('unavailable authenticated connection fails closed and releases its listener', async () => {
  await withFixture(async ({ module, servers, initialExitListeners }) => {
    const unavailable = context(false);
    try {
      module.apply(unavailable, config);
      assert.equal(await unavailable.vibeIsland.bridgeReady, null);
      assert.deepEqual(unavailable.registrations, []);
      assert.equal(servers.length, 0, 'bridge does not start without authenticated routes');
      assert.equal(servers.filter(s => s.listening).length, 0, 'failed connection closes bridge');
    } finally {
      module.dispose(unavailable);
      await tick(); await tick();
    }
    assert.equal(unavailable.routes.size, 0);
    assert.deepEqual(process.listeners('exit'), initialExitListeners, 'failed-closed path leaks no exit listeners');
  });
});
