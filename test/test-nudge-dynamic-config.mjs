// Public-boundary tests: no host, bridge, notification, profile, or network.
// Run: node test/test-nudge-dynamic-config.mjs
import assert from 'node:assert/strict';
import { attachNudges, NudgeCenter } from '../lib/nudge.js';

function fixture(initial, getConfig) {
  const handlers = new Map();
  const calls = [];
  const questions = { async ask(request) { calls.push(request); return 'answered'; } };
  const services = { approval: {}, userQuestions: questions, sessionTitle: undefined };
  const ctx = {
    on(name, handler) { handlers.set(name, handler); },
    get(name) {
      assert.ok(Object.hasOwn(services, name), `unexpected service: ${name}`);
      return services[name];
    },
    effect() {},
  };
  const center = new NudgeCenter(initial);
  const deps = { center };
  if (getConfig !== undefined) deps.getConfig = getConfig;
  const attachment = attachNudges(ctx, initial, deps);
  const session = { header: { id: 'session-1', cwd: '/fake/project' } };
  const event = (type, data) => handlers.get('session/event')(session, { type, data });
  return { ...attachment, handlers, questions, calls, session, event };
}
const config = (changes = {}) => ({ nudgeEnabled: true, nudgeOnCompleted: true,
  nudgeOnFailed: true, nudgeOnChoice: true, nudgeAlertOnToolError: true, ...changes });
const done = (f) => f.event('turn/end', { reason: { kind: 'completed' } });
const fail = (f, callId) => f.event('tool/result', { callId, isError: true });

// Updates are read at delivery time, with no polling or bridge.
{
  let live = config({ nudgeOnCompleted: false });
  const f = fixture(config(), () => live);
  done(f);
  assert.equal(f.center.list().length, 0, 'disabled completion suppresses event');
  live = config();
  done(f);
  assert.equal(f.center.list().length, 1, 'enabled completion is recorded immediately');
  f.center.ackAll();
  live = config({ nudgeEnabled: false });
  done(f);
  assert.equal(f.center.list().length, 0, 'master disable suppresses event');
  live = config();
  done(f);
  assert.equal(f.center.list().length, 1, 'master re-enable works without polling');
  f.dispose();
}
{
  let live = config({ nudgeAlertOnToolError: false });
  const f = fixture(config(), () => live);
  fail(f, 'one');
  assert.equal(f.center.list().length, 0, 'tool errors disabled');
  live = config();
  fail(f, 'one');
  assert.equal(f.center.list().length, 1, 'same call recorded after re-enable');
  f.center.ackAll();
  live = config({ nudgeAlertOnToolError: false });
  fail(f, 'two');
  assert.equal(f.center.list().length, 0, 'tool errors disabled again');
  f.dispose();
}
{
  let live = config({ nudgeOnChoice: false });
  const f = fixture(config(), () => live);
  const request = { agent: { id: 'session-1', session: f.session }, questions: [{ question: 'Choose' }] };
  let forwarded = 0;
  const approval = () => f.handlers.get('approval/request')(request, () => ++forwarded);
  assert.equal(approval(), 1);
  assert.equal(await f.questions.ask(request), 'answered');
  assert.equal(f.center.list().length, 0, 'disabled choice suppresses approval and question');
  live = config();
  assert.equal(approval(), 2);
  assert.equal(f.center.list().length, 1, 'enabled approval creates reminder');
  f.center.ackAll();
  assert.equal(await f.questions.ask(request), 'answered');
  assert.equal(f.center.list().length, 1, 'enabled question creates reminder');
  live = config({ nudgeEnabled: false });
  f.center.ackAll();
  approval();
  await f.questions.ask(request);
  assert.equal(f.center.list().length, 0, 'master disable applies to both paths');
  assert.equal(f.calls.length, 3, 'original question implementation always called');
  f.dispose();
}
// No callback and a throwing callback retain the latest center config.
{
  const f = fixture(config());
  f.center.config = config({ nudgeAlertOnToolError: false });
  fail(f, 'absent');
  assert.equal(f.center.list().length, 0);
  f.center.config = config();
  fail(f, 'absent');
  assert.equal(f.center.list().length, 1);
  f.dispose();
}
{
  const retained = config({ nudgeOnCompleted: false, nudgeOnChoice: false });
  const f = fixture(retained, () => { throw new Error('unavailable'); });
  done(f);
  const request = { agent: { id: 'session-1', session: f.session }, questions: [{ question: 'Choose' }] };
  let passed = false;
  f.handlers.get('approval/request')(request, () => { passed = true; });
  assert.equal(await f.questions.ask(request), 'answered');
  assert.equal(passed, true);
  assert.equal(f.center.config, retained);
  assert.equal(f.center.list().length, 0);
  f.center.config = config();
  done(f);
  assert.equal(f.center.list().length, 1, 'exceptions retain most recent center config');
  f.dispose();
}
console.log('dynamic nudge config: all assertions passed');
