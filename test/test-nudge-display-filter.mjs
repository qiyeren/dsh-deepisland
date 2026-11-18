// Synthetic-only host → Windows display tests. Never connects to a real bridge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { NudgeCenter, attachNudges } from '../lib/nudge.js';
const require = createRequire(import.meta.url);
const nudges = require('../windows/src/nudges.js');
const snapshot = require('../windows/src/snapshot.js');

const cfg = { nudgeEnabled: true, nudgeMergeWindowMs: 1200, nudgeMaxItems: 4,
  nudgeTtlMinutes: 30, nudgeMuteRanges: '', nudgeOnCompleted: true,
  nudgeOnFailed: true, nudgeOnChoice: true };

function fakeHost(sessions, center) {
  const handlers = new Map();
  const questions = { async ask(request) { return { pending: true, echoed: request.marker }; } };
  const ctx = {
    on(name, cb) { handlers.set(name, cb); return () => {}; },
    get(name) {
      if (name === 'sessions') return { get(id) { return sessions.get(id); } };
      if (name === 'approval') return {};
      if (name === 'userQuestions') return questions;
      return undefined;
    },
    effect() {},
  };
  const handle = attachNudges(ctx, cfg, { center, disposeCenter: false });
  return { handlers, questions, handle };
}
const session = (id, meta = {}) => ({ header: { id, cwd: '/synthetic', ...meta } });
const end = { type: 'turn/end', data: { reason: { kind: 'completed' } } };

function visible(center, fallback = [], max = 8) {
  const fetched = nudges.normalizeItems(JSON.parse(JSON.stringify(center.list())));
  return nudges.selectDisplayItems(fetched, fallback, max);
}

test('approval provenance uses the live session store, and forwarding is unchanged', async () => {
  const child = session('child', { origin: 'subagent' });
  const normal = session('normal');
  const center = new NudgeCenter(cfg);
  const { handlers, questions, handle } = fakeHost(new Map([['child', child], ['normal', normal]]), center);
  const approval = handlers.get('approval/request');
  assert.equal(await approval({ agent: { id: 'child' }, toolName: 'pwsh', reason: 'child secret' }, async () => 'unavailable'), 'unavailable');
  assert.equal(await approval({ agent: { id: 'normal' }, toolName: 'mnemon_recall', reason: 'mnemon secret' }, async () => 'unavailable'), 'unavailable');
  assert.equal(await approval({ agent: { id: 'normal' }, toolName: 'mcp__mnemon__search', reason: 'mnemon MCP secret' }, async () => 'unavailable'), 'unavailable');
  const result = await questions.ask({ agent: { id: 'child' }, marker: 'forwarded', questions: [{ header: 'child question' }] });
  assert.equal(result.echoed, 'forwarded');
  const raw = center.list();
  assert.equal(raw.length, 2, 'child approvals and questions can merge but must not disappear');
  assert.ok(raw.every((item) => item.sourceKind === 'internal'));
  assert.deepEqual(visible(center), [], 'internal-origin reminders never reach island display');
  assert.equal(center.list().length, 2, 'filtering is display only: no acknowledgement or deletion');
  handle.dispose();
});

test('approvals for explicit child-agent tools in a main session stay off the island', async () => {
  const center = new NudgeCenter(cfg);
  const { handlers, handle } = fakeHost(new Map([['main', session('main')]]), center);
  const approval = handlers.get('approval/request');
  for (const toolName of ['subagent', 'subagent_fork', 'send_message', 'list_agents', 'wait_agent', 'workflow', 'ralph']) {
    assert.equal(await approval({ agent: { id: 'main' }, toolName, reason: `private ${toolName}` }, async () => 'unavailable'), 'unavailable');
  }
  assert.ok(center.list().length > 0, 'the approvals remain in the queue');
  assert.ok(center.list().every((item) => item.sourceKind === 'internal'));
  assert.deepEqual(visible(center), []);
  handle.dispose();
});

