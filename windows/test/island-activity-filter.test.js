'use strict';
// Legacy activity parsing still protects sensitive values. The Windows renderer
// receives the separate five-state feed, exercised in expanded-session-layout.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ActivityCursor } = require('../src/activity.js');

function event(seq, type, data = {}) { return { seq, type, data, time: 1000 + seq }; }

test('sensitive tool calls hide name and arguments while keeping tool and approval state', () => {
  for (const name of ['subagent', 'subagent_fork', 'send_message', 'list_agents', 'wait_agent', 'workflow', 'ralph', 'mnemon_recall', 'mnemon_subagent_result', 'mnemon_runtime_memory', 'mcp__mnemon__recall', 'mcp__mnemon__search']) {
    const cursor = new ActivityCursor();
    const a = cursor.apply([event(1, 'tool/call', { callId: 'x', name, arguments: { description: 'PRIVATE ARGUMENT' } })], 1001);
    assert.equal(a.status, 'tool', name);
    assert.equal(a.isWaitingApproval, false, name);
    assert.equal(a.currentTool, null, name);
    assert.equal(a.title, '执行中', name);
    assert.equal(a.detail, '正在执行操作', name);
    assert.equal(a.toolCount, 1, name);
    const result = cursor.apply([event(2, 'tool/result', { callId: 'x', name, content: 'PRIVATE RESULT' })], 1002);
    assert.equal(result.status, 'thinking', name);
    assert.equal(result.isWaitingApproval, false, name);
    assert.equal(result.detail, '正在分析执行结果', name);
    assert.doesNotMatch([result.title, result.detail, result.currentTool].join(' '), /PRIVATE|subagent|mnemon_|send_message|list_agents|wait_agent|workflow|ralph/);
  }
  for (const [name, args] of [['subagent', { question: 'PRIVATE QUESTION' }], ['mnemon_recall', '{"question":"PRIVATE QUESTION"}']]) {
    const cursor = new ActivityCursor();
    const a = cursor.apply([event(1, 'tool/call', { callId: 'x', name, arguments: args })], 1001);
    assert.equal(a.status, 'waiting');
    assert.equal(a.isWaitingApproval, true);
    assert.equal(a.title, '等待人工确认');
    assert.equal(a.detail, '等待人工确认');
    assert.doesNotMatch([a.title, a.detail, a.currentTool].join(' '), /subagent|mnemon_recall|PRIVATE QUESTION/);
    const result = cursor.apply([event(2, 'tool/result', { callId: 'x' })], 1002);
    assert.equal(result.status, 'thinking');
    assert.equal(result.isWaitingApproval, false);
    assert.doesNotMatch([result.title, result.detail, result.currentTool].join(' '), /subagent|mnemon_recall|PRIVATE QUESTION/);
  }
});

test('assistant text cannot overwrite a pending sensitive operation or its approval state', () => {
  for (const [name, args, expectedStatus, expectedDetail] of [
    ['subagent', { description: 'PRIVATE INPUT' }, 'tool', '正在执行操作'],
    ['mnemon_recall', { question: 'PRIVATE QUESTION' }, 'waiting', '等待人工确认'],
  ]) {
    for (const [type, data] of [
      ['assistant/message', { text: 'PRIVATE GENERATED TOOL DETAILS' }],
      ['model/message', { message: { content: [{ type: 'reasoning', text: 'PRIVATE GENERATED TOOL DETAILS' }] } }],
    ]) {
      const cursor = new ActivityCursor();
      cursor.apply([event(1, 'tool/call', { callId: 'x', name, arguments: args })], 1001);
      const pending = cursor.apply([event(2, type, data)], 1002);
      assert.equal(pending.status, expectedStatus);
      assert.equal(pending.isWaitingApproval, expectedStatus === 'waiting');
      assert.equal(pending.detail, expectedDetail);
      const result = cursor.apply([event(3, 'tool/result', { callId: 'x' })], 1003);
      assert.equal(result.detail, '正在分析执行结果');
      const resumed = cursor.apply([event(4, 'assistant/message', { text: 'subagent 和 mnemon_recall 是文档里的普通文本' })], 1004);
      assert.equal(resumed.status, 'thinking');
      assert.equal(resumed.detail, 'subagent 和 mnemon_recall 是文档里的普通文本');
    }
  }
  const normal = new ActivityCursor();
  normal.apply([event(1, 'tool/call', { name: 'read', arguments: { file_path: 'normal.txt' } })], 1001);
  const text = normal.apply([event(2, 'assistant/message', { text: '普通文本提及 subagent' })], 1002);
  assert.equal(text.status, 'tool');
  assert.equal(text.detail, '普通文本提及 subagent');
});

