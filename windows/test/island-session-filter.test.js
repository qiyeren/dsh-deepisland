'use strict';

// Public seam: the snapshot consumed by every island layout contains only
// eligible sessions. All session/projection data below is synthetic and rooted
// in a fresh temporary directory; no Electron, real DSH sessions, or nudges.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { SessionMonitor } = require('../src/monitor.js');
const { buildSnapshot } = require('../src/snapshot.js');
const source = require('../src/session-source.js');
const projections = require('../src/projections.js');

function withFakeRoot(run) {
  const tempDir = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempDir, 'island-session-filter-'));
  const oldRoot = process.env.DSH_ROOT;
  process.env.DSH_ROOT = root;
  source.invalidate();
  projections.invalidate();
  try {
    return run(root);
  } finally {
    if (oldRoot === undefined) delete process.env.DSH_ROOT;
    else process.env.DSH_ROOT = oldRoot;
    source.invalidate();
    projections.invalidate();
    const resolvedRoot = path.resolve(root);
    if (path.dirname(resolvedRoot) !== tempDir || !path.basename(resolvedRoot).startsWith('island-session-filter-')) {
      throw new Error('refusing to remove an unexpected test root');
    }
    fs.rmSync(resolvedRoot, { recursive: true, force: true });
  }
}

function makeSession(root, id, properties, mtimeMs, title = id) {
  const dir = path.join(root, 'sessions', '--synthetic-project--', id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  const header = { type: 'session', version: 4, id, createdAt: 1, isSeeded: false, delegationDepth: 0, ...properties };
  const firstFrame = zlib.zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n'));
  const eventFrame = zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: 'synthetic-event' }) + '\n'));
  fs.writeFileSync(file, Buffer.concat([firstFrame, eventFrame]));
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  const projectionDir = path.join(root, 'storages', 'session_projcache', 'sessions');
  fs.mkdirSync(projectionDir, { recursive: true });
  fs.writeFileSync(path.join(projectionDir, id + '.json'), JSON.stringify({ record: { rows: {
    title: { seq: 1, val: title },
  } } }));
  return file;
}

test('newer delegated sessions cannot crowd ordinary sessions out of the island snapshot', () => withFakeRoot((root) => {
  const now = Date.now();
  for (let i = 0; i < 6; i++) {
    makeSession(root, 'session-child-' + i,
      i === 0 ? { delegationDepth: 1 }
        : i === 1 ? { origin: 'subagent', delegationDepth: undefined }
          : { origin: 'subagent' },
      now - 1000 - i * 1000, i === 1 ? 'Mnemon idle checkpoint review' : 'Child');
  }
  // Session IDs are encoded as filesystem-safe segments by DSH persistence.
  makeSession(root, 'session-child~003Aencoded', { id: 'session-child:encoded', origin: 'subagent' }, now - 7000);
  makeSession(root, 'session-main', {}, now - 30000);
  // parentSession means a fork, not necessarily a subagent. A main session
  // with the same title must not be hidden through a broad title match either.
  makeSession(root, 'session-fork', { parentSession: 'session-main' }, now - 31000, 'Mnemon idle checkpoint review');

  const entries = new SessionMonitor().poll(now, 1);
  const snapshot = buildSnapshot({ entries, nudges: [], now });
  assert.deepEqual(snapshot.entries.map((entry) => entry.id), ['session-main', 'session-fork']);
}));

test('the six-session cap and activity-then-mtime order remain unchanged for mains', () => withFakeRoot((root) => {
  const now = Date.now();
  makeSession(root, 'session-child', { origin: 'subagent' }, now - 1000);
  for (let i = 0; i < 7; i++) makeSession(root, 'session-main-' + i, {}, now - 20000 - i * 1000);
  const projection = path.join(root, 'storages', 'session_projcache', 'sessions', 'session-main-5.json');
  fs.writeFileSync(projection, JSON.stringify({ record: { rows: {
    title: { seq: 1, val: 'Main 5' },
    sessionStats: { seq: 2, val: { pendingCalls: { call: {} } } },
  } } }));
  const entries = new SessionMonitor().poll(now, 1);
  assert.deepEqual(buildSnapshot({ entries, nudges: [], now }).entries.map((entry) => entry.id), [
    'session-main-5', 'session-main-0', 'session-main-1', 'session-main-2', 'session-main-3', 'session-main-4',
  ]);
}));

