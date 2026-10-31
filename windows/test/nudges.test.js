// 提醒数据层（`src/nudges.js`）的自检。
//
// 这一层的所有纪律**违反时都不报错**，只会静默地做错事 ——
//   - 插件名不核对：47311 附近有别的服务时，把别人的 JSON 画成提醒；
//   - 失败抛异常：2 秒一次的探桥循环里每拍一条红字；
//   - detail 不截断：一条堆栈把 436px 的 HUD 撑成多行；
//   - id 不校验：出现一行「点了也点不掉」的提醒（ack 拿不到凭据）。
//
// 所以这里**不真连网**：注入假 http，把每条分支各造一次。
// 端口发现复用 `bridge.js` 的 bridgePort()（真读 bridge.json），照 bridge.test.js
// 的做法把 APPDATA 隔离到临时目录，免得搅了用户真实的桥配置。
//
// 用法: node windows/test/nudges.test.js
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-notch-nudges-'));
process.env.APPDATA = TMP;
process.env.USERPROFILE = TMP;

const B = require(path.join(__dirname, '..', 'src', 'bridge.js'));
const N = require(path.join(__dirname, '..', 'src', 'nudges.js'));

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
};

/**
 * 假 http：行为由 handler 决定，返回 `{status, body}` / `{error}` / `{timeout}`。
 * 与 bridge.test.js 的 fakeHttp 同款 —— 两个套件共用同一套替身形状，
 * 将来 http 用法变了只改一处。
 */
function fakeHttp(handler) {
  const calls = [];
  return {
    calls,
    request(opts, cb) {
      calls.push(opts);
      const req = new EventEmitter();
      let body = '';
      req.write = (chunk) => { body += chunk; };
      req.end = () => {
        const r = handler(opts, body) || {};
        if (r.error) {
          process.nextTick(() => req.emit('error', new Error(r.error)));
          return;
        }
        if (r.timeout) {
          process.nextTick(() => req.emit('timeout'));
          return;
        }
        const res = new EventEmitter();
        res.statusCode = r.status === undefined ? 200 : r.status;
        process.nextTick(() => {
          cb(res);
          process.nextTick(() => {
            res.emit('data', r.body === undefined ? '' : r.body);
            res.emit('end');
          });
        });
      };
      req.destroy = () => {};
      return req;
    },
  };
}

/** 一份形状正确的服务端响应（契约 §1.3）。 */
function okBody(extra = {}) {
  return JSON.stringify({
    ok: true,
    plugin: 'dsh-vibe-island',
    version: '1.4.0',
    rev: 'r-1',
    items: [],
    ...extra,
  });
}

/** 合法条目。 */
function item(over = {}) {
  return {
    id: 'needs_choice::session-abc::7',
    kind: 'needs_choice',
    severity: 0,
    sessionId: 'session-abc',
    title: '某个会话',
    project: '默认工作区',
    detail: '等待你批准一个操作',
    at: '19:55',
    atMs: 1793000000000,
    count: 1,
    ts: 1793000000000,
    ...over,
  };
}

