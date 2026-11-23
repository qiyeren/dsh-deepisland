// Windows 主岛展开即展示会话状态和普通提醒；紧急提醒仍属独立子岛。
// 渲染行为、几何与交互由 urgent-island.electron.js / expanded-layout.electron.js 覆盖。
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

console.log('=== U1: 独立的提醒区，不污染会话状态 ===');
{
  check('没有折叠提醒徽标或数据仪表', !/id="(?:c-nudge|c-gauge|c-elapsed)"/.test(raw.html));
  check('普通提醒没有二级折叠入口', raw.html.includes('id="nudges"') && !/<(?:summary|details)\b/.test(raw.html));
  check('紧急提醒有自己可访问的关闭和跳转按钮', ['urgent-close', 'urgent-jump'].every(id => new RegExp('<button id="' + id + '"[^>]*aria-label="[^"]+"').test(raw.html)));
  check('提醒不写入主会话状态色', !/NUDGE_GLOW|nudgeTone/.test(code.renderer));
  for (const [name, hex] of [['--nudge-choice', '#F5A623'], ['--nudge-failed', '#E74C3C'], ['--nudge-done', '#4ADE80']]) {
    check(name + ' 色板唯一', count(code.styles, new RegExp(name + ':')) === 1 && code.styles.includes(name + ': ' + hex));
  }
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
    /isClickControl[\s\S]{0,200}closest\('\[data-act\], \.row, \.nudge'\)/.test(code.renderer));
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
  check('禁用 transition: all（契约 §6.2）',
    !/transition\s*:[^;}]*\ball\b/.test(code.styles));
  check('提醒样式里不对 box-shadow / filter 做过渡',
    !/\.nudge[\s\S]{0,300}transition:\s*[^;}]*?(box-shadow|filter)/i.test(code.styles));
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
  check('提醒不需常驻定时器', !code.renderer.includes('setInterval('));
}

console.log('\n=== U10: 快照侧协作（提醒真的会到渲染层）===');
{
  check('onSnapshot 读 snap.nudges 并兜成数组',
    /state\.nudges = Array\.isArray\(snap\.nudges\) \? snap\.nudges : \[\]/.test(code.renderer));
  check('expanded 时消费独立提醒列表', fnBody(code.renderer, 'render').includes('renderNudges(mainNudges())'));
  check('每次渲染都更新紧急子岛', fnBody(code.renderer, 'render').includes('renderUrgentIsland()'));
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