test('assistant message preceding a structured sensitive tool call produces neutral activity', () => {
  for (const name of ['subagent', 'subagent_fork', 'send_message', 'mnemon_recall', 'mcp__mnemon__recall']) {
    for (const [ordinaryCallPosition, includeTopLevelText, contentKind] of [
      ['none', false, 'reasoning'], ['before', false, 'text'], ['after', false, 'both'], ['after', true, 'both'],
    ]) {
      const c = new ActivityCursor();
      c.apply([event(1, 'turn/start')], 1001);
      const parts = [];
      if (contentKind !== 'reasoning') parts.push({ type: 'text', text: 'PRIVATE TEXT ' + name });
      if (contentKind !== 'text') parts.push({ type: 'reasoning', text: 'PRIVATE REASONING ' + name });
      parts.push({ type: 'tool-call', name, arguments: { query: 'PRIVATE INPUT' } });
      const ordinaryCall = { type: 'tool-call', name: 'read', arguments: { file_path: 'normal.txt' } };
      if (ordinaryCallPosition === 'before') parts.unshift(ordinaryCall);
      if (ordinaryCallPosition === 'after') parts.push(ordinaryCall);
      const data = { message: { content: parts } };
      if (includeTopLevelText) data.text = 'PRIVATE TOP-LEVEL TEXT';
      const state = c.apply([event(2, 'assistant/message', data)], 1002);
      assert.equal(state.status, 'thinking');
      assert.doesNotMatch([state.title, state.detail, state.currentTool].join(' '), /PRIVATE|subagent|mnemon_/);
      c.apply([event(3, 'tool/call', { callId: 'hidden', name })], 1003);
      c.apply([event(4, 'tool/result', { message: { toolCallId: 'hidden' } })], 1004);
      assert.equal(c.apply([event(5, 'assistant/message', { text: '后续普通正文' })], 1005).detail, '后续普通正文');
    }
  }
});

test('a structured sensitive call does not overwrite a concurrent ordinary tool or approval', () => {
  for (const [name, args, status, detail] of [
    ['read', { file_path: 'normal.txt' }, 'tool', 'normal.txt'],
    ['ask_user_question', { question: '请确认普通事项' }, 'waiting', '提问: 请确认普通事项'],
  ]) {
    const c = new ActivityCursor();
    c.apply([event(1, 'tool/call', { callId: 'normal', name, arguments: args })], 1001);
    const state = c.apply([event(2, 'assistant/message', { message: { content: [
      { type: 'reasoning', text: 'PRIVATE REASONING' },
      { type: 'tool-call', name: 'mnemon_recall' },
    ] } })], 1002);
    assert.equal(state.status, status);
    assert.equal(state.isWaitingApproval, status === 'waiting');
    assert.equal(state.currentTool, name);
    assert.equal(state.detail, detail);
  }
});

test('ordinary structured calls and keyword-bearing text remain visible', () => {
  for (const name of ['read', 'subagent_helper', 'mcp__mnemon_extra__recall']) {
    const c = new ActivityCursor();
    c.apply([event(1, 'turn/start')], 1001);
    const content = [
      { type: 'text', text: '普通正文提及 subagent 和 mnemon_recall' },
      { type: 'reasoning', text: '普通推理提及 subagent 和 mnemon_recall' },
      { type: 'tool-call', name, arguments: { description: 'subagent mnemon_recall' } },
    ];
    const state = c.apply([event(2, 'assistant/message', { message: { content } })], 1002);
    assert.equal(state.status, 'thinking');
    assert.equal(state.detail, '普通推理提及 subagent 和 mnemon_recall');
  }
});

