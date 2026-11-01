'use strict';
/**
 * 提醒（nudge）数据层 —— Windows 版。
 *
 * 三种「该你处理了」的时刻（完成 / 待选择 / 失败）原本由上游 dsh-nudge 弹一张
 * 一次性 WPF 卡；融合后改由常驻岛体承载。字段与接口形状写在
 * `docs/nudge-fusion.md` §1.3 / §2.1，**两侧不得各自发明**。
 *
 * ## 为什么单独一个模块，而不是塞进 main.js
 *
 * 这和 `snapshot.js` 同一条理由：这个文件是纯的、可以用 `node` 直接断言。
 * 这里的每一条纪律（插件名核对、非法条目丢弃、超时静默降级、detail 截断）
 * 违反时**都不会报错**：认错服务会把别人的 JSON 画成提醒，细节超长会把岛
 * 撑歪，异常则会让 2 秒一次的探桥循环里多一条红字。只能靠测试钉住。
 *
 * ## 为什么复用 bridge.js 的端口发现
 *
 * 提醒与跳转走的是**同一个桥**（`lib/index.js` 一个 HTTP 服务）。端口来自
 * `bridge.json`，还用兜底 47311，还有 mtime-大小缓存 —— 这套逻辑已经在
 * `bridgePort()` 里处理过一次。再写一份必然在某个分支上分叉（那正是
 * 「跳转能通、提醒拿不到」这类最难查的故障的成因）。
 *
 * @module nudges
 */

const http = require('node:http');
const bridge = require('./bridge.js');

/**
 * 回环上的服务自证名。`/health`、`/jump`、`/nudges` 都会回显它，用来确认
 * 「这个端口的服务真是本插件」—— 47311 附近可能有别的服务，把它的 200
 * 当成提醒就会把别人的 JSON 画到岛上。
 */
const PLUGIN_NAME = 'dsh-vibe-island';

/** 超时上限：本机回环正常是毫秒级，超过就说明桥不在（契约 §2.1 要求 ≤1200ms）。 */
const DEFAULT_TIMEOUT_MS = 1200;

/** 只认这三种类别（服务端 `lib/nudge.js` 的 KINDS 同值）。 */
const KINDS = ['needs_choice', 'failed', 'completed'];

/** 类别 → 严重度（越小越该先处理）。服务端不带 severity 时按它推。 */
const SEVERITY = { needs_choice: 0, failed: 1, completed: 2 };

/**
 * 明细行的字符上限（契约 §2.1：主进程截断到 ≤120 字）。
 *
 * 服务端按 140 字截断（它不知道岛上一行放得下多少），app 侧再按**自己的**
 * 版面收一次 —— 超过这个长度在 436px 宽的 HUD 里会被 ellipsis 再切一刀，
 * 而「切一刀」发生在有意义的词中间，读起来像乱码。
 */
const DETAIL_LIMIT = 120;

/** 降级返回值。失败一律给这个形状，调用方不需要判空（契约 §2.1：不得抛）。 */
function degraded(reason) {
  return { ok: false, rev: '', items: [], reason };
}

/** 非负整数，缺省 0。服务端给的 count/removed/remaining 都该是这个域。 */
function nonNegInt(v) {
  return (typeof v === 'number' && Number.isFinite(v) && v > 0) ? Math.trunc(v) : 0;
}

/** 压成单行：空白合并 + 去首尾。提醒文本可能带换行与堆栈尾巴。 */
function oneLine(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/gu, ' ').trim();
}

/**
 * detail 截断到 DETAIL_LIMIT 字（含省略号）。
 *
 * 省略号算在限额里：断言「≤120 字」时若省略号额外算一个字符，就会永远
 * 差一位 —— 这类边界在测试里放过一次，界面上就是每行多一个字符的溢出。
 */
function clipDetail(value) {
  const s = oneLine(value);
  if (s.length <= DETAIL_LIMIT) return s;
  return s.slice(0, DETAIL_LIMIT - 1) + '…';
}

/** `HH:MM`；拿不到合法时间就给空串（渲染层按「没时间」处理）。 */
function clockText(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return hh + ':' + mm;
}

