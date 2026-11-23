'use strict';
// One outstanding conditional GET to the host. This module deliberately has no
// dependency on session files, projection caches or the old activity monitor.
const http = require('node:http');
const { bridgePort } = require('./bridge.js');
const PLUGIN = '@dsh-external/dsh-vibe-island';
const STATES = new Set(['running', 'waiting', 'done', 'failed', 'interrupted']);
const MAX_BODY = 64 * 1024;

function parseStates(obj) {
  if (!obj || obj.ok !== true || obj.plugin !== PLUGIN || typeof obj.rev !== 'string' ||
      !obj.rev || obj.rev.length > 128 || !Array.isArray(obj.items) || obj.items.length > 6) return null;
  const ids = new Set();
  const items = [];
  for (const row of obj.items) {
    if (!row || typeof row.id !== 'string' || !row.id || row.id.length > 512 || ids.has(row.id) ||
        typeof row.label !== 'string' || row.label.length > 512 || !STATES.has(row.status) ||
        !Number.isSafeInteger(row.at) || row.at < 0) return null;
    ids.add(row.id);
    items.push({ id: row.id, label: row.label, status: row.status, at: row.at });
  }
  return { rev: obj.rev, items };
}

function requestStates(since, { signal, port = bridgePort() } = {}) {
  return new Promise(resolve => {
    const pathname = '/session-states' + (since ? '?since=' + encodeURIComponent(since) : '');
    let deadline;
    const finish = value => { clearTimeout(deadline); resolve(value); };
    const req = http.get({ host:'127.0.0.1', port, path:pathname, signal, headers:{ Accept:'application/json' } }, res => {
      if (res.statusCode !== 200) { res.destroy(); return finish(null); }
      const chunks = []; let size = 0;
      res.on('error', () => finish(null));
      res.on('aborted', () => finish(null));
      res.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BODY) { res.destroy(); finish(null); } else chunks.push(chunk);
      });
      res.on('end', () => {
        try { finish(parseStates(JSON.parse(Buffer.concat(chunks).toString('utf8')))); }
        catch { finish(null); }
      });
    });
    req.on('error', () => finish(null));
    // Hard wall-clock budget, not just a socket inactivity timeout. The host
    // normally replies at 20 s even if nothing changed.
    deadline = setTimeout(() => { req.destroy(); finish(null); }, since ? 26_000 : 4_000);
  });
}

function followStates(notify, { read = requestStates, later = setTimeout, cancel = clearTimeout } = {}) {
  let stopped = false, timer, rev = '', online = false, retry = 1000;
  const controller = new AbortController();
  async function step() {
    if (stopped) return;
    let reply;
    try { reply = await read(rev, { signal: controller.signal }); } catch { reply = null; }
    if (stopped) return;
    let delay;
    if (reply) {
      const changed = reply.rev !== rev || !online;
      rev = reply.rev; online = true; retry = 1000;
      if (changed) notify(reply.items, true);
      // Coalesce bursts. Guard against a mismatched server that returns the
      // same revision immediately instead of holding the request.
      delay = changed ? 30 : 250;
    } else {
      if (online) notify([], false);
      online = false; rev = ''; // a reconnect always requests a full snapshot
      delay = retry; retry = Math.min(15000, retry * 2);
    }
    if (!stopped) timer = later(step, delay);
  }
  void step();
  return { stop() { stopped = true; cancel(timer); controller.abort(); } };
}

module.exports = { requestStates, followStates, parseStates };
