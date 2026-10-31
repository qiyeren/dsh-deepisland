'use strict';
/**
 * Electron 主进程 —— Windows 版灵动岛。
 *
 * ## 架构（macOS 版同款，丝滑的来源）
 *
 * 窗口按**最大展开态**一次开好（MAX_WINDOW），顶端钉在屏幕顶端、水平居中；
 * 展开收起只是岛体在窗口里改宽改高（渲染层 CSS 弹簧）—— 窗口不动，
 * 动画全程 GPU 合成。「逐帧 setBounds 跟随内容」的老路在 DWM 上必然抖：
 * 层化透明窗口的尺寸变化走不了合成器快路径。
 *
 * 窗口平时**鼠标穿透**（setIgnoreMouseEvents(true, {forward:true})），
 * 只有指针进岛时渲染层才调 island:set-interactive 临时接管 —— 比岛大一圈
 * 的透明区域（bleed，给外发光留的）不吞下方应用的点击。
 *
 * ## 为什么是 Electron 而不是手写 Win32
 *
 * 要一个「浮在所有窗口之上、不吃鼠标、半透明、无边框」的小窗，手写 Win32
 * 需要自己搭 `WS_EX_LAYERED` / `WS_EX_TRANSPARENT` / `SetWindowPos(HWND_TOPMOST)`
 * 一整套 —— 工作量远大于 UI 本身，而且「不吃鼠标」和「要能点」这对矛盾需求
 * 得靠 `WM_NCHITTEST` 逐像素判。Electron 一组选项就够（穿透由我们自己在
 * 渲染层做命中切换，等价于 Mac 的 NotchPanel.isInteractive）。
 *
 * ## 几个不能省的选项
 *
 * - `backgroundThrottling: false` —— 窗口不可见/失焦时 Chromium 会把定时器
 *   降频到 1s 甚至暂停，250ms 的轮询直接失效（岛变成「半天不动」）。
 * - `transparent: true` —— 岛是异形的，没有它就只能是个黑方块。
 * - `skipTaskbar: true` —— 它不是普通应用窗口，不该占任务栏位置。
 */

const { app, BrowserWindow, Tray, Menu, shell, clipboard, ipcMain, screen, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// 启动追踪（仅 DSH_NOTCH_TRACE=<文件> 时生效）。
// 打包后的 exe 是 Windows GUI 子系统进程：console.log 一个字都看不到，
// 「为什么打包产物起不来」就只能靠写文件来问。
const TRACE = path.join(
  process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData/Roaming'),
  'DSHNotch',
  'main.log'
);
const trace = (m) => {
  try {
    fs.appendFileSync(TRACE, `[${new Date().toISOString()}] ${m}\n`);
  } catch { /* ignore */ }
};
trace('[trace] main.js 载入 packaged=' + app.isPackaged + ' resourcesPath=' + process.resourcesPath);
process.on('uncaughtException', (e) => { trace('[trace] uncaughtException: ' + (e && (e.stack || e.message))); });
process.on('unhandledRejection', (e) => { trace('[trace] unhandledRejection: ' + (e && (e.stack || e))); });
app.on('will-quit', () => trace('[trace] app will-quit'));
app.on('quit', (e, code) => trace('[trace] app quit code=' + code));
process.on('exit', (code) => trace('[trace] process exit code=' + code));

const config = require('./config.js');
const { SessionMonitor } = require('./monitor.js');
const bridge = require('./bridge.js');
const nudges = require('./nudges.js');
const { performJump } = require('./jump.js');
// 快照协议是纯函数模块（无 electron 依赖），可直接被 node 单测 —— 见 snapshot.js。
const { buildSnapshot, nextDelay } = require('./snapshot.js');

/**
 * 穿透看门狗间隔（契约 §5 第 3 条「穿透永不粘连」）。
 *
 * 渲染层已经有两道防线（pointermove 节流 + mouseleave、transitionend 复算），
 * 但都依赖「事件能进来」。`setIgnoreMouseEvents(true, {forward:true})` 只在
 * 指针位于窗口内时转发 mousemove：一旦指针出窗，渲染层就再也收不到事件，
 * 若最后一条事件恰好把窗口切成了「接管」态，这个状态就**永远**收不回来 ——
 * 表现为岛外一圈透明区域把桌面点击全吞掉，且只能重启 app。所以主进程这条
 * 用真实光标位置兜底，500ms 一次，是唯一不依赖渲染进程的事件源。
 */
const WATCHDOG_MS = 500;

/**
 * 光标轮询间隔 —— **悬停的主驱动**（33ms ≈ 30Hz）。
 *
 * ## 为什么不能只靠 `forward: true`
 *
 * 原方案让渲染层吃 Electron 转发的 mousemove 做命中判定。真机实测（2026-10-19）
 * 发现一个致命限制：**窗口一旦有 `-webkit-app-region: drag` 区域，转发事件就
 * 几乎被掐断** —— 同一位置对比，全部元素改 no-drag 时 500ms 收到 46 条，
 * 带拖拽区时只收到 1 条。表现就是「只有岛上一个很窄的位置能触发展开」，而这
 * 恰好是悬停体验最不能被破坏的地方。
 *
 * 拖拽区不能删（它是唯一的拖窗手段），所以改成主进程自己读真实光标
 * （`screen.getCursorScreenPoint`，微秒级系统调用）按窗口坐标换算后推给渲染层。
 * 渲染层拿到的就是「指针此刻在窗口里的 CSS 坐标」，命中判定和悬停逻辑一行不用
 * 改，也不再依赖任何转发行为。
 */
const CURSOR_POLL_MS = 33;


/** 桥健康探测间隔。桥起没起不需要 250ms 精度；2s 且**变化才刷托盘**。 */
const BRIDGE_PROBE_MS = 2000;

/**
 * 跳转回执在快照里保留多久。
 *
 * 旧实现把 lastJump 永远留着，靠渲染层按 `Date.now() - at < 6000` 自己隐藏；
 * rev 去重后「到点该消失了」这件事没有一拍会触发推送，新 renderer 会一直
 * 显示旧回执。所以主进程到点把它清掉 —— 清掉本身让 rev 变化，正好推一跳。
 */
const JUMP_HOLD_MS = 6000;

/**
 * 固定窗口尺寸：按**最大展开态**一次开好（macOS 版 NotchMetrics 的
 * maxExpandedSize + bleed 同款结论）。
 *
 * 展开收起只是岛体在窗口里改宽改高（CSS 弹簧），窗口一个字节都不动 ——
 * 「逐帧 setBounds」的老路在 DWM 上必然抖（层化透明窗口的尺寸变化
 * 走不了合成器快路径），这是 macOS 丝滑、旧 Windows 版发涩的分水岭。
 *
 * 比最大内容（岛体最宽 436）大一圈的部分是 **bleed**：给外发光留绘制
 * 空间。窗口平时鼠标穿透，多出来的透明区域不吞下方应用的点击。
 */
const MAX_WINDOW = { w: 484, h: 300 };

let win = null;
let tray = null;
let monitor = null;
let tickIndex = 0;
let bridgeState = { ok: false, port: bridge.FALLBACK_PORT, plugin: null };
let lastJump = null;       // { kind, brief, at }
let requestedHidden = false;
let forceShow = false;     // 仅冒烟模式用：无条件显示

// ── 提醒（nudge 融合）状态 ──
/**
 * 当前要送进快照的提醒条目（已按 nudgeMaxItems 截断）。
 *
 * ⚠️ **引用本身就是去重依据**：服务端 rev 没变时这里不换引用，
 * 快照的 rev 因此不会变 —— 这是「同一份提醒不重渲染」的落点，不是巧合。
 */
let nudgeItems = [];
/**
 * 上一次拿到的**服务端** rev。相同就完全跳过（连截断都不做）。
 *
 * 与快照的 rev 是两码事：那个是「整份 DTO 的内容指纹」，这个是「提醒队列
 * 自己的版本号」（服务端按 id+count+ts 算）。拿它做第一道闸，省掉每 2 秒
 * 一次的重建与重渲染。
 */
let nudgeRev = '';
/**
 * 提醒拉取失败时的降噪键（`reason`）。
 *
 * 桥没起的时候这个分支每 2 秒就会被走到一次；每次都 `console.warn` 会让
 * 日志彻底失去可读性。同一个 reason 只记一次，恢复成功时清空 —— 下一次
 * 失败才会重新记，这正是「连续失败不刷屏、但新故障必须看得见」。
 */
let nudgeWarnKey = '';

// ── 快照 / 轮询状态（v2）──
/** 最近一拍组装好的 DTO。窗口显隐判断与冒烟输出都读它，不再解析 JSON 字符串。 */
let lastPayload = null;
/** 上一次真正发出去的 rev。相同就不发 —— 这是「只在真变化时推送」的落点。 */
let lastRev = '';
/**
 * renderer 是否已经 load 完。
 *
 * 在这之前 `webContents.send` 发出去的消息会被丢掉（订阅还没建立）。所以那时
 * **不能**推进 lastRev：否则首帧内容若一直不变，之后就再也不会推 —— 岛白屏。
 */
let rendererLoaded = false;
/** 首帧快照是否已发出。窗口要等它之后才 show，避免先露出一个空窗再「弹出」内容。 */
let firstSnapshotSent = false;
/** 递归 setTimeout 的句柄。用递归而不是 setInterval：每拍间隔由 nextDelay 决定。 */
let loopTimer = null;
/** 穿透看门狗句柄。退出路径必须清掉，否则进程被它多吊着 500ms。 */
let watchdogTimer = null;
/**
 * 渲染层是否正持有「临时接管」（窗口当前不穿透）。
 *
 * 唯一真相源在这里而不是渲染层：看门狗要用它判断「有没有东西可收回」，
 * 而渲染层在指针出窗后已经收不到事件、无法自证。
 */
let interactive = false;
/** 光标轮询句柄（悬停主驱动）。窗口隐藏/退出时必须清掉。 */
let cursorTimer = null;
/** 上一次推给渲染层的光标状态（去重用：位置没变就不发 IPC）。 */
let lastCursorKey = '';
/** 调试追踪：只记「首条成功/首条失败」，避免 30Hz 刷爆日志。 */
let cursorTraceSent = false;
let cursorTraceFailed = false;
/** 上次探桥的时间戳（按时间而不是 tickIndex 计：轮询间隔已不是固定 250ms）。 */
let lastBridgeProbeAt = 0;
/** 退出中：阻止已排队的 tick 再跑一拍。 */
let quitting = false;

// ───────────────────────────── 单实例 ─────────────────────────────

/**
 * 关掉硬件加速，用软件渲染。
 *
 * 岛上只有文字、圆角和一点光晕，没有视频也没有 3D —— GPU 完全用不上。
 * 而 GPU 进程在部分机器上（无显卡驱动、远程桌面、受限沙箱）会**反复崩溃**，
 * 崩够次数后 Chromium 直接 `FATAL: GPU process isn't usable. Goodbye.`
 * 把整个 app 带走。实测在本机受限环境下必现。软件渲染没这个风险，
 * 对这个尺寸的窗口性能也完全够。
 */
app.disableHardwareAcceleration();
// 光关硬件加速还不够：GPU 进程仍会被拉起来，崩够次数后
// `gpu_data_manager_impl_private.cc` 照样 FATAL。直接把 GPU 跑在浏览器进程里，
// 从根上不让它单独起进程。
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-features', 'AcceleratedVideoDecodeLinuxGL');

// 不锁的话，双击第二次会开第二个岛 —— 两个岛叠在一起，谁都不知道该关哪个。
const gotLock = app.requestSingleInstanceLock();
trace('[trace] 单实例锁 = ' + gotLock);
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { showWindow(); }
  });
}

