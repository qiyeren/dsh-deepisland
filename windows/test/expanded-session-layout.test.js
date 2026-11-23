'use strict';
// Synthetic snapshots and DOM only; no actual sessions, reminders or services.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function rendererHarness() {
  class Element {
    constructor() {
      this._text = '';
      this.children = [];
      this.attrs = new Map();
      this.classes = new Set();
      this.listeners = new Map();
      const props = new Map();
      this.style = { getPropertyValue: key => props.get(key) || '', setProperty: (key, value) => props.set(key, value) };
      this.classList = {
        contains: cls => this.classes.has(cls),
        toggle: (cls, on) => on ? this.classes.add(cls) : this.classes.delete(cls),
      };
    }
    set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    setAttribute(key, value) { this.attrs.set(key, String(value)); }
    getAttribute(key) { return this.attrs.get(key) || null; }
    removeAttribute(key) { this.attrs.delete(key); }
    append(...children) { for (const child of children) this.appendChild(child); }
    appendChild(child) { child.parent = this; this.children.push(child); return child; }
    insertBefore(child, before) {
      if (child.parent) child.remove();
      const i = this.children.indexOf(before);
      child.parent = this;
      this.children.splice(i < 0 ? this.children.length : i, 0, child);
    }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
    addEventListener(type, fn) { this.listeners.set(type, fn); }
    click(target = this) { this.listeners.get('click')?.({ target }); }
    closest(selector) { return selector === '.row' && this.classes.has('row') ? this : null; }
  }
  const nodes = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  let onSnapshot;
  const jumps = [];
  const acknowledgements = [];
  const document = {
    documentElement: new Element(), getElementById: node,
    querySelector: () => null, addEventListener() {},
    createElement: () => new Element(),
    createTextNode: text => { const el = new Element(); el.textContent = text; return el; },
  };
  const window = { addEventListener() {}, island: {
    onSnapshot: callback => { onSnapshot = callback; },
    jump: value => { jumps.push(value); return Promise.resolve({ kind: 'bridged' }); },
    nudgeAck: value => { acknowledgements.push(value); return Promise.resolve({ ok: true }); },
  } };
  const context = { document, window, requestAnimationFrame() {}, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, console };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8'), context, { filename: 'renderer.js' });
  return { node, jumps, acknowledgements, snapshot: snap => onSnapshot(snap) };
}

test('compact trusts the five-state projection, not old tool, count or progress fields', () => {
  const ui = rendererHarness();
  ui.snapshot({ entries: [{ id: 'a', label: '编译', status: 'running', tag: 'read', actionText: '执行 read', todoText: '1/3', elapsedText: '00:12' }, { id: 'b', label: '检查', status: 'done' }] });
  assert.equal(ui.node('c-title-text').textContent, '编译');
  assert.equal(ui.node('c-chip').textContent, '运行中');
  assert.equal(ui.node('c-gauge').textContent + ui.node('c-elapsed').textContent, '');
});

test('every row exposes only the supplied session name and canonical state, and jumps by ID', () => {
  const ui = rendererHarness();
  const statuses = ['running', 'waiting', 'done', 'failed', 'interrupted'];
  const labels = ['甲', '乙', '丙', '丁', '戊'];
  const entries = statuses.map((status, i) => ({ id: `id-${i}`, label: labels[i], status, actionText: '不应泄漏', elapsedText: '10:00' }));
  ui.snapshot({ rev: 'five', entries });
  ui.node('compact').click();
  const rows = ui.node('list').children;
  assert.deepEqual(rows.map(row => row.textContent), ['甲运行中', '乙待回答', '丙回合完成', '丁失败', '戊中断']);
  rows.forEach(row => ui.node('list').click(row));
  assert.deepEqual(ui.jumps.map(jump => jump.id), entries.map(entry => entry.id));
  assert.equal(ui.acknowledgements.length, 0);
});

test('no status is inferred from a reminder, an unknown entry, or a disconnected feed', () => {
  const ui = rendererHarness();
  ui.snapshot({ entries: [null, { id: 's', label: '旧条目', status: 'idle', badge: '已完成' }], nudges: [{ id: 'nh', kind: 'completed' }] });
  assert.equal(ui.node('c-title-text').textContent, '暂无会话');
  assert.equal(ui.node('c-chip').textContent, '');
  ui.snapshot({ entries: [{ id: 's', label: '测试', status: 'done' }] });
  assert.equal(ui.node('c-chip').textContent, '回合完成');
  ui.snapshot({ entries: [{ id: 's', label: '旧缓存', status: 'interrupted' }], bridge: { ok: true, statesOnline: false } });
  assert.equal(ui.node('c-title-text').textContent, '状态暂不可用');
  assert.equal(ui.node('c-chip').textContent + ui.node('list').textContent, '');
});

test('transition from multiple to one session preserves the remaining clickable row', () => {
  const ui = rendererHarness();
  const a = { id: 'a', label: '原会话', status: 'done' };
  const b = { id: 'b', label: '保留会话', status: 'running' };
  ui.snapshot({ rev: 'before', entries: [a, b], nudges: [], config: {}, bridge: {} });
  ui.node('compact').click();
  assert.equal(ui.node('list').children.length, 2);
  ui.snapshot({ rev: 'after', entries: [b], nudges: [], config: {}, bridge: {} });
  const rows = ui.node('list').children;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].getAttribute('data-id'), 'b');
  assert.equal(rows[0].children[1].textContent, '保留会话');
  assert.equal(rows[0].textContent, '保留会话运行中');
  ui.node('list').click(rows[0]);
  assert.equal(ui.jumps[0].id, 'b');
});

test('zero sessions with a synthetic reminder retains the reminder without inventing a session row', () => {
  const ui = rendererHarness();
  const item = { id: 'fake-notice', kind: 'completed', label: '合成提醒', detail: '模拟内容', at: '10:00' };
  ui.snapshot({ rev: 'none', entries: [], nudges: [item], config: {}, bridge: {} });
  ui.node('compact').click();
  assert.equal(ui.node('island').getAttribute('data-mode'), 'hud');
  assert.equal(ui.node('list').children.length, 0);
  assert.equal(ui.node('nudges').children.length, 1);
  assert.equal(ui.node('nudges').children[0].getAttribute('data-id'), 'fake-notice');
  assert.equal(ui.acknowledgements.length, 0);
});