test('a main-session snapshot does not expose a subagent count', () => withFakeRoot((root) => {
  const now = Date.now();
  const id = 'session-main';
  const file = makeSession(root, id, {}, now - 1000);
  const header = { type: 'session', version: 4, id, createdAt: 1, isSeeded: false, delegationDepth: 0 };
  const events = [
    { seq: 1, type: 'tool/call', time: now - 500,
      data: { callId: 'call-child', name: 'subagent', arguments: {} } },
    { seq: 2, type: 'tool/call', time: now - 400,
      data: { callId: 'call-read', name: 'read', arguments: { file_path: 'synthetic.txt' } } },
  ];
  fs.writeFileSync(file, Buffer.concat([
    zlib.zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n')),
    zlib.zstdCompressSync(Buffer.from(events.map(JSON.stringify).join('\n') + '\n')),
  ]));
  fs.utimesSync(file, new Date(now - 1000), new Date(now - 1000));
  const projection = path.join(root, 'storages', 'session_projcache', 'sessions', id + '.json');
  fs.writeFileSync(projection, JSON.stringify({ record: { rows: {
    title: { seq: 1, val: 'Main' },
    sessionStats: { seq: 2, val: { pendingCalls: { 'call-child': {} } } },
  } } }));
  const monitor = new SessionMonitor();
  const entries = monitor.poll(now, 1);
  const visible = buildSnapshot({ entries, nudges: [], now }).entries;
  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, id);
  assert.equal(visible[0].subagentText, undefined);
  assert.equal(visible[0].toolCountText, '1 次', 'only the ordinary tool is counted visibly');
  const turnEnd = { seq: 3, type: 'turn/end', time: now - 100, data: {} };
  fs.appendFileSync(file, zlib.zstdCompressSync(Buffer.from(JSON.stringify(turnEnd) + '\n')));
  fs.utimesSync(file, new Date(now), new Date(now));
  const after = buildSnapshot({ entries: monitor.poll(now + 6000, 4), nudges: [], now: now + 6000 }).entries;
  assert.equal(after[0].toolCountText, '1 次', 'idle fallback retains the visible count');
}));

test('fallback chooses the newest ordinary session, never an active child', () => withFakeRoot((root) => {
  const now = Date.now();
  makeSession(root, 'session-child', { origin: 'subagent' }, now - 1000);
  makeSession(root, 'session-old-main', {}, now - 600000);
  makeSession(root, 'session-older-main', {}, now - 700000);
  const entries = new SessionMonitor({ activeWindow: 60000 }).poll(now, 1);
  const snapshot = buildSnapshot({ entries, nudges: [], now });
  assert.deepEqual(snapshot.entries.map((entry) => entry.id), ['session-old-main']);
}));

test('when every session is delegated the island has no visible session', () => withFakeRoot((root) => {
  const now = Date.now();
  makeSession(root, 'session-child-one', { origin: 'subagent' }, now - 1000);
  makeSession(root, 'session-child-two', { delegationDepth: 2 }, now - 2000);
  const entries = new SessionMonitor().poll(now, 1);
  assert.deepEqual(buildSnapshot({ entries, nudges: [], now }).entries, []);
}));

test('only the checksummed first frame controls visibility', () => withFakeRoot((root) => {
  const now = Date.now();
  const compress = (json) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(json) + '\n'), {
    params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
  });
  const head = (id, properties = {}) => ({
    type: 'session', version: 4, id, createdAt: 1, isSeeded: false, delegationDepth: 0, ...properties,
  });
  const main = makeSession(root, 'session-main', {}, now - 20000);
  const child = makeSession(root, 'session-child', {}, now - 19000);
  // A later fake header must not hide the main session. A damaged later frame
  // must not prevent recognizing a valid subagent header.
  fs.writeFileSync(main, Buffer.concat([compress(head('session-main')), compress(head('decoy', { origin: 'subagent' }))]));
  fs.writeFileSync(child, Buffer.concat([compress(head('session-child', { origin: 'subagent' })), Buffer.from('damaged event frame')]));
  fs.utimesSync(main, new Date(now - 20000), new Date(now - 20000));
  fs.utimesSync(child, new Date(now - 19000), new Date(now - 19000));
  const entries = new SessionMonitor().poll(now, 1);
  assert.deepEqual(buildSnapshot({ entries, nudges: [], now }).entries.map((entry) => entry.id), ['session-main']);
}));