test('unknown provenance preserves an ordinary approval instead of silently dropping it', async () => {
  const center = new NudgeCenter(cfg);
  const { handlers, handle } = fakeHost(new Map(), center);
  const result = await handlers.get('approval/request')(
    { agent: { id: 'unavailable-session' }, toolName: 'pwsh', reason: 'ordinary approval' },
    async () => 'unavailable',
  );
  assert.equal(result, 'unavailable');
  assert.equal(center.list()[0].sourceKind, 'unknown');
  assert.equal(visible(center)[0].detail, 'ordinary approval');
  handle.dispose();
});

test('an unknown reminder is hidden once child metadata becomes available, without deleting it', async () => {
  const center = new NudgeCenter(cfg);
  const sessions = new Map();
  const { handlers, handle } = fakeHost(sessions, center);
  await handlers.get('approval/request')(
    { agent: { id: 'later-child' }, toolName: 'pwsh', reason: 'child detail' },
    async () => 'unavailable',
  );
  const id = center.list()[0].id;
  assert.equal(visible(center).length, 1, 'unknown is conservatively kept visible');
  sessions.set('later-child', session('later-child', { origin: 'subagent' }));
  assert.deepEqual(visible(center), [], 'display filters once supported provenance appears');
  assert.equal(center.list()[0].id, id, 'no acknowledgement or deletion occurred');
  sessions.delete('later-child');
  assert.deepEqual(visible(center), [], 'positive child evidence persists during transient store outages');
  assert.equal(center.pending.get(id).sourceKind, 'unknown', 'the original queued item remains unchanged');
  handle.dispose();
});

test('a failed attachment does not leave its resolver on a shared center', () => {
  const center = new NudgeCenter(cfg);
  const old = () => 'unknown';
  center.resolveUnknownSource = old;
  const ctx = {
    on() { return () => {}; },
    get(name) { if (name === 'approval') throw Error('synthetic unavailable'); },
    effect() {},
  };
  assert.throws(() => attachNudges(ctx, cfg, { center, disposeCenter: false }), /synthetic unavailable/);
  assert.equal(center.resolveUnknownSource, old);
});

test('an origin-only subagent retains prior capture but is not displayed', () => {
  const child = session('origin-only', { origin: 'subagent' });
  const center = new NudgeCenter(cfg);
  const { handlers, handle } = fakeHost(new Map([['origin-only', child]]), center);
  handlers.get('session/event')(child, end);
  assert.equal(center.list().length, 1, 'an existing collected event is not dropped by the display filter');
  assert.equal(center.list()[0].sourceKind, 'internal');
  assert.deepEqual(visible(center), []);
  handle.dispose();
});

test('an ordinary historical fork and an ordinary Mnemon title remain visible', () => {
  const fork = session('fork', { parentSession: 'parent', isSeeded: true });
  const center = new NudgeCenter(cfg);
  const { handlers, handle } = fakeHost(new Map([['fork', fork]]), center);
  handlers.get('session/event')(fork, end);
  assert.equal(center.list().length, 1);
  assert.equal(visible(center)[0].sessionId, 'fork');
  center.push('failed', { sessionId: 'normal', sourceKind: 'normal', title: '研究 Mnemon 的普通会话', detail: '普通任务失败' });
  assert.ok(visible(center).some((item) => item.title === '研究 Mnemon 的普通会话'));
  handle.dispose();
});

test('hidden and ordinary choices from the same session never merge', () => {
  const center = new NudgeCenter(cfg);
  center.push('needs_choice', { sessionId: 'same', sourceKind: 'internal', title: 'internal', detail: 'hidden details' });
  center.push('needs_choice', { sessionId: 'same', sourceKind: 'normal', title: 'normal', detail: 'ordinary approval' });
  assert.equal(center.list().length, 2);
  assert.deepEqual(visible(center).map((x) => x.detail), ['ordinary approval']);
});

