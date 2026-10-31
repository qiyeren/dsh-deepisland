// Windows 版配置层的自检。
//
// 用 `DSH_NOTCH_CONFIG` 把读写**隔离到临时目录** —— 生产路径是
// `%APPDATA%\DSHNotch\client-config.json`，一跑自检就把用户真实设置搅了，
// 那是不可接受的事故。
//
// 用法: node windows/test/config.test.js
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-notch-config-'));
process.env.DSH_NOTCH_CONFIG = path.join(TMP, 'client-config.json');

// 必须在设完 env 之后再 require —— storePath() 每次调用都读 env，
// 但模块顶层若缓存了就会失效，这里保持「先设后 require」的习惯。
const C = require(path.join(__dirname, '..', 'src', 'config.js'));

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
};

console.log('=== W1: 路径解析 ===');
check('storePath 读 DSH_NOTCH_CONFIG', C.storePath() === process.env.DSH_NOTCH_CONFIG, C.storePath());
delete process.env.DSH_NOTCH_CONFIG;
const prod = C.storePath();
check('生产路径在 %APPDATA%\\DSHNotch 下', prod.replace(/\\/g, '/').endsWith('/DSHNotch/client-config.json'), prod);
check('生产路径含 Roaming（APPDATA 语义）', /Roaming[/\\]DSHNotch/.test(prod) || !process.env.APPDATA, prod);
process.env.DSH_NOTCH_CONFIG = path.join(TMP, 'client-config.json');

console.log('\n=== W2: 文件不存在时的默认值 ===');
C.invalidate();
let v = C.load();
check('fileExists=false', v.fileExists === false);
check('缺字段不等于关闭 —— notchEnabled 默认 true', v.notchEnabled === true);
check('jumpEnabled 默认 true', v.jumpEnabled === true);
check('idleHide 默认 true', v.idleHide === true);
check('scale 默认 1.0', v.scale === 1.0);

console.log('\n=== W3: 读真实写的配置 ===');
fs.writeFileSync(C.storePath(), JSON.stringify({
  enabled: false, notchEnabled: false, jumpEnabled: false,
  hideWhenIdle: false, scale: 1.4, placement: 'top-center',
  someUnknownKey: 'x',
}));
C.invalidate();
v = C.load();
check('fileExists=true', v.fileExists === true);
check('domIslandEnabled ← enabled', v.domIslandEnabled === false);
check('notchEnabled ← notchEnabled', v.notchEnabled === false);
check('jumpEnabled ← jumpEnabled', v.jumpEnabled === false);
check('idleHide ← hideWhenIdle', v.idleHide === false);
check('scale ← scale', Math.abs(v.scale - 1.4) < 1e-9, String(v.scale));
check('raw 保留全部键（含未识别的）', v.raw.someUnknownKey === 'x');

console.log('\n=== W4: 坏值不污染（类型只认真正的 Bool/Number）===');
fs.writeFileSync(C.storePath(), JSON.stringify({
  notchEnabled: 'false', jumpEnabled: 0, scale: 99, hideWhenIdle: 'yes',
}));
C.invalidate();
v = C.load();
check('"false" 字符串不当布尔 → 保持默认 true', v.notchEnabled === true);
check('0 不当布尔 → jumpEnabled 保持默认 true', v.jumpEnabled === true);
check('"yes" 不当布尔 → idleHide 保持默认 true', v.idleHide === true);
check('scale 超出 0.5…2.0 → 保持 1.0', v.scale === 1.0, String(v.scale));

console.log('\n=== W5: mtime+size 缓存 ===');
fs.writeFileSync(C.storePath(), JSON.stringify({ notchEnabled: false }));
C.invalidate();
check('第一次读到 false', C.load().notchEnabled === false);
fs.writeFileSync(C.storePath(), JSON.stringify({ notchEnabled: true }));
check('文件变了但 stamp 一致时……（改内容后 size 变了，应能读到新值）',
  C.load().notchEnabled === true, String(C.load().notchEnabled));

console.log('\n=== W6: 写回与白名单 ===');
const toSave = { ...C.defaultValue() };
toSave.raw = { placement: 'top-left', junk: 'should-be-dropped' };
toSave.notchEnabled = true;
toSave.scale = 1.2;
check('save 返回 true', C.save(toSave) === true);
const written = JSON.parse(fs.readFileSync(C.storePath(), 'utf8'));
check('写回了 notchEnabled', written.notchEnabled === true);
check('写回了 scale', Math.abs(written.scale - 1.2) < 1e-9);
check('白名单内的 placement 保留', written.placement === 'top-left');
check('白名单外的 junk 被剔除', written.junk === undefined, JSON.stringify(written));
C.invalidate();
check('写回后 load 能读到', C.load().notchEnabled === true);

