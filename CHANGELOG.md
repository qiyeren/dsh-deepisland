# Changelog

本 fork（`qiyeren/dsh-deepisland`）在上游 `myYangyunfan/dsh-deepisland` 基础上扩展。
版本号与上游同轨：**本 fork 的新增功能并入下一个 minor 版本**，上游的补丁改动照常合入。

## 未发布（目标 1.5.0）

### 新增：提醒（融合自 [`HalfDone03/dsh-nudge`](https://github.com/HalfDone03/dsh-nudge)）

上游 dsh-nudge 在三种时刻弹一张一次性 WPF 卡片（右下角、15 秒自消失、点击只能把
DSH 主窗口带到前台）。本 fork 保留它的事件语义，把承载换成常驻岛体：

- **三种时刻**：回合完成（`completed` / `max-tokens`）、等你批准或回答（`approval/request`
  与 `userQuestions.ask`）、执行失败（`turn/end` 的 `error` / `blocked`、以及单次 `tool/result` 失败）。
- **点击跳会话**：走既有 `/jump` 桥 → 渲染进程 `uiWorkspace.openSession(id)`，
  **真的切到那个会话**，而不是只把窗口带到前台让人自己找。
- **合并与去重**：同一会话同一类别在 `nudgeMergeWindowMs`（默认 1.2 秒）内只加计数；
  同一次工具失败的 `callId` 只记一次；子代理会话不单独提醒。
- **静音与开关**：`nudgeMuteRanges` 支持多段与跨零点；三类提醒各自独立开关
  （「完成」在长链路里很吵，而「待你选择」一条都不能漏，一个总开关会逼用户二选一）。
- **不占额外资源**：复用已有的 2 秒探桥周期拉 `/nudges`，不新增任何常驻高频定时器；
  不新增进程（原方案每次提醒都起一个 `powershell.exe`）。
- **不打扰**：只在岛体显示，不弹系统通知、不自动展开 HUD，也不抢焦点。

新增服务端端点（只监听 `127.0.0.1`，与既有桥同端口）：

```
GET  /nudges     -> { ok, plugin, version, rev, items: [...], config }
POST /nudge/ack  <- { "ids": ["..."] } | { "all": true }  -> { ok, removed, remaining }
```

新增配置键：`nudgeEnabled` / `nudgeOnChoice` / `nudgeOnFailed` / `nudgeOnCompleted` /
`nudgeAlertOnToolError` / `nudgeMuteRanges` / `nudgeMaxItems` / `nudgeMergeWindowMs` /
`nudgeTtlMinutes`（全部写 `client-config.json`，与其余配置同源，实时生效）。

设计与取舍：见 [`docs/nudge-fusion.md`](./docs/nudge-fusion.md)。
实现：`lib/nudge.js`（事件语义，纯 Node 可断言）+ `lib/index.js`（HTTP 搬运，挂在既有桥上）。

**已知边界（未做，不是遗漏）**

- **macOS 端未适配**：改动 Swift 无法在本机编译验证，贸然改会让上游 `release.yml`
  的 mac job 红掉。mac 侧需要 `SessionMonitor` 读 `/nudges` 并在 `NotchContentView`
  加提醒条 —— 留作独立任务。
- **全屏抑制未实现**：Electron 侧枚举前台全屏窗口的成本与回归面都大于收益，
  当前只在静音时段生效。

### 修复

- `test/test-bridge-client.mjs` 的端口断言写成了 `port > 47322`，隐含假设「系统分配的
  临时端口一定在 Windows 的 49152+ 区间」。本机实测不成立（`listen(0)` 给的是
  9000–17000 段，实测 9441 / 11845 / 17143），于是该断言**恒定失败**，
  bridgeclient 固定 31 通过 / 1 失败，并把红数带进 `test/run.mjs` 的全量统计 ——
  而它真正要保证的事情（端口不在 47311..47322 探测区间）一直成立。
  判据改成按意图写：端口在探测区间之外即可。全量统计由 447/1 变为 **448/0**。

### 自检

- `node test/run.mjs` —— 448 通过 / 0 失败（新增 `nudge` 79 项、`nudgebridge` 33 项）。
- 提醒语义与端点搬到两个独立套件（`test-nudge.mjs` / `test-nudge-bridge.mjs`）：
  桥起不来时语义层仍然是对的，混在一个套件里会让「哪一层坏了」看不出来。