// ───────────────────────────── 窗口 ─────────────────────────────

function assetPath(name) {
  // 打包后 resources/app.asar/src/main.js → __dirname 在 asar 内，assets 同级
  const candidates = [
    path.join(__dirname, '..', 'assets', name),
    path.join(process.resourcesPath || '', 'assets', name),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * 把窗口摆到主显示器顶部中间。尺寸恒为 MAX_WINDOW × scale —— 本函数
 * 只在启动、scale 变化、显示器几何变化时被调用，**不参与展开动画**
 * （那是渲染层在窗口内部的 CSS 弹簧，碰窗口就会抖）。
 *
 * y = workArea.y：窗口顶端与屏幕（工作区）顶端重合，岛体顶端的两个方角
 * 落在屏幕边界上 —— 「从屏幕顶边长出来」的读感由此而来（macOS 版
 * windowOrigin 的同一条纪律：窗口顶端 = 屏幕顶端，不留顶部 bleed）。
 */
function placeWindow(force = false) {
  if (!win || win.isDestroyed()) return;
  const scale = win._scale || 1;
  const ww = Math.round(MAX_WINDOW.w * scale);
  const hh = Math.round(MAX_WINDOW.h * scale);
  const area = screen.getPrimaryDisplay().workArea;
  const x = Math.round(area.x + (area.width - ww) / 2);
  const y = area.y;

  // 容差 2px：DPI 取整会让「设 484 读到 485」，没有容差就会反复重设，
  // 白白触发 DWM 的窗口动画。2px 在这个尺寸上看不出来。
  const TOL = 2;
  const b = win.getBounds();
  if (!force
    && Math.abs(b.width - ww) <= TOL && Math.abs(b.height - hh) <= TOL
    && Math.abs(b.x - x) <= TOL && Math.abs(b.y - y) <= TOL) return;
  if (process.env.DSH_NOTCH_VERBOSE) {
    console.log('[dsh-notch] place ' + b.width + 'x' + b.height + ' → ' + ww + 'x' + hh);
  }
  win.setBounds({ x, y, width: ww, height: hh });
}

function createWindow() {
  const cfg = config.load();

  win = new BrowserWindow({
    width: Math.round(MAX_WINDOW.w * cfg.scale),
    height: Math.round(MAX_WINDOW.h * cfg.scale),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    focusable: true,
    show: false,
    title: 'DSHNotch',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // ⚠️ 不能省：窗口失焦/被遮挡时 Chromium 会把定时器降频，
      // 250ms 轮询会变成「半天不动」。
      backgroundThrottling: false,
    },
  });
  win._scale = cfg.scale;

  // 岛不该参与「显示全部窗口」的窗口切换
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // 穿透为常态：forward 让 mousemove 仍被转发进渲染层（命中判定靠它），
  // 指针进岛时渲染层会调 island:set-interactive 临时接管。
  win.setIgnoreMouseEvents(true, { forward: true });

  win.loadFile(path.join(__dirname, 'index.html'));

  // 任何形式的「打开新窗口」都不允许 —— 岛只有一个窗口
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });

  win.on('closed', () => {
    win = null;
    releasePointer('window-closed');
  });

  // 首帧快照发出之后才允许 show（判断在 applyVisibility 里）：
  // 透明窗口若先露出来，页面还是空的，肉眼看到的是「空一下，再弹出内容」。
  win.once('ready-to-show', () => {
    applyVisibility();
  });

  // 页面就绪 → 立刻把最近一拍补发。
  // 这是「首帧一定到渲染层」的唯一保证：首拍通常比 loadFile 完成更早，
  // 那时 send 出去的消息没有订阅者，会被静默丢掉；而 rev 去重意味着
  // 如果内容一直不变，后面再也不会补发 —— 岛就会白屏到第一次状态变化为止。
  win.webContents.on('did-finish-load', () => {
    rendererLoaded = true;
    if (lastPayload && sendSnapshot(lastPayload)) {
      lastRev = lastPayload.rev;
      firstSnapshotSent = true;
      applyVisibility();
      // 首拍往往发生在 load 之前，那一拍把下一拍排到了 1000ms（当时窗口不可见）；
      // 现在窗口已可见，立刻重排一次，让它进入 250ms 档，而不是先定住一秒。
      poke();
    }
  });

  // 窗口隐藏 / 被拖动 / 显示器变化后，穿透必须复位（见 watchdog 一节）。
  win.on('hide', () => releasePointer('window-hide'));
  win.on('move', () => { if (dragOrigin) return; releasePointer('window-move'); });

  placeWindow();
  // 先不 show —— 等首帧快照到了由 applyVisibility 决定
}

