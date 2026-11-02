'use strict';
// Isolated visual geometry regression. No live bridge, sessions, or profile.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const electron = require('electron');
if (typeof electron === 'string') {
  const { spawnSync } = require('node:child_process');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-layout-test-'));
  const env = { ...process.env, DSH_LAYOUT_TEST_HOME: temp };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ASAR;
  delete env.NODE_OPTIONS;
  const result = spawnSync(electron, [__filename], { env, stdio: 'inherit', timeout: 20000 });
  fs.rmSync(temp, { recursive: true, force: true });
  if (result.error || result.status === null) console.error('Electron subprocess failed:', result.error?.message || result.signal || 'unknown');
  process.exit(result.status === null ? 1 : result.status);
}
const { app, BrowserWindow, ipcMain, session } = electron;
app.setPath('userData', process.env.DSH_LAYOUT_TEST_HOME);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('devtools:') });
  });
  for (const ch of ['island:set-interactive', 'island:jump', 'island:open-dsh', 'island:open-config-dir', 'island:context-menu', 'island:notify', 'island:hide', 'island:show', 'island:quit', 'island:toggle-notch']) ipcMain.handle(ch, () => true);
  const src = path.join(__dirname, '..', 'src');
  const main = fs.readFileSync(path.join(src, 'main.js'), 'utf8');
  const size = main.match(/const MAX_WINDOW = \{ w: (\d+), h: (\d+) \}/);
  if (!size) throw new Error('Production window size unavailable');
  const win = new BrowserWindow({ width: Number(size[1]), height: Number(size[2]), show: false, frame: false, transparent: true, webPreferences: { preload: path.join(src, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });
  await win.loadFile(path.join(src, 'index.html'));
  const entries = Array.from({ length: 8 }, (_, i) => ({ id: `session-test-${i}`, label: `Synthetic session ${i}`, status: i === 0 ? 'waiting' : 'thinking', live: true, glow: '#ffaa00', tag: 'WAITING', badge: 'WAITING', actionText: 'Synthetic action', detailText: 'Synthetic details', turnStepText: 'T3·S7', contextText: '32%', contextFraction: 0.32 }));
  const nudges = Array.from({ length: 8 }, (_, i) => ({ id: `test-nudge-${i}`, kind: 'completed', severity: 2, sessionId: `session-test-${i}`, label: `Synthetic reminder ${i}`, detail: 'Synthetic completed event', at: '10:00', count: 1 }));
  for (const scale of [0.5, 1, 2]) {
    win.setSize(Math.round(Number(size[1]) * scale), Math.round(Number(size[2]) * scale));
    win.webContents.send('island:snapshot', { v: 2, rev: `synthetic-expanded-${scale}`, entries, nudges, config: { scale, glowEffect: true, expandOnHover: true, notchEnabled: true, jumpEnabled: true }, bridge: { ok: true, port: 0, pending: 0 }, jump: null, serverNow: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const geometry = await win.webContents.executeJavaScript(`(() => { const r = id => { const b = document.querySelector(id).getBoundingClientRect(); return { top: b.top, bottom: b.bottom, height: b.height }; }; const island = document.querySelector('#island'); const style = getComputedStyle(island); return { viewport: innerHeight, island: r('#island'), footer: r('.footer'), stats: r('#stats'), urgent: r('#urgent-island'), urgentVisible: getComputedStyle(document.querySelector('#urgent-island')).display !== 'none', mode: island.dataset.expanded, bottomLeft: style.borderBottomLeftRadius, bottomRight: style.borderBottomRightRadius, sessionRows: document.querySelectorAll('#list .row').length, nudgeRows: document.querySelectorAll('#nudges .nudge').length }; })()`);
    console.log(JSON.stringify({ scale, ...geometry }));
    if (geometry.mode !== '1' || geometry.island.bottom > geometry.viewport + 0.5 || geometry.footer.height !== 0 || geometry.stats.height !== 0 || parseFloat(geometry.bottomLeft) <= 0 || parseFloat(geometry.bottomRight) <= 0 || geometry.sessionRows !== 6 || geometry.nudgeRows !== 8 || !geometry.urgentVisible || geometry.urgent.top < geometry.island.bottom || geometry.urgent.bottom > geometry.viewport + 0.5) throw new Error('Expanded island, footer, rounded corners, rows, or urgent child invalid');
  }
  app.exit(0);
}).catch(error => { console.error(error.message); app.exit(1); });