test('ordinary tools and message text containing keywords remain unchanged', () => {
  const cursor = new ActivityCursor();
  cursor.apply([event(1, 'tool/call', { callId: 'hidden', name: 'mnemon_recall', arguments: { description: 'PRIVATE' } })], 1001);
  cursor.apply([event(2, 'tool/result', { callId: 'hidden' })], 1002);
  const a = cursor.apply([event(3, 'tool/call', { callId: 'normal', name: 'read', arguments: { file_path: 'docs/subagent-mnemon_recall.txt' } })], 1003);
  assert.equal(a.status, 'tool');
  assert.equal(a.currentTool, 'read');
  assert.equal(a.title, '执行 read');
  assert.equal(a.detail, 'docs/subagent-mnemon_recall.txt');
  assert.equal(a.toolCount, 2);
  cursor.apply([event(4, 'tool/result', { callId: 'normal' })], 1004);
  const message = cursor.apply([event(5, 'assistant/message', { text: 'subagent 和 mnemon_recall 是文档里的普通文本' })], 1005);
  assert.equal(message.status, 'thinking');
  assert.equal(message.detail, 'subagent 和 mnemon_recall 是文档里的普通文本');

  for (const name of ['subagent_helper', 'not_subagent', 'x_mnemon_recall', 'mcp__mnemon_extra__recall']) {
    const c = new ActivityCursor();
    const ordinary = c.apply([event(1, 'tool/call', { callId: 'x', name, arguments: { description: '正常描述' } })], 1001);
    assert.equal(ordinary.currentTool, name);
    assert.equal(ordinary.title, '执行 ' + name);
    assert.equal(ordinary.detail, '正常描述');
  }
  const ask = new ActivityCursor().apply([event(1, 'tool/call', { name: 'ask_user_question', arguments: { question: '普通审批' } })], 1001);
  assert.equal(ask.status, 'waiting');
  assert.equal(ask.isWaitingApproval, true);
  assert.equal(ask.title, '执行 ask_user_question');
  assert.equal(ask.detail, '提问: 普通审批');
});

test('concurrent sensitive calls stay protected through ordinary results and release independently', () => {
  for (const resultOf of [id => ({ message: { toolCallId: id } }), id => ({ message: { source: { kind: 'tool', callId: id } } })]) {
    const c = new ActivityCursor();
    c.apply([event(1, 'tool/call', { callId: 'h1', name: 'subagent', arguments: { description: 'PRIVATE INPUT' } })], 1001);
    c.apply([event(2, 'tool/call', { callId: 'h2', name: 'mnemon_recall', arguments: { description: 'PRIVATE INPUT' } })], 1002);
    const normal = c.apply([event(3, 'tool/call', { callId: 'n', name: 'read', arguments: { file_path: 'normal.txt' } })], 1003);
    assert.equal(normal.currentTool, 'read');
    assert.equal(normal.detail, 'normal.txt');
    c.apply([event(4, 'tool/result', resultOf('n'))], 1004);
    const pending = c.apply([event(5, 'assistant/message', { text: 'PRIVATE GENERATED TOOL DETAILS' })], 1005);
    assert.equal(pending.status, 'tool');
    assert.equal(pending.currentTool, null);
    assert.doesNotMatch(pending.detail, /PRIVATE/);
    c.apply([event(6, 'tool/result', resultOf('h1'))], 1006);
    assert.doesNotMatch(c.apply([event(7, 'assistant/message', { text: 'PRIVATE SECOND TOOL DETAILS' })], 1007).detail, /PRIVATE/);
    c.apply([event(8, 'tool/result', resultOf('h2'))], 1008);
    const resumed = c.apply([event(9, 'assistant/message', { text: '正常正文提及 subagent' })], 1009);
    assert.equal(resumed.status, 'thinking');
    assert.equal(resumed.isWaitingApproval, false);
    assert.equal(resumed.detail, '正常正文提及 subagent');
  }
});

test('all concurrent result orderings protect until the last sensitive result', () => {
  function permutations(items) {
    if (items.length === 0) return [[]];
    return items.flatMap((item, i) => permutations(items.filter((_, j) => i !== j)).map(rest => [item, ...rest]));
  }
  for (const order of permutations(['h1', 'n1', 'h2', 'n2'])) {
    const c = new ActivityCursor();
    let seq = 0;
    for (const [id, name] of [['h1', 'subagent'], ['n1', 'read'], ['h2', 'mnemon_recall'], ['n2', 'write']]) {
      c.apply([event(++seq, 'tool/call', { callId: id, name })], 1000 + seq);
    }
    const pendingHidden = new Set(['h1', 'h2']);
    for (const id of order) {
      c.apply([event(++seq, 'tool/result', { message: { toolCallId: id } })], 1000 + seq);
      pendingHidden.delete(id);
      const state = c.apply([event(++seq, 'assistant/message', { text: 'PRIVATE STREAM' })], 1000 + seq);
      if (pendingHidden.size) assert.doesNotMatch(state.detail, /PRIVATE/, order.join(','));
      else assert.equal(state.detail, 'PRIVATE STREAM', order.join(','));
    }
  }
});