function showWindow() {
  if (!win) return;
  if (win.isVisible()) { win.focus(); return; }
  win.show();
  win.focus();
  // 窗口从隐藏态恢复 → 光标轮询要恢复（悬停主驱动），轮询也要立刻回到 250ms 档。
  startCursorWatch();
  poke();
}

function hideWindow() {
  if (!win) return;
  // 窗口不可见时光标轮询没有意义（也读不到可靠的窗口坐标），先停掉。
  stopCursorWatch();
  if (win.isVisible()) win.hide();
}

// ───────────────────────────── 托盘 ─────────────────────────────

/**
 * 托盘图标。
 *
 * 没有一个可见入口的话，岛会变成一个「关不掉也找不到」的东西 ——
 * 用户只能在任务管理器里杀。所以托盘是这个 app 必须的一部分，不是装饰。
 */
function createTray() {
  const file = assetPath('tray.png');
  let image;
  if (file) {
    image = nativeImage.createFromPath(file);
    image = image.resize({ width: 32, height: 32 });
  }
  if (!image || image.isEmpty()) {
    // 兜底：画一个 32×32 的纯色块，保证托盘一定出现（没有图标时 Electron 会静默不建）
    image = nativeImage.createFromBuffer(makeFallbackPng(32));
  }
  tray = new Tray(image);
  tray.setToolTip('DSHNotch · DSH 灵动岛');
  refreshTrayMenu();
  tray.on('click', () => {
    if (win && win.isVisible()) hideWindow(); else showWindow();
  });
}

/**
 * 把 DSH 窗口带到前台。
 *
 * ## 为什么要这个
 *
 * 岛自己不做设置界面 —— 唯一的设置入口是 DSH 的「设置 → 🏝️ 灵动岛」，
 * 两边共用同一份 `client-config.json`，再画一套只会变成第二个真相源。
 * 于是第一件会绊住用户的事就是：**装完了，设置在哪？**
 *
 * ## 为什么只能做到「尽量」
 *
 * Windows 没有 `NSWorkspace.activate` 那种按 bundle id 激活的能力。
 * Electron 侧能做的只有两件事，且都不保证成功：
 * 1. 自己有没有 DSH 窗口能聚焦（本 app 没有，它只有岛）；
 * 2. 再问一次**单实例锁**——若 DSH 也用了单实例锁，这次调用会把已有实例
 *    带到前台，然后我们立刻退出。
 *
 * 第 2 条依赖 DSH 自己实现了 `requestSingleInstanceLock`，**本仓库无法验证**。
 * 所以返回值会如实说明用了哪条路，界面上也照实提示，而不是假装一定能打开。
 *
 * @returns {Promise<{ ok: boolean, how: string }>}
 */
function bringDshToFront() {
  // 路 1：本进程若还留着别的窗口（正常情况没有）
  for (const w of BrowserWindow.getAllWindows()) {
    if (w === win || w.isDestroyed()) continue;
    try { if (w.isMinimized()) w.restore(); w.show(); w.focus(); return { ok: true, how: 'window' }; }
    catch { /* 试下一条 */ }
  }
  // 路 2：现有实例已经持有单实例锁 —— 再起一个会唤起它
  return { ok: false, how: 'single-instance' };
}

