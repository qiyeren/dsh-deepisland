import test from 'node:test';
import assert from 'node:assert/strict';
import { attachNudges } from '../lib/nudge.js';

test('a failed tool alone is not a task failure, but a failed turn is', () => {
  let onEvent;
  const ctx = {
    on(name, handler) { if (name === 'session/event') onEvent = handler; return () => {}; },
    get() { return undefined; }, effect() {},
  };
  const { center, dispose } = attachNudges(ctx, { nudgeAlertOnToolError: true });
  try {
    const session = { header: { id: 'synthetic-session' } };
    onEvent(session, { type: 'tool/result', data: { callId: 'synthetic-call', isError: true } });
    assert.equal(center.list().length, 0, 'an individual tool failure must not create an alert even if old settings enabled it');
    onEvent(session, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'synthetic turn failure' } } } });
    assert.equal(center.list().length, 1);
    assert.equal(center.list()[0].kind, 'failed', 'a genuinely failed turn must still alert');
    onEvent({ header: { id: 'synthetic-blocked-session' } }, { type: 'turn/end', data: { reason: { kind: 'blocked' } } });
    assert.equal(center.list().filter(item => item.kind === 'failed').length, 2, 'a blocked turn must still alert');
    onEvent({ header: { id: 'synthetic-aborted-session' } }, { type: 'turn/end', data: { reason: { kind: 'aborted' } } });
    assert.equal(center.list().length, 2, 'user cancellation must not be classified as a failure');
  } finally { dispose(); }
});
