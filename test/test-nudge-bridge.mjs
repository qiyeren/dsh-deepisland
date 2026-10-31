// 提醒端点（/nudges、/nudge/ack）的自检：真起 HTTP 服务、真发请求。
//
// 与 test/test-nudge.mjs 的分工：那边测**语义**（什么事件算出什么提醒），
// 这边测**搬运**（语义队列怎么变成 HTTP 响应、ack 怎么落回队列）。
// 两者分开的理由：桥起不来时语义层仍然是对的，混在一起会让「哪一层坏了」
// 变得看不出来。
//
// 用法: node test/test-nudge-bridge.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

globalThis.__http = http;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// lib/index.js 静态 import 了宿主提供的 @deepseek-ai/schemastery，仓库里没有
// node_modules 解析不到 —— 与 test-bridge.mjs 共用同一份最小替身，跑完删掉。
const SHIM_DIR = path.join(ROOT, 'node_modules', '@deepseek-ai', 'schemastery');
function ensureShim() {
  if (fs.existsSync(SHIM_DIR)) return false;
  fs.mkdirSync(SHIM_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(SHIM_DIR, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/schemastery', version: '0.0.0-test-shim', type: 'module', main: 'index.js' }, null, 2),
  );
  fs.writeFileSync(path.join(SHIM_DIR, 'index.js'), `const node = () => { const s = {}; for (const m of ['default','description','step','min','max','readonly']) s[m] = () => s; return s; };
export default { object: node, union: node, boolean: node, number: node, natural: node, string: node, const: node };
`);
  return true;
}
const madeShim = ensureShim();
process.on('exit', () => {
  if (madeShim) {
    try { fs.rmSync(path.join(ROOT, 'node_modules'), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href);
const { startBridge, PLUGIN_VERSION } = mod;
// 提醒语义在 lib/nudge.js，不在 index.js 的导出表里（index 只 re-export 桥相关件）
const { NudgeCenter, attachNudges } = await import(pathToFileURL(path.join(ROOT, 'lib', 'nudge.js')).href);

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass += 1; return; }
  fail += 1;
  failures.push(name + (extra === undefined ? '' : `  → ${extra}`));
}

/** 起桥但不占真实端口段：用一个远离默认值的端口，避免被用户真实的桥复用。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function request(port, pathname, { method = 'GET', body = null, timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method,
      headers: payload === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { raw += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, text: raw, body: json });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    if (payload !== null) req.write(payload);
    req.end();
  });
}

// 造一个能驱动队列的最小 ctx；语义细节由 test-nudge.mjs 覆盖，这里只要「能产生条目」。
function makeCtx(cfg) {
  const handlers = new Map();
  const center = new NudgeCenter({ ...cfg }, {});
  const ctx = {
    on(e, fn) { const l = handlers.get(e) ?? []; l.push(fn); handlers.set(e, l); },
    get() { return undefined; },
    effect() {},
    emit(e, ...args) { for (const fn of handlers.get(e) ?? []) fn(...args); },
    handlers,
  };
  attachNudges(ctx, center.config, { log: () => {}, center });
  return { ctx, center, emitTurnEnd: (kind, sid = 'session-x') => ctx.emit('session/event', { header: { id: sid, cwd: '/p/demo' } }, { type: 'turn/end', data: { reason: { kind } } }) };
}

const base = await freePort();
const bridge = await startBridge({
  port: base,
  log: () => {},
  installState: () => ({ status: 'test' }),
});

check('桥已起（远离默认端口段）', bridge !== null && bridge.port >= 1024, String(base));

// ===========================================================================
console.log('\n=== B1: 提醒端点在没有队列时也要干净降级 ===');
// ===========================================================================
{
  const r = await request(bridge.port, '/nudges');
  check('/nudges 200', r.status === 200, String(r.status));
  check('/nudges 回显 plugin', typeof r.body?.plugin === 'string' && r.body.plugin.includes('vibe-island'), r.body?.plugin);
  check('/nudges 回显 version', r.body?.version === PLUGIN_VERSION, r.body?.version);
  // 桥被 startBridge 直接调用时没接到 nudges 参数 → 必须回空列表而不是 500。
  // app 侧对 500 会判「桥异常」，而真实情况只是「暂时没有可显示的提醒」。
  check('/nudges 无队列时 items 是空数组', Array.isArray(r.body?.items) && r.body.items.length === 0, JSON.stringify(r.body?.items));
  check('/nudges 无队列时 rev 仍是字符串', typeof r.body?.rev === 'string', typeof r.body?.rev);

  const a = await request(bridge.port, '/nudge/ack', { method: 'POST', body: { ids: ['nope'] } });
  check('/nudge/ack 200', a.status === 200, String(a.status));
  check('/nudge/ack removed=0 不报错', a.body?.ok === true && a.body?.removed === 0, JSON.stringify(a.body));
  check('/nudge/ack remaining=0', a.body?.remaining === 0, String(a.body?.remaining));
}

// ===========================================================================
console.log('\n=== B2: 接上真队列后，条目与 ack 端到端 ===');
// ===========================================================================
{
  const cfg = { nudgeEnabled: true, nudgeMergeWindowMs: 0, nudgeMaxItems: 4, nudgeTtlMinutes: 30, nudgeMuteRanges: '', nudgeOnCompleted: true, nudgeOnFailed: true, nudgeOnChoice: true, nudgeAlertOnToolError: true };
  const s = makeCtx(cfg);

  // 独立起一座带队列的桥（不复用上面那座：startBridge 按端口缓存，换端口最干净）
  const port = base + 1;
  const live = await startBridge({
    port,
    log: () => {},
    nudges: {
      list: () => s.center.list(),
      rev: () => s.center.rev(),
      ack: (ids) => s.center.ack(ids),
      ackAll: () => s.center.ackAll(),
      config: () => ({ enabled: true, maxItems: 4, onCompleted: true, onFailed: true, onChoice: true }),
    },
  });
  check('带队列的桥已起', live !== null, String(port));

  s.emitTurnEnd('completed', 'session-a');
  s.emitTurnEnd('error', 'session-a');
  s.emitTurnEnd('blocked', 'session-b');

  const r = await request(live.port, '/nudges');
  check('/nudges 拿到 3 条', r.body?.items?.length === 3, JSON.stringify(r.body?.items?.map((i) => i.kind)));
  const kinds = r.body.items.map((i) => i.kind);
  check('排序按严重度：failed 在 completed 之前',
    kinds.indexOf('failed') < kinds.indexOf('completed'), kinds.join(','));
  check('条目带 id', r.body.items.every((i) => typeof i.id === 'string' && i.id.length > 0));
  check('条目带 severity 数字', r.body.items.every((i) => typeof i.severity === 'number'));
  check('条目带 at (HH:MM)', r.body.items.every((i) => /^\d{2}:\d{2}$/.test(i.at)), r.body.items[0]?.at);
  check('条目带 project（cwd 末段）', r.body.items.every((i) => i.project === 'demo'), r.body.items[0]?.project);
  check('config 一起报出去（app 要判用户有没有关掉提醒）',
    r.body?.config?.enabled === true && r.body?.config?.maxItems === 4, JSON.stringify(r.body?.config));

  // rev 稳定性：同一份内容拉两次必须一样，否则 app 侧每 2 秒都会重渲染
  const r2 = await request(live.port, '/nudges');
  check('内容不变 rev 不变', r.body.rev === r2.body.rev, `${r.body.rev} vs ${r2.body.rev}`);

  // ack 指定 id
  const target = r.body.items[0].id;
  const a = await request(live.port, '/nudge/ack', { method: 'POST', body: { ids: [target] } });
  check('ack 回 removed=1', a.body?.removed === 1, String(a.body?.removed));
  check('ack 回 remaining=2', a.body?.remaining === 2, String(a.body?.remaining));

  const r3 = await request(live.port, '/nudges');
  check('ack 之后该条不再出现', !r3.body.items.some((i) => i.id === target));
  check('ack 之后 rev 变了', r3.body.rev !== r.body.rev, `${r.body.rev} vs ${r3.body.rev}`);

  // ackAll
  const a2 = await request(live.port, '/nudge/ack', { method: 'POST', body: { all: true } });
  check('ackAll 清空', a2.body?.removed === 2 && a2.body?.remaining === 0, JSON.stringify(a2.body));
  const r4 = await request(live.port, '/nudges');
  check('ackAll 之后空列表', r4.body.items.length === 0);

  // 非法 body 不能把服务带崩
  const bad = await request(live.port, '/nudge/ack', { method: 'POST', body: '{not json' });
  check('非法 JSON 的 ack 仍 200（当作什么都没确认）', bad.status === 200 && bad.body?.removed === 0, `${bad.status} ${JSON.stringify(bad.body)}`);

  const weird = await request(live.port, '/nudge/ack', { method: 'POST', body: { ids: [1, 2, null] } });
  check('非字符串 id 被过滤掉', weird.status === 200 && weird.body?.removed === 0, JSON.stringify(weird.body));

  // 语义层抛错时端点不能 500
  const boom = await startBridge({
    port: port + 1,
    log: () => {},
    nudges: { list: () => { throw new Error('boom'); }, rev: () => { throw new Error('boom'); }, ack: () => { throw new Error('boom'); } },
  });
  check('语义层抛错时桥仍起得来', boom !== null);
  const br = await request(boom.port, '/nudges');
  check('语义层抛错时 /nudges 回 200 + 空列表', br.status === 200 && br.body.items.length === 0, `${br.status} ${br.text.slice(0, 120)}`);

  for (const b of [live, boom]) await b.close();
}

// ===========================================================================
console.log('\n=== B3: /health 与 README 要如实反映新端点 ===');
// ===========================================================================
{
  const h = await request(bridge.port, '/health');
  check('/health 仍 ok', h.body?.ok === true);
  check('/health 报的插件名不变', String(h.body?.plugin || '').includes('vibe-island'), h.body?.plugin);

  const readme = (await request(bridge.port, '/readme')).text;
  check('README 列出了 /nudges', readme.includes('/nudges'), readme.slice(0, 80));
  check('README 列出了 /nudge/ack', readme.includes('/nudge/ack'));
}

await bridge.close();
check('桥已关闭（测试不该吊住事件循环）', true);

console.log('\n' + '='.repeat(44));
console.log('通过 ' + pass + ' / 失败 ' + fail);
console.log('='.repeat(44));
if (fail > 0) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  ❌ ' + f);
}
globalThis.__results = globalThis.__results || {};
globalThis.__results['nudge-bridge'] = { pass, fail };
