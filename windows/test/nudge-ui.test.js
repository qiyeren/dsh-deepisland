// 提醒 UI 的契约自检（`src/index.html` / `renderer.js` / `styles.css`）。
//
// 与 setup-entry.test.js 同一套做法：**源码断言 + 契约断言**。原因也一样 ——
// 这一层在纯 Node 里跑不起来（要 DOM 要 Electron），而它的错法全是静默的：
//   - `#c-nudge` 漏一个 id：徽标永远不出现，没有任何报错；
//   - 三档色散着写：某次改动只改了一处，徽标与行色条颜色对不上；
//   - `--glow` 在 CSS 里被再写一遍：renderer 每拍的覆盖会被静默盖掉，
//     症状是「颜色怎么改都不对」，而这是 v2 真踩过的坑（见 styles.css §状态色板）。
//
// 所以这里把 docs/nudge-fusion.md §2.2 逐条钉成断言。
//
// 用法: node windows/test/nudge-ui.test.js
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

const raw = {
  html: read('index.html'),
  renderer: read('renderer.js'),
  styles: read('styles.css'),
};

/**
 * 去掉注释后的源码。
 *
 * 为什么必须剥：本文件的注释里会写反例（「不许新增第二份 glow 变量」
 * 之类），不剥的话那些句子会把自己判成违规 —— setup-entry.test.js 的
 * 第一版就踩过这个坑，全红。
 */
function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const code = {
  renderer: stripComments(raw.renderer),
  styles: stripComments(raw.styles),
};

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
};

/** 数一段源码里某个模式出现几次（带 g 的正则会共享 lastIndex，这里重建）。 */
function count(src, re) {
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  return (src.match(r) || []).length;
}

/** 抽一个顶层函数的函数体（renderer 里都是 IIFE 内 2 空格缩进的 function）。 */
function fnBody(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return '';
  const start = src.indexOf('{', i);
  if (start < 0) return '';
  let depth = 0;
  for (let j = start; j < src.length; j++) {
    const ch = src[j];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(i, j + 1);
    }
  }
  return '';
}

console.log('=== U1: DOM 骨架（#c-nudge / #nudges / data-nudge ===');
{
  check('index.html 有折叠态徽标 #c-nudge', /id="c-nudge"/.test(raw.html));
  check('徽标初始就带 is-off（没有提醒时不占位）',
    /id="c-nudge"[^>]*class="[^"]*is-off/.test(raw.html),
    (raw.html.match(/id="c-nudge"[^>]*/) || [''])[0]);
  check('index.html 有展开态区块 #nudges', /id="nudges"/.test(raw.html));
  check('提醒区块初始 is-off（空板比空白更像 bug）',
    /id="nudges"[^>]*class="[^"]*is-off/.test(raw.html),
    (raw.html.match(/id="nudges"[^>]*/) || [''])[0]);
  check('#island 声明了 data-nudge（初值 none）',
    /id="island"[\s\S]{0,400}data-nudge="none"/.test(raw.html));
  check('徽标排在标题之后、胶囊之前（标题不能被挤掉）', (() => {
    const t = raw.html.indexOf('id="c-title"');
    const n = raw.html.indexOf('id="c-nudge"');
    const c = raw.html.indexOf('id="c-chip"');
    return t > 0 && n > t && c > n;
  })());
  check('提醒区块在待办之后、列表之前（它是列表的第 0 行）', (() => {
    const a = raw.html.indexOf('id="todo"');
    const b = raw.html.indexOf('id="nudges"');
    const c = raw.html.indexOf('id="list"');
    return a > 0 && b > a && c > b;
  })());
}

