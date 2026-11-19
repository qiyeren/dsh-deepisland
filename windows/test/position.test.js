'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const position = require('../src/position.js');
const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
  { workArea: { x: -1280, y: 0, width: 1280, height: 900 } }];

test('isolated persistence and invalid data fallback', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'island-position-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'window-position.json');
  assert.equal(position.loadPosition(file), null);
  assert.equal(position.savePosition(file, { x: -900, y: 120 }), true);
  assert.deepEqual(position.loadPosition(file), { x: -900, y: 120 });
  fs.writeFileSync(file, '{broken'); assert.equal(position.loadPosition(file), null);
  fs.writeFileSync(file, '{"x":1e100,"y":0}'); assert.equal(position.loadPosition(file), null);
  assert.equal(position.savePosition(file, { x: NaN, y: 0 }), false);
});

test('multiple displays, unplugged display and oversized window', () => {
  assert.deepEqual(position.visiblePosition({ x: -900, y: 120 }, 484, 500, displays), { x: -900, y: 120 });
  assert.deepEqual(position.visiblePosition({ x: -900, y: 120 }, 484, 500, displays.slice(0, 1)), { x: -24, y: 120 });
  assert.deepEqual(position.visiblePosition({ x: 9999, y: 9999 }, 484, 500, displays), { x: 1460, y: 580 });
  assert.deepEqual(position.visiblePosition({ x: 10, y: 10 }, 3000, 3000, displays.slice(0, 1)), { x: -149, y: 0 });
  assert.deepEqual(position.visiblePosition({ x: -24, y: 580 }, 484, 500, displays.slice(0, 1)), { x: -24, y: 580 });
  assert.deepEqual(position.visiblePosition({ x: 1460, y: 580 }, 484, 500, displays.slice(0, 1)), { x: 1460, y: 580 });
  // At 1.5x the expanded width is 654 and its left offset is 36.
  assert.deepEqual(position.visiblePosition({ x: -999, y: 9999 }, 726, 750, displays.slice(0, 1)), { x: -36, y: 330 });
});

test('main drag and placement use only injected memory store', () => {
  const handlers = {}; let bounds = { x: 718, y: 0, width: 484, height: 500 };
  let cursor = { x: 750, y: 20 }, saved = null;
  const ctx = { position, rememberedPosition: null, positionFile: 'isolated', MAX_WINDOW: { w: 484, h: 500 },
    win: { _scale: 1, isDestroyed: () => false, getBounds: () => ({ ...bounds }), setBounds: b => { bounds = b; } },
    screen: { getPrimaryDisplay: () => displays[0], getAllDisplays: () => displays, getCursorScreenPoint: () => cursor },
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }, process: { env: {} }, console, trace() {} };
  ctx.position = { ...position, savePosition: (_, p) => { saved = { ...p }; return true; } };
  vm.createContext(ctx);
  const placement = source.slice(source.indexOf('function placeWindow('), source.indexOf('\nfunction createWindow()'));
  const drag = source.slice(source.indexOf('let dragOrigin = null;'), source.indexOf("ipcMain.handle('island:hide'"));
  vm.runInContext(placement + '\n' + drag, ctx);
  ctx.placeWindow(); assert.equal(bounds.x, 718); assert.equal(bounds.y, 0);
  handlers['island:drag-start'](); handlers['island:drag-end'](); assert.equal(saved, null);
  handlers['island:drag-start'](); handlers['island:drag-move'](null, { x: 850, y: 70 }); handlers['island:drag-end']();
  assert.deepEqual(saved, { x: 818, y: 50 });
  bounds = { x: 0, y: 0, width: 484, height: 500 }; ctx.placeWindow();
  assert.equal(bounds.x, 818); assert.equal(bounds.y, 50);
  ctx.screen.getAllDisplays = () => [{ workArea: { x: 0, y: 0, width: 800, height: 600 } }];
  ctx.placeWindow(true); assert.equal(bounds.x, 340); assert.equal(bounds.y, 50);
  handlers['island:drag-start']();
  handlers['island:drag-move'](null, { x: 900, y: 2000 });
  handlers['island:drag-end']();
  assert.equal(bounds.y, 100); assert.equal(saved.y, 100);
  const savedAfterDrag = { ...saved };
  // Programmatic display re-placement never saves a second position.
  ctx.placeWindow(true); assert.deepEqual(saved, savedAfterDrag);
  bounds = { x: 0, y: 0, width: 484, height: 500 };
  ctx.placeWindow(true); assert.equal(bounds.y, savedAfterDrag.y);
  // Display and scale changes must not reposition or resize during a drag.
  handlers['island:drag-start']();
  const during = { ...bounds };
  ctx.win._scale = 1.5;
  ctx.screen.getAllDisplays = () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];
  ctx.placeWindow(true); assert.deepEqual({ ...bounds }, during);
  handlers['island:drag-move'](null, { x: 1200, y: 1000 });
  assert.equal(bounds.width, 484); assert.equal(bounds.height, 500);
  handlers['island:drag-end']();
  assert.equal(bounds.width, 726); assert.equal(bounds.height, 750);
  assert.equal(bounds.y, 330); assert.equal(saved.y, 330);
  assert.equal(saved.x, bounds.x);
});