/**
 * 校验并归一化一条提醒。
 *
 * 服务端是我们自己写的，但**仍然逐字段校验**：桥是 HTTP 端点，任何进程都能
 * 往上打；而渲染层没有能力判断「这条 kind 是不是真的」。这里丢掉非法条目
 * 比把它画歪再排查便宜得多。
 *
 * @param {unknown} raw 服务端 /nudges 的 items[i]
 * @returns {object|null} 归一化条目；id / kind 不合法时返回 null（丢弃该条）
 */
function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;

  // id 是 ack 的唯一凭据：空串或非字符串一律丢，否则会出现「点不掉的行」。
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;

  const kind = typeof raw.kind === 'string' ? raw.kind.trim() : '';
  if (!KINDS.includes(kind)) return null;

  const sev = raw.severity;
  const severity = (typeof sev === 'number' && Number.isFinite(sev) && sev >= 0 && sev <= 2)
    ? Math.trunc(sev)
    : SEVERITY[kind];

  const atMs = (typeof raw.atMs === 'number' && Number.isFinite(raw.atMs) && raw.atMs > 0)
    ? raw.atMs
    : ((typeof raw.ts === 'number' && Number.isFinite(raw.ts) && raw.ts > 0) ? raw.ts : 0);

  return {
    id,
    kind,
    severity,
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId.trim() : '',
    title: typeof raw.title === 'string' ? raw.title.trim() : '',
    project: typeof raw.project === 'string' ? raw.project.trim() : '',
    detail: clipDetail(raw.detail),
    // 服务端已经算好 HH:MM；它漏了就从时间戳补，不与服务端的格式分叉。
    at: typeof raw.at === 'string' && raw.at.trim() ? raw.at.trim() : clockText(atMs),
    atMs,
    count: Math.max(1, nonNegInt(raw.count)),
    ts: atMs,
  };
}

/** 批量校验。非数组一律当「没有条目」，绝不让它冒泡成异常。 */
function normalizeItems(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    const item = normalizeItem(raw);
    if (item) out.push(item);
  }
  return out;
}

/**
 * 投一次 JSON 请求。
 *
 * @param {string} pathname
 * @param {'GET'|'POST'} method
 * @param {object|undefined} body 有则序列化并带 Content-Type / Content-Length
 * @param {{ timeoutMs?: number, httpImpl?: any }} opts httpImpl 是自检用的注入点
 * @returns {Promise<{status: number, obj: any, port: number, reason: string}>}
 *          status 0 = 没连上（reason 说明是超时还是连接被拒）
 */
function requestJson(pathname, method, body, opts) {
  const timeoutMs = (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0)
    ? opts.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const H = opts.httpImpl || http;
  const port = bridge.bridgePort();
  const payload = body === undefined ? null : JSON.stringify(body);

  const headers = { Accept: 'application/json' };
  if (payload !== null) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }

  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    let req;
    try {
      req = H.request({
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers,
        timeout: timeoutMs,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); });
        res.on('end', () => {
          let obj = null;
          try { obj = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { obj = null; }
          // reason 的优先级是「先分层再分因」：HTTP 层失败（非 200）先说
          // http，再谈响应体写坏。反过来记的话，一个 502 网关返回的 HTML
          // 页面会被标成「json 解析失败」，排查方向直接跑偏。
          const reason = res.statusCode !== 200 ? 'http' : (obj ? '' : 'json');
          done({ status: res.statusCode, obj, port, reason });
        });
      });
    } catch {
      // 端口/参数本身就非法（比如 bridge.json 被写坏成 0）：当作桥不在。
      return done({ status: 0, obj: null, port, reason: 'network' });
    }

    req.on('error', () => done({ status: 0, obj: null, port, reason: 'network' }));
    req.on('timeout', () => { try { req.destroy(); } catch { /* 已销毁 */ } done({ status: 0, obj: null, port, reason: 'timeout' }); });
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** 响应里的 plugin 字段是不是本插件（与 bridge.js 的判定同一条）。 */
function pluginMatches(obj) {
  const plugin = (obj && typeof obj.plugin === 'string') ? obj.plugin : '';
  return plugin.includes(PLUGIN_NAME);
}

