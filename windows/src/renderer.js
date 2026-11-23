'use strict';
/**
 * 渲染进程 —— 岛的界面（v2：骨架只建一次，之后只改文本/属性）。
 *
 * 只做四件事：把主进程推来的快照画出来、把点击翻译成一个 IPC、
 * 驱动展开/收起的弹簧形变、判定「指针在不在岛上」以切换点击穿透。
 * **不读文件、不推断会话状态** —— 五态来自主进程快照。
 *
 * ## v2 为什么重写（2026-10-18 全面优化）
 *
 * 旧版每次快照都 `innerHTML =` 重建整块界面，而快照里的 `now` 每拍都变，
 * 于是 4 次/秒：销毁重建全部节点 → 展开动画被打断、hover 的行被抽走、
 * 每拍还 `offsetHeight` 强制同步布局两次。界面「能看但发涩」的根源不在
 * CSS，而在这里。v2 的纪律：
 *
 * 1. **快照去重**：主进程带 `rev`，相同直接跳过整次渲染（见 main.js）；
 * 2. **增量更新**：节点只建一次，之后 `textContent` / class / 变量按差异写；
 * 3. **零同步布局**：高度用 `ResizeObserver` 量、写 `--island-h`，由 CSS
 *    过渡；渲染热路径里没有 `offsetHeight` / `getBoundingClientRect`；
 * 4. **指针 rAF 节流**：`pointermove` 只记位置 + 脏标记，命中判定合并到
 *    下一帧；矩形缓存，只在尺寸/模式变化后失效。
 *
 * ## 架构：窗口不动，岛在窗口里动
 *
 * 窗口按最大展开态一次开好（main.js 的 MAX_WINDOW），岛顶对齐、水平居中
 * 钉在窗口里。展开/收起只是 `.island` 自己改宽改高（CSS 真弹簧，340ms，
 * 与 Swift `.spring(response:0.34, dampingFraction:0.8)` 同一条曲线）。
 *
 * ## 点击穿透：常态穿透，悬停接管
 *
 * 窗口平时 `setIgnoreMouseEvents(true, {forward:true})`：比岛大一圈的透明
 * 区域不吞下方应用的点击，鼠标移动事件仍被转发进来。渲染层用转发的
 * 位置对岛体**当前**矩形做命中：进岛 → 请主进程临时接管，出岛 → 立刻
 * 恢复穿透。三道防线（本文件两道 + 主进程 500ms 看门狗）保证「永不粘连」。
 */