test('concurrent hidden results do not hide or clear a normal approval', () => {
  for (const hiddenFirst of [true, false]) {
    const c = new ActivityCursor();
    const hidden = event(1, 'tool/call', { callId: 'h', name: 'subagent', arguments: { description: 'PRIVATE' } });
    const normal = event(2, 'tool/call', { callId: 'n', name: 'ask_user_question', arguments: { question: '请确认普通事项' } });
    if (hiddenFirst) c.apply([hidden, normal], 1002);
    else c.apply([event(1, 'tool/call', normal.data), event(2, 'tool/call', hidden.data)], 1002);
    let state = c.apply([event(3, 'assistant/message', { text: 'PRIVATE GENERATED TOOL DETAILS' })], 1003);
    assert.equal(state.status, 'waiting');
    assert.equal(state.isWaitingApproval, true);
    assert.equal(state.currentTool, 'ask_user_question');
    assert.equal(state.detail, '提问: 请确认普通事项');
    state = c.apply([event(4, 'tool/result', { message: { toolCallId: 'h' } })], 1004);
    assert.equal(state.status, 'waiting');
    assert.equal(state.isWaitingApproval, true);
    assert.equal(state.detail, '提问: 请确认普通事项');
    state = c.apply([event(5, 'assistant/message', { text: '普通助手文本' })], 1005);
    assert.equal(state.status, 'waiting');
    assert.equal(state.detail, '提问: 请确认普通事项');
    state = c.apply([event(6, 'tool/result', { message: { source: { kind: 'tool', callId: 'n' } } })], 1006);
    assert.equal(state.status, 'thinking');
    assert.equal(state.isWaitingApproval, false);
  }
});

test('question replies do not release sensitive in-flight output', () => {
  const c = new ActivityCursor();
  c.apply([event(1, 'tool/call', { callId: 'hidden', name: 'subagent' })], 1001);
  c.apply([event(2, 'user/message', { source: { kind: 'user-question-reply' }, text: '用户回复' })], 1002);
  const state = c.apply([event(3, 'assistant/message', { text: 'PRIVATE GENERATED DETAILS' })], 1003);
  assert.doesNotMatch(state.detail, /PRIVATE/);
});

test('question replies preserve in-flight protection, ordinary approval and the turn counters', () => {
  for (const name of ['subagent', 'mnemon_recall']) {
    const c = new ActivityCursor();
    c.apply([event(1, 'turn/start', {})], 1001);
    c.apply([event(2, 'tool/call', { callId: 'hidden', name, arguments: { description: 'PRIVATE INPUT' } })], 1002);
    c.apply([event(3, 'tool/call', { callId: 'ask', name: 'ask_user_question', arguments: { question: '请确认普通事项' } })], 1003);
    let state = c.apply([event(4, 'user/message', { source: { kind: 'user-question-reply' }, text: '用户的回复' })], 1004);
    assert.equal(state.status, 'waiting');
    assert.equal(state.isWaitingApproval, true);
    assert.equal(state.detail, '提问: 请确认普通事项');
    assert.equal(state.toolCount, 2);
    assert.equal(state.visibleToolCount, 1);
    assert.equal(state.turnStartTime, 1001);
    state = c.apply([event(5, 'tool/result', { message: { toolCallId: 'ask' } })], 1005);
    assert.equal(state.status, 'tool');
    assert.equal(state.currentTool, null);
    state = c.apply([event(6, 'assistant/message', { text: 'PRIVATE GENERATED DETAILS' })], 1006);
    assert.doesNotMatch(state.detail, /PRIVATE/);
    c.apply([event(7, 'tool/result', { message: { toolCallId: 'hidden' } })], 1007);
    state = c.apply([event(8, 'assistant/message', { text: '正常正文' })], 1008);
    assert.equal(state.detail, '正常正文');
    assert.equal(state.toolCount, 2);
    assert.equal(state.visibleToolCount, 1);
  }
});

test('actual new user messages still reset pending calls and per-turn counts', () => {
  for (const source of [undefined, { kind: 'user' }, { kind: 'user-question-reply-other' }]) {
    const c = new ActivityCursor();
    c.apply([event(1, 'turn/start', {})], 1001);
    c.apply([event(2, 'tool/call', { callId: 'hidden', name: 'subagent' })], 1002);
    let state = c.apply([event(3, 'user/message', { source, text: '新指令' })], 1003);
    assert.equal(state.status, 'thinking');
    assert.equal(state.isWaitingApproval, false);
    assert.equal(state.toolCount, 0);
    assert.equal(state.visibleToolCount, 0);
    assert.equal(state.turnStartTime, 1003);
    state = c.apply([event(4, 'assistant/message', { text: '新回合正常正文' })], 1004);
    assert.equal(state.detail, '新回合正常正文');
  }
});

