# 提醒融合契约（nudge × DeepIsland）

上游 `HalfDone03/dsh-nudge` 的三种「该你处理了」时刻（**任务完成 / 需要你选择 / 执行失败**），
改成由常驻的岛体承载，而不是每次都弹一张一次性 WPF 卡片。

本文描述当前工作区源码及其设计契约，不代表已经安装、运行或验证的版本。本次未为 fork 构建发行版；上游 Release 不包含本 fork 的保证。桥接安全与浏览器 API 改动仍在进行中，下文涉及这些内容时是设计意图，须以后续验证为准。融合呈现仅适配 Windows，macOS 尚未适配。

---

## §0 为什么融合在岛体，而不是把弹窗搬过来

| 维度 | nudge 现状 | 融合后 |
| --- | --- | --- |
| 载体 | `powershell.exe` + WPF 一次性 helper | 复用 Windows 岛体；不对资源占用或启动时间作未经验证的量化 |
| 位置 | 桌面右下角，盖在任务栏上方 | 屏幕顶端岛体，可能遮挡内容 |
| 点击 | 聚焦 DSH 主窗口 | `POST /jump` 入队，客户端尝试 `uiWorkspace.openSession(id)`；入队不证明已打开 |
| 多条提醒 | 合并窗口内合成一张卡 | 在合并窗口内合并，受配置、容量、TTL 和确认影响 |
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
| 单次工具失败 | 同上 → `tool/result` | 不单独生成失败提醒；任务可能继续或恢复，最终回合失败仍按 `turn/end` 提醒 |
| 待选择 | `ctx.on('approval/request', (req, next) => …)` | waterfall 观察者，**必须 `return next()`**，否则劫持审批链 |
| 待选择 | 包装 `ctx.get('userQuestions').ask` | 原样转发，卸载时还原原函数并删掉幂等标记 |
| 标题 | `session/title` 事件 → 本地缓存 | 另外**每次需要时**再试 `ctx.get('sessionTitle').get(session).title`；**不要读 `session.header.title`**（该字段不存在） |

过滤：对 `session/event`，忽略 `session.header.parentSession != null` 或 `delegationDepth > 0` 的子代理会话。审批与提问路径不做该过滤，因此子代理的待选择请求仍可能产生提醒；不要假定父会话一定汇总所有子任务事件。

生成条目时的字段归一：

- `sessionId`：`session.header.id ?? 'unknown'`
- `project`：`session.header.cwd` 按 `[\\/]+` 切开取最后一段（空则 `''`）
- `detail`：压成单行（去换行/堆栈尾巴/连续空白），超 140 字截断加 `…`
- `at`：`HH:MM`；`atMs` / `ts`：毫秒时间戳

### 1.2 合并与去重

- 合并窗口 `mergeWindowMs`（默认 1200）：窗口内同 `(kind, sessionId)` 的重复事件累加 `count`，并将条目 ID 轮换为新 UUID；旧快照的确认不会删除合并后的新版本。每组同时持有独立的随机 `lineageId` 和递增 `generation`，用于辨别合并代次；它们不是身份认证凭据。
- 队列上限 `maxItems` 之外的旧条目丢弃（按 `ts` 先进先出）
- 同一条目 TTL 30 分钟；`ack` 立即移除。
- 待选择提醒在已跟踪的所有合并请求明确结算后标为 `resolved: true`，只影响紧急子岛展示，不执行 `ack` 或删除提醒。问题答复须有成功答案，或在迟答场景观察到匹配 callId 的已接纳回复；审批的允许、拒绝和取消算结算，未知结果、超时和异常保守保留。跟踪仅在当前插件进程内，未观察到请求或匹配失败时不能保证自动消失。

### 1.3 HTTP（挂在既有跳转桥上，`127.0.0.1`，`lib/index.js`）

```
GET  /nudges
     -> { ok: true, plugin, version, rev, items: NudgeItem[] }
POST /nudge/ack
     body: { ids: string[] }  // 1–8 个已观察到的 ID；不支持 all
     -> { ok: true, plugin, version, removed: number, remaining: number }
```

`NudgeItem`：

```json
{
  "id": "0f3d5c70-7789-4c80-88c2-e14a42211111",
  "lineageId": "a42d5c70-7789-4c80-88c2-e14a42222222",
  "generation": 1,
  "kind": "completed | needs_choice | failed",
  "severity": 0,
  "sessionId": "session-abc",
  "title": "会话标题（可能为空串）",
  "project": "默认工作区",
  "detail": "等待你批准一个操作",
  "at": "19:55",
  "atMs": 1793000000000,
  "count": 1,
  "resolved": false,
  "ts": 1793000000000
}
```

- `severity`：`needs_choice = 0` < `failed = 1` < `completed = 2`（**数字越小越该处理**）
- `rev`：内容指纹（`id`+`count`+`ts` 的稳定序列化哈希），app 侧靠它判「要不要重新渲染」
- 响应带 `plugin` 名回显，供 app 侧识别；名称可被伪造，并非服务身份认证。

