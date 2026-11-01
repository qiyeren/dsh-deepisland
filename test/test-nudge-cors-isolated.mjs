// Isolated HTTP regression: temporary source copies, fixture queue and app data only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deepisland-cors-'));
const previous = Object.fromEntries(['APPDATA', 'USERPROFILE', 'HOME', 'XDG_CONFIG_HOME'].map(k => [k, process.env[k]]));
let bridge;
try {
  for (const k of Object.keys(previous)) process.env[k] = tmp;
  fs.mkdirSync(path.join(tmp, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'windows'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'node_modules', '@deepseek-ai', 'schemastery'), { recursive: true });
  for (const file of ['index.js', 'nudge.js']) fs.copyFileSync(path.join(root, 'lib', file), path.join(tmp, 'lib', file));
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
  const shim = path.join(tmp, 'node_modules', '@deepseek-ai', 'schemastery');
  fs.writeFileSync(path.join(shim, 'package.json'), '{"type":"module","exports":"./index.js"}');
  fs.writeFileSync(path.join(shim, 'index.js'), "const n=()=>{const s={};for(const k of ['default','description','step','min','max','readonly'])s[k]=()=>s;return s};export default {object:n,union:n,boolean:n,number:n,natural:n,string:n,const:n};");
  fs.cpSync(path.join(root, 'windows', 'src'), path.join(tmp, 'windows', 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'windows', 'package.json'), '{"type":"commonjs"}');
  const { startBridge } = await import(pathToFileURL(path.join(tmp, 'lib', 'index.js')));
  const listener = http.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  assert.ok(port <= 65524, 'ephemeral port must leave room for bridge scan');
  let items = [{ id: 'fixture', kind: 'completed', sessionId: 'fake-session', detail: 'fixture only' }];
  let reads = 0, acks = 0;
  const fixture = {
    list() { reads++; return items; }, rev: () => 'fixture-rev', config: () => ({}),
    ack(ids) { acks++; const old = items.length; items = items.filter(i => !ids.includes(i.id)); return old - items.length; },
    ackAll() { acks++; const old = items.length; items = []; return old; },
  };
  // Suppress sibling probes entirely: no request may reach the user's live bridge.
  const originalRequest = http.request;
  http.request = () => {
    const r = new EventEmitter();
    r.end = () => queueMicrotask(() => r.emit('error', new Error('isolated probe')));
    return r;
  };
  try { bridge = await startBridge({ port, nudges: fixture }); }
  finally { http.request = originalRequest; }
  assert.ok(bridge && !bridge.reused && bridge.port === port, 'must start own ephemeral bridge');
  assert.ok(bridge.portFile.startsWith(tmp), 'bridge.json must be in isolated app data');
  const request = (route, method = 'GET', headers = {}, body) => new Promise((resolve, reject) => {
    const requestHeaders = body === undefined ? headers : { ...headers, 'content-length': Buffer.byteLength(body) };
    const req = http.request({ host: '127.0.0.1', port: bridge.port, path: route, method, headers: requestHeaders }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject); req.end(body);
  });
  const routes = ['/nudges', '/nudge/list', '/nudge/ack', '/nudges/ack'];
  for (const route of routes) {
    for (const origin of ['https://attacker.example', 'null', 'dsh-app://app', 'http://127.0.0.1:4924', '']) {
      for (const method of ['GET', 'POST', 'OPTIONS', 'PUT']) {
        const r = await request(route + '?fixture=1', method, { origin, 'content-type': 'text/plain' }, '{"all":true}');
        assert.equal(r.status, 403, `${method} ${route} Origin=${origin} denied`);
        assert.equal(r.headers['access-control-allow-origin'], undefined, `${route} never exposes wildcard`);
      }
    }
  }
  assert.equal(reads, 0, 'denied requests must not read queue');
  assert.equal(acks, 0, 'denied requests must not mutate queue');
  for (const route of routes) {
    const r = await request(route, 'OPTIONS');
    assert.equal(r.status, 204);
    assert.equal(r.headers['access-control-allow-origin'], undefined);
  }
  for (const route of ['/nudges', '/nudge/list']) {
    const r = await request(route);
    assert.equal(r.status, 200);
    assert.equal(r.headers['access-control-allow-origin'], undefined);
    assert.equal(JSON.parse(r.text).items[0].id, 'fixture');
  }
  const badMethod = await request('/nudges', 'DELETE');
  assert.equal(badMethod.status, 404);
  assert.equal(badMethod.headers['access-control-allow-origin'], undefined);
  for (const route of ['/health', '/next', '/config']) {
    const r = await request(route, 'GET', { origin: 'dsh-app://app' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['access-control-allow-origin'], '*');
  }
  const preflight = await request('/config', 'OPTIONS', { origin: 'dsh-app://app' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], '*');
  const browserHeaders = { origin: 'dsh-app://app', 'content-type': 'application/json' };
  const config = await request('/config', 'POST', browserHeaders, '{"enabled":false}');
  assert.equal(config.status, 200);
  assert.equal(config.headers['access-control-allow-origin'], '*');
  assert.equal(JSON.parse(config.text).config.enabled, false);
  const jump = await request('/jump', 'POST', browserHeaders, '{"sessionId":"fixture-session"}');
  assert.equal(jump.status, 200);
  assert.equal(jump.headers['access-control-allow-origin'], '*');
  const next = await request('/next', 'GET', { origin: 'dsh-app://app' });
  assert.equal(JSON.parse(next.text).items[0].sessionId, 'fixture-session');
  const require = createRequire(path.join(tmp, 'windows', 'src', 'nudges.js'));
  const native = require('./nudges.js');
  // On Linux the Windows client expects the macOS data location, so point it at
  // the same isolated bridge.json (never the real default port).
  const nativeBridge = require('./bridge.js');
  const nativeFile = nativeBridge.bridgeFilePath();
  fs.mkdirSync(path.dirname(nativeFile), { recursive: true });
  if (nativeFile !== bridge.portFile) fs.copyFileSync(bridge.portFile, nativeFile);
  nativeBridge.invalidatePort();
  const fetched = await native.fetchNudges();
  assert.equal(fetched.ok, true, 'actual Windows Node client fetches without Origin');
  assert.equal(fetched.items[0].id, 'fixture');
  const result = await native.ack(['fixture']);
  assert.equal(result.ok, true, 'actual Windows Node client acknowledges without Origin');
  assert.equal(result.removed, 1);
  for (const route of ['/nudge/ack', '/nudges/ack']) {
    items = [{ id: 'fixture2', kind: 'completed' }];
    const r = await request(route, 'POST', { 'content-type': 'application/json' }, '{"all":true}');
    assert.equal(r.status, 200);
    assert.equal(r.headers['access-control-allow-origin'], undefined);
    assert.equal(JSON.parse(r.text).removed, 1);
  }
  console.log('isolated CORS regression passed');
} finally {
  if (bridge) await bridge.close();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