test('model completion and unmatched results do not end an in-flight sensitive call', () => {
  const c = new ActivityCursor();
  c.apply([event(1, 'tool/call', { callId: 'h', name: 'subagent', arguments: { question: 'PRIVATE QUESTION' } })], 1001);
  let state = c.apply([event(2, 'model/done', { text: 'PRIVATE MODEL OUTPUT' })], 1002);
  assert.equal(state.status, 'waiting');
  assert.equal(state.isWaitingApproval, true);
  assert.doesNotMatch(state.detail, /PRIVATE/);
  c.apply([event(3, 'tool/result', { message: { toolCallId: 'unrelated' } })], 1003);
  state = c.apply([event(4, 'assistant/message', { text: 'PRIVATE TOOL OUTPUT' })], 1004);
  assert.equal(state.status, 'waiting');
  assert.doesNotMatch(state.detail, /PRIVATE/);
  c.apply([event(5, 'tool/result', { message: { toolCallId: 'h' } })], 1005);
  assert.equal(c.apply([event(6, 'assistant/message', { text: '正常正文' })], 1006).detail, '正常正文');
});

test('ambiguous idless results keep protection until remaining calls can be matched', () => {
  const c = new ActivityCursor();
  c.apply([event(1, 'tool/call', { name: 'subagent', arguments: { description: 'PRIVATE' } })], 1001);
  c.apply([event(2, 'tool/call', { callId: 'n', name: 'read', arguments: { file_path: 'normal.txt' } })], 1002);
  c.apply([event(3, 'tool/result', {})], 1003);
  assert.doesNotMatch(c.apply([event(4, 'assistant/message', { text: 'PRIVATE GENERATED' })], 1004).detail, /PRIVATE/);
  c.apply([event(5, 'tool/result', { message: { toolCallId: 'n' } })], 1005);
  assert.equal(c.apply([event(6, 'assistant/message', { text: '正常正文' })], 1006).detail, '正常正文');
});

test('legacy idless single calls and turn boundaries release privacy protection', () => {
  const c = new ActivityCursor();
  c.apply([event(1, 'tool/call', { name: 'subagent', arguments: { description: 'PRIVATE' } })], 1001);
  assert.doesNotMatch(c.apply([event(2, 'assistant/message', { text: 'PRIVATE GENERATED' })], 1002).detail, /PRIVATE/);
  c.apply([event(3, 'tool/result', {})], 1003);
  assert.equal(c.apply([event(4, 'assistant/message', { text: '正常正文' })], 1004).detail, '正常正文');
  c.apply([event(5, 'tool/call', { callId: 'h', name: 'mnemon_recall', arguments: { description: 'PRIVATE' } })], 1005);
  c.apply([event(6, 'turn/end', {})], 1006);
  c.apply([event(7, 'turn/start', {})], 1007);
  assert.equal(c.apply([event(8, 'assistant/message', { text: '下回合正常正文' })], 1008).detail, '下回合正常正文');
});

test('visible tool totals exclude sensitive calls but keep internal counts', () => {
  const c = new ActivityCursor();
  c.apply([event(1, 'turn/start', {})], 1001);
  c.apply([event(2, 'tool/call', { callId: 'h', name: 'subagent' })], 1002);
  c.apply([event(3, 'tool/result', { callId: 'h' })], 1003);
  c.apply([event(4, 'tool/call', { callId: 'n', name: 'read' })], 1004);
  c.apply([event(5, 'tool/result', { callId: 'n' })], 1005);
  c.apply([event(6, 'tool/call', { callId: 'm', name: 'mcp__mnemon__recall' })], 1006);
  c.apply([event(7, 'tool/result', { callId: 'm' })], 1007);
  let state = c.apply([event(8, 'turn/end', {})], 1008);
  assert.equal(state.toolCount, 3);
  assert.equal(state.visibleToolCount, 1);
  assert.equal(state.detail, '调用 1 次工具');
  state = c.apply([event(9, 'turn/start', {})], 1009);
  assert.equal(state.toolCount, 0);
  assert.equal(state.visibleToolCount, 0);
});
