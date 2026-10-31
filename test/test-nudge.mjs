// 提醒采集（lib/nudge.js）的自检 —— 纯 Node，不需要宿主。
//
// 为什么这组断言值得单独一个套件：事件语义错了在真机上**只表现为**
// 「弹了不该弹的 / 该弹的没弹」，没有任何报错。而它又是最容易错的一块
// （turn/end 的五种 kind、tool/result 的双判据、审批链必须放行、
// userQuestions 包装必须还原）。
//
// 用法: node test/test-nudge.mjs
import {
  NudgeCenter, attachNudges, condenseText, clipTitle,
  toolFailureDetail, inMuteRange, projectOf, stableStringify,
} from '../lib/nudge.js';

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) { pass += 1; return; }
  fail += 1;
  failures.push(name + (extra === undefined ? '' : `  → ${extra}`));
}

function eq(name, actual, expected) {
  ok(name, actual === expected, `实际 ${JSON.stringify(actual)}, 期望 ${JSON.stringify(expected)}`);
}

/** 一个够用的假 ctx：记录注册了哪些监听、提供了几个服务面。 */
function mockCtx({ withApproval = true, withQuestions = true } = {}) {
  const handlers = new Map();
  const services = new Map();
  const state = { effects: [], disposed: false };
  const questions = withQuestions
    ? { ask: async () => ({ ok: true }) }
    : undefined;
  if (withQuestions) services.set('userQuestions', questions);
  if (withApproval) services.set('approval', {});
  const ctx = {
    on(event, fn) {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
    },
    get(key) { return services.get(key); },
    effect(fn) { state.effects.push(fn); },
    __handlers: handlers,
    __services: services,
    __state: state,
    __emit(event, ...args) {
      for (const fn of handlers.get(event) ?? []) fn(...args);
    },
  };
  return ctx;
}

/** 造一个最小 session：header.id / header.cwd，没有 header.title（真实形态）。 */
function session(id, cwd = '/Users/x/project-a') {
  return { header: { id, cwd } };
}

console.log('=== N1: 文本压缩（只留一行重点）===');
{
  eq('换行与连续空白压成单空格', condenseText('a\n\n   b\tc'), 'a b c');
  eq('砍掉真实堆栈帧', condenseText('boom at fn (file.js:12:3)'), 'boom');
  ok('正文里的自然语言 " at " 要留住',
    condenseText('look at the sky').includes('at the sky'),
    condenseText('look at the sky'));
  const long = 'x'.repeat(200);
  const clipped = condenseText(long, 140);
  ok('超长截断到 140 带省略号', clipped.length === 140 && clipped.endsWith('…'), clipped.length);
  eq('空值返回空串', condenseText(''), '');
  eq('null 返回空串', condenseText(null), '');
  eq('标题上限比明细短', clipTitle('y'.repeat(200)).length, 42);
}

console.log('=== N2: 工具失败明细（正文优先、结构化错误兜底）===');
{
  const data = { message: { isError: true, content: [{ type: 'text', text: 'Error: disk full' }] } };
  eq('正文优先且去掉 Error: 前缀', toolFailureDetail(data), '工具调用失败：disk full');
  eq('结构化错误兜底', toolFailureDetail({ error: { message: 'EACCES' } }), '工具调用失败：EACCES');
  eq('什么都没有时写 unknown', toolFailureDetail({}), '工具调用失败：unknown');
  eq('非文本块被忽略', toolFailureDetail({ message: { content: [{ type: 'image' }] }, name: 'boom' }), '工具调用失败：boom');
}

console.log('=== N3: 静音时段（含跨零点与非法行）===');
{
  const at = (h, m) => new Date(2026, 0, 1, h, m);
  ok('22:00-08:00 的 23:00 在静音里', inMuteRange('22:00-08:00', at(23, 0)));
  ok('22:00-08:00 的 02:00 在静音里', inMuteRange('22:00-08:00', at(2, 0)));
  ok('22:00-08:00 的 12:00 不在静音里', !inMuteRange('22:00-08:00', at(12, 0)));
  ok('边界 22:00 算进入', inMuteRange('22:00-08:00', at(22, 0)));
  ok('边界 08:00 已退出', !inMuteRange('22:00-08:00', at(8, 0)));
  ok('同日段 09:00-18:00 的 10:00 命中', inMuteRange('09:00-18:00', at(10, 0)));
  ok('空串不静音', !inMuteRange('', at(3, 0)));
  ok('非法行被忽略而不是整段失效', !inMuteRange('乱写,09:00-18:00', at(3, 0)) && inMuteRange('乱写,09:00-18:00', at(10, 0)));
  // 写错一行就整段不生效，是用户手写配置时最难排查的一类失败 —— 断言钉住
  ok('起始分钟 > 1439 的行被忽略', !inMuteRange('25:00-08:00', at(23, 0)));
  ok('逗号分隔多段', inMuteRange('12:00-13:00,22:00-08:00', at(12, 30)));
}