test('more than 512 delegated candidates do not thrash decompression on successive scans', () => withFakeRoot((root) => {
  const now = Date.now();
  const project = path.join(root, 'sessions', '--synthetic-project--');
  fs.mkdirSync(project, { recursive: true });
  for (let i = 0; i < 550; i++) {
    const id = 'session-child-' + String(i).padStart(4, '0');
    const dir = path.join(project, id);
    fs.mkdirSync(dir);
    const file = path.join(dir, 'session.v4.jsonl.zstd');
    const header = { type: 'session', version: 4, id, createdAt: 1, isSeeded: false, delegationDepth: 1 };
    fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n')));
    fs.utimesSync(file, new Date(now - 20000 - i), new Date(now - 20000 - i));
  }
  makeSession(root, 'session-main', {}, now - 30000);
  const original = zlib.zstdDecompressSync;
  const originalNow = Date.now;
  let clock = now;
  let decodes = 0;
  Date.now = () => clock;
  zlib.zstdDecompressSync = function (buffer, options) {
    decodes++;
    return original.call(this, buffer, options);
  };
  try {
    const monitor = new SessionMonitor();
    const visible = () => buildSnapshot({ entries: monitor.poll(now, 1), nudges: [], now }).entries.map((entry) => entry.id);
    assert.deepEqual(visible(), ['session-main']);
    const initialDecodes = decodes;
    assert.ok(initialDecodes >= 550);
    assert.deepEqual(visible(), ['session-main']);
    assert.equal(decodes, initialDecodes, 'unchanged candidate headers must not be decompressed a second time');
    clock += 801;
    assert.deepEqual(visible(), ['session-main']);
    assert.equal(decodes, initialDecodes, 'a full 800ms rescan must reuse unchanged classifications');
  } finally {
    zlib.zstdDecompressSync = original;
    Date.now = originalNow;
  }
}));

test('append reuses header classification, but a changed first frame is reclassified', () => withFakeRoot((root) => {
  const now = Date.now();
  const id = 'session-child';
  const header = { type: 'session', version: 4, id, createdAt: 1, isSeeded: false, delegationDepth: 0, origin: 'subagent' };
  const frame = zlib.zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n'));
  const file = makeSession(root, id, { origin: 'subagent' }, now - 5000);
  const original = zlib.zstdDecompressSync;
  let headerDecodes = 0;
  // Instrument only the public Node zlib call to measure the cache contract;
  // do not replace the decoder or reach into the session source internals.
  zlib.zstdDecompressSync = function (buffer, options) {
    if (buffer.equals(frame)) headerDecodes++;
    return original.call(this, buffer, options);
  };
  try {
    const monitor = new SessionMonitor();
    const visible = () => buildSnapshot({ entries: monitor.poll(now, 1), nudges: [], now }).entries.map((entry) => entry.id);
    assert.deepEqual(visible(), []);
    assert.equal(headerDecodes, 1);
    fs.appendFileSync(file, zlib.zstdCompressSync(Buffer.from('{"type":"synthetic-event"}\n')));
    fs.utimesSync(file, new Date(now - 4000), new Date(now - 4000));
    assert.deepEqual(visible(), []);
    assert.equal(headerDecodes, 1, 'an unchanged header frame must not be decompressed again on append');

    const replacement = { ...header };
    delete replacement.origin;
    fs.writeFileSync(file, Buffer.concat([
      zlib.zstdCompressSync(Buffer.from(JSON.stringify(replacement) + '\n')),
      zlib.zstdCompressSync(Buffer.from('{"type":"synthetic-event"}\n')),
    ]));
    fs.utimesSync(file, new Date(now - 3000), new Date(now - 3000));
    assert.deepEqual(visible(), [id]);
  } finally {
    zlib.zstdDecompressSync = original;
  }
}));

test('a rebuilt header with unchanged size and mtime does not reuse the old classification', () => withFakeRoot((root) => {
  const now = Date.now();
  const id = 'session-child';
  const file = makeSession(root, id, {}, now - 20000);
  const head = { type: 'session', version: 4, id, createdAt: 1, isSeeded: false,
    delegationDepth: 0, origin: 'subagent' };
  // A raw-block zstd frame keeps equal-sized JSON substitutions byte-for-byte sized.
  const rawFrame = (value) => {
    const body = Buffer.from(JSON.stringify(value) + '\n');
    assert.ok(body.length < 256);
    const block = Buffer.alloc(3);
    block.writeUIntLE((body.length << 3) | 1, 0, 3);
    return Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, body.length]), block, body]);
  };
  const before = rawFrame(head);
  const after = rawFrame({ ...head, origin: 'normal--' }); // equal length, conservatively unknown
  assert.equal(before.length, after.length);
  fs.writeFileSync(file, before);
  fs.utimesSync(file, new Date(now - 20000), new Date(now - 20000));
  const originalStat = fs.statSync;
  let rebuilt = false;
  fs.statSync = function (filename, ...args) {
    const st = originalStat.call(this, filename, ...args);
    // Deterministic file-identity change even on filesystems with coarse ctime.
    return filename === file && rebuilt ? new Proxy(st, {
      get(target, key) { return key === 'ino' ? target.ino + 1 : target[key]; },
    }) : st;
  };
  try {
    const monitor = new SessionMonitor();
    const visible = () => buildSnapshot({ entries: monitor.poll(now, 1), nudges: [], now }).entries.map((entry) => entry.id);
    assert.deepEqual(visible(), []);
    const oldStat = originalStat(file);
    fs.writeFileSync(file, after);
    fs.utimesSync(file, oldStat.atime, oldStat.mtime);
    const newStat = originalStat(file);
    assert.equal(newStat.size, oldStat.size);
    assert.equal(newStat.mtimeMs, oldStat.mtimeMs);
    rebuilt = true;
    assert.deepEqual(visible(), [id]);
  } finally {
    fs.statSync = originalStat;
  }
}));

