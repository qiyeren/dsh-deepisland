'use strict';
/**
 * 会话数据源 —— Windows 版。
 *
 * 移植自 `swift/Sources/DSHNotch/Core/SessionSource.swift`，行为一一对应。
 * 那一侧有详细的中文注释说明「为什么这么设计」，这里只保留决策要点，
 * 需要看完整推导去读 Swift 版。
 *
 * DSH 的目录布局：
 * ```
 * ~/.dsh/sessions/<项目目录名>/<会话目录名>/session.v4.jsonl.zstd
 *     --Users-delinger-Desktop-office--   session-a59ae858-…
 * ```
 *
 * ## 与 macOS 版的关键差异：zstd
 *
 * macOS 版要**自带 zstdlite 二进制**（系统与 DSH 运行时都不提供 libzstd），
 * Windows 版不需要 —— Node 22+ 的 `zlib.zstdDecompressSync` 内置 zstd 解压。
 * 已在宿主自带的 Node 24.18.1 与开发用 Node 22 上各验过真实会话文件。
 *
 * 若运行环境的 Node < 22.15（zstd 落地版本），`decompress()` 会返回 null
 * 并给出明确原因 —— 表现为「读不到会话」，而不是崩。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');

/** 同时监控的会话数上限。超过就只取 mtime 最新的几个。与 Swift 版一致。 */
const MAX_SESSIONS = 6;

/**
 * 「活跃」窗口：最近这个时间内有写入的会话才进候选。
 * 30 分钟足够覆盖「同时开着的几个对话」。
 * 与 Swift 版 `SessionSource.activeWindow` 一致。
 */
const ACTIVE_WINDOW_MS = 30 * 60 * 1000;

/** DSH 根目录（`~/.dsh`）。可用 `DSH_ROOT` 覆盖，测试用。 */
function dshRoot() {
  return process.env.DSH_ROOT
    ? path.resolve(process.env.DSH_ROOT)
    : path.join(os.homedir(), '.dsh');
}

/**
 * 会话文件及其元信息。
 * @typedef {{ id: string, project: string, file: string, mtimeMs: number, size: number, ctimeMs: number, ino: number, dev: number }} SessionFileInfo
 */

/** 按 mtime 倒序返回候选会话文件。 */
function sessionFiles(opts = {}) {
  const maxCount = opts.maxCount ?? MAX_SESSIONS;
  const activeWithin = opts.activeWithin ?? ACTIVE_WINDOW_MS;

  const all = scanAllSessionFiles();
  const cutoff = Date.now() - activeWithin;

  const byRecent = (a, b) => b.mtimeMs - a.mtimeMs;
  const candidates = all.filter((f) => f.mtimeMs >= cutoff).sort(byRecent);
  // 先过滤再限额：子会话再新也不能挤走普通会话。通常凑够 maxCount 就停，
  // 避免为不会显示的旧候选解压头部；特殊 slice 参数保留原有语义。
  const limit = Number.isSafeInteger(maxCount) && maxCount > 0 ? maxCount : Infinity;
  let recent = visibleFiles(candidates, limit);
  // 活跃窗口内没有可显示的会话时，仍退化为全量中最新的一个可显示会话。
  if (recent.length === 0) {
    recent = visibleFiles(all.slice().sort(byRecent), 1);
  }
  return recent.slice(0, maxCount);
}

/** 最新的单个会话文件（单目标场景用）。 */
function latestSessionFile() {
  const f = sessionFiles({ maxCount: 1 });
  return f.length ? f[0].file : null;
}

let cachedScan = null;
let lastScanTime = 0;
const SCAN_CACHE_MS = 800;