**桥接边界（工作区设计，尚需验证）**：浏览器通过受 DSH 宿主信任和会话认证保护的同源 `/api/dsh-vibe-island/config` 读写配置，通过同源 `POST /api/dsh-vibe-island/next` 取跳转队列；路由自身不认证。原生回环桥要求 `Host` 为实际 `127.0.0.1:端口`，拒绝带 `Origin` 或任意 `Sec-Fetch-*` 的请求；这是降低浏览器攻击面，不是认证，本地进程可自行构造请求。桥所有权或端口冲突时按严格失败关闭设计停止启动，不顺延或复用未知桥；旧版本可能不遵守所有权约束。跳转请求入队仅为尽力投递，客户端取走后仍可能失败或丢失，不证明会话实际打开。

### 1.4 配置（写 **`client-config.json`**，与其余配置同源，不改 `Config(z.object)`）

`CONFIG_ALLOWED` 增键（类型即注释）：

| 键 | 类型 | 默认 | 语义 |
| --- | --- | --- | --- |
| `nudgeEnabled` | boolean | `true` | 总开关；false 时 `/nudges` 恒返回空 |
| `nudgeOnCompleted` | boolean | `true` | 完成类是否记录 |
| `nudgeOnFailed` | boolean | `true` | 失败类是否记录 |
| `nudgeOnChoice` | boolean | `true` | 待选择类是否记录 |
| `nudgeAlertOnToolError` | boolean | 已停用 | 旧配置保留兼容，不再产生单次工具失败提醒 |
| `nudgeMuteRanges` | string | `''` | `HH:MM-HH:MM,HH:MM-HH:MM`，支持跨零点；空串表示不静音 |
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
nudges: [ { id, kind, severity, sessionId, label, detail, at, atMs, count, resolved } ]
```

`label` = `title || shortId`（渲染层不再做 fallback）；`detail` 已在主进程截断到 ≤120 字。`atMs` 为正数毫秒时间戳，缺失或无效时为 0，始终保留该字段以稳定快照结构。展开面板中，同一会话仅展示一条普通提醒：优先展示时间戳最大的条目；均缺少时间戳或时间相同时保留输入顺序中的第一条。这只影响显示，不确认、不删除服务端提醒；无会话 ID 的条目不参与去重。
空数组时该字段仍是空数组（稳定序列化，不影响 rev 抖动）。

### 2.2 UI

- 折叠态：`#c-nudge` 徽标（`is-off` 时隐藏），文本按最严重那类取符号 + 计数：`needs_choice` → `?N`、`failed` → `!N`、`completed` → `✔N`
- 岛体根节点新增 `data-nudge="none|choice|failed|done"`
- `--glow` **仍由 renderer 唯一写入**：`needs_choice` 覆盖为琥珀 `#F5A623`；`failed` 且当前 `status !== 'waiting'` 覆盖为红 `#E74C3C`；其余维持原状态色
- 展开 HUD：`#nudges` 区块（空则 `is-off`），每行 = 类色条 + `label` + `detail` + `at`；点击后通过 `window.island.jump({ id, label, nudgeId })` 让主进程先捕获当前快照项；只有捕获成功且跳转请求入队（`kind === 'bridged'`）后才逐条调用 `window.island.nudgeAck({ ids: [item.id] })`。确认失败或没有移除时尝试在本地保留并刷新；入队和确认均不证明会话已打开。本地保留仅在进程内有效，可能重复；实时提醒占满显示上限时，保留项可能持续不可见，应用重启后也不会恢复。保留副本至多 128 条，超出时淘汰最早条目；首次保留满 24 小时后，在下次成功拉取时移除副本；若成功拉取到同一随机 lineage 且代数严格更高的合并条目，也只替换旧本地副本，不确认新条目。旧协议缺少 lineage、不同 lineage 或代数无法证明更新时，仍保留副本。离线期间不按时间清除，移除副本不会确认或删除服务端提醒；系统时钟变化会影响保留时长。
- 样式：三色常量只定义一次；循环动画受 `data-glow="0"` 与 `prefers-reduced-motion` 双门控（与既有纪律一致）

## §3 测试要求

- 数据层：`windows/test/nudges.test.js` 进 `test/run.js` 默认套件（fake http/fetch，桥缺失降级、插件名不符拒绝、rev 去重、截断）
- 快照：扩展既有 `snapshot.test.js` —— `nudges` 变化必须改 `rev`，`nudges` 为空时 rev 稳定
- UI：`windows/test/nudge-ui.test.js` —— `index.html` 有 `#c-nudge` / `#nudges`、三色 CSS 各定义一次、`data-nudge` 四态、`--glow` 仍只由 renderer 写
- Host：使用隔离测试覆盖 `/nudges`、`/nudge/ack`、旧世代确认和配套校验；例如 `node --test test/test-ack-integration-memory.mjs test/test-nudge-ack-safety.mjs test/test-windows-pairing-isolated.mjs`。不要直接在有真实 profile 的机器运行旧默认套件；部分旧测试尚未完成安全隔离。mock 测试不等同于真实 GUI 验收。

## §4 已知边界（**不许装作能做到**）

1. **macOS 端未适配**：本机无 macOS/Swift 工具链，改 Swift 无法编译验证，贸然改会让上游 `release.yml` 的 mac job 红掉。mac 侧需要 `SessionMonitor` 读 `/nudges` 并在 `NotchContentView` 加提醒条 —— 留作独立任务。
2. **全屏抑制未实现**：不会因为前台全屏而自动抑制；可配置静音时段，默认空串表示不静音。
3. **不抢焦点**：提醒**只在岛体内显示**，不弹系统通知、不自动展开 HUD（避免打断正在全屏操作的人）。用户悬停才看到明细。