test('a transient unreadable header is retried after the scan cache interval', () => withFakeRoot((root) => {
  let clock = Date.now();
  const file = makeSession(root, 'session-child', { origin: 'subagent' }, clock - 20000);
  const originalOpen = fs.openSync;
  const originalNow = Date.now;
  let refused = false;
  fs.openSync = function (filename, ...args) {
    if (!refused && filename === file) {
      refused = true;
      throw new Error('synthetic transient sharing violation');
    }
    return originalOpen.call(this, filename, ...args);
  };
  Date.now = () => clock;
  try {
    const monitor = new SessionMonitor();
    const visible = () => buildSnapshot({ entries: monitor.poll(clock, 1), nudges: [], now: clock }).entries.map((entry) => entry.id);
    // Unknown must not hide a possible main, but the error must not be cached forever.
    assert.deepEqual(visible(), ['session-child']);
    assert.equal(refused, true);
    clock += 801;
    assert.deepEqual(visible(), []);
  } finally {
    fs.openSync = originalOpen;
    Date.now = originalNow;
  }
}));

test('malformed metadata and invalid UTF-8 cannot hide an uncertain session', () => withFakeRoot((root) => {
  const now = Date.now();
  makeSession(root, 'session-bad-parent', { origin: 'subagent', parentSession: {} }, now - 21000);
  const badUtf8 = makeSession(root, 'session-bad-utf8', {}, now - 22000);
  const invalidHeader = Buffer.concat([
    Buffer.from('{"type":"session","version":4,"id":"session-'),
    Buffer.from([0xff]),
    Buffer.from('","createdAt":1,"isSeeded":false,"delegationDepth":0,"origin":"subagent"}\n'),
  ]);
  fs.writeFileSync(badUtf8, zlib.zstdCompressSync(invalidHeader));
  fs.utimesSync(badUtf8, new Date(now - 22000), new Date(now - 22000));
  const torn = makeSession(root, 'session-torn', {}, now - 23000);
  makeSession(root, 'session-bad-cwd', { origin: 'subagent', cwd: 'relative/path' }, now - 24000);
  makeSession(root, 'session-bad-preset', { origin: 'subagent', agentPreset: {} }, now - 25000);
  makeSession(root, 'session-mismatched-id', { origin: 'subagent', id: 'different-session' }, now - 26000);
  const tornFrame = zlib.zstdCompressSync(Buffer.from(JSON.stringify({
    type: 'session', version: 4, id: 'session-torn', createdAt: 1,
    isSeeded: false, delegationDepth: 1,
  }) + '\n'));
  fs.writeFileSync(torn, tornFrame.subarray(0, -1));
  fs.utimesSync(torn, new Date(now - 23000), new Date(now - 23000));
  const entries = new SessionMonitor().poll(now, 1);
  assert.deepEqual(buildSnapshot({ entries, nudges: [], now }).entries.map((entry) => entry.id), [
    'session-bad-parent', 'session-bad-utf8', 'session-torn', 'session-bad-cwd', 'session-bad-preset', 'session-mismatched-id',
  ]);
}));

test('legacy and damaged headers are conservatively retained', () => withFakeRoot((root) => {
  const now = Date.now();
  makeSession(root, 'session-child', { origin: 'subagent' }, now - 20000);
  makeSession(root, 'session-legacy', { delegationDepth: undefined, isSeeded: undefined }, now - 21000);
  makeSession(root, 'session-fork', { parentSession: 'session-parent' }, now - 22000);
  makeSession(root, 'session-wrong-type', { type: 'event', origin: 'subagent' }, now - 23000);
  makeSession(root, 'session-bad-depth', { delegationDepth: '1' }, now - 24000);
  makeSession(root, 'session-bad-id', { id: null, origin: 'subagent' }, now - 25000);
  const broken = makeSession(root, 'session-broken', {}, now - 26000);
  fs.writeFileSync(broken, Buffer.from('not a zstd frame'));
  fs.utimesSync(broken, new Date(now - 26000), new Date(now - 26000));
  const entries = new SessionMonitor().poll(now, 1);
  assert.deepEqual(buildSnapshot({ entries, nudges: [], now }).entries.map((entry) => entry.id), [
    'session-legacy', 'session-fork', 'session-wrong-type', 'session-bad-depth', 'session-bad-id', 'session-broken',
  ]);
}));