/** 递归找出所有 `session.v4.jsonl.zstd`。带 800ms 快速缓存，避免 250ms 高频全盘递归。 */
function scanAllSessionFiles() {
  const now = Date.now();
  if (cachedScan && (now - lastScanTime < SCAN_CACHE_MS)) {
    // 命中短期缓存：仅快速刷新前 3 个活跃文件的 stat，毫秒级返回
    for (let i = 0; i < Math.min(3, cachedScan.length); i++) {
      try {
        const st = fs.statSync(cachedScan[i].file);
        cachedScan[i].mtimeMs = st.mtimeMs;
        cachedScan[i].size = st.size;
        cachedScan[i].ctimeMs = st.ctimeMs;
        cachedScan[i].ino = st.ino;
        cachedScan[i].dev = st.dev;
      } catch {}
    }
    return cachedScan.slice();
  }

  const sessionsDir = path.join(dshRoot(), 'sessions');
  const out = [];
  if (!fs.existsSync(sessionsDir)) {
    cachedScan = out;
    lastScanTime = now;
    return out;
  }

  // 手写递归而不是用 withFileTypes 的迭代器：DSH 的目录层级很浅
  // （sessions/<项目>/<会话>/文件），但项目目录可能很多，
  // 迭代器在深层目录上有踩坑记录，这里只要三层。
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;   // 权限/竞态：跳过这一层，不影响其它
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;         // 跳过隐藏
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (e.name !== 'session.v4.jsonl.zstd') continue;

      let st;
      try { st = fs.statSync(full); } catch { continue; }
      const sessionDir = path.dirname(full);
      out.push({
        id: path.basename(sessionDir),          // = 会话 id
        project: path.basename(path.dirname(sessionDir)),
        file: full,
        mtimeMs: st.mtimeMs,
        size: st.size,
        ctimeMs: st.ctimeMs,
        ino: st.ino,
        dev: st.dev,
      });
    }
  };
  walk(sessionsDir, 0);

  cachedScan = out;
  lastScanTime = now;
  return out;
}

/**
 * 把 DSH 的项目目录名还原成人看得懂的名字（**兜底**用）。
 *
 * `--Users-delinger-Desktop-deepisland--` → `deepisland`
 * 规则：去掉首尾连字符（DSH 用 `--` 包裹路径），再把 `-` 当分隔符取最后一段。
 *
 * 与 Swift 版 `prettyProject` 行为一致（注意它要求末段长度 ≥ 2）。
 */
function prettyProject(raw) {
  const trimmed = String(raw || '').replace(/^-+|-+$/g, '');
  if (!trimmed) return null;
  const parts = trimmed.split('-').filter(Boolean);
  if (parts.length === 0) return null;
  const last = parts[parts.length - 1];
  if (last.length < 2) return null;
  return last;
}

// ────────────────────────────── 读取与解压 ──────────────────────────────

/** mtime+size 缓存：避免每 250ms 重新解压同一个文件。 */
const eventCache = new Map();

/** zstd 帧标准魔数 0xFD2FB528 (小端序 28 b5 2f fd) */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

// 仅缓存已观察的压缩头帧及分类，不缓存会话正文。追加事件改变 mtime/size 时，
// 若第一帧字节不变，仍可复用分类，不必每拍重复解压。
const headerCache = new Map();
// Persistent entries are bounded; overspill uses the current 800ms scan's
// object identities and never evicts the whole cache during a long traversal.
let scanHeaderCache = new WeakMap();
const MAX_HEADER_FRAME_BYTES = 256 * 1024;
const MAX_CACHED_HEADER_BYTES = 4 * 1024;
const MAX_HEADER_CACHE_ENTRIES = 8192;