(function () {
  const $ = (id) => document.getElementById(id);

  /** 悬停驻留（毫秒）：进入等一等（防「划过屏幕顶端」误触），离开宽限一点。 */
  const HOVER_OPEN_MS = 200;
  const HOVER_CLOSE_MS = 350;
  /** 折叠态只上下外扩：窄条更易命中，同时左右的标题栏保留点击穿透。 */
  const HOT_MARGIN_PX = 8;
  /** 展开态已经很大，外扩收到 4px，避免把岛下方应用的可点区算进来。 */
  const HOT_MARGIN_EXPANDED = 4;
  /** 跳转反馈 / 打开设置反馈的驻留时长。 */
  const RESULT_HOLD_MS = 6000;

  const root = document.documentElement;

  const state = {
    snap: null,
    rev: '',
    entries: [],
    primary: null,
    pinned: false,
    expanded: false,
    mode: '',
    /** 指针在岛上的判定结果（决定是否接管鼠标）。 */
    overIsland: false,
    /**
     * 主进程是否已经开始推真实光标位置。
     *
     * 一旦为 true，就**不再相信** document 上的 mousemove/pointermove：
     * 窗口带 `-webkit-app-region: drag` 时 Electron 的 forward 转发会被掐断
     * 或者坐标错位（真机实测：全 no-drag 46 条/带拖拽区 1 条），而主进程推来的
     * 是 `屏幕光标 - 窗口原点`，与岛体矩形同一坐标系，可靠得多。
     * shots.js / perf.js 这类没有主进程的合成场景里它保持 false，仍走原路径。
     */
    cursorFromMain: false,
    pointer: null,
    pointerQueued: false,
    rect: null,
    rectDirty: true,
    interactive: false,
    /** 自定义拖窗状态：{ id, x0, y0, moved } 或 null。 */
    drag: null,
    /** 拖窗结束后短暂抑制 click（否则「拖一下」会顺带钉住/跳转）。 */
    suppressClickUntil: 0,
    hoverOpenTimer: 0,
    hoverCloseTimer: 0,
    jump: null,
    jumpAt: 0,
    jumpTimer: 0,
    dshHint: null,
    dshHintFailed: false,
    dshTimer: 0,
    focusIndex: -1,
    lastScale: null,
    lastGlow: null,
    /** 会话行的节点缓存（增量更新的依据）。 */
    rows: new Map(),
    /**
     * 提醒（融合自 dsh-nudge）。元素形状 = 契约 §2.1 的八字段 DTO。
     *
     * 它是快照的一部分，所以 rev 变化时才更新 —— 提醒条目的增删本身就让
     * 快照 rev 变，不需要渲染层再自己轮询什么。
     */
    nudges: [],
    /** 提醒行的节点缓存（与 rows 同一套增量复用纪律，按 id 复用）。 */
    nudgeRows: new Map(),
    /** One jump/ack sequence at a time per reminder id. */
    nudgeInFlight: new Set(),
    // Local presentation only. Never acknowledge or remove server reminders.
    urgentHandled: new Map(),
    urgentWaitingEpochs: new Map(),
    urgentNextEpoch: 0,
    urgentInFlight: false,
  };

  /* ───────────────────────────── 差异写 DOM 的小工具 ─────────────────────────────
   *
   * 三个 helper 都遵守同一条纪律：**值没变就不碰 DOM**。即使这里少写一次
   * 比较，Chromium 也会因为「写了相同值」触发一次样式失效/重排，4 次/秒
   * 累积起来就是可感知的抖动。读 `textContent`/`getPropertyValue`/`contains`
   * 都不触发布局，所以比较是免费的。
   */

  function setText(node, text) {
    if (!node) return;
    const v = (text === null || text === undefined) ? '' : String(text);
    if (node.textContent !== v) node.textContent = v;
  }

  function setOff(node, off) {
    if (!node) return;
    const has = node.classList.contains('is-off');
    if (has !== !!off) node.classList.toggle('is-off', !!off);
  }

  function setHidden(node, hidden) { setOff(node, hidden); }

  function setClass(node, cls, on) {
    if (!node) return;
    const has = node.classList.contains(cls);
    if (has !== !!on) node.classList.toggle(cls, !!on);
  }

  function setCssVar(node, prop, value) {
    if (!node) return;
    if (node.style.getPropertyValue(prop) === value) return;
    node.style.setProperty(prop, value);
  }

  function setAttr(node, name, value) {
    if (!node) return;
    if (node.getAttribute(name) !== String(value)) node.setAttribute(name, String(value));
  }

  /* ───────────────────────────── 纯函数 ───────────────────────────── */

  const GLOW_IDLE = '#50505A';

  // A state is explicit evidence, never an inference from an action, clock or reminder.
  const STATUS = new Map([
    ['running',     { label: '运行中',   color: '#4E7CFF' }],
    ['waiting',     { label: '待回答',   color: '#FFAA00' }],
    ['done',        { label: '回合完成', color: '#4ADE80' }],
    ['failed',      { label: '失败',     color: '#E74C3C' }],
    ['interrupted', { label: '中断',     color: '#CEACFA' }],
  ]);

  const sessionLabel = entry => entry.label || entry.shortId || entry.id;
  const emptyLabel = () => state.snap?.bridge?.statesOnline === false ? '状态暂不可用' : '暂无会话';

  /** 当前配置（新协议是顶层字段；`raw` 兜住旧快照与 shots.js）。 */
  function config() {
    const c = (state.snap && state.snap.config) || {};
    const raw = (c.raw && typeof c.raw === 'object') ? c.raw : {};
    const pick = (key, fallback) => {
      if (typeof c[key] === 'boolean') return c[key];
      if (typeof raw[key] === 'boolean') return raw[key];
      return fallback;
    };
    return {
      scale: typeof c.scale === 'number' ? c.scale : (typeof raw.scale === 'number' ? raw.scale : 1),
      glowEffect: pick('glowEffect', true),
      expandOnHover: pick('expandOnHover', true),
      notchEnabled: pick('notchEnabled', true),
      jumpEnabled: pick('jumpEnabled', true),
    };
  }

  // 提醒可以使空板可供查看，但本身不强制展开。
  function shouldExpand() {
    if (!state.entries.length && !state.nudges.length) return false;
    if (state.pinned) return true;
    if (state.primary && state.primary.status === 'waiting') return true;
    return config().expandOnHover && state.overIsland;
  }

  /* ───────────────────────────── 快照入口 ───────────────────────────── */

  function onSnapshot(snap) {
    if (!snap || typeof snap !== 'object') return;

    // Same content (including configuration and transport availability), no work.
    if (typeof snap.rev === 'string' && snap.rev && snap.rev === state.rev) return;

    state.snap = snap;

    const cfg = config();
    if (state.lastScale !== cfg.scale) {
      setCssVar(root, '--scale', String(cfg.scale));
      state.lastScale = cfg.scale;
      state.rectDirty = true;
    }

    const online = snap.bridge?.statesOnline !== false;
    const entries = (online && Array.isArray(snap.entries) ? snap.entries : [])
      .filter(e => e && typeof e.id === 'string' && e.id && STATUS.has(e.status));
    // A confirmed waiting → non-waiting transition retires only the choice
    // alerts seen during that waiting episode from this renderer's view.
    // The bridge queue is untouched; newly arrived IDs remain eligible.
    for (const entry of entries) {
      if (entry.status === 'waiting' || !state.urgentWaitingEpochs.has(entry.id)) continue;
      const oldChoices = state.nudges.filter((n) => n && n.sessionId === entry.id && n.kind === 'needs_choice' && n.id);
      if (!oldChoices.length) continue;
      const handled = state.urgentHandled.get(entry.id) || { waitingEpoch: 0, ids: new Set() };
      for (const choice of oldChoices) handled.ids.add(choice.id);
      state.urgentHandled.set(entry.id, handled);
    }
    state.entries = entries;
    // `at` is the start of this state, not its last update. A rename/replay
    // stays in the same episode; an intervening answer may be coalesced by the feed.
    if (online) {
      const waiting = new Set();
      for (const e of entries) {
        if (e.status !== 'waiting') continue;
        waiting.add(e.id);
        const at = Number.isFinite(e.at) && e.at > 0 ? e.at : 0;
        const prior = state.urgentWaitingEpochs.get(e.id);
        if (!prior || (at && prior.at && at !== prior.at)) {
          state.urgentWaitingEpochs.set(e.id, { at, epoch: ++state.urgentNextEpoch });
        } else if (at) prior.at = at;
      }
      for (const id of state.urgentWaitingEpochs.keys()) if (!waiting.has(id)) state.urgentWaitingEpochs.delete(id);
    }
    state.primary = entries.length ? entries[0] : null;
    // 快照里的 nudges 恒是数组（snapshot.js 保证空列表仍是 []），但**渲染层
    // 照样兜一层**：契约要求「字段缺失 ↔ 空数组」不抖动，而兜底是这条
    // 纪律在渲染侧的落点（旧主进程不发这个字段时界面就是「没有提醒」）。
    state.nudges = Array.isArray(snap.nudges) ? snap.nudges : [];
    // Prune local presentation state when the underlying events disappear.
    const currentUrgent = new Map(urgentItems(true).map((item) => [item.id, item]));
    for (const [id, handled] of state.urgentHandled) {
      const current = currentUrgent.get(id);
      if (!current) {
        if (online || !handled.waitingEpoch) state.urgentHandled.delete(id);
        continue;
      }
      if (online && current.waitingEpoch !== handled.waitingEpoch) handled.waitingEpoch = 0;
      for (const nudgeId of handled.ids) if (!current.ids.includes(nudgeId)) handled.ids.delete(nudgeId);
      if (!handled.waitingEpoch && !handled.ids.size) state.urgentHandled.delete(id);
    }

    const glow = STATUS.get(state.primary?.status)?.color || GLOW_IDLE;
    if (state.lastGlow !== glow) {
      setCssVar(root, '--glow', glow);
      state.lastGlow = glow;
    }

    applyJumpSnapshot(snap.jump);
    render();
    // rev 记在渲染成功之后：万一 render 抛错，下一拍还有机会重试，
    // 而不是把「这一版内容」永久标记成已渲染（界面会停在旧数据上）。
    if (typeof snap.rev === 'string') state.rev = snap.rev;
  }

  /**
   * 主进程带下来的跳转结果（用户点了岛上的会话）。同一个 `at` 只记一次，
   * 否则每拍快照都会把 6 秒的反馈重新点亮。
   */
  function applyJumpSnapshot(jump) {
    if (!jump || typeof jump.brief !== 'string' || !jump.brief) return;
    const at = typeof jump.at === 'number' ? jump.at : 0;
    if (at && at === state.jumpAt) return;
    state.jumpAt = at;
    state.jump = { kind: jump.kind, brief: jump.brief };
    clearTimeout(state.jumpTimer);
    state.jumpTimer = setTimeout(() => { state.jump = null; render(); }, RESULT_HOLD_MS);
  }

  /* ───────────────────────────── 渲染 ───────────────────────────── */

  function render() {
    const cfg = config();
    const entries = state.entries;
    const primary = state.primary;
    const expanded = shouldExpand();

    if (state.expanded !== expanded) {
      state.expanded = expanded;
      state.rectDirty = true;
      // 收起后行焦点没有意义，顺手复位
      if (!expanded) state.focusIndex = -1;
    }
    const mode = expanded ? 'hud' : 'compact';
    if (state.mode !== mode) { state.mode = mode; state.rectDirty = true; }

    const island = $('island');
    const status = primary ? primary.status : '';
    setAttr(island, 'data-mode', mode);
    setAttr(island, 'data-expanded', expanded ? '1' : '0');
    setAttr(island, 'data-status', status);
    setAttr(island, 'data-live', primary ? '1' : '0');
    setAttr(island, 'data-glow', cfg.glowEffect ? '1' : '0');
    setAttr(island, 'data-pinned', state.pinned ? '1' : '0');
    const name = primary ? sessionLabel(primary) : emptyLabel();
    const tag = primary ? STATUS.get(status).label : '';
    setAttr(island, 'aria-label', primary ? name + '，' + tag : name);
    setHidden($('c-dot'), !primary);
    renderCompact(name, tag);
    if (expanded || !entries.length) renderRows(entries);
    if (expanded) {
      renderNudges(mainNudges());
      // A completion can outlive its session row. It is content, not an empty HUD.
      const showEmpty = !primary && (!state.nudgeRows.size || state.snap?.bridge?.statesOnline === false);
      setText($('empty'), showEmpty ? name : '');
    }
    renderUrgentIsland();

    updateHint();

    // 模式/尺寸可能变了：命中矩形失效，下一帧重估（不在这里同步读布局）
    state.rectDirty = true;
    queuePointerRecheck();
  }

  /** 类别 → 中文标签。文案与服务端 KIND_LABEL 一致，改一处要同步两处。 */
  function kindLabel(kind) {
    if (kind === 'needs_choice') return '待你选择';
    if (kind === 'failed') return '执行失败';
    return '已完成';
  }

  function renderCompact(name, tag) {
    setText($('c-title-text'), name);
    setAttr($('c-title'), 'title', name);
    setText($('c-chip'), tag);
    setHidden($('c-chip'), !tag);
  }

  /* ───────────── 提醒区块（融合 dsh-nudge 的三种时刻） ─────────────
   *
   * ## 为什么行不参与 ↑/↓ 选行
   *
   * HUD 的键盘导航（↑/↓ 选行、Enter 跳转）是为**会话行**设计的：
   * focusIndex 是 `state.entries` 的下标，Enter 走的是 jumpTo(entry)。
   * 提醒行若要并进去，就得再造一套「焦点指向哪一类」的索引，而两套索引
   * 一旦不一致，用户按 Enter 会跳到反的会话 —— 这个错非常难自查。
   *
   * 所以提醒行只响应点击，不占用会话键盘导航。
   *
   * ## 行结构
   *
   * `.nudge[data-id]` > `.nudge-bar`（类色条）+ `.nudge-label` +
   * `.nudge-detail` + `.nudge-at.mono`（+ `×N`）。字段全部来自 DTO，
   * 渲染层不做任何 fallback（契约 §2.1：label 已在主进程算好 title || shortId）。
   */
  function createNudgeRow(id) {
    const node = document.createElement('div');
    node.className = 'nudge';
    node.setAttribute('data-id', id);
    node.setAttribute('tabindex', '-1');
    const bar = document.createElement('span');
    bar.className = 'nudge-bar';
    const label = document.createElement('span');
    label.className = 'nudge-label';
    const detail = document.createElement('span');
    detail.className = 'nudge-detail';
    const at = document.createElement('span');
    at.className = 'nudge-at mono';
    node.append(bar, label, detail, at);
    return { node, bar, label, detail, at };
  }

  function updateNudgeRow(row, item) {
    const kind = item.kind;
    setAttr(row.node, 'data-kind', kind);
    setAttr(row.node, 'aria-label',
      kindLabel(kind) + '：' + (item.label || '') + (item.sessionId ? '（点击跳转）' : ''));
    setText(row.label, item.label || '');
    setHidden(row.label, !item.label);
    setText(row.detail, item.detail || kindLabel(kind));
    setClass(row.node, 'can-jump', !!item.sessionId);
    // `at` 是服务端算好的 HH:MM（本地时钟口径不同，不能在渲染层重算 ——
    // 重算会把「21:03 收到」显示成「21:05」，那是另一台机器的钟）。
    const atText = item.at || '';
    const count = (typeof item.count === 'number' && item.count > 1) ? ' ×' + item.count : '';
    setText(row.at, atText + count);
    setHidden(row.at, !atText && !count);
  }

  function renderNudges(list) {
    const host = $('nudges');
    // 渲染层**不再截断**：条数上限来自配置（nudgeMaxItems，1..8），已由主进程
    // 按它裁过一次。这里再写一个 4 会与配置打架 —— 用户把它调到 6，界面却只
    // 显示 4 条，而「为什么少了两条」在界面上没有任何线索。
    // Display at most one reminder per identified session, without altering the queue.
    const items = [];
    const positions = new Map();
    for (const item of Array.isArray(list) ? list : []) {
      if (!item || !item.id) continue;
      const sid = typeof item.sessionId === 'string' ? item.sessionId : '';
      if (!sid || !positions.has(sid)) {
        if (sid) positions.set(sid, items.length);
        items.push(item);
      } else {
        const index = positions.get(sid);
        const previous = items[index];
        if (Number.isFinite(item.atMs) && item.atMs > 0 &&
            (!Number.isFinite(previous.atMs) || item.atMs > previous.atMs)) items[index] = item;
      }
    }

    const keep = new Set(items.map((it) => it && it.id).filter(Boolean));
    for (const [id, row] of state.nudgeRows) {
      if (!keep.has(id)) { row.node.remove(); state.nudgeRows.delete(id); }
    }
    items.forEach((item, i) => {
      if (!item || !item.id) return;
      let row = state.nudgeRows.get(item.id);
      if (!row) { row = createNudgeRow(item.id); state.nudgeRows.set(item.id, row); }
      updateNudgeRow(row, item);
      const current = host.children[i];
      if (current !== row.node) host.insertBefore(row.node, current || null);
    });
  }

  // Keep non-navigable urgent reminders visible rather than silently hiding them.
  function mainNudges() {
    return state.nudges.filter((n) => n && (!n.sessionId || (n.kind !== 'needs_choice' && n.kind !== 'failed')));
  }

  // Count distinct sessions; live waiting state wins over a failed event.
  // A click navigates only: this independent view never acknowledges a reminder.
  function urgentItems(includeHandled = false) {
    const bySession = new Map();
    for (const e of state.entries) {
      if (e && e.id && e.status === 'waiting') bySession.set(e.id, { id: e.id, label: e.label || e.shortId || '会话', kind: 'choice', waiting: true, waitingEpoch: state.urgentWaitingEpochs.get(e.id)?.epoch, ids: [], choices: [] });
    }
    for (const n of state.nudges) {
      if (!n || !n.sessionId || (n.kind !== 'needs_choice' && n.kind !== 'failed')) continue;
      // A settled question remains in the server queue but no longer creates
      // an urgent island. Do not suppress a separately observed live wait.
      if (n.kind === 'needs_choice' && n.resolved === true) continue;
      let item = bySession.get(n.sessionId);
      if (!item) {
        item = { id: n.sessionId, label: n.label || '会话', kind: 'failed', waiting: false, ids: [], choices: [] };
        bySession.set(n.sessionId, item);
      }
      if (n.kind === 'needs_choice') item.kind = 'choice';
      if (n.id) {
        item.ids.push(n.id);
        if (n.kind === 'needs_choice') item.choices.push(n.id);
      }
    }
    return [...bySession.values()].filter((item) => {
      const handled = state.urgentHandled.get(item.id);
      if (includeHandled || !handled) return true;
      const waiting = item.waiting && item.waitingEpoch !== handled.waitingEpoch;
      const choice = item.choices.some((id) => !handled.ids.has(id));
      const visible = waiting || item.ids.some((id) => !handled.ids.has(id));
      if (visible) item.kind = waiting || choice ? 'choice' : 'failed';
      return visible;
    }).sort((a, b) => (a.kind === 'choice' ? 0 : 1) - (b.kind === 'choice' ? 0 : 1));
  }

  function renderUrgentIsland() {
    const node = $('urgent-island');
    if (!node) return;
    const items = urgentItems();
    const first = items[0];
    setHidden(node, !first);
    if (!first) return;
    setAttr(node, 'data-kind', first.kind);
    setText($('urgent-kind'), first.kind === 'choice' ? '等待处理' : '执行失败');
    setText($('urgent-label'), first.label);
    setText($('urgent-more'), items.length > 1 ? '+' + (items.length - 1) : '');
    setAttr($('urgent-jump'), 'aria-label', '跳转到' + first.label);
  }

  /** `bridged` means enqueued, not that the client actually navigated. */
  async function handleNudgeClick(item) {
    if (!item || !item.id || !item.sessionId || state.nudgeInFlight.has(item.id)) return;
    const id = item.sessionId || '';
    state.nudgeInFlight.add(item.id);
    try {
      const result = await window.island.jump({ id, label: item.label || '', nudgeId: item.id });
      if (!result || result.kind !== 'bridged') return;
      // Fail closed if main could not capture a trusted displayed generation.
      if (result.nudgeCaptured !== true) {
        state.dshHint = '提醒已变化，请刷新后重试';
        state.dshHintFailed = true;
        clearTimeout(state.dshTimer);
        state.dshTimer = setTimeout(() => { state.dshHint = null; render(); }, RESULT_HOLD_MS);
        updateHint();
        return;
      }
      let ack;
      let ackRejected = false;
      try { ack = await window.island.nudgeAck({ ids: [item.id] }); }
      catch { ackRejected = true; }
      if (ack && ack.ok === true) {
        state.nudges = state.nudges.filter((n) => n !== item);
        render();
      } else {
        // Diagnostic categories only: never include IDs, titles, or response text.
        const reason = ack && ack.reason;
        state.dshHint = reason === 'not-found' ? '确认失败：编号不存在，已保留'
          : reason === 'network' || reason === 'timeout' ? '确认失败：连接异常，已保留'
          : reason === 'http' ? '确认失败：接口拒绝，已保留'
          : reason === 'plugin' || reason === 'json' || reason === 'not-ok' || reason === 'invalid-removed'
            ? '确认失败：接口响应异常，已保留'
            : ackRejected ? '提醒确认失败，请刷新后重试' : '提醒确认失败，已保留并刷新';
        state.dshHintFailed = true;
        clearTimeout(state.dshTimer);
        state.dshTimer = setTimeout(() => { state.dshHint = null; render(); }, RESULT_HOLD_MS);
        updateHint();
      }
    } catch { /* No confirmation: retain the reminder. */ }
    finally { state.nudgeInFlight.delete(item.id); }
  }

  /* ───────────── 会话行：按 id 增量复用 ───────────── */

  function createRow(id) {
    const node = document.createElement('div');
    node.className = 'row';
    node.setAttribute('data-id', id);
    node.setAttribute('tabindex', '-1');
    const dot = document.createElement('span');
    dot.className = 'dot';
    const label = document.createElement('span');
    label.className = 'label';
    const tag = document.createElement('span');
    tag.className = 'tag';
    node.append(dot, label, tag);
    return { node, dot, label, tag };
  }

  function updateRow(row, entry, index) {
    const status = STATUS.get(entry.status);
    const name = sessionLabel(entry);
    setCssVar(row.dot, '--dot', status.color);
    setClass(row.node, 'primary-row', index === 0);
    setClass(row.node, 'focused', index === state.focusIndex);
    setAttr(row.node, 'data-status', entry.status);
    setText(row.label, name);
    setText(row.tag, status.label);
    setAttr(row.node, 'aria-label', '跳转到 ' + name + '，' + status.label);
  }

  function renderRows(entries) {
    const host = $('list');
    const wanted = entries.slice(0, 6);
    const keep = new Set(wanted.map((e) => e.id));

    // 先删掉不再展示的（会话结束/被挤出前 6）
    for (const [id, row] of state.rows) {
      if (!keep.has(id)) { row.node.remove(); state.rows.delete(id); }
    }
    // 再按顺序复用/创建；节点已存在时 insertBefore 是移动，不是重建
    wanted.forEach((entry, i) => {
      let row = state.rows.get(entry.id);
      if (!row) { row = createRow(entry.id); state.rows.set(entry.id, row); }
      updateRow(row, entry, i);
      const current = host.children[i];
      if (current !== row.node) host.insertBefore(row.node, current || null);
    });
  }

  /* ───────────── 头部提示区：跳转反馈 > 钉住 > 默认提示 ───────────── */

  function updateHint() {
    const hint = $('h-hint');
    let text = '点会话跳转 · 点空白钉住';
    let kind = '';
    if (state.dshHint && state.dshHintFailed) {
      text = state.dshHint;
      kind = 'failed';
    } else if (state.jump && state.jump.brief) {
      text = state.jump.brief;
      kind = state.jump.kind === 'failed' ? 'failed' : 'ok';
    } else if (state.dshHint) {
      text = state.dshHint;
      kind = 'ok';
    } else if (state.pinned) {
      text = '已钉住 · 点空白取消';
      kind = 'pin';
    }
    setText(hint, text);
    setClass(hint, 'ok', kind === 'ok');
    setClass(hint, 'pin', kind === 'pin');
    setClass(hint, 'failed', kind === 'failed');
  }

  /* ───────────────────────────── 高度：ResizeObserver → CSS 变量 ─────────────────────────────
   *
   * 旧版在每次渲染里 `offsetHeight` → 写 height → 再 `offsetHeight`，3 次
   * 强制同步布局/秒。v2 反过来：让浏览器先把内容布局好（RO 回调），把自然
   * 高度写进 `--island-h`，高度过渡交给 CSS。展开/收起、内容增减、宽度变化
   * 引起换行，全部自动跟上，热路径里一次布局都不强制。
   */

  function observeSize() {
    const body = $('island-body') || document.querySelector('.island-body');
    const island = $('island');
    if (!body || !island) return;
    if (typeof ResizeObserver !== 'function') return;   // 理论到不了，兜底不崩

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // contentRect 是已完成的布局结果，读它不触发回流
        const h = Math.max(1, Math.round(entry.contentRect.height));
        setCssVar(island, '--island-h', h + 'px');
        state.rectDirty = true;
        queuePointerRecheck();
      }
    });
    ro.observe(body);

    // CSS cannot test text overflow directly. Only animate a long, visible title.
    const title = $('c-title'), text = $('c-title-text');
    let available = 0, natural = 0;
    const titleSize = new ResizeObserver(changes => {
      for (const change of changes) {
        if (change.target === title) available = change.contentRect.width;
        else natural = change.contentRect.width;
      }
      setClass(title, 'overflows', available > 0 && natural > available + 1);
    });
    titleSize.observe(title);
    titleSize.observe(text);
  }

  /* ───────────────────────────── 指针命中与穿透 ───────────────────────────── */

  function islandRect() {
    if (state.rect && !state.rectDirty) return state.rect;
    state.rect = $('island').getBoundingClientRect();
    state.rectDirty = false;
    return state.rect;
  }

  function hitIsland(x, y) {
    const r = islandRect();
    const m = state.expanded ? HOT_MARGIN_EXPANDED : HOT_MARGIN_PX;
    // Keep vertical tolerance on the 14px strip, but release the title bar on either side.
    const mx = state.expanded ? m : 0;
    return x >= r.left - mx && x <= r.right + mx && y >= r.top - m && y <= r.bottom + m;
  }

  /** 合并到下一帧：pointermove 可能一秒几百次，命中判定只值每帧一次。 */
  function queuePointerRecheck() {
    if (state.pointerQueued) return;
    state.pointerQueued = true;
    requestAnimationFrame(() => {
      state.pointerQueued = false;
      evaluatePointer();
    });
  }

  function setInteractive(on) {
    if (state.interactive === on) return;
    state.interactive = on;
    window.island.setInteractive(on).catch(() => { /* 主进程已记日志 */ });
  }

  function evaluatePointer() {
    if (!state.pointer) return;
    const over = hitIsland(state.pointer.x, state.pointer.y);
    const child = $('urgent-island');
    let overChild = false;
    if (child && !child.classList.contains('is-off')) {
      const r = child.getBoundingClientRect();
      overChild = state.pointer.x >= r.left && state.pointer.x <= r.right && state.pointer.y >= r.top && state.pointer.y <= r.bottom;
    }
    setInteractive(over || overChild);
    if (over === state.overIsland) return;
    state.overIsland = over;

    clearTimeout(state.hoverOpenTimer);
    clearTimeout(state.hoverCloseTimer);
    if (over) {
      // 进岛：先接管鼠标（行/按钮立即可点），展开等驻留时间走完
      setInteractive(true);
      state.hoverOpenTimer = setTimeout(() => {
        if (state.overIsland) render();
      }, HOVER_OPEN_MS);
    } else {
      // 出岛：宽限一会儿再收起（防手抖），但立刻交还穿透 ——
      // 否则岛外的透明区域会继续吞下方应用的点击
      state.hoverCloseTimer = setTimeout(() => {
        if (!state.overIsland) render();
      }, HOVER_CLOSE_MS);
    }
  }

  function onPointerMove(ev) {
    // 主进程已经在推真实光标 → 忽略 DOM 上的指针事件。
    // 原因见 state.cursorFromMain：带 `-webkit-app-region: drag` 的窗口上，
    // Electron 的 forward 转发会漏/错位，两路混用会让命中判定在水面上下跳。
    if (state.cursorFromMain) return;
    state.pointer = { x: ev.clientX, y: ev.clientY };
    queuePointerRecheck();
  }

  /**
   * 主进程推来的真实光标位置（约 30Hz）。
   *
   * 这是**悬停的主驱动**：窗口带拖拽区时 Electron 的 forwarded mousemove 会断，
   * 靠它才能在整个岛体上稳定触发悬停。`inside:false` = 指针已出窗口。
   */
  function onCursor(pos) {
    state.cursorFromMain = true;
    if (!pos || pos.inside === false) {
      onPointerLeave();
      return;
    }
    state.pointer = { x: pos.x, y: pos.y };
    queuePointerRecheck();
  }

  /** 指针离开窗口 / 主进程看门狗强制收回：复位悬停态，别留下「假常驻」。 */
  function onPointerLeave() {
    state.pointer = null;
    clearTimeout(state.hoverOpenTimer);
    clearTimeout(state.hoverCloseTimer);
    const changed = state.overIsland;
    state.overIsland = false;
    // ⚠️ 必须真的通知主进程收回穿透，不能只改本地 state。
    // 反例：指针从岛上直接滑出窗口（document mouseleave）→ 本地以为已经
    // 出岛，但主进程还停在「接管」态；此时指针在窗口 bleed 的透明区里移动，
    // evaluatePointer 会因为 over === state.overIsland 提前 return，永远补不上
    // 那条 false —— 于是 484×300 窗口里的透明区继续吞桌面点击。看门狗只在
    // 「真实光标已出窗口矩形」时兜底，救不了「已回到窗口内透明区」这一段。
    setInteractive(false);
    if (changed) render();
  }

  /* ───────────────────────────── 交互 ───────────────────────────── */

  function togglePin() {
    state.pinned = !state.pinned;
    render();
  }

  function jumpTo(entry) {
    if (!entry) return;
    window.island.jump({ id: entry.id, label: entry.label })
      .then((r) => {
        state.jump = { kind: r && r.kind, brief: r && r.brief };
        clearTimeout(state.jumpTimer);
        state.jumpTimer = setTimeout(() => { state.jump = null; render(); }, RESULT_HOLD_MS);
        render();
      })
      .catch(() => { /* 主进程已记日志 */ });
  }

  function openDsh() {
    window.island.openDsh().then((r) => {
      // 做不到就说做不到：能不能把 DSH 带起来取决于它自己有没有单实例锁
      state.dshHint = (r && r.ok) ? '已切到 DSH' : 'DSH 设置 → 🏝️ 灵动岛';
      state.dshHintFailed = false;
      render();
      clearTimeout(state.dshTimer);
      state.dshTimer = setTimeout(() => { state.dshHint = null; render(); }, RESULT_HOLD_MS);
    }).catch(() => { /* 主进程已记日志 */ });
  }

  function openContextMenu() {
    if (!window.island.contextMenu) return;
    window.island.contextMenu({ pinned: state.pinned }).catch(() => { /* 主进程已记日志 */ });
  }

  function moveFocus(dir) {
    const rows = state.entries.slice(0, 6);
    if (!rows.length) return;
    if (state.focusIndex < 0) state.focusIndex = dir > 0 ? 0 : rows.length - 1;
    else state.focusIndex = Math.max(0, Math.min(rows.length - 1, state.focusIndex + dir));
    refreshRowFocus();
  }

  function refreshRowFocus() {
    const order = state.entries.slice(0, 6).map((e) => e.id);
    for (const [id, row] of state.rows) {
      setClass(row.node, 'focused', order[state.focusIndex] === id);
    }
  }

  /* ───────────────────────────── 自定义拖窗 ─────────────────────────────
   *
   * 为什么不用 `-webkit-app-region: drag`：真机实测（2026-10-19）发现，窗口一旦
   * 声明拖拽区，Windows 会把岛体里的点击当成**非客户区拖拽**处理 —— 点一下
   * 窗口真的被拖走几个像素，页面收不到 click（钉住/跳转全失效）；同时
   * `forward:true` 的 mousemove 转发也会被掐断（表现为「只有很窄的位置能触发
   * 悬停」）。拖窗能力不能丢，所以改成自己实现：渲染层报指针屏幕坐标，
   * 主进程按位移搬窗口。阈值 4px 用于区分「点击」与「拖窗」。
   */

  const DRAG_THRESHOLD_PX = 4;

  /** 这些区域有自己的点击语义，按下不应启动拖窗。 */
  function isClickControl(target) {
    return !!(target && target.closest && (target.closest('[data-act], .row, .nudge') || target.closest('#urgent-island')));
  }

  function onDragDown(ev) {
    if (ev.button !== 0 || !state.interactive) return;
    if (isClickControl(ev.target)) return;
    state.drag = { id: ev.pointerId, x0: ev.screenX, y0: ev.screenY, moved: false };
    // ⚠️ 不在这里 setPointerCapture：一旦给岛体加了指针捕获，click 事件会被
    // 重定向到捕获元素，页面上的按钮/行就再也收不到 click（真机踩过）。
    // 只有确认「真的在拖」之后才捕获，那时本来就要吞掉 click。
  }

  function onDragMove(ev) {
    const d = state.drag;
    if (!d || ev.pointerId !== d.id) return;
    const dx = ev.screenX - d.x0;
    const dy = ev.screenY - d.y0;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    if (!d.moved) {
      d.moved = true;
      try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch { /* 忽略 */ }
      window.island.dragStart().catch(() => { /* 主进程已记日志 */ });
    }
    window.island.dragMove({ x: ev.screenX, y: ev.screenY }).catch(() => { /* 同上 */ });
  }

  function onDragEnd(ev) {
    const d = state.drag;
    if (!d) return;
    state.drag = null;
    if (d.moved) {
      state.suppressClickUntil = Date.now() + 400;
      window.island.dragEnd().catch(() => { /* 同上 */ });
      try { ev.currentTarget.releasePointerCapture(d.id); } catch { /* 忽略 */ }
    }
  }

  function bindInteractions() {
    const island = $('island');

    // 折叠态：点一下 = 钉住/取消（整条信息带是可点区）
    $('compact').addEventListener('click', () => togglePin());
    // 双击 = 把 DSH 叫到前面（省得去托盘里找）
    $('compact').addEventListener('dblclick', (ev) => { ev.preventDefault(); openDsh(); });

    // 展开态：按区域分派。可点区（会话行/提醒/设置）自己处理，
    // 其余空白 = 钉住/取消 —— 与 Swift 版的「点非对话区 = 钉住」同一分工。
    $('hud').addEventListener('click', (ev) => {
      const target = ev.target;
      if (target.closest('#list .row')) return;            // 行自己处理
      if (target.closest('#nudges .nudge')) return;        // 提醒行自己处理
      if (target.closest('[data-act="settings"]')) { openDsh(); return; }
      togglePin();
    });

    // 行点击（事件委托，行节点复用不重新绑定）
    $('list').addEventListener('click', (ev) => {
      const row = ev.target.closest('.row');
      if (!row) return;
      const id = row.getAttribute('data-id');
      const entry = state.entries.find((x) => x.id === id);
      if (entry) jumpTo(entry);
    });

    // 提醒行点击（同样走事件委托：行按 id 复用，不重复绑定）
    $('nudges').addEventListener('click', (ev) => {
      const row = ev.target.closest('.nudge');
      if (!row) return;
      const id = row.getAttribute('data-id');
      const item = state.nudges.find((x) => x.id === id);
      if (item) handleNudgeClick(item);
    });

    const urgent = $('urgent-island');
    if (urgent) urgent.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const item = urgentItems()[0];
      if (!item || state.urgentInFlight) return;
      state.urgentInFlight = true;
      try {
        const result = await window.island.jump({ id: item.id, label: item.label });
        state.jump = { kind: result && result.kind, brief: result && result.brief };
        clearTimeout(state.jumpTimer);
        state.jumpTimer = setTimeout(() => { state.jump = null; render(); }, RESULT_HOLD_MS);
        if (result && result.kind === 'bridged') {
          markUrgentHandled(item);
        }
        render();
      } catch { /* Preserve the item on failure. */ }
      finally { state.urgentInFlight = false; }
    });

    // Merge with any dismissal made while this jump was in flight. An old
    // completion must not replace the handled IDs or epoch of a newer wait.
    function markUrgentHandled(item) {
      const previous = state.urgentHandled.get(item.id);
      const ids = new Set(previous ? previous.ids : []);
      for (const id of item.ids) ids.add(id);
      state.urgentHandled.set(item.id, { waitingEpoch: Math.max(previous?.waitingEpoch || 0, item.waitingEpoch || 0), ids });
    }

    // Both dismissal gestures affect presentation only, never the server queue.
    function dismissUrgent() {
      const item = urgentItems()[0];
      if (!item) return;
      markUrgentHandled(item);
      render();
    }
    const urgentClose = $('urgent-close');
    if (urgentClose) urgentClose.addEventListener('click', (ev) => {
      ev.stopPropagation();
      dismissUrgent();
    });
    // Preserve the original right-click gesture, including on the close button.
    if (urgent) urgent.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      dismissUrgent();
    });

    // 右键：原生菜单（钉住/隐藏/设置/配置目录/退出）
    island.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      openContextMenu();
    });

    // 键盘：Esc 取消钉住；展开态 ↑/↓ 选行、Enter 跳转
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        state.focusIndex = -1;
        refreshRowFocus();
        if (state.pinned) { state.pinned = false; render(); }
        return;
      }
      if (state.mode !== 'hud' || ev.target.closest?.('button')) return;
      if (ev.key === 'ArrowDown') { moveFocus(1); ev.preventDefault(); }
      else if (ev.key === 'ArrowUp') { moveFocus(-1); ev.preventDefault(); }
      else if (ev.key === 'Enter' && state.focusIndex >= 0) {
        const entry = state.entries[state.focusIndex];
        if (entry) jumpTo(entry);
        ev.preventDefault();
      }
    });

    // 自定义拖窗（替代 app-region: drag）：移动超过阈值才开始拖，拖完抑制 click。
    island.addEventListener('pointerdown', onDragDown);
    island.addEventListener('pointermove', onDragMove);
    island.addEventListener('pointerup', onDragEnd);
    island.addEventListener('pointercancel', onDragEnd);
    // 拖窗结束后的 click 在捕获阶段吞掉，避免「拖一下」顺带钉住/跳转。
    island.addEventListener('click', (ev) => {
      if (Date.now() < state.suppressClickUntil) {
        ev.stopPropagation();
        ev.preventDefault();
      }
    }, true);

    // 指针：只记位置 + 脏标记，判定合并到下一帧。
    // 两路都收的原因不是「保险」：
    //   - 真实鼠标移动两路都会来（pointermove 由 mousemove 合成），rAF 合并后只判一次；
    //   - 窗口 forward:true 转发进来的是 mousemove；
    //   - `DSH_NOTCH_SMOKE` 与 `scripts/shots.js` 用合成的 MouseEvent('mousemove')
    //     驱动悬停（合成事件不会派生 pointermove）—— 只监听 pointermove 的话
    //     「冒烟能展开」这条验证会静默失效，退回 v1 那种「截不到展开态」。
    document.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('mousemove', onPointerMove, { passive: true });

    document.addEventListener('mouseleave', onPointerLeave);
    window.addEventListener('resize', () => { state.rectDirty = true; queuePointerRecheck(); });

    // 尺寸过渡结束：矩形变了，重新判定（指针没动时也要跟上）
    island.addEventListener('transitionend', (ev) => {
      if (ev.target !== island) return;
      if (ev.propertyName !== 'width' && ev.propertyName !== 'height') return;
      state.rectDirty = true;
      queuePointerRecheck();
    });

    // 主进程看门狗收回穿透后通知我们复位
    if (typeof window.island.onPointerLeave === 'function') {
      window.island.onPointerLeave(onPointerLeave);
    }
    // 悬停主驱动：真实光标位置（约 30Hz，位置不变不发）。
    // 没有主进程的合成场景（shots.js / perf.js）不暴露它，自动退回 DOM 事件路径。
    if (typeof window.island.onCursor === 'function') {
      window.island.onCursor(onCursor);
    }
    // 右键菜单里的「钉住/取消钉住」：原生菜单在主进程弹，但 pinned 的唯一
    // 真相源在渲染层（它还要同时管展开/收起、Esc、点主行）。菜单只发一条
    // 「切换」回来，走同一条 togglePin，避免两处各存一份状态在某个分支打架。
    if (typeof window.island.onPinToggle === 'function') {
      window.island.onPinToggle(togglePin);
    }
  }

  /* ───────────────────────────── 启动 ───────────────────────────── */

  bindInteractions();
  observeSize();
  render();                              // 首帧先给「没有活跃会话」，避免白屏
  window.island.onSnapshot(onSnapshot);
})();
