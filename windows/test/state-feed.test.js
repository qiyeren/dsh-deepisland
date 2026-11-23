'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const fs = require('node:fs');
const { requestStates, followStates, parseStates } = require('../src/state-feed.js');
const { buildSnapshot } = require('../src/snapshot.js');
const plugin = '@dsh-external/dsh-vibe-island';
const row = { id: 's1', label: 'demo', status: 'waiting', at: 100, detail: 'do not relay' };
const body = { ok: true, plugin, rev: 'v1', items: [row] };

test('paired state contract is bounded, allow-listed, not an activity or detail feed', () => {
  assert.deepEqual(parseStates(body), { rev:'v1', items:[{ id:'s1', label:'demo', status:'waiting', at:100 }] });
  for (const invalid of [{ plugin:'other' }, { ok:false }, { rev:'' }, { items:[{ ...row, status:'tool' }] }, { items:[row,row] }, { items:Array(7).fill(row) }]) assert.equal(parseStates({ ...body, ...invalid }), null);
  const snap = buildSnapshot({ states:[row], bridge:{ statesOnline:true } });
  assert.deepEqual(snap.entries, [{id:'s1',label:'demo',status:'waiting',at:100,live:true,shortId:'s1'}]);
  assert.equal(snap.bridge.statesOnline, true);
  assert.equal(snap.rev, buildSnapshot({ states:[{...row, detail:'another tool'}], bridge:{ statesOnline:true } }).rev);
});

test('conditional GET, malformed/foreign responses and cancellation (private loopback only)', async t => {
  let reply = body, url;
  const server = http.createServer((req,res) => { url = req.url; if (reply === null) return; res.end(typeof reply === 'string' ? reply : JSON.stringify(reply)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const options = { port:server.address().port };
  assert.equal((await requestStates('', options)).rev, 'v1'); assert.equal(url,'/session-states');
  assert.equal((await requestStates('a/b',options)).rev,'v1'); assert.equal(url,'/session-states?since=a%2Fb');
  for (reply of ['{', 'a'.repeat(70000), {...body,plugin:'unrelated'}]) assert.equal(await requestStates('',options),null);
  reply = null; const controller = new AbortController(); const pending = requestStates('v1',{...options,signal:controller.signal}); controller.abort(); assert.equal(await pending,null);
});

test('snapshot -> changes only -> outage clears -> full reconnect; stop aborts single inflight read', async () => {
  let task, pending, signal; const revisions=[], changes=[], delays=[];
  const follow = followStates((items,online) => changes.push([items.map(i=>i.status),online]), {
    read: (since,opts) => { revisions.push(since); signal=opts.signal; return new Promise(r => {pending=r;}); },
    later:(fn,delay) => {task=fn; delays.push(delay); return 1;}, cancel:()=>{task=null;},
  });
  async function deliver(value) {pending(value); await new Promise(setImmediate);}
  await deliver(parseStates(body)); task(); await deliver(parseStates(body)); task(); await deliver(null); task(); await deliver(null); task();
  await deliver(parseStates({...body, rev:'new-owner:1', items:[{...row,status:'interrupted'}]})); task(); follow.stop();
  assert.equal(signal.aborted,true); await deliver(parseStates(body));
  assert.deepEqual(revisions,['','v1','v1','','','new-owner:1']);
  assert.deepEqual(changes,[[['waiting'],true],[[],false],[['interrupted'],true]]);
  assert.ok(delays[3] > delays[2], 'failed reads back off');
});

test('production main never loads a disk monitor, even without a paired host', () => {
  const source=fs.readFileSync(require.resolve('../src/main.js'),'utf8');
  assert.doesNotMatch(source,/require\(['"]\.\/(monitor|session-source|projections)\.js['"]\)|monitor\.poll\(/);
  assert.match(source,/followStates\(/);
});
