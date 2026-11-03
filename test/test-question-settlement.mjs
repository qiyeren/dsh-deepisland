import test from 'node:test';
import assert from 'node:assert/strict';
import { attachNudges } from '../lib/nudge.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const nativeNudges = require('../windows/src/nudges.js');
const snapshot = require('../windows/src/snapshot.js');

test('settled status crosses native normalization and snapshot boundaries', () => {
  const raw = { id: 'synthetic-id', kind: 'needs_choice', sessionId: 'synthetic-session', resolved: true };
  const normalized = nativeNudges.normalizeItem(raw);
  assert.equal(normalized.resolved, true);
  assert.equal(snapshot.mapNudge(normalized).resolved, true);
  assert.equal(snapshot.mapNudge(nativeNudges.normalizeItem({ ...raw, resolved: 'true' })).resolved, false);
});

test('a successfully answered question remains in the queue but is no longer pending', async () => {
  let answerQuestion;
  const questions = { ask: () => new Promise((resolve) => { answerQuestion = resolve; }) };
  const ctx = {
    on() { return () => {}; },
    get(name) { return name === 'userQuestions' ? questions : undefined; },
    effect() {},
  };
  const { center, dispose } = attachNudges(ctx, {});
  const request = { agent: { id: 'synthetic-session' }, questions: [{ id: 'q', question: 'Synthetic?' }] };
  const pending = questions.ask(request);
  const original = center.list()[0];
  assert.equal(original.kind, 'needs_choice');
  assert.notEqual(original.resolved, true);
  const answer = { answers: [{ id: 'q', selected: ['yes'] }] };
  answerQuestion(answer);
  assert.equal(await pending, answer);
  const after = center.list();
  assert.equal(after.length, 1, 'answering must not remove or acknowledge the reminder');
  assert.equal(after[0].id, original.id);
  assert.equal(after[0].resolved, true, 'a successfully answered question must no longer be displayed as pending');
  dispose();
});

test('merged questions remain pending until every associated request is answered', async () => {
  const resolvers = [];
  const questions = { ask: () => new Promise((resolve) => resolvers.push(resolve)) };
  const ctx = { on() { return () => {}; }, get(name) { return name === 'userQuestions' ? questions : undefined; }, effect() {} };
  const { center, dispose } = attachNudges(ctx, {});
  const request = { agent: { id: 'synthetic-session' }, questions: [{ id: 'q', question: 'Synthetic?' }] };
  const a = questions.ask(request);
  const b = questions.ask(request);
  assert.equal(center.list().length, 1, 'the requests merge into one reminder');
  const id = center.list()[0].id;
  resolvers[0]({ answers: [{ id: 'q', selected: ['yes'] }] });
  await a;
  assert.notEqual(center.list()[0].resolved, true, 'second request is still waiting');
  const before = center.rev();
  resolvers[1]({ answers: [{ id: 'q', selected: ['yes'] }] });
  await b;
  assert.equal(center.list()[0].id, id, 'settlement is not an acknowledgement');
  assert.equal(center.list()[0].resolved, true);
  assert.notEqual(center.rev(), before, 'a settled state must be sent to the client');
  dispose();
});

test('late replies settle only the exact admitted question, not merely a queued answer', async () => {
  let onSessionEvent;
  const questions = { ask: async () => { throw new Error('synthetic timeout'); } };
  const ctx = {
    on(name, callback) { if (name === 'session/event') onSessionEvent = callback; return () => {}; },
    get(name) { return name === 'userQuestions' ? questions : undefined; }, effect() {},
  };
  const { center, dispose } = attachNudges(ctx, {});
  const session = { header: { id: 'synthetic-session' } };
  const request = { agent: { id: 'synthetic-session', session }, wait: { callId: 'synthetic-call', timed: true }, questions: [{ id: 'q', question: 'Synthetic?' }] };
  await assert.rejects(questions.ask(request), /synthetic timeout/);
  assert.notEqual(center.list()[0].resolved, true, 'timeout is not a human answer');
  onSessionEvent(session, { type: 'user/message', data: { source: { kind: 'user-question-reply', callId: 'another-call' } } });
  assert.notEqual(center.list()[0].resolved, true, 'a different call must not settle the question');
  onSessionEvent(session, { type: 'user/message', data: { source: { kind: 'user-question-reply', callId: 'synthetic-call' } } });
  assert.equal(center.list()[0].resolved, true, 'an admitted matching reply settles the reminder');
  assert.equal(center.list().length, 1, 'settlement does not acknowledge or delete');
  dispose();
});

test('merged approval remains pending until its own decision and the question both settle', async () => {
  let approvalHandler;
  let decide;
  let answer;
  const questions = { ask: () => new Promise((resolve) => { answer = resolve; }) };
  const ctx = {
    on(name, callback) { if (name === 'approval/request') approvalHandler = callback; return () => {}; },
    get(name) { return name === 'userQuestions' ? questions : name === 'approval' ? {} : undefined; }, effect() {},
  };
  const { center, dispose } = attachNudges(ctx, {});
  const request = { agent: { id: 'synthetic-session' }, questions: [{ id: 'q', question: 'Synthetic?' }] };
  const question = questions.ask(request);
  const approval = approvalHandler({ agent: request.agent }, () => new Promise((resolve) => { decide = resolve; }));
  assert.equal(center.list().length, 1);
  answer({ answers: [{ id: 'q', selected: ['yes'] }] });
  await question;
  assert.notEqual(center.list()[0].resolved, true, 'the approval remains open');
  decide('rejected');
  assert.equal(await approval, 'rejected', 'the actual waterfall result is preserved');
  assert.equal(center.list()[0].resolved, true);
  assert.equal(center.list().length, 1, 'settling does not delete reminders');
  dispose();
});

test('an unavailable approval stays conservatively unresolved', async () => {
  let approvalHandler;
  const ctx = { on(name, callback) { if (name === 'approval/request') approvalHandler = callback; return () => {}; }, get(name) { return name === 'approval' ? {} : undefined; }, effect() {} };
  const { center, dispose } = attachNudges(ctx, {});
  assert.equal(await approvalHandler({ agent: { id: 'synthetic-session' } }, async () => 'unavailable'), 'unavailable');
  assert.notEqual(center.list()[0].resolved, true);
  dispose();
});

test('a pending timeout or rejected question is not declared answered', async () => {
  let rejectAsk;
  const questions = { ask: () => new Promise((_, reject) => { rejectAsk = reject; }) };
  const ctx = { on() { return () => {}; }, get(name) { return name === 'userQuestions' ? questions : undefined; }, effect() {} };
  const { center, dispose } = attachNudges(ctx, {});
  const pending = questions.ask({ agent: { id: 'synthetic-session' }, questions: [{ id: 'q', question: 'Synthetic?' }] });
  rejectAsk(new Error('synthetic timeout'));
  await assert.rejects(pending, /synthetic timeout/);
  assert.notEqual(center.list()[0].resolved, true);
  assert.equal(center.list().length, 1);
  dispose();
});