/** Return the end of the first complete standard zstd frame, null if incomplete, -1 if invalid. */
function firstFrameEnd(data) {
  if (data.length < 5) return null;
  if (!data.subarray(0, 4).equals(ZSTD_MAGIC)) return -1;
  const descriptor = data[4];
  if (descriptor & 0x18) return -1;
  const contentSizeFlag = descriptor >>> 6;
  const singleSegment = (descriptor & 0x20) !== 0;
  const dictionaryFlag = descriptor & 0x03;
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
  let offset = 5 + (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
  if (offset > data.length) return null;
  for (;;) {
    if (data.length - offset < 3) return null;
    const block = data.readUIntLE(offset, 3);
    offset += 3;
    const last = (block & 1) !== 0;
    const type = (block >>> 1) & 3;
    if (type === 3) return -1;
    offset += type === 1 ? 1 : block >>> 3;
    if (offset > data.length) return null;
    if (last) break;
  }
  if (descriptor & 0x04) offset += 4;
  return offset <= data.length ? offset : null;
}

/** Read at most a bounded prefix and return only its first compressed frame. */
function readHeaderFrame(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    let data = Buffer.alloc(0);
    while (data.length < MAX_HEADER_FRAME_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(8192, MAX_HEADER_FRAME_BYTES - data.length));
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) return null;
      data = Buffer.concat([data, chunk.subarray(0, count)]);
      const end = firstFrameEnd(data);
      if (end === -1) return null;
      if (end !== null) return Buffer.from(data.subarray(0, end));
    }
  } catch { /* 不完整、损坏或不可读：不把普通会话误判为子会话 */ }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
  return null;
}

/** Match the session directory encoding used by DSH persistence's encodeSegment. */
function sessionIdSegment(id) {
  if (id === '.') return '~002E';
  if (id === '..') return '~002E~002E';
  return id.replace(/[^A-Za-z0-9._-]/g, (ch) => '~' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'));
}

/** Only affirmative, structurally plausible SessionHeader metadata hides a session. */
function headerIsSubagent(frame, sessionId) {
  if (!frame || typeof zlib.zstdDecompressSync !== 'function') return false;
  try {
    const plain = zlib.zstdDecompressSync(frame, { maxOutputLength: MAX_HEADER_FRAME_BYTES });
    // 当前 DSH 的独立头帧只含一条以换行结尾的 JSONL；其它形态保守保留。
    if (!plain.length || plain.indexOf(0x0a) !== plain.length - 1) return false;
    const h = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain.subarray(0, -1)));
    if (!h || typeof h !== 'object' || Array.isArray(h) || h.type !== 'session'
        || typeof h.id !== 'string' || !h.id || sessionIdSegment(h.id) !== sessionId
        || !Number.isSafeInteger(h.version) || h.version < 1
        || !Number.isSafeInteger(h.createdAt) || h.createdAt < 0 || Object.is(h.createdAt, -0)
        || (h.cwd !== undefined && (typeof h.cwd !== 'string' || !path.isAbsolute(h.cwd)))
        || (h.parentSession !== undefined && typeof h.parentSession !== 'string')
        || (h.agentPreset !== undefined && typeof h.agentPreset !== 'string')
        || (h.isSeeded !== undefined && typeof h.isSeeded !== 'boolean')
        || (h.origin !== undefined && h.origin !== 'subagent')
        || (h.delegationDepth !== undefined
          && (!Number.isSafeInteger(h.delegationDepth) || h.delegationDepth < 0 || Object.is(h.delegationDepth, -0)))) return false;
    return h.origin === 'subagent' || h.delegationDepth > 0;
  } catch { return false; }
}

function isSubagentFile(info) {
  const persistent = headerCache.get(info.file);
  const hit = persistent || scanHeaderCache.get(info);
  const now = Date.now();
  if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size
      && hit.ctimeMs === info.ctimeMs && hit.ino === info.ino && hit.dev === info.dev
      && (hit.hasFrame || now < hit.retryAt)) return hit.isSubagent;
  const frame = readHeaderFrame(info.file);
  const isSubagent = frame && hit && hit.frame && frame.equals(hit.frame)
    ? hit.isSubagent : headerIsSubagent(frame, info.id);
  // A sharing violation or torn prefix may recover without a stat change.
  // Retry unknown prefixes at the scan cadence instead of caching them forever.
  const entry = {
    mtimeMs: info.mtimeMs, size: info.size, ctimeMs: info.ctimeMs, ino: info.ino, dev: info.dev,
    hasFrame: !!frame, frame: frame && frame.length <= MAX_CACHED_HEADER_BYTES ? frame : null,
    isSubagent, retryAt: now + SCAN_CACHE_MS,
  };
  if (persistent || headerCache.size < MAX_HEADER_CACHE_ENTRIES) headerCache.set(info.file, entry);
  else scanHeaderCache.set(info, entry);
  return isSubagent;
}

