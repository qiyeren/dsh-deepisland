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
  node('detail').className = 'detail is-off';
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
    ackNudge: value => { acknowledgements.push(value); return Promise.resolve({ ok: true }); },
  } };
  const context = { document, window, requestAnimationFrame() {}, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, console };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8'), context, { filename: 'renderer.js' });
  return { node, jumps, acknowledgements, snapshot: snap => onSnapshot(snap) };
}

test('one idle session remains a clickable list row with action on the right', () => {
  const ui = rendererHarness();
  ui.snapshot({ rev: 'one-idle', entries: [{ id: 's1', label: '合成主会话', status: 'idle', badge: 'Ready', actionText: '待命', detailText: '等待指令输入' }], nudges: [], config: {}, bridge: {} });
  ui.node('compact').click();
  assert.equal(ui.node('island').getAttribute('data-mode'), 'hud');
  assert.equal(ui.node('detail').classList.contains('is-off'), true, 'standalone detail must not be displayed');
  const rows = ui.node('list').children;
  assert.equal(rows.length, 1, 'one session still has one visible session row');
  assert.equal(rows[0].children[1].textContent, '合成主会话');
  assert.equal(rows[0].children[3].textContent, '待命');
  ui.node('list').click(rows[0]);
  assert.equal(ui.jumps.length, 1);
  assert.equal(ui.jumps[0].id, 's1');
  assert.equal(ui.acknowledgements.length, 0);
});

test('multiple sessions keep their titles, Chinese actions and individual jumps', () => {
  const ui = rendererHarness();
  const entries = [
    { id: 'a', label: '主会话甲', status: 'thinking', actionText: '深度思考中' },
    { id: 'b', label: '主会话乙', status: 'tool', actionText: '执行中' },
  ];
  ui.snapshot({ rev: 'two', entries, nudges: [], config: {}, bridge: {} });
  ui.node('compact').click();
  const rows = ui.node('list').children;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => [row.children[1].textContent, row.children[3].textContent]), [
    ['主会话甲', '深度思考中'], ['主会话乙', '执行中'],
  ]);
  assert.equal(ui.node('detail').classList.contains('is-off'), true);
  ui.node('list').click(rows[1]);
  assert.equal(ui.jumps[0].id, 'b');
  assert.equal(ui.acknowledgements.length, 0);
});

test('transition from multiple to one session preserves the remaining clickable row', () => {
  const ui = rendererHarness();
  const a = { id: 'a', label: '原会话', status: 'idle', actionText: '待命' };
  const b = { id: 'b', label: '保留会话', status: 'thinking', actionText: '思考中' };
  ui.snapshot({ rev: 'before', entries: [a, b], nudges: [], config: {}, bridge: {} });
  ui.node('compact').click();
  assert.equal(ui.node('list').children.length, 2);
  ui.snapshot({ rev: 'after', entries: [b], nudges: [], config: {}, bridge: {} });
  const rows = ui.node('list').children;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].getAttribute('data-id'), 'b');
  assert.equal(rows[0].children[1].textContent, '保留会话');
  assert.equal(rows[0].children[3].textContent, '思考中');
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
  assert.equal(ui.node('detail').classList.contains('is-off'), true);
  assert.equal(ui.node('nudges').children.length, 1);
  assert.equal(ui.node('nudges').children[0].getAttribute('data-id'), 'fake-notice');
  assert.equal(ui.acknowledgements.length, 0);
});