console.log('\n=== W7: toggleNotch ===');
fs.writeFileSync(C.storePath(), JSON.stringify({ notchEnabled: true }));
C.invalidate();
const after1 = C.toggleNotch();
check('true → false', after1 === false);
C.invalidate();
const after2 = C.toggleNotch();
check('false → true', after2 === true);

console.log('\n=== W8: 半截 JSON 不崩 ===');
fs.writeFileSync(C.storePath(), '{"notchEnabled": tr');
C.invalidate();
let threw = false;
try { v = C.load(); } catch { threw = true; }
check('读到坏 JSON 不抛错', !threw);
check('坏 JSON 时退回默认值（notchEnabled 仍为 true）', !threw && v.notchEnabled === true);

console.log('\n=== W9: equalBehavior ===');
const a = C.defaultValue();
const b = { ...C.defaultValue(), raw: { x: 1 } };
check('raw 不同不影响相等判定', C.equalBehavior(a, b) === true);
const c = { ...C.defaultValue(), notchEnabled: false };
check('notchEnabled 不同 → 不等', C.equalBehavior(a, c) === false);

console.log('\n=== W10: 提醒配置（nudgeMaxItems）必须穿过 save 白名单 ===');
// 这条是「静默丢数据」的那一类：save() 会剔掉 WHITELIST 外的键，而岛每次
// 切显隐/钉住都会 save 一次 —— 少列一个键，用户刚在设置面板调好的提醒
// 配置就会被随手一点抹掉，且文件里少几个键没有任何报错。
{
  const nudgeKeys = ['nudgeEnabled', 'nudgeOnCompleted', 'nudgeOnFailed', 'nudgeOnChoice',
    'nudgeAlertOnToolError', 'nudgeMuteRanges', 'nudgeMergeWindowMs',
    'nudgeMaxItems', 'nudgeTtlMinutes'];
  for (const k of nudgeKeys) {
    check('白名单含 ' + k, C.WHITELIST.includes(k));
  }
  check('插件服务端的 9 个提醒键一个都没漏', nudgeKeys.every((k) => C.WHITELIST.includes(k)));

  // 写回后仍然在文件里（这是 save 真的没有剔掉它们的证据，不是列表里有没有名字）
  fs.writeFileSync(C.storePath(), JSON.stringify({
    nudgeMaxItems: 6, nudgeMuteRanges: '22:00-08:00', nudgeEnabled: false,
  }));
  C.invalidate();
  const saved = { ...C.load() };
  check('save 后 nudgeMaxItems 仍在 raw 里', (() => {
    C.save(saved);
    const w = JSON.parse(fs.readFileSync(C.storePath(), 'utf8'));
    return w.nudgeMaxItems === 6;
  })(), JSON.stringify(JSON.parse(fs.readFileSync(C.storePath(), 'utf8'))));
  check('save 后 nudgeMuteRanges / nudgeEnabled 也都在', (() => {
    const w = JSON.parse(fs.readFileSync(C.storePath(), 'utf8'));
    return w.nudgeMuteRanges === '22:00-08:00' && w.nudgeEnabled === false;
  })());

  // 取值校验：1..8 之外退回默认 4（不 clamp 到边上的合法值）
  // ⚠️ 先删掉配置文件：上一段刚写进 nudgeMaxItems=6，不删的话下面测的是
  // 「读文件」而不是「文件不存在时的默认值」。
  try { fs.rmSync(C.storePath(), { force: true }); } catch { /* 没有就算了 */ }
  C.invalidate();
  check('配置文件不存在时 nudgeMaxItems 默认 4', C.load().nudgeMaxItems === 4, String(C.load().nudgeMaxItems));
  for (const [v0, want] of [[6, 6], [1, 1], [8, 8], [0, 4], [99, 4], [-2, 4], ['6', 4], [2.7, 2]]) {
    fs.writeFileSync(C.storePath(), JSON.stringify({ nudgeMaxItems: v0 }));
    C.invalidate();
    check('nudgeMaxItems=' + JSON.stringify(v0) + ' → ' + want + '（非法值退回默认）',
      C.load().nudgeMaxItems === want, String(C.load().nudgeMaxItems));
  }
  check('pickNudgeMaxItems 单独可用（主进程不需要 load 也能校验）',
    C.pickNudgeMaxItems(5) === 5 && C.pickNudgeMaxItems(undefined) === 4
      && C.pickNudgeMaxItems(0) === 4);
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 无所谓 */ }

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
