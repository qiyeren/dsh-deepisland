'use strict';
// Exercise the actual menu IPC handler in a VM; no Electron runtime, sockets or user data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const start = source.indexOf("ipcMain.handle('island:context-menu'");
const end = source.indexOf('\n});', start);
assert.ok(start >= 0 && end > start, 'expected context menu handler');
function harness() {
  let handler, items, popup;
  const ctx = { ipcMain: { handle: (_name, fn) => { handler = fn; } }, win: { isDestroyed: () => false }, Menu: { buildFromTemplate: list => { items = list; return { popup: options => { popup = options; } }; } } };
  vm.runInNewContext(source.slice(start, end + 4), ctx);
  return { open: value => handler({}, value), items: () => items, popup: () => popup };
}
test('ordinary menu remains available', () => {
  const h = harness();
  assert.equal(h.open({ pinned: false }), true);
  assert.equal(h.items()[0].label, '钉住');
  assert.ok(h.items().some(item => item.label === '隐藏灵动岛'));
});