/**
 * 拉一次提醒列表。
 *
 * 任何失败（桥不在 / 超时 / 非 200 / 不是本插件 / JSON 写坏）都返回
 * `{ ok:false, rev:'', items:[] }` —— 契约 §2.1 要求**静默降级、不得抛**：
 * 提醒是增强，桥没起的时候岛必须照常显示会话。
 *
 * `reason` 是给日志用的诊断字段（不进快照、不参与渲染）：主进程要靠它做
 * 「同一个错误只记一次」的降频，否则每 2 秒一条 warn 会把日志刷爆。
 *
 * @param {{ timeoutMs?: number, httpImpl?: any }} [opts]
 * @returns {Promise<{ok: boolean, rev: string, items: object[], reason: string}>}
 */
function fetchNudges(opts = {}) {
  return requestJson('/nudges', 'GET', undefined, opts).then((r) => {
    if (!r || r.status !== 200) return degraded(r ? (r.reason || 'http') : 'http');
    if (!pluginMatches(r.obj)) return degraded('plugin');
    if (!r.obj || r.obj.ok !== true) return degraded('not-ok');
    return {
      ok: true,
      rev: typeof r.obj.rev === 'string' ? r.obj.rev : '',
      items: normalizeItems(r.obj.items),
      reason: '',
    };
  }).catch(() => degraded('network'));
}

/**
 * 确认（移除）若干提醒。
 *
 * 与 `/jump` 的差别很重要：`/jump` 是队列 drain 语义（取走就没了），提醒必须
 * 留在服务端等用户处理 —— 所以是 list + 显式 ack，而不是「一拉即消」。
 *
 * 失败同样不抛：界面上「点了没消掉」比「点了报错」好，因为用户会再点一次，
 * 而异常会把整个 IPC 通道打红。
 *
 * @param {string[]} ids 要移除的提醒 id
 * @param {{ timeoutMs?: number, httpImpl?: any }} [opts]
 * @returns {Promise<{ok: boolean, removed: number, remaining: number, reason: string}>}
 */
function ack(ids, opts = {}) {
  const list = Array.isArray(ids)
    ? ids.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
    : [];
  if (!list.length) return Promise.resolve({ ok: false, removed: 0, remaining: 0, reason: 'empty' });

  return requestJson('/nudge/ack', 'POST', { ids: list }, opts).then((r) => {
    if (!r || r.status !== 200) {
      return { ok: false, removed: 0, remaining: 0, reason: r ? (r.reason || 'http') : 'http' };
    }
    if (!pluginMatches(r.obj)) return { ok: false, removed: 0, remaining: 0, reason: 'plugin' };
    if (!r.obj || r.obj.ok !== true) return { ok: false, removed: 0, remaining: 0, reason: 'not-ok' };
    if (!Number.isSafeInteger(r.obj.removed) || r.obj.removed < 0) {
      return { ok: false, removed: 0, remaining: 0, reason: 'invalid-removed' };
    }
    return {
      ok: true,
      removed: r.obj.removed,
      remaining: nonNegInt(r.obj.remaining),
      reason: '',
    };
  }).catch(() => ({ ok: false, removed: 0, remaining: 0, reason: 'network' }));
}

/** A count alone cannot identify which ID was removed from a batch. Ack each
 * generation separately and only remove the matching local ID on confirmation.
 * Callbacks are injected so this policy can be tested without Electron or HTTP.
 */
async function acknowledgeItems(ids, effects) {
  const list = [...new Set(Array.isArray(ids)
    ? ids.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim())
    : [])];
  if (!list.length) return { ok: false, remaining: effects.getItems().length };
  effects.invalidate();
  let ok = true;
  for (const id of list) {
    let result;
    try { result = await effects.ack([id]); } catch { result = { ok: false, reason: 'network' }; }
    if (result && result.ok === true && result.removed === 1) {
      effects.confirmed(id);
      effects.setItems(effects.getItems().filter((item) => item.id !== id));
    } else {
      ok = false;
      effects.retain(id);
      effects.warn((result && result.reason) || 'zero-or-invalid-removed');
    }
  }
  effects.invalidate();
  effects.notify();
  effects.refresh();
  return { ok, remaining: effects.getItems().length };
}

module.exports = {
  acknowledgeItems,
  PLUGIN_NAME,
  DEFAULT_TIMEOUT_MS,
  KINDS,
  SEVERITY,
  DETAIL_LIMIT,
  normalizeItem,
  normalizeItems,
  fetchNudges,
  ack,
};
