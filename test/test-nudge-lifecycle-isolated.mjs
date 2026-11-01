import test from 'node:test';
import assert from 'node:assert/strict';
import { attachNudges, inMuteRange, NudgeCenter } from '../lib/nudge.js';

function fakeCtx(questions) {
  const listeners = new Map();
  const offCounts = new Map();
  let hostDispose;
  return {
    listeners, offCounts,
    on(name, handler) {
      listeners.set(name, handler);
      return () => { offCounts.set(name, (offCounts.get(name) ?? 0) + 1); listeners.delete(name); };
    },
    get(name) { return name === 'approval' ? {} : name === 'userQuestions' ? questions : undefined; },
    effect(register) { hostDispose = register(); },
    disposeHost() { hostDispose(); },
  };
}
const session = { header: { id: 's1', cwd: '/project' } };

test('subscriptions and host effect are idempotently disposed; approval forwards waterfall', async () => {
  const ctx = fakeCtx();
  const handle = attachNudges(ctx, {});
  assert.equal(ctx.listeners.size, 2);
  let calls = 0;
  const outcome = { approved: true };
  assert.equal(await ctx.listeners.get('approval/request')({ agent: { id: 's1', session } }, async () => { calls++; return outcome; }), outcome);
  assert.equal(calls, 1);
  assert.equal(handle.center.list()[0].kind, 'needs_choice');
  handle.dispose();
  ctx.disposeHost();
  handle.dispose();
  assert.equal(ctx.listeners.size, 0);
  assert.deepEqual([...ctx.offCounts.entries()].sort(), [['approval/request', 1], ['session/event', 1]]);
  assert.deepEqual(handle.center.list(), []);
});

test('turn end only recognizes known successful reasons, preserving failure handling', () => {
  const ctx = fakeCtx();
  const { center, dispose } = attachNudges(ctx, {});
  const emit = (reason) => ctx.listeners.get('session/event')(session, { type: 'turn/end', data: reason === undefined ? {} : { reason } });
  for (const reason of [undefined, null, {}, { kind: 'other' }, { kind: 'aborted' }]) {
    emit(reason); assert.equal(center.list().length, 0);
  }
  emit({ kind: 'completed' });
  assert.equal(center.list()[0].kind, 'completed'); center.ackAll();
  emit({ kind: 'max-tokens' });
  assert.equal(center.list()[0].detail, '输出被长度上限截断'); center.ackAll();
  emit({ kind: 'error', error: { message: 'test error' } });
  assert.equal(center.list()[0].kind, 'failed'); assert.equal(center.list()[0].detail, 'test error'); center.ackAll();
  emit({ kind: 'blocked' });
  assert.equal(center.list()[0].kind, 'failed'); dispose();
});

test('mute ranges validate each clock component without breaking valid ranges', () => {
  const now = new Date(2024, 0, 1, 2, 30);
  for (const bad of ['01:60-03:00', '01:00-02:99', '24:00-03:00', '01:00-24:00', '1:2-03:00', 'x']) assert.equal(inMuteRange(bad, now), false, bad);
  assert.equal(inMuteRange('22:00-08:00', now), true);
  assert.equal(inMuteRange('01:60-03:00,02:00-03:00', now), true);
  assert.equal(inMuteRange('02:30-03:00', now), true);
  assert.equal(inMuteRange('01:30-02:30', now), false);
});

test('question ask inherited method and original descriptor are restored', async () => {
  class Questions { ask(request) { assert.equal(this, questions); return request; } }
  const questions = new Questions();
  const original = questions.ask;
  const ctx = fakeCtx(questions);
  const handle = attachNudges(ctx, {});
  assert.equal(Object.hasOwn(questions, 'ask'), true);
  const request = { questions: [{ question: 'hello' }], agent: { id: 's1', session } };
  assert.equal(await questions.ask(request), request);
  handle.dispose();
  assert.equal(Object.hasOwn(questions, 'ask'), false);
  assert.equal(questions.ask, original);
  const own = {};
  Object.defineProperty(own, 'ask', { value: original, configurable: true, writable: true, enumerable: false });
  const before = Object.getOwnPropertyDescriptor(own, 'ask');
  const ownHandle = attachNudges(fakeCtx(own), {});
  ownHandle.dispose();
  assert.deepEqual(Object.getOwnPropertyDescriptor(own, 'ask'), before);
  const accessor = {};
  Object.defineProperty(accessor, 'ask', { get: () => original, configurable: true, enumerable: false });
  const accessorBefore = Object.getOwnPropertyDescriptor(accessor, 'ask');
  const accessorHandle = attachNudges(fakeCtx(accessor), {});
  accessorHandle.dispose();
  assert.deepEqual(Object.getOwnPropertyDescriptor(accessor, 'ask'), accessorBefore);
});

test('a failing unsubscribe does not prevent the remaining cleanup', () => {
  const ctx = fakeCtx();
  const register = ctx.on;
  ctx.on = function (name, handler) {
    const off = register.call(this, name, handler);
    return name === 'session/event' ? () => { off(); throw new Error('fake cleanup failure'); } : off;
  };
  const handle = attachNudges(ctx, {});
  handle.dispose();
  assert.equal(ctx.listeners.size, 0);
  assert.equal(handle.center.disposed, true);
});

test('shared center survives detach; stale callbacks still forward but cannot collect', async () => {
  const questions = { ask: async () => 'answered' };
  const ctx = fakeCtx(questions);
  const center = new NudgeCenter({});
  const first = attachNudges(ctx, {}, { center, disposeCenter: false });
  const event = ctx.listeners.get('session/event');
  const approval = ctx.listeners.get('approval/request');
  const oldAsk = questions.ask;
  event(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  const initial = center.list();
  assert.equal(initial.length, 1);
  first.dispose();
  assert.equal(center.disposed, false);
  assert.equal(center.list()[0].id, initial[0].id);
  event(session, { type: 'turn/end', data: { reason: { kind: 'error' } } });
  let forwarded = 0;
  await approval({ agent: { id: 's1', session } }, () => { forwarded++; });
  assert.equal(await oldAsk({ agent: { id: 's1', session } }), 'answered');
  assert.equal(forwarded, 1);
  assert.equal(center.list().length, 1);
  const second = attachNudges(ctx, {}, { center, disposeCenter: false });
  ctx.listeners.get('session/event')(session, { type: 'turn/end', data: { reason: { kind: 'error' } } });
  assert.equal(center.list().length, 2);
  second.dispose(); center.dispose();
  assert.equal(center.list().length, 0);
});

test('disposal does not overwrite a later third-party question wrapper', async () => {
  const questions = { ask: async () => 'result' };
  const handle = attachNudges(fakeCtx(questions), {});
  const prior = questions.ask;
  const thirdParty = (...args) => prior(...args);
  questions.ask = thirdParty;
  handle.dispose();
  assert.equal(questions.ask, thirdParty);
  assert.equal(await questions.ask({}), 'result');
  assert.deepEqual(handle.center.list(), []);
});
