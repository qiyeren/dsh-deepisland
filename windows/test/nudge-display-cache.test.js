'use strict';
// Real display selection/probe code in a sandbox: no Electron, sockets, profile, or reminders.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('function probeNudges(cfg)');
const end = source.indexOf('\n/**', start);
assert.ok(start >= 0 && end > start);
const nudgesSource = fs.readFileSync(path.join(__dirname, '../src/nudges.js'), 'utf8');
const moduleMock = { exports: {} };
vm.runInNewContext(nudgesSource, {
  module: moduleMock, exports: moduleMock.exports, Buffer,
  require(name) {
    if (name === 'node:http' || name === 'http') return { request() { throw Error('socket forbidden'); } };
    if (name === './bridge.js') return { bridgePort() { throw Error('profile forbidden'); } };
    throw Error('unexpected module ' + name);
  },
});

function fixture() {
  let response = { ok: true, rev: 'fixed', items: [] };
  const ctx = {
    Date: { now: () => 1_000 }, console: { warn() {} }, poke() {},
    nudges: { fetchNudges: async () => response, selectDisplayItems: moduleMock.exports.selectDisplayItems },
  };
  vm.createContext(ctx);
  vm.runInContext("let nudgeItems=[]; let nudgeRev=''; let nudgeFetchEpoch=0; let nudgeWarnKey=''; let nudgeAckInFlight=0; const retainedNudges=new Map();", ctx);
  vm.runInContext(source.slice(start, end), ctx);
  const item = (id, fields = {}) => ({ id, kind: 'failed', severity: 1, count: 1, ts: 1, detail: '', sourceKind: 'normal', ...fields });
  return {
    set(items, rev = 'fixed') { response = { ok: true, rev, items }; },
    retain(entry) { ctx.entry = { ...entry, _retainedAt: 1000 }; vm.runInContext('retainedNudges.set(entry.id, entry)', ctx); },
    async probe(max) { ctx.max = max; vm.runInContext('probeNudges({nudgeMaxItems:max})', ctx); await Promise.resolve(); },
    get items() { return Array.from(vm.runInContext('nudgeItems', ctx)); },
    item,
  };
}

test('display cap changes apply with unchanged server revision and retained fallback', async () => {
  const f = fixture();
  f.set([f.item('live')]);
  f.retain(f.item('fallback'));
  await f.probe(2);
  assert.deepEqual(f.items.map(x => x.id), ['live', 'fallback']);
  await f.probe(1);
  assert.deepEqual(f.items.map(x => x.id), ['live']);
  await f.probe(2);
  assert.deepEqual(f.items.map(x => x.id), ['live', 'fallback']);
});

test('a recovered failure cannot take the last display slot or expose its stale fallback', async () => {
  const f = fixture();
  const old = f.item('old', { sessionId: 'a', ts: 3 });
  const recovered = Object.freeze({ ...old, resolved: true });
  const peer = f.item('peer', { sessionId: 'b', ts: 2, sourceKind: 'unknown' });
  f.retain(old);
  f.retain(f.item('retained-recovered', { sessionId: 'c', ts: 4, resolved: true }));
  f.set([recovered, peer]);
  await f.probe(1);
  assert.deepEqual(f.items.map(x => x.id), ['peer']);
  await f.probe(3);
  assert.deepEqual(f.items.map(x => x.id), ['peer'], 'live ID still shadows its unresolved local copy');
  f.set([recovered, f.item('no-session', { resolved: true })]);
  await f.probe(1);
  assert.deepEqual(f.items.map(x => x.id), ['no-session'], 'non-navigable ordinary reminders keep their existing presentation');
});

test('visible metadata updates even when id/count/time/detail match', async () => {
  const f = fixture();
  f.set([f.item('live', { title: 'old', project: 'old project' })], 'one');
  await f.probe(2);
  f.set([f.item('live', { title: 'new', project: 'new project' })], 'two');
  await f.probe(2);
  assert.equal(f.items[0].title, 'new');
  assert.equal(f.items[0].project, 'new project');
});

test('a server-side known internal item suppresses its retained unknown fallback', async () => {
  const f = fixture();
  const lineageId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  f.retain(f.item('same', { sourceKind: 'unknown', lineageId, generation: 1 }));
  f.set([]);
  await f.probe(2);
  assert.deepEqual(f.items.map(x => x.id), ['same']);
  f.set([f.item('same', { sourceKind: 'internal', lineageId, generation: 1 })], 'internal');
  await f.probe(2);
  assert.deepEqual(f.items.map(x => x.id), []);
  f.set([], 'empty-again');
  await f.probe(2);
  assert.deepEqual(f.items.map(x => x.id), [], 'proven internal fallback stays hidden after the live copy disappears');
});

test('an ID collision cannot permanently reclassify an ordinary retained reminder', async () => {
  const f = fixture();
  const normalLineage = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  const otherLineage = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
  f.retain(f.item('same', { sourceKind: 'normal', lineageId: normalLineage, generation: 1 }));
  f.set([f.item('same', { sourceKind: 'internal', lineageId: otherLineage, generation: 1 })]);
  await f.probe(2);
  assert.deepEqual(f.items, [], 'do not offer an acknowledgment while the same ID belongs to another owner');
  f.set([], 'empty-again');
  await f.probe(2);
  assert.deepEqual(f.items.map(x => x.sourceKind), ['normal']);
});
