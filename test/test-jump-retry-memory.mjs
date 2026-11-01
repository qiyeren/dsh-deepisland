// In-memory regressions of navigation after consuming a jump.
// No sockets, profile files, actual sessions, or live notifications.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
function fixture(openSession) {
  let api, timerId = 0;
  const timers = new Map();
  const queue = [{sessionId: 'fixture-session'}];
  const sandbox = {
    window: { __ModuleLoader__: { load: ({factory}) => { api = factory(name => { if(name === 'react') return {}; throw Error(name); }); } } },
    fetch: async () => ({ok:true, json:async () => ({ok:true, items:queue.splice(0)})}),
    AbortController, AbortSignal, console: {log(){}, warn(){}},
    localStorage: {getItem(){return null}, setItem(){}},
    setTimeout(fn) { const id=++timerId; timers.set(id,fn); return id; },
    clearTimeout(id) {timers.delete(id)}, setInterval(){throw Error('unexpected interval')}, clearInterval(){},
  };
  vm.runInNewContext(source, sandbox);
  const bridge = api.startJumpBridge({get: () => ({openSession})});
  async function tick() { const entries=[...timers]; timers.clear(); for(const [,fn] of entries) fn(); for(let i=0;i<30;i++) await Promise.resolve(); }
  return {bridge,tick};
}
let calls=0;
let f=fixture(async () => { calls++; if(calls===1) throw Error('transient fixture failure'); });
await f.tick(); await f.tick(); assert.equal(calls,2,'transient navigation is retried once');
assert.equal(f.bridge.state().jumps,1,'successful retry records one jump'); f.bridge.stop();
calls=0;
f=fixture(async () => {calls++; throw Error('permanent fixture failure')});
await f.tick(); await f.tick(); assert.equal(calls,2,'permanent failure never retries more than once');
assert.equal(f.bridge.state().jumps,0); f.bridge.stop();
calls=0; let reject;
f=fixture(() => {calls++; return new Promise((_,r) => {reject=r;});});
const pending = f.tick(); for(let i=0;i<10 && !reject;i++) await Promise.resolve();
assert.ok(reject); f.bridge.stop(); reject(Error('stopped')); await pending;
assert.equal(calls,1,'disposed bridge does not retry an outstanding failure');
console.log('in-memory jump retry regressions: 3 passed');
