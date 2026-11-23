import test from 'node:test';
import assert from 'node:assert/strict';
import { attachNudges } from '../lib/nudge.js';

// The collector boundary, with a stopped clock: wall time/arrival order cannot
// prove a later turn. No host, files, timers, or network are needed.
function fixture(t) {
  const handlers = new Map();
  const reads = { config: 0, services: 0 };
  let ms = 1_000_000;
  const cfg = { nudgeMaxItems: 8, nudgeMergeWindowMs: 1200 };
  const ctx = {
    on(name, fn) { handlers.set(name, fn); },
    get(name) { reads.services++; return name === 'approval' ? {} : undefined; },
  };
  const { center, dispose } = attachNudges(ctx, cfg, {
    now: () => new Date(ms), getConfig() { reads.config++; return cfg; },
  });
  t.after(dispose);
  const emit = (s, type, seq, data = {}) => handlers.get('session/event')(s, { type, seq, data });
  return { center, emit, reads,
    tick: (delta) => { ms += delta; },
    fail: (s, seq, kind = 'error') => emit(s, 'turn/end', seq, { reason: { kind } }),
    start: (s, seq) => emit(s, 'turn/start', seq),
    approve: (s) => handlers.get('approval/request')({ agent: { id: s.header.id, session: s } }, () => 'unavailable'),
    items: () => structuredClone(center.list()),
  };
}
const session = (id) => ({ header: { id }, inheritedEventCount: 0 });

test('a later own turn resolves the prior failure in place; a new failure rotates the merged generation', (t) => {
  const f = fixture(t), s = session('session-a');
  f.fail(s, 12);
  const [first] = f.items(), activeRev = f.center.rev();
  f.start(s, 14);
  assert.deepEqual(f.items(), [{ ...first, resolved: true }], 'recovery is a flag, not an acknowledgement or replacement');
  const recoveredRev = f.center.rev();
  assert.notEqual(recoveredRev, activeRev);
  f.start(s, 14);
  assert.equal(f.center.rev(), recoveredRev, 'a duplicate start is idempotent');
  f.fail(s, 15, 'blocked');
  const [again] = f.items();
  assert.equal(f.items().length, 1);
  assert.notEqual(again.resolved, true);
  assert.notEqual(again.id, first.id);
  assert.equal(again.lineageId, first.lineageId);
  assert.equal(again.generation, 2);
  assert.equal(again.count, 2);
  assert.equal(f.center.ack([first.id]), 0, 'stale UI acknowledgements cannot remove the new failure');
});

test('replayed lifecycle events neither rotate a generation nor hide a newer failure', (t) => {
  const f = fixture(t), s = session('session-a');
  f.fail(s, 20);
  f.start(s, 22);
  const settled = f.items();
  f.tick(60_000); // outside the merge window, still the very same event
  f.fail(s, 20);
  assert.deepEqual(f.items(), settled, 'a replay must not resurrect a settled failure');
  f.fail(s, 30);
  const active = f.items();
  assert.equal(active.length, 2, 'out-of-window failures retain the older settled record');
  assert.notEqual(active[0].resolved, true);
  for (const seq of [22, 27, 30]) f.start(s, seq);
  f.fail(s, 30);
  assert.deepEqual(f.items(), active, 'equal and older sequence numbers are not a new generation');
  f.start(s, 31);
  assert.ok(f.items().every(i => i.resolved === true));
});

test('only the matching session’s failed records change; unrelated state and choices are not recovery evidence', (t) => {
  const f = fixture(t), a = session('session-a'), b = session('session-b');
  f.approve(a);
  f.fail(a, 2); f.fail(b, 100);
  f.tick(2000); f.fail(a, 4, 'blocked');
  f.emit(a, 'turn/end', 5, { reason: { kind: 'completed' } });
  const before = f.items();
  assert.equal(before.length, 5);
  assert.ok(before.every(i => i.resolved !== true));
  f.emit(a, 'user/message', 6); f.emit(a, 'turn/end', 7, { reason: { kind: 'aborted' } });
  f.emit(a, 'agent/status', 8, { status: 'running' }); f.emit(a, 'session/title', 9, { title: 'renamed' });
  assert.deepEqual(f.items(), before);
  f.start(a, 10);
  assert.deepEqual(f.items(), before.map(i => i.kind === 'failed' && i.sessionId === 'session-a' ? { ...i, resolved: true } : i));
});

test('legacy or malformed positions and unknown session identities never establish recovery', (t) => {
  const f = fixture(t), s = session('known');
  f.fail(s, 2);
  for (const seq of [undefined, null, NaN, Infinity, '100', 2.5, -1, Number.MAX_SAFE_INTEGER + 1]) f.start(s, seq);
  assert.notEqual(f.items()[0].resolved, true);
  f.fail(s, undefined); // merged unsequenced occurrence must not inherit seq=2
  f.start(s, 100);
  assert.notEqual(f.items()[0].resolved, true);
  for (const id of ['unknown', undefined, '', '  ', 123]) {
    const anonymous = session(id);
    f.fail(anonymous, 1); f.start(anonymous, 2);
  }
  assert.equal(f.items().length, 6);
  assert.ok(f.items().every(i => i.resolved !== true));
});

test('fork-owned sequence positions are required; inherited starts and ends are not live turns', (t) => {
  const f = fixture(t), fork = { header: { id: 'fork', isSeeded: true }, inheritedEventCount: 10 };
  f.fail(fork, 9);
  assert.deepEqual(f.items(), []);
  f.fail(fork, 10); // first own event is at the boundary, not after it
  const before = f.items();
  f.start(fork, 9); f.fail(fork, 8);
  assert.deepEqual(f.items(), before);
  f.start({ header: fork.header, inheritedEventCount: 50 }, 40); // later number, but inherited
  f.start({ header: fork.header }, 60); // fork with no usable prefix information
  assert.deepEqual(f.items(), before);
  f.start(fork, 11);
  assert.equal(f.items()[0].resolved, true);
});

test('token and tool bursts never inspect the queue, services or session; recovery needs no history', (t) => {
  const f = fixture(t), s = session('quiet');
  for (const key of ['events', 'eventAt', 'ownEvents', 'snapshotEvents']) {
    Object.defineProperty(s, key, { get() { assert.fail(`no history read: ${key}`); } });
  }
  f.fail(s, 10);
  const reads = { ...f.reads };
  const untouched = new Proxy(s, { get(_, key) { assert.fail(`hot path read ${String(key)}`); } });
  const queue = f.center.pending;
  f.center.pending = new Proxy(queue, { get(_, key) { assert.fail(`hot path queue access: ${String(key)}`); } });
  try {
    for (let i = 0; i < 1000; i++) {
      f.emit(untouched, 'tool/call', i); f.emit(untouched, 'tool/result', i); f.emit(untouched, 'model/delta', i);
    }
  } finally { f.center.pending = queue; }
  f.start(s, 11);
  assert.deepEqual(f.reads, reads);
  assert.equal(f.items()[0].resolved, true);
});
