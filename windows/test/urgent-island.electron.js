'use strict';
// Synthetic renderer test; independent profile and all network requests denied.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const electron = require('electron');
if (typeof electron === 'string') {
  const { spawnSync } = require('node:child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-urgent-test-'));
  const env = { ...process.env, DSH_URGENT_TEST_HOME: tmp };
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_NO_ASAR; delete env.NODE_OPTIONS;
  const r = spawnSync(electron, [__filename], { env, stdio: 'inherit', timeout: 20000 });
  fs.rmSync(tmp, { recursive: true, force: true });
  if (r.error || r.status === null) console.error('Electron subprocess failed:', r.error?.message || r.signal || 'unknown');
  process.exit(r.status === null ? 1 : r.status);
}
const { app, BrowserWindow, ipcMain, session } = electron;
app.setPath('userData', process.env.DSH_URGENT_TEST_HOME);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith('file:') }));
  let jumped = null; let acks = 0; const interactive = [];
  ipcMain.handle('island:set-interactive', (_e, value) => { interactive.push(value); return true; });
  ipcMain.handle('island:jump', (_e, arg) => { jumped = arg; return { kind: 'bridged', brief: 'queued' }; });
  ipcMain.handle('island:nudge-ack', () => { acks++; return { ok: true }; });
  for (const ch of ['island:open-dsh', 'island:open-config-dir', 'island:context-menu', 'island:notify', 'island:hide', 'island:show', 'island:quit', 'island:toggle-notch']) ipcMain.handle(ch, () => true);
  const src = path.join(__dirname, '..', 'src');
  const win = new BrowserWindow({ width: 484, height: 500, show: false, frame: false, transparent: true, webPreferences: { preload: path.join(src, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });
  await win.loadFile(path.join(src, 'index.html'));
  const send = (rev, entries, nudges) => win.webContents.send('island:snapshot', { v: 2, rev, entries, nudges, config: { scale: 1, glowEffect: true, expandOnHover: false }, bridge: { ok: true, port: 0, pending: 0 } });
  const wait = () => new Promise(r => setTimeout(r, 500));
  const view = () => win.webContents.executeJavaScript(`(() => { const n = document.querySelector('#urgent-island'); if (!n) return null; const r = n.getBoundingClientRect(), p = document.querySelector('#island').getBoundingClientRect(); return { visible: getComputedStyle(n).display !== 'none', text: n.textContent, top: r.top, bottom: r.bottom, parentBottom: p.bottom, height: innerHeight }; })()`);
  send('a', [], [{ id: 'complete', kind: 'completed', sessionId: 'session-done', label: 'done' }]); await wait();
  let v = await view(); if (!v || v.visible) throw new Error('Completed-only must not show urgent child');
  send('b', [{ id: 'session-choice', label: 'Choice session', status: 'waiting', live: true }], [{ id: 'fail', kind: 'failed', sessionId: 'session-fail', label: 'Fail session' }, { id: 'choice', kind: 'needs_choice', sessionId: 'session-choice', label: 'Choice session' }]); await wait();
  v = await view(); if (!v.visible || !v.text.includes('Choice session') || !v.text.includes('1') || v.top < v.parentBottom || v.bottom > v.height) throw new Error('Urgent child priority/count/geometry invalid: ' + JSON.stringify(v));
  const point = await win.webContents.executeJavaScript("(() => { const r = document.querySelector('#urgent-island').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, inside: true }; })()");
  win.webContents.send('island:cursor', point); await wait();
  if (!interactive.includes(true)) throw new Error('Child pointer must enable mouse interaction');
  await win.webContents.executeJavaScript("document.querySelector('#urgent-island').click()"); await wait();
  if (!jumped || jumped.id !== 'session-choice' || acks !== 0) throw new Error('Child click must jump without acknowledging alerts');
  send('c', [], [{ id: 'fail-1', kind: 'failed', sessionId: 'session-fail', label: 'Fail session' }, { id: 'fail-2', kind: 'failed', sessionId: 'session-fail', label: 'Fail session' }]); await wait();
  v = await view(); if (!v.visible || !v.text.includes('执行失败') || v.text.includes('+1')) throw new Error('Failed reminders from one session must not inflate count');
  send('d', [], []); await wait();
  v = await view(); if (v.visible) throw new Error('Child must hide without urgent items');
  console.log('urgent child synthetic UI: passed'); app.exit(0);
}).catch(e => { console.error(e.stack || e.message); app.exit(1); });
