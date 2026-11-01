// Pure queue test: no bridge, no real configuration or notifications.
import assert from 'node:assert/strict';
import { NudgeCenter } from '../lib/nudge.js';

let now = 1_000_000;
const config = { nudgeEnabled: true, nudgeMuteRanges: '', nudgeMergeWindowMs: 1200 };
const center = new NudgeCenter(config, { now: () => new Date(now) });
center.push('failed', { sessionId: 'session', detail: 'first' });
const observedId = center.list()[0].id;
now += 100;
center.push('failed', { sessionId: 'session', detail: 'second' });
assert.equal(center.ack([observedId]), 0, 'old observation must not acknowledge a merged event');
const merged = center.list();
assert.equal(merged.length, 1);
assert.equal(merged[0].count, 2);
assert.equal(merged[0].detail, 'second');
assert.equal(center.ack([merged[0].id]), 1, 'current observation can be acknowledged');
const firstOwner = new NudgeCenter(config, { now: () => new Date(now) });
const nextOwner = new NudgeCenter(config, { now: () => new Date(now) });
firstOwner.push('failed', { sessionId: 'session' });
nextOwner.push('failed', { sessionId: 'session' });
assert.notEqual(firstOwner.list()[0].id, nextOwner.list()[0].id, 'a restarted owner must not reuse a previous observation id');
assert.equal(nextOwner.ack([firstOwner.list()[0].id]), 0, 'previous owner cannot acknowledge the new owner item');
console.log('queue stale acknowledgement safety: passed');
