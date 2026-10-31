# 提醒融合契约（nudge × DeepIsland）

上游 `HalfDone03/dsh-nudge` 的三种「该你处理了」时刻（**任务完成 / 需要你选择 / 执行失败**），
改成由常驻的岛体承载，而不是每次都弹一张一次性 WPF 卡片。

理由写在本文 §0；接口形状写死在这里，Host 侧与 Windows app 侧分别按 §1 / §2 实现，
**两侧不得各自发明字段名**。

---

## §0 为什么融合在岛体，而不是把弹窗搬过来

| 维度 | nudge 现状 | 融合后 |
| --- | --- | --- |
| 载体 | `powershell.exe` + WPF 一次性 helper（每次约 100–200ms 启动、60–80MB） | 已经在跑的岛，零新增进程 |
| 位置 | 桌面右下角，盖在任务栏上方 | 屏幕顶端常驻，不挡内容 |
| 点击 | `SetForegroundWindow` 聚焦 DSH 主窗口（**没有会话级深链**，只能人工找） | `POST /jump` → 渲染进程 `uiWorkspace.openSession(id)`，**真的跳到那个会话** |
| 多条提醒 | 1.2s 合并窗口内合成一张卡 | 同样合并，并且常驻可见，不会 15 秒后自己消失 |
| 静音 | Host 侧判时段，不生成 | 相同 |
| 全屏抑制 | helper 判前台全屏 | **未实现**（见 §4 已知边界） |

nudge 的真正价值是**事件语义**（三类、严重度、合并、静音），不是那张 WPF 卡；
岛体本来就是「常驻状态显示器」，把事件语义接进来才是这两者最自然的结合点。

---

## §1 Host 侧接口（服务端，`lib/`）

### 1.1 采集（新文件 `lib/nudge.js`，ESM，只依赖 `node:`）

事件源（与 dsh-nudge 取证一致，见 `HalfDone03/dsh-nudge` 的 `docs/api-notes.md`）：

| 时刻 | 来源 | 判定 |
| --- | --- | --- |
| 完成 | `ctx.on('session/event')` → `turn/end` | `reason.kind` ∈ `completed` / `max-tokens`；`max-tokens` 明细写「输出被长度上限截断」 |
| 失败 | 同上 | `reason.kind` ∈ `error` / `blocked`（`blocked` 是「本回合没有执行」，不算完成）；`aborted` 不提醒 |
| 失败 | 同上 → `tool/result` | `message.isError === true` 或 `error !== undefined`；同一 `callId` 只记一次 |
| 待选择 | `ctx.on('approval/request', (req, next) => …)` | waterfall 观察者，**必须 `return next()`**，否则劫持审批链 |
| 待选择 | 包装 `ctx.get('userQuestions').ask` | 原样转发，卸载时还原原函数并删掉幂等标记 |
| 标题 | `session/title` 事件 → 本地缓存 | 另外**每次需要时**再试 `ctx.get('sessionTitle').get(session).title`；**不要读 `session.header.title`**（该字段不存在） |

过滤：`session.header.parentSession != null` 或 `delegationDepth > 0` 的子代理会话**不提醒**
（父会话会汇总，单独弹是噪音）。

生成条目时的字段归一：

- `sessionId`：`session.header.id ?? 'unknown'`
- `project`：`session.header.cwd` 按 `[\\/]+` 切开取最后一段（空则 `''`）
- `detail`：压成单行（去换行/堆栈尾巴/连续空白），超 140 字截断加 `…`
- `at`：`HH:MM`；`atMs` / `ts`：毫秒时间戳

### 1.2 合并与去重

- 合并窗口 `mergeWindowMs`（默认 1200）：窗口内同 `(kind, sessionId)` 的重复事件**累加 `count`**，不新建条目
- 队列上限 `maxItems` 之外的旧条目丢弃（按 `ts` 先进先出）
- 同一条目 TTL 30 分钟；`ack` 立即移除

### 1.3 HTTP（挂在既有跳转桥上，`127.0.0.1`，`lib/index.js`）

```
GET  /nudges
     -> { ok: true, plugin, version, rev, items: NudgeItem[] }
POST /nudge/ack
     body: { ids: string[] } | { all: true }
     -> { ok: true, removed: number, remaining: number, rev }
```

`NudgeItem`：

```json
{
  "id": "needs_choice::session-abc::7",
  "kind": "completed | needs_choice | failed",
  "severity": 0,
  "sessionId": "session-abc",
  "title": "会话标题（可能为空串）",
  "project": "默认工作区",
  "detail": "等待你批准一个操作",
  "at": "19:55",
  "atMs": 1793000000000,
  "count": 1,
  "ts": 1793000000000
}
```

- `severity`：`needs_choice = 0` < `failed = 1` < `completed = 2`（**数字越小越该处理**）
- `rev`：内容指纹（`id`+`count`+`ts` 的稳定序列化哈希），app 侧靠它判「要不要重新渲染」
- 响应带 `plugin` 名回显，与 `/health` 一致，让 app 侧能确认「这个端口的服务真是本插件」