(async () => {
  console.log('=== N1: 端口复用 bridge.js（不重写端口发现）===');
  {
    const bridgeFile = B.bridgeFilePath();
    fs.mkdirSync(path.dirname(bridgeFile), { recursive: true });
    fs.writeFileSync(bridgeFile, JSON.stringify({ ok: true, plugin: 'dsh-vibe-island', port: 47315 }));
    B.invalidatePort();

    const h = fakeHttp(() => ({ status: 200, body: okBody() }));
    await N.fetchNudges({ httpImpl: h });
    check('请求打到 bridgePort() 的端口（47315，不是兜底 47311）',
      h.calls[0] && h.calls[0].port === 47315, String(h.calls[0] && h.calls[0].port));
    check('路径是 /nudges', h.calls[0] && h.calls[0].path === '/nudges', String(h.calls[0] && h.calls[0].path));
    check('方法是 GET', h.calls[0] && h.calls[0].method === 'GET');
    check('host 是 127.0.0.1', h.calls[0] && h.calls[0].host === '127.0.0.1');
    check('超时 ≤ 1200ms（契约 §2.1）',
      h.calls[0] && h.calls[0].timeout > 0 && h.calls[0].timeout <= 1200, String(h.calls[0] && h.calls[0].timeout));
    check('模块常量 DEFAULT_TIMEOUT_MS 就是 1200', N.DEFAULT_TIMEOUT_MS === 1200);
  }

  console.log('\n=== N2: 成功路径与归一化 ===');
  {
    const h = fakeHttp(() => ({
      status: 200,
      body: okBody({ rev: 'r-abc', items: [item(), item({ id: 'failed::s1::9', kind: 'failed', severity: 1 })] }),
    }));
    const r = await N.fetchNudges({ httpImpl: h });
    check('ok=true', r.ok === true);
    check('rev 原样透传服务端', r.rev === 'r-abc', r.rev);
    check('两条合法条目都被接受', r.items.length === 2, String(r.items.length));
    check('severity 原样保留', r.items[0].severity === 0 && r.items[1].severity === 1);
    check('count 保留', r.items[0].count === 1);
    check('title / project / sessionId 都归一成字符串',
      typeof r.items[0].title === 'string' && typeof r.items[0].project === 'string'
        && typeof r.items[0].sessionId === 'string');

    // 空列表必须仍是 items: []（不是缺字段）：渲染层与 rev 都按「空数组」
    // 读，缺字段会让「字段缺失 ↔ 空数组」抖成两跳重渲染。
    const empty = await N.fetchNudges({ httpImpl: fakeHttp(() => ({ status: 200, body: okBody({ items: [] }) })) });
    check('空 list 时 items 是空数组而不是缺字段',
      Array.isArray(empty.items) && empty.items.length === 0, JSON.stringify(empty.items));
  }

  console.log('\n=== N3: 桥缺失 / 失败 → 静默降级（一律不抛）===');
  {
    let threw = false;
    let r;
    try {
      // ECONNREFUSED：桥没起
      r = await N.fetchNudges({ httpImpl: fakeHttp(() => ({ error: 'ECONNREFUSED' })) });
    } catch { threw = true; }
    check('连接被拒不抛异常', !threw);
    check('连接被拒 → { ok:false, rev:"", items:[] }',
      r.ok === false && r.rev === '' && Array.isArray(r.items) && r.items.length === 0, JSON.stringify(r));
    check('诊断 reason = network', r.reason === 'network', r.reason);

    r = await N.fetchNudges({ httpImpl: fakeHttp(() => ({ timeout: true })) });
    check('超时 → 降级', r.ok === false && r.items.length === 0);
    check('诊断 reason = timeout', r.reason === 'timeout', r.reason);

    r = await N.fetchNudges({ httpImpl: fakeHttp(() => ({ status: 500, body: 'boom' })) });
    check('HTTP 500 → 降级', r.ok === false && r.items.length === 0);
    check('HTTP 500 的 reason 带 http', /http/.test(r.reason), r.reason);

    r = await N.fetchNudges({ httpImpl: fakeHttp(() => ({ status: 200, body: 'not json' })) });
    check('响应不是 JSON → 降级', r.ok === false && r.items.length === 0);

    const okFalse = fakeHttp(() => ({
      status: 200,
      // 真服务端一定带 plugin，所以这里必须带上 —— 否则测的是
      // 「插件名不符」那条，而不是「ok:false」那条。
      body: JSON.stringify({ ok: false, plugin: 'dsh-vibe-island' }),
    }));
    r = await N.fetchNudges({ httpImpl: okFalse });
    check('ok:false → 降级', r.ok === false);
    check('ok:false 的 reason = not-ok', r.reason === 'not-ok', r.reason);
  }

  console.log('\n=== N4: 插件名核对（认错服务会把别人的 JSON 当提醒）===');
  {
    const other = fakeHttp(() => ({ status: 200, body: JSON.stringify({ ok: true, plugin: 'some-other-app', items: [item()] }) }));
    const r = await N.fetchNudges({ httpImpl: other });
    check('plugin 不是本插件 → 拒绝，哪怕 200 且 ok:true', r.ok === false && r.items.length === 0);
    check('拒绝的 reason = plugin', r.reason === 'plugin', r.reason);

    const noPlugin = fakeHttp(() => ({ status: 200, body: JSON.stringify({ ok: true, items: [item()] }) }));
    const r2 = await N.fetchNudges({ httpImpl: noPlugin });
    check('缺 plugin 字段 → 同样拒绝', r2.ok === false && r2.items.length === 0);

    const prefixed = fakeHttp(() => ({
      status: 200,
      body: JSON.stringify({ ok: true, plugin: '@dsh-external/dsh-vibe-island', rev: 'x', items: [item()] }),
    }));
    const r3 = await N.fetchNudges({ httpImpl: prefixed });
    check('带包名前缀 plugin（@dsh-external/…）被接受 —— 用子串判定',
      r3.ok === true && r3.items.length === 1, JSON.stringify({ ok: r3.ok, plugin: r3.reason }));
  }

  console.log('\n=== N5: 字段校验（非法条目必须丢掉，不能画歪）===');
  {
    // 一次性喂一整批，逐条验证「哪些被接受、哪些被丢」
    const h = fakeHttp(() => ({
      status: 200,
      body: okBody({
        items: [
          item(),                                              // 合法
          item({ id: '' }),                                    // 空 id → 丢
          item({ id: 123 }),                                   // 非字符串 id → 丢
          item({ kind: 'unknown_kind' }),                       // 认不出的 kind → 丢
          item({ kind: undefined }),                            // 缺 kind → 丢
          item({ id: 'no-sev::s1::2', kind: 'completed', severity: undefined }), // 缺 severity → 按 kind 推
          item({ id: 'bad-sev::s1::3', kind: 'failed', severity: 'high' }),      // 非法 severity → 按 kind 推
          null,                                                 // 空条目 → 丢
          'not-an-object',                                      // 非对象 → 丢
        ],
      }),
    }));
    const r = await N.fetchNudges({ httpImpl: h });
    check('只有合法与可推导的两条被留下', r.items.length === 3, String(r.items.length));
    check('空 id / 非字符串 id 都被丢', !r.items.some((it) => !it.id || typeof it.id !== 'string'));
    check('认不出的 kind 被丢', !r.items.some((it) => it.kind === 'unknown_kind'));
    check('其实 kind 都在三种里',
      r.items.every((it) => N.KINDS.includes(it.kind)), r.items.map((it) => it.kind).join(','));
    check('缺 severity 时按 kind 推（completed → 2 / failed → 1）',
      r.items.find((it) => it.id === 'no-sev::s1::2').severity === 2
        && r.items.find((it) => it.id === 'bad-sev::s1::3').severity === 1);
    check('SEVERITY 口径与契约 §1.3 一致（choice 0 < failed 1 < completed 2）',
      N.SEVERITY.needs_choice === 0 && N.SEVERITY.failed === 1 && N.SEVERITY.completed === 2);
  }

  console.log('\n=== N6: detail 截断到 ≤120 字 ===');
  {
    const long = '这是一段很长的失败堆栈说明'.repeat(30);   // 远超 120
    const r = await N.fetchNudges({
      httpImpl: fakeHttp(() => ({
        status: 200,
        body: okBody({ items: [item({ detail: long })] }),
      })),
    });
    check('超长 detail 被截断到 120 字以内', r.items[0].detail.length <= 120, String(r.items[0].detail.length));
    check('截断带省略号（用户要知道后面还有）', r.items[0].detail.endsWith('…'), r.items[0].detail.slice(-3));
    check('恰好 120 字以内不截断（边界不多切一刀）',
      N.normalizeItem(item({ detail: 'a'.repeat(120) })).detail.length === 120);
    check('换行被压成单行（提醒是单行文本，跨行会破坏高度）',
      N.normalizeItem(item({ detail: '第一行\n第二行' })).detail === '第一行 第二行',
      N.normalizeItem(item({ detail: '第一行\n第二行' })).detail);
    check('DETAIL_LIMIT 常量就是 120', N.DETAIL_LIMIT === 120);
  }

  console.log('\n=== N7: at / count 归一 ===');
  {
    check('服务端给的 at 原样保留', N.normalizeItem(item({ at: '07:05' })).at === '07:05');
    check('at 缺失时从 atMs 补 HH:MM',
      /^\d{2}:\d{2}$/.test(N.normalizeItem(item({ at: undefined })).at),
      N.normalizeItem(item({ at: undefined })).at);
    check('count 非法（0 / 负数 / 非数字）退回 1（一条提醒至少算一次）',
      N.normalizeItem(item({ count: 0 })).count === 1
        && N.normalizeItem(item({ count: -3 })).count === 1
        && N.normalizeItem(item({ count: 'x' })).count === 1);
    check('count 是小数时取整', N.normalizeItem(item({ count: 2.9 })).count === 2);
  }

  console.log('\n=== N8: ack —— 成功与失败 ===');
  {
    const h = fakeHttp((opts, body) => {
      return { status: 200, body: JSON.stringify({ ok: true, plugin: 'dsh-vibe-island', removed: 2, remaining: 1 }) };
    });
    const r = await N.ack(['a', 'b'], { httpImpl: h });
    check('ack 成功 ok=true', r.ok === true);
    check('removed / remaining 透传', r.removed === 2 && r.remaining === 1);
    check('hit 打到 /nudge/ack（POST）',
      h.calls[0].path === '/nudge/ack' && h.calls[0].method === 'POST',
      h.calls[0].path + ' ' + h.calls[0].method);

    // 单独抓一次 body：fakeHttp 的 handler 第二个入参就是写进去的字符串
    let seen = null;
    const h2 = fakeHttp((opts, body) => {
      seen = body;
      return { status: 200, body: JSON.stringify({ ok: true, plugin: 'dsh-vibe-island', removed: 1, remaining: 0 }) };
    });
    await N.ack(['id-1'], { httpImpl: h2 });
    check('POST body 真的是 { "ids": ["id-1"] }',
      (() => { try { return JSON.stringify(JSON.parse(seen).ids) === '["id-1"]'; } catch { return false; } })(),
      String(seen));
    check('POST 带 Content-Type: application/json',
      h2.calls[0].headers && h2.calls[0].headers['Content-Type'] === 'application/json');

    // 失败分支
    const refused = fakeHttp(() => ({ error: 'ECONNREFUSED' }));
    const rf = await N.ack(['x'], { httpImpl: refused });
    check('桥拒连 → ok:false 且不抛', rf.ok === false && rf.removed === 0 && rf.remaining === 0);
    const timedOut = await N.ack(['x'], { httpImpl: fakeHttp(() => ({ timeout: true })) });
    check('超时 → ok:false 且不抛', timedOut.ok === false);
    const badPlugin = await N.ack(['x'], { httpImpl: fakeHttp(() => ({ status: 200, body: JSON.stringify({ ok: true, plugin: 'other' }) })) });
    check('插件名不符 → 不认这次 ack', badPlugin.ok === false);
    const e500 = await N.ack(['x'], { httpImpl: fakeHttp(() => ({ status: 500, body: 'boom' }) ) });
    check('HTTP 500 → ok:false', e500.ok === false);

    const empty = await N.ack([], { httpImpl: fakeHttp(() => ({ error: 'should-not-be-called' })) });
    check('空 ids 不发请求（返回 ok:false reason=empty）', empty.ok === false && empty.reason === 'empty');
    const junk = await N.ack(['', '  ', 3], { httpImpl: fakeHttp(() => ({ error: 'should-not-be-called' })) });
    check('全是非法 id 时也不发请求', junk.ok === false && junk.reason === 'empty');
  }

  console.log('\n=== N9: 「只读」语义 —— 拿到不会清空，与 /jump 不同 ===');
  {
    // 契约与 lead 的实测要点：/nudges 是 list 语义，不是 drain 语义。
    // 两次拉取都必须各拿到完整列表（若实现成 drain，第二次就空了）。
    let calls = 0;
    const h = fakeHttp(() => {
      calls += 1;
      return { status: 200, body: okBody({ rev: 'r-' + calls, items: [item(), item({ id: 'b::s1::2', kind: 'failed' })] }) };
    });
    const r1 = await N.fetchNudges({ httpImpl: h });
    const r2 = await N.fetchNudges({ httpImpl: h });
    check('连拉两次都拿到完整列表（不是取走就清空）',
      r1.items.length === 2 && r2.items.length === 2, r1.items.length + '/' + r2.items.length);
    check('两次各发了一次请求', calls === 2, String(calls));
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 无所谓 */ }
  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