console.log('\n=== U2: data-nudge 四态 + 三档颜色变量各定义一次 ===');
{
  check('renderer 写 data-nudge 到 #island',
    /setAttr\(island, 'data-nudge', nudgeKindOf\(mainNudges\(\)\)\)/.test(code.renderer),
    (code.renderer.match(/setAttr\(island, 'data-nudge'[^)]*\)/g) || [''])[0]);
  check('nudgeKindOf 只产出四态 none|choice|failed|done',
    /return 'none'/.test(code.renderer) && /return 'choice'/.test(code.renderer)
      && /return 'failed'/.test(code.renderer) && /return 'done'/.test(code.renderer));
  check('CSS 里四态被真用到（choice / failed / done 各至少一条；none 是默认）',
    /\[data-nudge="choice"\]/.test(code.styles) && /\[data-nudge="failed"\]/.test(code.styles)
      && /\[data-nudge="done"\]/.test(code.styles));

  for (const [name, hex] of [['--nudge-choice', '#F5A623'], ['--nudge-failed', '#E74C3C'], ['--nudge-done', '#4ADE80']]) {
    const defs = count(code.styles, new RegExp(name + ':'));
    check(name + ' 只定义一次（散写必然分叉）', defs === 1, '共 ' + defs + ' 处');
    check(name + ' 的值是契约定值 ' + hex,
      new RegExp(name + ':\\s*' + hex + '\\s*;', 'i').test(code.styles),
      (code.styles.match(new RegExp(name + ':[^;]*')) || [''])[0]);
  }
  check('徽标三态用的是变量而不是硬编码色值',
    /\.nudge-badge\.choice\s*\{[\s\S]{0,120}?var\(--nudge-choice\)/.test(code.styles)
      && /\.nudge-badge\.failed\s*\{[\s\S]{0,120}?var\(--nudge-failed\)/.test(code.styles)
      && /\.nudge-badge\.done\s*\{[\s\S]{0,120}?var\(--nudge-done\)/.test(code.styles));
  check('行色条也走变量（三档各一条）',
    /\.nudge\[data-kind="needs_choice"\]\s*\{\s*--nudge-bar: var\(--nudge-choice\)/.test(code.styles)
      && /\.nudge\[data-kind="failed"\]\s*\{\s*--nudge-bar: var\(--nudge-failed\)/.test(code.styles)
      && /\.nudge\[data-kind="completed"\]\s*\{\s*--nudge-bar: var\(--nudge-done\)/.test(code.styles));
}

console.log('\n=== U3: --glow 仍只由 renderer 写（契约 §3 的铁律）===');
{
  // 这条是 v2 真踩过的坑：CSS 里按 [data-status] 再写一遍 --glow，
  // renderer 每拍 inline 覆盖会被静默盖掉，症状是「颜色怎么改都不对」。
  const cssAssign = count(code.styles, /--glow:/);
  check('CSS 里 --glow 只有 1 处赋值（:root 兜底灰，不是状态色板）',
    cssAssign === 1, '共 ' + cssAssign + ' 处：' + (code.styles.match(/--glow:[^;]*/g) || []).join(' | '));
  check('CSS 里没有任何 [data-status] 规则重新赋值 --glow',
    !/\[data-status="[a-z]+"\][\s\S]{0,200}?--glow:/.test(code.styles));
  check('CSS 里也没有 [data-nudge] 规则重新赋值 --glow（提醒只覆盖 BGAND 与徽标）',
    !/\[data-nudge="[a-z]+"\][\s\S]{0,200}?--glow:/.test(code.styles));
  check('renderer 是 --glow 的唯一写入方',
    /setCssVar\(root, '--glow', glow\)/.test(code.renderer));
  check('提醒覆盖色只在一处定义（NUDGE_GLOW 常量）',
    count(code.renderer, /#F5A623/) === 1 && count(code.renderer, /#E74C3C/) === 1,
    'F5A623 × ' + count(code.renderer, /#F5A623/) + ' / E74C3C × ' + count(code.renderer, /#E74C3C/));
}

console.log('\n=== U4: 覆盖规则本身（契约 §2.2 的三条）===');
{
  const onSnap = fnBody(code.renderer, 'onSnapshot');
  check('needs_choice 覆盖为琥珀 #F5A623', /nudgeTone === 'choice'\) glow = NUDGE_GLOW\.choice/.test(onSnap),
    onSnap.slice(0, 0));
  check('failed 且 status !== waiting 才覆盖为红（等待确认有自己的琥珀心跳）',
    /nudgeTone === 'failed' && status !== 'waiting'\) glow = NUDGE_GLOW\.failed/.test(onSnap));
  check('status 取自主会话（primary.status，缺省 idle）',
    /const status = state\.primary \? state\.primary\.status : 'idle'/.test(onSnap));
  check('其余情况维持原状态色（glow 先取 primary.glow）',
    /let glow = \(state\.primary && state\.primary\.glow\) \|\| GLOW_IDLE/.test(onSnap));
  check('NUDGE_GLOW 的值就是契约定值',
    /NUDGE_GLOW = \{ choice: '#F5A623', failed: '#E74C3C' \}/.test(code.renderer),
    (code.renderer.match(/NUDGE_GLOW = [^;]*/) || [''])[0]);
}

console.log('\n=== U5: 折叠徽标 —— ?N / !N / ✔N，N 是 count 之和 ===');
{
  check('三类的符号是 ? ! ✔',
    /needs_choice: \{ glyph: '\?'/.test(code.renderer)
      && /failed: \{ glyph: '!'/.test(code.renderer)
      && /completed: \{ glyph: '✔'/.test(code.renderer));
  check('N 取的是同类条目 count 之和（不是条目条数）',
    /function nudgeCountOf[\s\S]{0,400}n \+= \(typeof it\.count === 'number' && it\.count > 0\) \? it\.count : 1/.test(code.renderer));
  check('徽标文本 = 符号 + N', /setText\(badge, meta\.glyph \+ n\)/.test(code.renderer));
  check('没有提醒时徽标 is-off', /if \(tone === 'none'\) \{ setHidden\(badge, true\)/.test(code.renderer));
  check('徽标只显示最严重那一类（折叠条 380px 排不下三档并列）',
    /function nudgeKindOf[\s\S]{0,600}sev < best\.sev/.test(code.renderer));
  check('徽标带 data-kind 与 aria-label（读屏能听到「几条」）',
    /setAttr\(badge, 'data-kind', kind\)/.test(code.renderer)
      && /setAttr\(badge, 'aria-label', kindLabel\(kind\)/.test(code.renderer));
  check('徽标在 renderCompact 里被渲染（折叠态真的会画）',
    /function renderCompact[\s\S]{0,400}renderNudgeBadge\(mainNudges\(\)\)/.test(code.renderer));
}

console.log('\n=== U6: 展开列表 —— 行结构 / 增量复用 / 点击 ===');
{
  const rows = fnBody(code.renderer, 'createNudgeRow');
  check('行是 .nudge[data-id] + tabindex="-1"',
    /node\.className = 'nudge'/.test(rows) && /setAttribute\('data-id', id\)/.test(rows)
      && /setAttribute\('tabindex', '-1'\)/.test(rows));
  check('行结构 = 类色条 + label + detail + at（契约 §2.2）',
    /node\.append\(bar, label, detail, at\)/.test(rows));
  check('行内节点类名与 CSS 对得上（nudge-bar / nudge-label / nudge-detail / nudge-at）',
    /className = 'nudge-bar'/.test(rows) && /className = 'nudge-label'/.test(rows)
      && /className = 'nudge-detail'/.test(rows) && /className = 'nudge-at mono'/.test(rows));
  check('CSS 里这四个类都有定义（用了未定义的类会静默回退默认样式）',
    ['.nudge-bar', '.nudge-label', '.nudge-detail', '.nudge-at']
      .every((c) => new RegExp('\\' + c + '\\s*\\{').test(code.styles)));

  check('行按 id 增量复用（与会话行同一套纪律）',
    /state\.nudgeRows\.get\(item\.id\)/.test(code.renderer)
      && /state\.nudgeRows\.set\(item\.id, row\)/.test(code.renderer)
      && /host\.insertBefore\(row\.node/.test(code.renderer));
  check('不再展示的提醒行被移除（不是留着占位）',
    /for \(const \[id, row\] of state\.nudgeRows\)[\s\S]{0,160}row\.node\.remove\(\); state\.nudgeRows\.delete\(id\);/.test(code.renderer));
  check('渲染层**不做** label fallback（契约 §2.1：主进程已算 title || shortId）',
    !/item\.label \|\| item\.shortId/.test(code.renderer) && !/item\.title \|\| item\.shortId/.test(code.renderer));
  check('count>1 时显示 ×N', /' ×' \+ item\.count/.test(code.renderer));
  check('at 用服务端给的 HH:MM（不在渲染层重算，两台机器的钟不同）',
    /const atText = item\.at \|\| ''/.test(code.renderer) && !/new Date\(item\.atMs\)/.test(code.renderer));
  check('空列表整块 is-off', /setHidden\(host, items\.length === 0\)/.test(code.renderer));

  // 点击顺序必须是「先 jump 再 ack」：反过来的表现是「行没了，但 DSH 没切过去」
  const act = fnBody(code.renderer, 'handleNudgeClick');
  check('点击行 → jump 携带提醒 id 供主进程捕获',
    /window\.island\.jump\(\{ id, label: item\.label \|\| '', nudgeId: item\.id \}\)/.test(act));
  check('点击行 → window.island.nudgeAck({ ids: [item.id] })',
    /window\.island\.nudgeAck\(\{ ids: \[item\.id\] \}\)/.test(act));
  check('先 jump 再 ack（顺序反了用户会以为点错）',
    act.indexOf('window.island.jump(') < act.indexOf('window.island.nudgeAck('),
    'jump@' + act.indexOf('window.island.jump(') + ' ack@' + act.indexOf('window.island.nudgeAck('));
  check('jump 用 sessionId 而不是提醒自己的 id（那是 ack 的凭据）',
    /const id = item\.sessionId \|\| ''/.test(act));
  check('等待 bridged 后才 ack；只有 ack 成功才本地移除',
    /await window\.island\.jump/.test(act) && /result\.kind !== 'bridged'/.test(act)
      && /await window\.island\.nudgeAck/.test(act) && /ack\.ok === true/.test(act)
      && /result\.nudgeCaptured !== true/.test(act)
      && /state\.nudges = state\.nudges\.filter\(\(n\) => n !== item\)[\s\S]{0,80}render\(\)/.test(act));

  check('提醒行事件委托挂在 #nudges 上（行复用不重绑）',
    /\$\('nudges'\)\.addEventListener\('click'/.test(code.renderer));
  check('点提醒行不会顺带钉住（hud 空白分支里先 return）',
    /if \(target\.closest\('#nudges \.nudge'\)\) return;/.test(code.renderer));
  check('提醒行算「有自己语义的可点区」（拖窗按下不启动）',
    /isClickControl[\s\S]{0,200}closest\('\[data-act\], \.row, #detail, #stats, \.nudge'\)/.test(code.renderer));
}

console.log('\n=== U7: 键盘 —— 提醒行不参与 ↑/↓（不许与会话行抢焦点）===');
{
  const key = stripComments(raw.renderer);   // 键盘块里有注释讲到这件事
  check('↑/↓ 仍按 state.entries 的下标走（提醒不进这一套索引）',
    /function moveFocus[\s\S]{0,300}state\.entries\.slice\(0, 6\)/.test(key));
  check('Enter 仍只跳会话行',
    /ev\.key === 'Enter' && state\.focusIndex >= 0[\s\S]{0,200}state\.entries\[state\.focusIndex\]/.test(key));
  check('focusIndex 只由会话行数约束（updateRow 里写 focused）',
    /setClass\(row\.node, 'focused', index === state\.focusIndex\)/.test(code.renderer));
  check('提醒行不写 focused class（否则会与会话行抢同一个焦点环）',
    !/setClass\(row\.node, 'focused'[\s\S]{0,200}nudgeRows/.test(code.renderer)
      && !/nudgeRows[\s\S]{0,200}setClass\([^)]*'focused'/.test(code.renderer));
  check('提醒行仍可有键盘焦点环（tabindex + :focus-visible，只读可达性）',
    /\.nudge:focus-visible/.test(code.styles));
}

console.log('\n=== U8: 样式 —— 双门控 / no-drag / 不新增第二份 glow ===');
{
  check('提醒行带 -webkit-app-region: no-drag',
    /\.nudge\s*\{[\s\S]{0,400}?-webkit-app-region: no-drag/.test(code.styles));
  check('循环/脉冲类动画受 data-glow="0" 门控（本文件已有的那道闸仍然覆盖提醒）',
    (code.styles.match(/\[data-glow="0"\]/g) || []).length >= 2);
  check('reduced-motion 全量让位（animation:none !important 仍在）',
    /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,400}?animation: none !important/.test(code.styles));
  check('提醒的强调只有 opacity，不是新的一份 --glow 变量',
    /\.island\[data-nudge="choice"\] \.band,/.test(code.styles)
      && /\.island\[data-nudge="failed"\] \.band,/.test(code.styles)
      && /\.island\[data-nudge="done"\] \.band \{/.test(code.styles));
  check('提醒强调不能把常态内发光带掐掉（只写 opacity:1，不写 0）', (() => {
    const seg = code.styles.slice(code.styles.indexOf('[data-nudge="choice"] .band,'));
    const block = seg.slice(seg.indexOf('{'), seg.indexOf('}') + 1);
    return /opacity:\s*1/.test(block) && !/opacity:\s*0/.test(block);
  })());
  check('禁用 transition: all（契约 §6.2）',
    !/transition\s*:[^;}]*\ball\b/.test(code.styles));
  check('提醒样式里不对 box-shadow / filter 做过渡',
    !/\.nudge[\s\S]{0,300}transition:\s*[^;}]*?(box-shadow|filter)/i.test(code.styles));
  check('提醒区块参与分层入场阶梯（110ms，与 list 同档）',
    /\.hud > \.nudges\s*\{ animation-delay: 110ms; \}/.test(code.styles));
  check('.nudges:empty 时不显示（结构空着也不占位）',
    /\.nudges:empty \{ display: none; \}/.test(code.styles));
}

console.log('\n=== U9: 不做自动展开（契约 §4.3 不允许打断别人）===');
{
  const shouldExpand = fnBody(code.renderer, 'shouldExpand');
  // 判据是「提醒**本身**不构成一条展开理由」，不是「函数里不许出现 nudges」：
  // 提醒确实参与空板判定（没会话但有提醒时，悬停要能展开 —— 否则折叠条上
  // 的徽标点开是空的）。所以这里按意图分成两条断言：
  //   1. 三条 return true 里都不含 nudges（提醒不是理由）；
  //   2. 提醒只出现在第一行空板判定里，且与 entries 是同一条「都没有」。
  check('shouldExpand 里没有「有提醒就展开」这条 return true', (() => {
    // 逐**语句**判（按分号切），不是按字符窗口滑 — 滑动窗口会把下一条
    // `if (state.pinned) return true;` 也算进「nudges 附近」，误报。
    const stmts = shouldExpand.split(';').filter((s) => /nudges/.test(s));
    return stmts.length > 0 && stmts.every((s) => !/return true/.test(s));
  })(), shouldExpand.split(';').filter((s) => /nudges/.test(s)).join(' | ').replace(/\n/g, ' '));
  check('提醒只参与空板判定（与 entries 判同一条「都没有」）',
    /if \(!state\.entries\.length && !state\.nudges\.length\) return false;/.test(shouldExpand)
      && (shouldExpand.match(/nudges/g) || []).length === 1,
    'nudges 出现 ' + (shouldExpand.match(/nudges/g) || []).length + ' 次');
  check('它仍只认 pinned / waiting / 悬停（三条原口径不变）',
    /if \(state\.pinned\) return true;/.test(shouldExpand)
      && /state\.primary && state\.primary\.status === 'waiting'/.test(shouldExpand)
      && /config\(\)\.expandOnHover && state\.overIsland/.test(shouldExpand));
  check('没有为提醒新增常驻定时器（renderer 里 setInterval 只有那两处既有兜底）',
    (code.renderer.match(/setInterval\(/g) || []).length === 1,
    '共 ' + (code.renderer.match(/setInterval\(/g) || []).length + ' 处');
}

console.log('\n=== U10: 快照侧协作（提醒真的会到渲染层）===');
{
  check('onSnapshot 读 snap.nudges 并兜成数组',
    /state\.nudges = Array\.isArray\(snap\.nudges\) \? snap\.nudges : \[\]/.test(code.renderer));
  check('render 每拍写 data-nudge（不是只在折叠态）',
    /setAttr\(island, 'data-nudge'/.test(fnBody(code.renderer, 'render')));
  check('HUD 里真的会渲染提醒区块',
    /function renderHud[\s\S]{0,2000}renderNudges\(mainNudges\(\)\)/.test(code.renderer),
    String(/function renderHud[\s\S]{0,2000}renderNudges\(mainNudges\(\)\)/.test(code.renderer)));
}

console.log('\n=== U11: 截图脚本（README 的视觉证据不能与线上形状分叉）===');
{
  // 为什么这组要放在这里：`scripts/shots.js` 是 README 里所有图的来源，但它
  // 合成快照时**自己写一份 DTO**（不走 buildSnapshot）。一旦它漏了新字段，
  // 图就拍不出那个功能 —— 而图是最有说服力的证据，漏了等于这个功能「不存在」。
  // 实测踩过：提醒 UI 做完后第一轮出图完全没有提醒区，因为 shots.js 的
  // snap() 里根本没有 nudges 字段。
  const shotsCode = stripComments(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'shots.js'), 'utf8'));

  check('shots.js 的合成快照带 nudges 字段',
    /nudges:\s*Array\.isArray\(nudges\)\s*\?\s*nudges\s*:\s*\[\]/.test(shotsCode));
  check('shots.js 有提醒场景（否则提醒区永远没有视觉证据）',
    /name:\s*'(hud-nudges|compact-nudge)'/.test(shotsCode));
  check('shots.js 提供 nudge() 合成器（字段口径与 nudgesDto 对齐）',
    /function nudge\(o\)/.test(shotsCode));

  // 同一个场景名出现两次 → 后者覆盖前者，出图数量与打印对不上，且没有报错。
  // 实测踩过：把某个场景挪到列表末尾时原位置没删干净，同名场景写了两份。
  const names = (shotsCode.match(/name:\s*'([a-z0-9-]+)'/g) || [])
    .map((m) => m.replace(/name:\s*'|'/g, ''));
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  check('场景名不重复（重名会静默覆盖前一张图）',
    dup.length === 0, '重复: ' + dup.join(','));

  // 「靠调整场景顺序避开悬停状态泄漏」已经掩盖过两次这个真问题。这里钉住
  // 「每个场景自己重置 + 等到真的展开」，这样再加场景也不会再踩。
  check('每个场景推快照前先重置悬停（不依赖场景顺序）',
    /clientX:\s*-100/.test(shotsCode));
  check('悬停场景等到 data-expanded=1 才截图（不蒙时延）',
    /await waitExpanded\(win/.test(shotsCode) && /function waitExpanded/.test(shotsCode));
}

console.log('\n' + '='.repeat(44));
console.log('通过 ' + pass + ' / 失败 ' + fail);
console.log('='.repeat(44));
process.exitCode = fail > 0 ? 1 : 0;