### 1.4 配置（写 **`client-config.json`**，与其余配置同源，不改 `Config(z.object)`）

`CONFIG_ALLOWED` 增键（类型即注释）：

| 键 | 类型 | 默认 | 语义 |
| --- | --- | --- | --- |
| `nudgeEnabled` | boolean | `true` | 总开关；false 时 `/nudges` 恒返回空 |
| `nudgeOnCompleted` | boolean | `true` | 完成类是否记录 |
| `nudgeOnFailed` | boolean | `true` | 失败类是否记录 |
| `nudgeOnChoice` | boolean | `true` | 待选择类是否记录 |
| `nudgeAlertOnToolError` | boolean | `true` | 单次工具失败是否也算失败 |
| `nudgeMuteRanges` | string | `'22:00-08:00'` | `HH:MM-HH:MM,HH:MM-HH:MM`，支持跨零点、可空串关闭 |
| `nudgeMergeWindowMs` | number | `1200` | 合并窗口，200..10000 |
| `nudgeMaxItems` | number | `4` | 岛上一屏最多列几条，1..8 |
| `nudgeTtlMinutes` | number | `30` | 条目 TTL，1..1440 |

## §2 Windows app 侧接口

### 2.1 数据层

- 新文件 `windows/src/nudges.js`（CommonJS，纯 Node，**可被 `node` 直接断言**）：读 `bridge.json` 拿端口 → `GET /nudges` → 校验 `plugin` 名 → 返回 `{ ok, rev, items }`；桥不在/超时/非本插件 → 返回 `{ ok:false, rev:'', items:[] }`（**静默降级，不得抛**）
- `windows/src/main.js`：复用既有 **2 秒探桥周期**拉一次 `/nudges`（**不新增任何高频定时器**，契约 §7）；拿到后按 `cfg.nudgeMaxItems` 截断，与上次 `rev` 相同则跳过；`island:nudge-ack` IPC 转发 `POST /nudge/ack`
- `windows/src/preload.js`：新增 `nudgeAck(payload)`（通道名 `island:nudge-ack`，**必须与 main.js 的 `ipcMain.handle` 逐字一致**）
- `windows/src/snapshot.js`：`buildSnapshot` 入参增加 `nudges`，作为**顶层字段**进 payload（同时进 `rev` 计算）；白名单 DTO：

```js
nudges: [ { id, kind, severity, sessionId, label, detail, at, count } ]
```

`label` = `title || shortId`（渲染层不再做 fallback）；`detail` 已在主进程截断到 ≤120 字。
空数组时该字段仍是空数组（稳定序列化，不影响 rev 抖动）。

### 2.2 UI

- 折叠态：`#c-nudge` 徽标（`is-off` 时隐藏），文本按最严重那类取符号 + 计数：`needs_choice` → `?N`、`failed` → `!N`、`completed` → `✔N`
- 岛体根节点新增 `data-nudge="none|choice|failed|done"`
- `--glow` **仍由 renderer 唯一写入**：`needs_choice` 覆盖为琥珀 `#F5A623`；`failed` 且当前 `status !== 'waiting'` 覆盖为红 `#E74C3C`；其余维持原状态色
- 展开 HUD：`#nudges` 区块（空则 `is-off`），每行 = 类色条 + `label` + `detail` + `at`；点击行 = `window.island.jump({ id, label })` 然后 `window.island.nudgeAck({ ids: [id] })`
- 样式：三色常量只定义一次；循环动画受 `data-glow="0"` 与 `prefers-reduced-motion` 双门控（与既有纪律一致）

## §3 测试要求

- 数据层：`windows/test/nudges.test.js` 进 `test/run.js` 默认套件（fake http/fetch，桥缺失降级、插件名不符拒绝、rev 去重、截断）
- 快照：扩展既有 `snapshot.test.js` —— `nudges` 变化必须改 `rev`，`nudges` 为空时 rev 稳定
- UI：`windows/test/nudge-ui.test.js` —— `index.html` 有 `#c-nudge` / `#nudges`、三色 CSS 各定义一次、`data-nudge` 四态、`--glow` 仍只由 renderer 写
- Host：`node test/run.mjs` 全绿；`/nudges` 与 `/nudge/ack` 走 `test-bridge.mjs` 同款起服务断言

## §4 已知边界（**不许装作能做到**）

1. **macOS 端未适配**：本机无 macOS/Swift 工具链，改 Swift 无法编译验证，贸然改会让上游 `release.yml` 的 mac job 红掉。mac 侧需要 `SessionMonitor` 读 `/nudges` 并在 `NotchContentView` 加提醒条 —— 留作独立任务。
2. **全屏抑制未实现**：Electron 侧要枚举前台全屏窗口，成本与回归面都大于收益；当前只在静音时段生效。
3. **不抢焦点**：提醒**只在岛体内显示**，不弹系统通知、不自动展开 HUD（避免打断正在全屏操作的人）。用户悬停才看到明细。