function visibleFiles(files, limit) {
  const visible = [];
  for (const file of files) {
    if (isSubagentFile(file)) continue;
    visible.push(file);
    if (visible.length >= limit) break;
  }
  return visible;
}

/**
 * 读并解码某个会话文件的事件流。
 * @returns {Array<object>|null} 解码成功的事件数组；读不到/解压失败返回 null
 */
function loadEvents(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;   // 会话刚被删/正在写
  }

  const hit = eventCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.events;

  const raw = decompress(file);
  if (raw === null) return null;

  const events = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch { /* 单行坏掉不该让整份失效 */ }
  }
  eventCache.set(file, { events, mtimeMs: st.mtimeMs, size: st.size });
  return events;
}

/** 读最新会话的事件流。 */
function loadLatestEvents() {
  const f = latestSessionFile();
  return f ? (loadEvents(f) || []) : [];
}

/**
 * zstd 多帧串联流解压。
 * DSH 在会话过程中是按帧追加写入的（multi-frame concatenated zstd stream）。
 * Node 内置的 zlib.zstdDecompressSync 单次只解压第 1 帧，必须切片解压全部帧并合并。
 * @returns {string|null} 解压后的文本；不可用/失败返回 null
 */
function decompress(file) {
  let data;
  try {
    data = fs.readFileSync(file);
  } catch {
    return null;
  }
  // 极小文件直接判空（仅 zstd 帧头）—— 与 Swift 版一致
  if (data.length <= 32) return '';

  // Node 22.15+ / 23.8+ / 24+ 内置 zstd。Electron 自带的 Node 属于这一档。
  if (typeof zlib.zstdDecompressSync !== 'function') {
    return null;
  }

  // 1. 快速单帧探测
  const first = data.indexOf(ZSTD_MAGIC);
  if (first === -1) {
    try {
      return zlib.zstdDecompressSync(data).toString('utf8');
    } catch {
      return null;
    }
  }

  const second = data.indexOf(ZSTD_MAGIC, first + 4);
  if (second === -1) {
    // 只有 1 个标准帧
    try {
      return zlib.zstdDecompressSync(data).toString('utf8');
    } catch {
      return null;
    }
  }

  // 2. 多帧流：定位所有帧魔数并循环解压合并
  const chunks = [];
  const offsets = [];
  let pos = first;
  while (pos !== -1) {
    offsets.push(pos);
    pos = data.indexOf(ZSTD_MAGIC, pos + 4);
  }

  for (let i = 0; i < offsets.length; i++) {
    const start = offsets[i];
    const end = (i + 1 < offsets.length) ? offsets[i + 1] : data.length;
    const slice = data.subarray(start, end);
    try {
      chunks.push(zlib.zstdDecompressSync(slice).toString('utf8'));
    } catch {
      // 容错：写到一半的文件末尾帧可能被截断，跳过不崩溃
    }
  }

  return chunks.length > 0 ? chunks.join('') : null;
}

/** 清空缓存（自检用；正常路径靠 mtime 自动失效）。 */
function invalidate() {
  eventCache.clear();
  headerCache.clear();
  scanHeaderCache = new WeakMap();
  cachedScan = null;
  lastScanTime = 0;
}

module.exports = {
  MAX_SESSIONS,
  ACTIVE_WINDOW_MS,
  dshRoot,
  sessionFiles,
  latestSessionFile,
  scanAllSessionFiles,
  prettyProject,
  loadEvents,
  loadLatestEvents,
  decompress,
  invalidate,
};
