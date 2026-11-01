// Test-only guard: requests may reach only HTTP servers created in this process.
// A bound server remains owned until its close event; all other probes are denied.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';

export function isolateBridgeEnvironment() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepisland-bridge-'));
  const keys = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME'];
  const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  for (const key of keys) process.env[key] = path.join(dir, key.toLowerCase());
  const servers = new Set();
  const createServer = http.createServer;
  const request = http.request;
  const fetch = globalThis.fetch;
  const permitted = port => [...servers].some(s => s.listening && s.address()?.port === Number(port));
  http.createServer = function (...args) {
    const server = createServer.apply(this, args);
    servers.add(server);
    server.once('close', () => servers.delete(server));
    return server;
  };
  http.request = function (options, ...args) {
    if (options && typeof options === 'object' && options.host === '127.0.0.1' && permitted(options.port)) {
      return request.call(this, options, ...args);
    }
    const denied = new EventEmitter();
    denied.end = () => queueMicrotask(() => denied.emit('error', new Error('bridge sandbox denied unowned endpoint')));
    denied.setTimeout = () => denied;
    denied.destroy = () => denied;
    denied.write = () => false;
    return denied;
  };
  globalThis.fetch = (input, options) => {
    let url;
    try { url = new URL(typeof input === 'string' ? input : input.url); } catch { return Promise.reject(new Error('bridge sandbox denied invalid URL')); }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !permitted(url.port)) {
      return Promise.reject(new Error('bridge sandbox denied unowned endpoint'));
    }
    return fetch(input, options);
  };
  let done = false;
  function cleanup() {
    if (done) return;
    done = true;
    http.createServer = createServer;
    http.request = request;
    globalThis.fetch = fetch;
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.once('exit', cleanup);
  return { dir, cleanup, permitted };
}