test('hidden-origin entries have separate bounded capacity and do not evict ordinary reminders', () => {
  const center = new NudgeCenter({ ...cfg, nudgeMaxItems: 1 });
  center.push('failed', { sessionId: 'ordinary', sourceKind: 'normal', detail: 'ordinary failure' });
  center.push('needs_choice', { sessionId: 'child', sourceKind: 'internal', detail: 'hidden choice' });
  assert.equal(center.list().length, 2, 'both remain available in the actual queue');
  assert.deepEqual(visible(center, [], 1).map((x) => x.sessionId), ['ordinary']);
});

test('unknown provenance cannot evict a known normal reminder from the host queue', () => {
  const center = new NudgeCenter({ ...cfg, nudgeMaxItems: 1 });
  center.push('failed', { sessionId: 'ordinary', sourceKind: 'normal', detail: 'ordinary failure' });
  center.push('needs_choice', { sessionId: 'missing', sourceKind: 'unknown', detail: 'unknown choice' });
  assert.deepEqual(new Set(center.list().map((x) => x.sessionId)), new Set(['ordinary', 'missing']));
  assert.deepEqual(new Set(visible(center, [], 2).map((x) => x.sessionId)), new Set(['ordinary', 'missing']));
});

test('a positively identified child no longer competes with unknown ordinary reminders', async () => {
  const center = new NudgeCenter({ ...cfg, nudgeMaxItems: 2 });
  const sessions = new Map();
  const { handlers, handle } = fakeHost(sessions, center);
  const approval = handlers.get('approval/request');
  await approval({ agent: { id: 'ordinary-unknown' }, toolName: 'pwsh', reason: 'ordinary' }, async () => 'unavailable');
  await approval({ agent: { id: 'later-child' }, toolName: 'pwsh', reason: 'child' }, async () => 'unavailable');
  sessions.set('later-child', session('later-child', { origin: 'subagent' }));
  assert.equal(center.list().find(x => x.sessionId === 'later-child').sourceKind, 'internal');
  center.config = { ...cfg, nudgeMaxItems: 1 };
  assert.deepEqual(new Set(center.list().map(x => x.sessionId)), new Set(['ordinary-unknown', 'later-child']));
  assert.deepEqual(visible(center).map(x => x.sessionId), ['ordinary-unknown']);
  handle.dispose();
});

test('unidentified producers do not merge independently asked questions', async () => {
  const center = new NudgeCenter(cfg);
  const { questions, handle } = fakeHost(new Map(), center);
  await questions.ask({ marker: 'first', questions: [{ header: 'first question' }] });
  await questions.ask({ marker: 'second', questions: [{ header: 'second question' }] });
  const items = center.list();
  assert.equal(items.length, 2);
  assert.deepEqual(new Set(items.map((x) => x.detail)), new Set(['first question', 'second question']));
  center.ack([items[0].id]); // Only a synthetic ID in this private in-memory center.
  assert.equal(center.list().length, 1, 'acknowledging one must not remove the other');
  handle.dispose();
});

test('filter both live and retained entries before the display cap and again at snapshot boundary', () => {
  const center = new NudgeCenter(cfg);
  center.push('needs_choice', { sessionId: 'child', sourceKind: 'internal', title: 'child secret', detail: 'child details' });
  center.push('failed', { sessionId: 'main', sourceKind: 'normal', title: 'main title', detail: 'main detail' });
  const hiddenFallback = nudges.normalizeItem({ id: 'old-hidden', kind: 'needs_choice', sourceKind: 'internal', title: 'retained secret' });
  const chosen = visible(center, [hiddenFallback], 1);
  assert.equal(chosen.length, 1);
  assert.equal(chosen[0].sessionId, 'main');
  const dto = snapshot.buildSnapshot({ entries: [], nudges: [...nudges.normalizeItems(center.list()), hiddenFallback], config: {}, now: 1 });
  assert.equal(dto.nudges.length, 1);
  assert.equal(dto.nudges[0].sessionId, 'main');
  assert.doesNotMatch(JSON.stringify(dto), /child secret|child details|retained secret/);
});