console.log('=== N4: 项目名（只取 cwd 最后一段，不带全路径）===');
{
  eq('取最后一段', projectOf(session('s', 'C:\\Users\\me\\proj-x')), 'proj-x');
  eq('POSIX 路径同样', projectOf(session('s', '/home/me/proj-y')), 'proj-y');
  eq('尾斜杠被过滤', projectOf(session('s', '/home/me/proj-z/')), 'proj-z');
  eq('无 cwd 返回空串', projectOf(session('s', '')), '');
  eq('session 为空不抛', projectOf(null), '');
}

console.log('=== N5: 稳定序列化（判定 rev 的唯一依据）===');
{
  eq('键序不影响结果', stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  eq('数组按序', stableStringify([2, 1]), '[2,1]');
  eq('null', stableStringify(null), 'null');
  eq('字符串加引号', stableStringify('x'), '"x"');
}

console.log('=== N6: 队列语义（合并 / 排序 / 上限 / TTL / ack）===');
{
  let nowMs = 1_000_000;
  const clock = () => new Date(nowMs);
  const cfg = {
    nudgeEnabled: true, nudgeMergeWindowMs: 1200, nudgeMaxItems: 4,
    nudgeTtlMinutes: 30, nudgeMuteRanges: '',
    nudgeOnCompleted: true, nudgeOnFailed: true, nudgeOnChoice: true,
    nudgeAlertOnToolError: true,
  };
  const c = new NudgeCenter(cfg, { now: clock });

  c.push('completed', { sessionId: 's1', title: 'A', detail: '回合已完成' });
  c.push('failed', { sessionId: 's1', title: 'A', detail: '回合异常' });
  eq('不同类别不合并', c.list().length, 2);
  eq('最严重的排在前面（needs_choice=0 < failed=1 < completed=2）',
    c.list()[0].kind, 'failed');

  nowMs += 500;
  const before = c.list().length;
  c.push('failed', { sessionId: 's1', title: 'A', detail: '另一个失败' });
  eq('窗口内同类别同会话只加计数', c.list().length, before);
  const failedItem = c.list().find((i) => i.kind === 'failed');
  eq('计数累加到 2', failedItem.count, 2);
  eq('明细被后到的那条覆盖（更接近现场）', failedItem.detail, '另一个失败');

  nowMs += 5000;
  c.push('failed', { sessionId: 's1', title: 'A', detail: '窗口外的新失败' });
  eq('超出合并窗口算新条目', c.list().length, before + 1);

  // 上限
  const tight = new NudgeCenter({ ...cfg, nudgeMaxItems: 2 }, { now: clock });
  for (let i = 0; i < 5; i += 1) {
    nowMs += 5000;
    tight.push('completed', { sessionId: `s${i}`, title: `T${i}`, detail: 'done' });
  }
  eq('队列被 nudgeMaxItems 截断', tight.list().length, 2);
  ok('丢的是最旧的（新提醒更贴近用户此刻在等的事）',
    tight.list().every((i) => i.sessionId !== 's0'), tight.list().map((i) => i.sessionId).join(','));

  // TTL
  const ttl = new NudgeCenter({ ...cfg, nudgeTtlMinutes: 1, nudgeMaxItems: 8, nudgeMergeWindowMs: 0 }, { now: clock });
  ttl.push('completed', { sessionId: 'old', title: 'O', detail: 'old' });
  nowMs += 61_000;
  eq('超过 TTL 被清掉', ttl.list().length, 0);

  // rev
  const r1 = c.rev();
  eq('内容不变 rev 不变', c.rev(), r1);
  c.push('completed', { sessionId: 's9', title: 'B', detail: 'x' });
  ok('内容一变 rev 就变', c.rev() !== r1, c.rev());

  // ack
  const target = c.list()[0].id;
  eq('ack 移除一条', c.ack([target]), 1);
  ok('该条已不在队列', !c.list().some((i) => i.id === target));
  const remainingBefore = c.list().length;
  eq('ack 不存在的 id 报 0', c.ack(['no-such']), 0);
  eq('ack 之后剩多少不变', c.list().length, remainingBefore);
  eq('ackAll 清空', c.ackAll(), remainingBefore);
  eq('ackAll 后队列空', c.list().length, 0);
}

console.log('=== N7: 开关（总开关 / 三类 / 静音 / 工具失败）===');
{
  let nowMs = 1_000_000;
  const clock = () => new Date(nowMs);
  const base = { nudgeEnabled: true, nudgeMergeWindowMs: 0, nudgeMaxItems: 8, nudgeTtlMinutes: 30, nudgeMuteRanges: '', nudgeOnCompleted: true, nudgeOnFailed: true, nudgeOnChoice: true, nudgeAlertOnToolError: true };

  const off = new NudgeCenter({ ...base, nudgeEnabled: false }, { now: clock });
  eq('总开关关掉后不接受', off.push('completed', { sessionId: 's', title: 't' }), null);

  const noDone = new NudgeCenter({ ...base, nudgeOnCompleted: false }, { now: clock });
  eq('completed 关掉后不接受', noDone.push('completed', { sessionId: 's', title: 't' }), null);
  ok('failed 仍然接受', noDone.push('failed', { sessionId: 's', title: 't' }) !== null);

  const muted = new NudgeCenter({ ...base, nudgeMuteRanges: '22:00-08:00' }, { now: () => new Date(2026, 0, 1, 23, 0) });
  eq('静音时段内不接受', muted.push('completed', { sessionId: 's', title: 't' }), null);

  const unknown = new NudgeCenter(base, { now: clock });
  eq('未知类别直接丢弃', unknown.push('whatever', { sessionId: 's', title: 't' }), null);
}

console.log('=== N8: 事件采集（turn/end 的五种 kind）===');
{
  let nowMs = 1_000_000;
  const clock = () => new Date(nowMs);
  const cfg = { nudgeEnabled: true, nudgeMergeWindowMs: 0, nudgeMaxItems: 8, nudgeTtlMinutes: 30, nudgeMuteRanges: '', nudgeOnCompleted: true, nudgeOnFailed: true, nudgeOnChoice: true, nudgeAlertOnToolError: true };
  const center = new NudgeCenter(cfg, { now: clock });
  const ctx = mockCtx();
  const handle = attachNudges(ctx, cfg, { log: () => {}, now: clock, center });
  const emit = (type, data, sess = session('session-1')) => ctx.__emit('session/event', sess, { type, data });

  emit('turn/end', { reason: { kind: 'completed' } });
  eq('completed → 完成类', center.list()[0].kind, 'completed');
  eq('完成类明细', center.list()[0].detail, '回合已完成');

  center.ackAll(); nowMs += 5000;
  emit('turn/end', { reason: { kind: 'max-tokens' } });
  eq('max-tokens 也算完成（但要写清被截断）', center.list()[0].detail, '输出被长度上限截断');

  center.ackAll(); nowMs += 5000;
  emit('turn/end', { reason: { kind: 'error', error: { message: 'boom' } } });
  eq('error → 失败类', center.list()[0].kind, 'failed');
  eq('error 明细取 message', center.list()[0].detail, 'boom');

  center.ackAll(); nowMs += 5000;
  emit('turn/end', { reason: { kind: 'blocked' } });
  eq('blocked 不算完成，按失败更接近事实', center.list()[0].kind, 'failed');
  eq('blocked 明细', center.list()[0].detail, '回合被策略拦截');

  center.ackAll(); nowMs += 5000;
  emit('turn/end', { reason: { kind: 'aborted' } });
  eq('aborted（用户自己按了停止）不提醒', center.list().length, 0);

  // 子代理过滤
  center.ackAll(); nowMs += 5000;
  const sub = { header: { id: 'child', cwd: '/p', parentSession: 'parent' } };
  ctx.__emit('session/event', sub, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  eq('有 parentSession 的子代理不提醒', center.list().length, 0);
  const deep = { header: { id: 'child2', cwd: '/p', delegationDepth: 2 } };
  ctx.__emit('session/event', deep, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  eq('delegationDepth > 0 也不提醒', center.list().length, 0);

  handle.dispose();
}

console.log('=== N9: 事件采集（工具失败的双判据 + callId 去重）===');
{
  let nowMs = 1_000_000;
  const clock = () => new Date(nowMs);
  const cfg = { nudgeEnabled: true, nudgeMergeWindowMs: 0, nudgeMaxItems: 8, nudgeTtlMinutes: 30, nudgeMuteRanges: '', nudgeOnCompleted: true, nudgeOnFailed: true, nudgeOnChoice: true, nudgeAlertOnToolError: true };
  const center = new NudgeCenter(cfg, { now: clock });
  const ctx = mockCtx();
  attachNudges(ctx, cfg, { log: () => {}, now: clock, center });
  const emit = (data) => ctx.__emit('session/event', session('s1'), { type: 'tool/result', data });

  emit({ message: { isError: true, source: { callId: 'c1' }, content: [{ type: 'text', text: 'Error: nope' }] } });
  eq('isError 判据命中', center.list().length, 1);
  eq('明细走正文', center.list()[0].detail, '工具调用失败：nope');
  nowMs += 100;

  emit({ message: { isError: true, source: { callId: 'c1' }, content: [{ type: 'text', text: 'Error: nope' }] } });
  eq('同一 callId 只记一次', center.list().length, 1);

  nowMs += 100;
  emit({ message: { source: { callId: 'c2' } }, error: { code: 'E_BOOM' } });
  eq('只有 data.error 也算失败（否则普通工具失败全漏）', center.list().length, 2);

  nowMs += 100;
  emit({ message: { isError: true, source: { callId: 'c3' } } });
  eq('没正文时兜底 unknown 但仍记录', center.list().length, 3);

  // 关掉工具失败
  const cfgOff = { ...cfg, nudgeAlertOnToolError: false };
  const centerOff = new NudgeCenter(cfgOff, { now: clock });
  const ctxOff = mockCtx();
  attachNudges(ctxOff, cfgOff, { log: () => {}, now: clock, center: centerOff });
  ctxOff.__emit('session/event', session('s1'), { type: 'tool/result', data: { message: { isError: true, source: { callId: 'c4' } } } });
  eq('nudgeAlertOnToolError=false 时不记工具失败', centerOff.list().length, 0);

  // 成功的结果不该记
  const centerOk = new NudgeCenter(cfg, { now: clock });
  const ctxOk = mockCtx();
  attachNudges(ctxOk, cfg, { log: () => {}, now: clock, center: centerOk });
  ctxOk.__emit('session/event', session('s1'), { type: 'tool/result', data: { message: { source: { callId: 'c5' }, content: [{ type: 'text', text: 'ok' }] } } });
  eq('成功的工具结果不记', centerOk.list().length, 0);
}

console.log('=== N10: 审批与提问（必须放行、必须还原）===');
{
  let nowMs = 1_000_000;
  const clock = () => new Date(nowMs);
  const cfg = { nudgeEnabled: true, nudgeMergeWindowMs: 0, nudgeMaxItems: 8, nudgeTtlMinutes: 30, nudgeMuteRanges: '', nudgeOnCompleted: true, nudgeOnFailed: true, nudgeOnChoice: true, nudgeAlertOnToolError: true };

  const center = new NudgeCenter(cfg, { now: clock });
  const ctx = mockCtx();
  let nextCalled = 0;
  attachNudges(ctx, cfg, { log: () => {}, now: clock, center });

  // approval/request 是 waterfall：观察者必须返回 next() 的结果
  const handler = ctx.__handlers.get('approval/request')[0];
  const ret = handler({ agent: { id: 's1', session: session('s1') }, displayReason: '要跑 rm' }, () => { nextCalled += 1; return 'ok'; });
  eq('审批观察者返回 next() 的结果（放行）', ret, 'ok');
  ok('next 被调用', nextCalled >= 1);
  const pushed = center.list().filter((i) => i.kind === 'needs_choice');
  eq('审批产生待选择提醒', pushed.length, 1);
  eq('明细取 displayReason', pushed[0].detail, '要跑 rm');

  // next 缺失时不能抛（直接 next() 会 TypeError，等于把审批砸在这个插件手里）
  const ret2 = handler({ agent: { id: 's2', session: session('s2') }, toolName: 'bash' }, undefined);
  eq('next 缺失时返回 undefined 而不抛', ret2, undefined);

  // 提问包装：原样转发 + 卸载还原
  const original = ctx.__services.get('userQuestions').ask;
  const qHandler = ctx.__services.get('userQuestions');
  const beforeAsk = center.list().filter((i) => i.kind === 'needs_choice').length;
  const realResult = await qHandler.ask({ agent: { id: 's3', session: session('s3') }, questions: [{ header: '选哪个' }] });
  eq('包装后仍返回原方法结果', realResult.ok, true);
  eq('提问新增一条待选择', center.list().filter((i) => i.kind === 'needs_choice').length, beforeAsk + 1);
  const last = center.list().find((i) => i.sessionId === 's3');
  eq('明细取 header', last.detail, '选哪个');
  eq('包装打了幂等标记', qHandler.__nudgePatched, true);

  // 卸载：必须还原成原函数（不是 bind 副本），否则下一个包装者无法干净卸掉
  const effects = ctx.__state.effects[0]();
  eq('卸载后 ask 还原', qHandler.ask, original);
}

console.log('');
console.log('============================================');
console.log(`通过 ${pass} / 失败 ${fail}`);
console.log('============================================');
globalThis.__results = globalThis.__results || {};
globalThis.__results.nudge = { pass, fail };
if (fail > 0) {
  console.log('');
  console.log('失败项：');
  for (const f of failures) console.log('  ❌ ' + f);
  process.exit(1);
}