function refreshTrayMenu() {
  if (!tray) return;
  const cfg = config.load();
  const login = app.getLoginItemSettings();
  const menu = Menu.buildFromTemplate([
    {
      label: cfg.notchEnabled ? '隐藏灵动岛' : '显示灵动岛',
      click: () => {
        const v = { ...config.load() };
        v.notchEnabled = !v.notchEnabled;
        config.save(v);
        applyVisibility();
        refreshTrayMenu();
      },
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: !!login.openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
      },
    },
    {
      label: '跳转桥：' + (bridgeState.ok ? '已连上 (' + bridgeState.port + ')' : '未连上')
        // 待处理条数是「点了会话但 DSH 没切过去」的唯一线索。
        // 只显示「已连上」的话，这种情况下界面和正常态完全一样。
        + (bridgeState.ok && bridgeState.pending > 0
          ? ' · ' + bridgeState.pending + ' 条待处理'
          : ''),
      enabled: false,
    },
    {
      label: '打开 DSH 设置（灵动岛面板）',
      click: () => { bringDshToFront(); },
    },
    { type: 'separator' },
    {
      label: '打开配置目录',
      click: () => { shell.openPath(config.appDataDir()); },
    },
    {
      label: '在资源管理器中显示配置文件',
      click: () => { shell.showItemInFolder(config.storePath()); },
    },
    { type: 'separator' },
    { label: '退出', click: () => { app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

// ───────────────────────────── 穿透看门狗 ─────────────────────────────

/**
 * 主进程 → 渲染层的统一发送口。
 *
 * ⚠️ 退出过程中定时器还会再打一拍，而那时渲染帧已经销毁了 —— 直接 send 会抛
 * 「Render frame was disposed」，在退出日志里留一串红字。所有发送必须过这里。
 */
function sendToRenderer(channel, payload) {
  if (!win || win.isDestroyed()) return false;
  const wc = win.webContents;
  if (!wc || wc.isDestroyed()) return false;
  try {
    wc.send(channel, payload);
    return true;
  } catch (e) {
    console.warn('[dsh-notch] 推送失败(' + channel + '):', e && e.message);
    return false;
  }
}

/** 发快照。rev 去重由调用方负责（去重状态在 tick 里，不在发送函数里）。 */
function sendSnapshot(payload) {
  return sendToRenderer('island:snapshot', payload);
}

/**
 * 强制收回穿透，并通知渲染层复位悬停状态。幂等。
 *
 * 触发源：看门狗（指针出窗）、窗口隐藏、窗口被拖动、显示器几何变化、退出。
 * 为什么必须由主进程收回：`forward:true` 只在指针位于窗口内时转发 mousemove，
 * 指针一出窗渲染层就收不到任何事件 —— 若最后一条事件恰好把窗口切成了接管态，
 * 它就**再也解不开**，岛外一圈透明区域会一直吞掉桌面点击，只能重启 app。
 *
 * @param {string} reason 仅用于 trace 排障（'watchdog' / 'window-hide' / ...）
 */
function releasePointer(reason) {
  const was = interactive;
  interactive = false;
  if (win && !win.isDestroyed()) {
    try { win.setIgnoreMouseEvents(true, { forward: true }); } catch { /* 已销毁 */ }
  }
  if (was) {
    // 渲染层收到后把 overIsland / interactiveReq 归零并重渲染 —— 否则岛会保持
    // 「悬停展开 / 钉住」的假象，等到下一次鼠标移动才恢复。
    sendToRenderer('island:pointer-leave');
    trace('[trace] 收回穿透 reason=' + reason);
  }
}

/**
 * 500ms 看门狗（契约 §5「穿透永不粘连」第 3 条）。
 *
 * 只在「已接管」时需要动作：常态穿透下不存在会粘连的状态。命中判定用
 * `screen.getCursorScreenPoint()`（真实光标，DIP 坐标，与 getBounds 同单位）
 * 对窗口矩形 —— 这里**故意**判整窗而不是岛体：只要指针还在窗口内，渲染层就
 * 还能收到转发的 mousemove，它自己的命中判定会把穿透切回去。指针已在窗口外
 * 而 interactive 仍为 true 才是唯一的故障态，也正是这条 watchdog 存在的理由。
 */
function watchdogTick() {
  if (!win || win.isDestroyed()) return;
  if (!interactive) return;                 // 常态穿透：无事可做
  if (!win.isVisible()) { releasePointer('hidden'); return; }
  // ⚠️ 冒烟模式下不判：它的「悬停」是 executeJavaScript 合成的 mousemove
  // （见 startLoop 里的 SMOKE 段），真实光标可能在屏幕任何地方 —— 按真实
  // 光标判定必然误判成「指针已出窗」，把正要截图的展开态收回去。冒烟窗口
  // 只活几秒、随后整个进程退出，不参与粘连防护没有副作用；看门狗本身由
  // 单测与源码断言覆盖。
  if (process.env.DSH_NOTCH_SMOKE === '1') return;
  let p;
  let b;
  try {
    p = screen.getCursorScreenPoint();
    b = win.getBounds();
  } catch {
    return;                                 // 拔显示器之类的瞬态，下一拍再看
  }
  const inside = p.x >= b.x && p.x < b.x + b.width
    && p.y >= b.y && p.y < b.y + b.height;
  if (inside) return;
  releasePointer('watchdog');
}

/**
 * 读真实光标在窗口里的 CSS 坐标（与渲染层坐标系一致）。
 *
 * `screen.getCursorScreenPoint()` 返回 DIP，`win.getBounds()` 也是 DIP —— 两者
 * 相减就是窗口内容坐标。窗口无边框，所以 bounds == 内容区。
 *
 * @returns {{ x: number, y: number, inside: boolean }|null}
 */
function cursorInWindow() {
  if (!win || win.isDestroyed()) return null;
  let p;
  let b;
  try {
    p = screen.getCursorScreenPoint();
    b = win.getBounds();
  } catch {
    return null;                       // 拔显示器 / 窗口销毁中的瞬态
  }
  const x = p.x - b.x;
  const y = p.y - b.y;
  const inside = x >= 0 && y >= 0 && x < b.width && y < b.height;
  return { x, y, inside };
}

/**
 * 光标轮询一拍：把「指针在窗口里的位置」推给渲染层，由它做岛体命中与悬停。
 *
 * 两个职责：
 * 1. 悬停驱动 —— 摆脱 `forward:true` 在拖拽区上的失效（见 CURSOR_POLL_MS 注释）；
 * 2. 快速收回穿透 —— 指针一出窗立刻 releasePointer，比 500ms 看门狗快一个数量级
 *    （出窗那一瞬间若窗口还在「接管」态，岛外透明区会短暂吞掉桌面点击）。
 */
function cursorTick() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  const pos = cursorInWindow();
  if (!pos) return;

  if (!pos.inside) {
    // 出窗：立刻收回穿透（幂等），并只通知渲染层一次。
    if (interactive) releasePointer('cursor-out');
    if (lastCursorKey !== 'out') {
      lastCursorKey = 'out';
      sendToRenderer('island:cursor', { inside: false });
    }
    return;
  }

  // 位置没变就不发 IPC（悬停静止时零开销）；0.5px 粒度足够平滑。
  const x = Math.round(pos.x * 2) / 2;
  const y = Math.round(pos.y * 2) / 2;
  const key = x + ',' + y;
  if (key === lastCursorKey) return;
  lastCursorKey = key;
  const ok = sendToRenderer('island:cursor', { inside: true, x, y });
  if (ok && !cursorTraceSent) {
    cursorTraceSent = true;
    trace('[trace] 首条光标位置已推送 x=' + x + ' y=' + y);
  } else if (!ok && !cursorTraceFailed) {
    cursorTraceFailed = true;
    trace('[trace] 光标位置推送失败（renderer 未就绪？）');
  }
}

/** 启动光标轮询（幂等）。冒烟模式不启动：合成的 hover 与真实光标无关。 */
function startCursorWatch() {
  if (cursorTimer) return;
  if (process.env.DSH_NOTCH_SMOKE === '1') { trace('[trace] 光标轮询跳过（冒烟模式）'); return; }
  lastCursorKey = '';
  cursorTimer = setInterval(cursorTick, CURSOR_POLL_MS);
  trace('[trace] 光标轮询已起 interval=' + CURSOR_POLL_MS + 'ms');
}

/** 停止光标轮询（窗口隐藏 / 退出）。 */
function stopCursorWatch() {
  if (cursorTimer) {
    clearInterval(cursorTimer);
    cursorTimer = null;
    trace('[trace] 光标轮询已停');
  }
  lastCursorKey = '';
}

// ───────────────────────────── 轮询 ─────────────────────────────

/**
 * 提醒队列的一拍拉取（挂在既有 2s 探桥闸门里，**没有自己的定时器**）。
 *
 * ## 两道闸，各自省掉不同的事
 *
 * 1. **服务端 rev 相同** → 整段跳过。省的是「每 2 秒重建一份 items 数组」
 *    以及随之而来的重渲染：`rev` 由 id+count+ts 算，内容没变时它不变，
 *    而截断（nudgeMaxItems）是个纯函数 —— 重算一遍结果必然相同。
 * 2. **快照 rev 相同** → main 的 tick 里本来就不会 send。这条是白拿的，
 *    但前提是「引用真的没换」：所以第 1 条命中时**必须原样保留** nudgeItems，
 *    而不是重新赋一个内容相同的新数组（否则快照 rev 每次都变，2 秒推一跳）。
 *
 * ## 为什么失败只记一次
 *
 * 桥没起的时候这个分支每 2 秒都会被走到。每次都 warn 会让日志彻底失去可读性，
 * 而「日志里什么都没有」又会让人以为提醒功能根本没实现 —— 所以按 reason
 * 去重：同一个错误只留一行，恢复成功时清空键，下一次失败重新记。
 *
 * @param {object} cfg 本拍 config.load() 的结果（nudgeMaxItems 取在这里）
 */
function probeNudges(cfg) {
  nudges.fetchNudges().then((r) => {
    if (!r.ok) {
      const key = r.reason || 'unknown';
      if (nudgeWarnKey !== key) {
        nudgeWarnKey = key;
        console.warn('[dsh-notch] 提醒拉取失败（' + key + '）：后续同类错误不再重复记录');
      }
      // 桥暂时不可用 ≠ 提醒已被处理：保留本地列表，别让界面无端清空。
      return;
    }
    nudgeWarnKey = '';
    // 服务端 rev 没变：什么都不做（见函数头第 1 条）。
    if (r.rev === nudgeRev) return;

    // 条数上限来自配置（插件设置面板的「一屏几条」）。config.load() 已经把
    // 它收进顶层字段并做了 1..8 的取值校验，这里不再 clamp 第二遍 ——
    // 两处各 clamp 一次，将来口径一变必然分叉（一处改一处不改）。
    const max = cfg.nudgeMaxItems;
    // 按严重度升序（越小越该先处理），同档按时间倒序（新的在前）。
    // 服务端已排过序，这里再排一次是因为**截断发生在 app 侧**：maxItems 只
    // 留前 N 条，拿错顺序留下的就是最不重要的那几条。
    const items = r.items
      .slice()
      .sort((a, b) => (a.severity - b.severity) || (b.ts - a.ts))
      .slice(0, max);

    const nextRev = r.rev;
    const same = (items.length === nudgeItems.length)
      && items.every((it, i) => {
        const old = nudgeItems[i];
        return old && old.id === it.id && old.count === it.count
          && old.ts === it.ts && old.detail === it.detail;
      });
    nudgeRev = nextRev;
    if (same) return;              // 内容一致：保住旧引用，不让快照 rev 抖

    nudgeItems = items;
    poke();                        // 立刻补一拍：提醒是事件，不该等最多 1 秒
  }).catch((e) => {
    const key = 'exception';
    if (nudgeWarnKey !== key) {
      nudgeWarnKey = key;
      console.warn('[dsh-notch] 提醒拉取异常：' + (e && e.message));
    }
  });
}

/**
 * 组装一拍快照。纯映射（字段白名单、rev、体积）全在 snapshot.js ——
 * 这里只负责取数据，这样协议部分可以用 node 直接单测。
 *
 * @param {object} cfg 本拍 config.load() 的结果（调用方每拍只 load 一次）
 * @param {number} now 本拍时间戳
 */
function takeSnapshot(cfg, now) {
  // 回执到点就清掉：rev 去重下，「该消失了」没有别的东西会触发推送。
  if (lastJump && now - lastJump.at > JUMP_HOLD_MS) lastJump = null;
  const entries = monitor ? monitor.poll(now, tickIndex) : [];
  return buildSnapshot({ entries, nudges: nudgeItems, config: cfg, bridge: bridgeState, jump: lastJump, now });
}

/** 当前 tick 函数（startLoop 里赋值）。poke() 用它把等待中的下一拍提前。 */
let tickFn = null;

/**
 * 请求「尽快再跑一拍」。
 *
 * 用在哪：跳转回执刚产生、窗口刚从托盘重新显示出来。这两件事都必须立刻反映
 * 到岛上，而自适应轮询在空闲/隐藏时可能正睡 1000ms —— 等它自然醒，点击反馈
 * 会慢到像没反应。这里只清掉当前等待并立刻重排，**不新增定时器**。
 */
function poke() {
  if (!tickFn) return;
  if (loopTimer) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
  loopTimer = setTimeout(tickFn, 0);
}

function startLoop() {
  monitor = new SessionMonitor();

  /**
   * 递归 setTimeout 而不是 setInterval：下一拍等多久由 nextDelay 决定
   * （有活跃会话 250ms / 全空闲或窗口隐藏 1000ms）。固定间隔的 setInterval
   * 做不到这件事，而「再加一个高频定时器」是契约 §7 明令禁止的。
   */
  const tick = () => {
    loopTimer = null;
    if (quitting) return;
    tickIndex += 1;

    // 每拍只 load 一次配置：下面判显隐、判 scale、给快照用的是同一份。
    const cfg = config.load();
    const now = Date.now();

    let payload = null;
    try {
      payload = takeSnapshot(cfg, now);
    } catch (e) {
      // 单拍出错不该让岛整个死掉 —— 记日志，下一拍再来
      console.error('[dsh-notch] poll 异常:', e && e.stack);
    }

    if (payload) {
      lastPayload = payload;
      // rev 去重：内容指纹没变就不发（serverNow 不参与 rev，见 snapshot.js）。
      // renderer 还没 load 完时发出的消息会被丢掉，所以那之前**不推进**
      // lastRev —— 否则首帧内容若一直不变，就再也不会补发，岛白屏。
      if (rendererLoaded && payload.rev !== lastRev) {
        if (sendSnapshot(payload)) {
          lastRev = payload.rev;
          firstSnapshotSent = true;
        }
      }
    }

    // 配置可能在两次 tick 之间被设置面板改了
    applyVisibility(cfg);

    // scale 变化要重摆窗口（尺寸 = MAX_WINDOW × scale），其余几何不变
    const wantScale = cfg.scale || 1;
    if (win && !win.isDestroyed() && (win._scale || 1) !== wantScale) {
      win._scale = wantScale;
      placeWindow();
    }

    // 每 2s 探一次桥。按**时间**算而不是 tickIndex % 8：轮询间隔已经会在
    // 250/1000ms 之间变，按下标算会让空闲时变成 8s 才探一次。
    if (now - lastBridgeProbeAt >= BRIDGE_PROBE_MS) {
      lastBridgeProbeAt = now;
      // 提醒与桥健康探测**共用这一个 2s 闸门**（契约 §7 明令禁止新增常驻
      // 高频定时器）：它们打的是同一个回环服务，同一个节拍足够 —— 提醒的
      // 时效要求本来就是「秒级」，不是「帧级」。
      probeNudges(cfg);
      bridge.health().then((r) => {
        // 判定要不要刷托盘菜单：pending 也要算进去。
        // 只比 ok/port 的话，「0 条待处理 → 1 条待处理」不会触发刷新，
        // 而这恰恰是最需要让用户看见的一次变化（他刚点了，没生效）。
        const changed = r.ok !== bridgeState.ok
          || r.port !== bridgeState.port
          || (r.pending || 0) !== (bridgeState.pending || 0);
        bridgeState = r;
        if (changed) refreshTrayMenu();
      }).catch(() => { /* 探桥失败就当没桥 */ });
    }

    // 自适应下一拍。注意 hidden 要在 applyVisibility 之后算 —— 这一拍刚把
    // 窗口显示出来的话，下一拍应该回到 250ms 而不是继续睡 1000ms。
    const hidden = !win || win.isDestroyed() || !win.isVisible();
    loopTimer = setTimeout(tick, nextDelay(payload && payload.entries, hidden));
  };

  tickFn = tick;
  tick();

  // ── 端到端冒烟（仅 DSH_NOTCH_SMOKE=1 时生效）──
  //
  // 存在的理由：UI 层（renderer.js / styles.css）在纯 Node 自检里测不到，
  // 而「没跑过的 UI 代码」等于没写。这个开关让 CI 能真的把岛显示出来、
  // 读回渲染后的文本与岛体尺寸，再自己退出。
  //
  // 除了读文本，还会**落两张截图**（折叠态 + 展开态，按岛体实际矩形裁剪，
  // 不带窗口的 bleed 留白）：动画/布局这类「跑通了但长得不对」的问题只有
  // 看图能发现。截图目录由 DSH_NOTCH_SMOKE_DIR 指定（默认与冒烟输出同目录，
  // 再退 %APPDATA%\DSHNotch）。展开态用合成 mousemove 触发 —— 窗口平时
  // 鼠标穿透，渲染层的命中判定吃的就是这些转发事件（listener 不校验 isTrusted）。
  if (process.env.DSH_NOTCH_SMOKE === '1') {
    forceShow = true;
    setTimeout(async () => {
      if (!win || win.isDestroyed()) { app.quit(); return; }
      win.show();
      await new Promise((r) => setTimeout(r, 1500));
      const lines = [];
      const shotDir = process.env.DSH_NOTCH_SMOKE_DIR
        || (process.env.DSH_NOTCH_SMOKE_OUT
          ? path.dirname(process.env.DSH_NOTCH_SMOKE_OUT)
          : path.join(process.env.APPDATA || '.', 'DSHNotch'));
      const readIsland = async () => win.webContents.executeJavaScript(`(() => {
        const i = document.getElementById('island');
        const r = i.getBoundingClientRect();
        return { text: i.innerText, x: r.left, y: r.top, w: r.width, h: r.height };
      })()`);
      const shot = async (name, box) => {
        try {
          // capturePage 要 {x,y,width,height} 且取整（getBoundingClientRect 是小数）
          const rect = {
            x: Math.round(box.x), y: Math.round(box.y),
            width: Math.round(box.w), height: Math.round(box.h),
          };
          const img = await win.webContents.capturePage(rect);
          fs.mkdirSync(shotDir, { recursive: true });
          const file = path.join(shotDir, name);
          fs.writeFileSync(file, img.toPNG());
          lines.push('截图 = ' + file);
        } catch (e) {
          lines.push('截图失败（' + name + '）: ' + (e && e.message));
        }
      };
      try {
        // 折叠态：文本 + 岛体矩形 + 截图（窗口恒定，量的是岛自己的尺寸）
        const c = await readIsland();
        lines.push('折叠文本 = ' + JSON.stringify(c.text));
        lines.push('折叠岛体 = ' + Math.round(c.w) + 'x' + Math.round(c.h));
        await shot('smoke-collapsed.png', c);

        // 展开态：把指针「挪」到岛心（穿透窗口只认转发的 mousemove）→ 等驻留+弹簧 → 再量再截。
        // 两种事件都派发：渲染层 v2 用 pointermove（命中判定），旧版用 mousemove；
        // 合成事件不会互相冒充（MouseEvent('mousemove') 不会触发 pointermove 监听），
        // 所以这里必须两个都发，否则换渲染层后冒烟会「展开不动」。
        const fire = (x, y) => win.webContents.executeJavaScript(`(() => {
          const opts = { clientX: ${x}, clientY: ${y}, bubbles: true };
          document.dispatchEvent(new MouseEvent('mousemove', opts));
          if (typeof PointerEvent === 'function') {
            document.dispatchEvent(new PointerEvent('pointermove', Object.assign({
              pointerId: 1, pointerType: 'mouse', isPrimary: true,
            }, opts)));
          }
          return true;
        })()`);
        await fire(Math.round(c.x + c.w / 2), Math.round(c.y + c.h / 2));
        await new Promise((r) => setTimeout(r, 250));   // 跨过 200ms 驻留门槛
        await fire(Math.round(c.x + c.w / 2), Math.round(c.y + c.h / 2) + 4);
        await new Promise((r) => setTimeout(r, 750));   // 等弹簧走完
        const e = await readIsland();
        lines.push('展开文本 = ' + JSON.stringify(e.text));
        lines.push('展开岛体 = ' + Math.round(e.w) + 'x' + Math.round(e.h));
        await shot('smoke-expanded.png', e);
        lines.push('会话数 = ' + ((lastPayload && lastPayload.entries) || []).length);

        for (const l of lines) console.log('[smoke] ' + l);
        // 打包后的 exe 是 Windows GUI 子系统进程，stdout 拿不到（终端里一片空白），
        // 所以额外写一份到文件 —— 否则「打包产物真的能跑」这件事无从验证。
        if (process.env.DSH_NOTCH_SMOKE_OUT) {
          try { fs.writeFileSync(process.env.DSH_NOTCH_SMOKE_OUT, lines.join('\n') + '\n'); }
          catch (e) { /* 写不出不影响冒烟本身 */ }
        }
      } catch (e) {
        console.log('[smoke] 取渲染结果失败: ' + (e && e.message));
      }
      app.quit();
    }, 3000);
  }
}

/**
 * 决定窗口此刻该不该显示。
 *
 * @param {object} [cfg] 本拍已经 load 过的配置；不传则现场读（IPC 路径用）
 */
function applyVisibility(cfg) {
  if (!win) return;
  // 冒烟模式：无条件显示（否则「空闲自动收起」会立刻把它藏起来，什么也看不到）
  if (forceShow) { if (!win.isVisible()) win.show(); return; }
  const c = cfg || config.load();
  if (requestedHidden || !c.notchEnabled) { hideWindow(); return; }

  // 首帧快照发出之前不 show：透明窗口先露出来时页面还是空的，
  // 肉眼看到的是「空一下，再弹出内容」。等首帧数据到了再显示。
  if (!firstSnapshotSent) { hideWindow(); return; }

  // 空闲收起：一个活跃会话都没有时把岛藏起来（macOS 的 idleHide 同义）。
  // 直接用 DTO 的 live（= status !== 'idle'），不再解析 JSON 字符串。
  //
  // ⚠️ **有待处理提醒时不藏**：提醒最常见的时刻恰恰是「会话刚结束」（完成 /
  // 失败都是回合末尾），而那时 live 已经为 false —— 按老口径岛会在提醒到达
  // 的同一拍被藏起来，徽标永远没人看见。提醒是「该你处理了」，它比「空闲
  // 就收起」优先。
  if (c.idleHide) {
    const entries = (lastPayload && lastPayload.entries) || [];
    const nudges = (lastPayload && lastPayload.nudges) || [];
    if (!nudges.length && !entries.some((e) => e && e.live === true)) { hideWindow(); return; }
  }
  if (!win.isVisible()) {
    win.show();
    // 显示路径有多条（首帧、托盘、idleHide 恢复），统一在这里挂光标轮询。
    startCursorWatch();
  }
}

// ───────────────────────────── IPC ─────────────────────────────

ipcMain.handle('island:jump', async (_e, payload) => {
  const entry = payload || {};
  const cfg = config.load();
  const outcome = await performJump(entry, {
    // `dsh://open` 是 DSH 唯一对外注册的深链。Windows 上是否注册过未实测 ——
    // 失败只是「置前」这一步无效，降级路径照走。
    activate: async () => {
      try {
        await shell.openExternal('dsh://open');
        return true;
      } catch (err) {
        console.warn('[dsh-notch] dsh://open 打不开（协议可能未注册）:', err && err.message);
        return false;
      }
    },
    copy: (text) => { clipboard.writeText(text); return true; },
    post: cfg.jumpEnabled
      ? (sid, title) => bridge.postJump(sid, title)
      : async () => false,
  });
  lastJump = { kind: outcome.kind, brief: outcome.brief, at: Date.now() };
  // 立刻补一拍：rev 因 at 变了必然不同，渲染层马上就能拿到回执。
  // 旧实现靠「清空上一次快照字符串」强制下一拍必推；rev 去重这套里不再需要
  // 那种「清空去重状态」的技巧 —— 回执内容本身就变了。
  poke();
  return { ok: outcome.isSuccess, brief: outcome.brief, kind: outcome.kind };
});

/**
 * 用户点了（处理过）一条提醒 → 通知服务端移除。
 *
 * ## 为什么本地也要立刻删
 *
 * 服务端是真相源，但它的下一次拉取最多要等 2 秒。用户的动作是「我点过了」，
 * 那条提醒必须当场消失 —— 否则会出现「点了，它还挂在原地」这种最伤信任的
 * 反馈。所以：**先本地移除 + poke（立刻重渲染），再让服务端慢慢同步**。
 *
 * 万一服务端 ack 失败（桥刚好重启），下一拍拉取还会把它拉回来 —— 界面上
 * 表现为「它又出现了」。这比「假装删掉、服务端其实还在」好：后者用户永远
 * 点不掉，而且没有任何线索。
 *
 * `nudgeRev` 在列表清空时置空：清空意味着「本地与服务端暂时不一致」，
 * 置空强制下一拍把服务端那份重新拉一遍（而不是靠 rev 相等跳过）。
 */
ipcMain.handle('island:nudge-ack', async (_e, payload) => {
  const p = (payload && typeof payload === 'object') ? payload : {};
  const ids = Array.isArray(p.ids)
    ? p.ids.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
    : [];
  if (!ids.length) return { ok: false, remaining: nudgeItems.length };

  // 先在本地移除（含 count 累加型重复：同 id 只算一条）
  nudgeItems = nudgeItems.filter((it) => !ids.includes(it.id));

  const r = await nudges.ack(ids);
  if (r.ok) {
    nudgeWarnKey = '';
  } else if (nudgeWarnKey !== 'ack') {
    nudgeWarnKey = 'ack';
    console.warn('[dsh-notch] 提醒确认失败（' + (r.reason || 'unknown') + '）：本地已移除，下次拉取会同步');
  }

  // 列表空了就把 rev 清掉：下一拍重新拉一遍服务端，把「不是本地删的」
  // （比如服务端又新增了别的）拿回来，而不是因为 rev 相同整段跳过。
  if (!nudgeItems.length) nudgeRev = '';
  poke();
  return { ok: r.ok, remaining: nudgeItems.length };
});

/**
 * 指针进岛/出岛：切窗口的点击穿透。判定在渲染层（它有岛的当前矩形和
 * 转发来的指针位置），这里只执行。穿透是常态，进岛才临时接管 ——
 * macOS 版 NotchPanel.isInteractive 的同一条纪律。
 *
 * ⚠️ 这条 IPC 翻转的是 main 侧的 `interactive` 状态，500ms 看门狗才有的放矢：
 * 若渲染层因为收不到 mouseleave 而「忘了」发 false，看门狗能强制收回。
 */
ipcMain.handle('island:set-interactive', (_e, value) => {
  interactive = !!value;
  if (win && !win.isDestroyed()) {
    try {
      win.setIgnoreMouseEvents(!value, { forward: true });
    } catch (e) {
      trace('[trace] setIgnoreMouseEvents 失败: ' + (e && e.message));
    }
  }
  // 这段是 main 侧 `interactive` 状态的唯一写入口（看门狗、hide/move 复位都读它）。
  // 刻意不抽成独立函数：只在这一个地方被调用，抽出去只会让「谁改的」更难追。
  return true;
});

/**
 * 自定义拖窗：替代 \`-webkit-app-region: drag\`。
 *
 * 真机事故（2026-10-19）：带拖拽区的窗口上，点击岛体会触发 Windows 的
 * 非客户区拖拽（窗口真的被拖走几个像素），页面收不到 click —— 钉住/跳转
 * 全部失效；同时 forward:true 的 mousemove 也被掐断。拖拽区不能删了就算
 * 完，拖窗能力改由这里实现：渲染层报指针屏幕坐标，主进程按位移搬窗口。
 */
let dragOrigin = null;
ipcMain.handle('island:drag-start', () => {
  if (!win || win.isDestroyed()) return false;
  let p;
  let b;
  try { p = screen.getCursorScreenPoint(); b = win.getBounds(); } catch { return false; }
  dragOrigin = {
    cursorX: p.x, cursorY: p.y,
    x: b.x, y: b.y, width: b.width, height: b.height,
  };
  return true;
});
ipcMain.handle('island:drag-move', (_e, point) => {
  if (!dragOrigin || !win || win.isDestroyed()) return false;
  const x = Math.round(dragOrigin.x + ((point && point.x) - dragOrigin.cursorX));
  const y = Math.round(dragOrigin.y + ((point && point.y) - dragOrigin.cursorY));
  // 用 setBounds（把尺寸钉回拖拽开始时的值）而不是 setPosition：
  // 透明 + 非整数 DPI 下反复 setPosition 会让 Windows 对尺寸做 ±1 的取整漂移，
  // 拖几次窗口就悄悄变宽几个像素。
  win.setBounds({ x, y, width: dragOrigin.width, height: dragOrigin.height });
  return true;
});
ipcMain.handle('island:drag-end', () => { dragOrigin = null; return true; });

ipcMain.handle('island:hide', () => {
  requestedHidden = true;
  hideWindow();
  return true;
});

ipcMain.handle('island:show', () => {
  requestedHidden = false;
  applyVisibility();
  poke();     // 立刻回到 250ms 档（隐藏期间轮询是 1000ms）
  return true;
});

ipcMain.handle('island:quit', () => { app.quit(); return true; });

ipcMain.handle('island:toggle-notch', () => {
  const next = config.toggleNotch();
  applyVisibility();
  refreshTrayMenu();
  return next;
});

ipcMain.handle('island:open-dsh', () => bringDshToFront());

ipcMain.handle('island:open-config-dir', () => {
  shell.openPath(config.appDataDir());
  return true;
});

/**
 * 岛体右键 → 原生菜单（契约 §5「右键」一行）。
 *
 * 为什么菜单必须由主进程弹：岛窗口常态是鼠标穿透的，渲染层画不出能盖住其它
 * 应用的菜单；而且「隐藏」「退出」这类动作本来就在主进程。
 *
 * 为什么「钉住/取消钉住」不在这里直接改状态，而是发一条切换请求回渲染层：
 * pinned 的唯一真相源在渲染层（它还要同时驱动展开/收起、Esc、点主行）。
 * 主进程再存一份，必然在某个分支上和它不一致 —— 那种 bug 的表现是「菜单里
 * 点了钉住，但岛并没有钉住」，且只在特定操作顺序下复现。
 */
ipcMain.handle('island:context-menu', (_e, payload) => {
  if (!win || win.isDestroyed()) return false;
  const p = (payload && typeof payload === 'object') ? payload : {};
  const pinned = p.pinned === true;
  const menu = Menu.buildFromTemplate([
    {
      label: pinned ? '取消钉住' : '钉住',
      click: () => sendToRenderer('island:pin-toggle'),
    },
    {
      // 与托盘里的同名项走同一条路：写进 client-config.json，而不是只藏当前
      // 进程。只藏进程的坑是：设置面板里还显示「显示中」，两边说法不一致。
      label: '隐藏灵动岛',
      click: () => {
        const v = { ...config.load() };
        v.notchEnabled = false;
        config.save(v);
        applyVisibility();
        refreshTrayMenu();
      },
    },
    { type: 'separator' },
    { label: '打开 DSH 设置', click: () => { bringDshToFront(); } },
    { label: '打开配置目录', click: () => { shell.openPath(config.appDataDir()); } },
    { type: 'separator' },
    { label: '退出', click: () => { app.quit(); } },
  ]);
  menu.popup({ window: win });
  return true;
});

/**
 * 系统级提示（Windows 托盘气泡）。
 *
 * 用在降级路径上：跳转没成功时，岛上的文字回执会被下一跳快照刷掉，而用户
 * 可能正看着别处。托盘不存在时如实返回 `{ ok: false }` —— 调用方不要假设它
 * 一定成功（`Tray.displayBalloon` 是 Windows 专属 API，本仓库只在 win32 用）。
 */
ipcMain.handle('island:notify', (_e, payload) => {
  const p = (payload && typeof payload === 'object') ? payload : {};
  const title = (typeof p.title === 'string' && p.title) ? p.title : 'DSH 灵动岛';
  const body = (typeof p.body === 'string') ? p.body : '';
  if (tray) {
    try {
      // iconType 显式给 'info'：Windows 的旧式气泡要求有图标类型，
      // 不传时部分系统版本上弹不出来（Electron 文档里 icon 与 iconType 二选一）。
      tray.displayBalloon({ title, content: body, iconType: 'info' });
      return { ok: true, how: 'tray' };
    } catch (e) {
      trace('[trace] 托盘气泡失败: ' + (e && e.message));
    }
  }
  return { ok: false, how: 'none' };
});

// ───────────────────────────── 工具 ─────────────────────────────

/** 32×32 的纯色 PNG（托盘图标缺失时的兜底，保证托盘一定存在）。 */
function makeFallbackPng(size) {
  const zlib = require('node:zlib');
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;   // filter: none
    for (let x = 0; x < size; x += 1) {
      const o = rowStart + 1 + x * 4;
      raw[o] = 0x4e; raw[o + 1] = 0x7c; raw[o + 2] = 0xff; raw[o + 3] = 0xff;
    }
  }
  const idat = zlib.deflateSync(raw);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ───────────────────────────── 生命周期 ─────────────────────────────

app.on('ready', () => {
  trace('[trace] ready');
  createWindow();
  trace('[trace] window 建好');
  createTray();
  trace('[trace] tray 建好');
  startLoop();
  trace('[trace] 轮询已起');

  // 穿透看门狗：500ms 一次，只在渲染层接管期间真正比较光标位置（见 watchdogTick）。
  watchdogTimer = setInterval(watchdogTick, WATCHDOG_MS);
  trace('[trace] 看门狗已起');

  // 显示器变了（插拔外接屏 / 改分辨率）→ 重新定位，否则岛会飘到屏幕外。
  // 顺带收回穿透：窗口被搬到另一个显示器后，旧坐标下的「接管」状态已无意义，
  // 且此时指针几乎必然不在新位置 —— 不收回就会吞掉桌面点击。
  const repo = () => {
    releasePointer('display-change');
    placeWindow(true);
  };
  screen.on('display-added', repo);
  screen.on('display-removed', repo);
  screen.on('display-metrics-changed', repo);
});

app.on('window-all-closed', () => {
  // Windows 上关窗不等于退出：岛靠托盘活着
  if (process.platform !== 'darwin') return;
  app.quit();
});

app.on('before-quit', () => {
  // 退出路径必须清掉两个定时器：递归 setTimeout 会把自己一直排下去，
  // 500ms 看门狗也是常驻的 —— 不清的话进程会被多吊一拍，且 tick 可能
  // 在渲染帧销毁后再 send（虽然 sendToRenderer 已挡，但能少一条日志）。
  quitting = true;
  if (loopTimer) { clearTimeout(loopTimer); loopTimer = null; }
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  stopCursorWatch();
  tickFn = null;
  releasePointer('quit');
  if (tray) { tray.destroy(); tray = null; }
});
