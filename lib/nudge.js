/**
 * 提醒采集（Host 侧）—— 融合自 dsh-nudge 的事件语义。
 *
 * ## 这里做的是「语义」，不是「弹窗」
 *
 * 上游 dsh-nudge 在三种时刻弹一张一次性 WPF 卡片。我们保留它的**判定口径**
 * （哪五种 turn/end 是完成、哪两种是失败、aborted 为什么不提醒、子代理为什么
 * 要过滤、合并窗口怎么算），但把承载换成了常驻的岛体 —— 因为岛本来就在
 * 跑，而且它有一条真正能跳会话的通道（`/jump` + `uiWorkspace.openSession`），
 * 而弹窗只能 `SetForegroundWindow` 把人带回 DSH 主窗口让人自己找。
 *
 * 判定口径的原证在 dsh-nudge 的 `docs/api-notes.md`，本文只在**偏离**时重述。
 *
 * ## 为什么这个文件能在纯 node 下跑
 *
 * 只依赖 `node:` 与本地纯函数，`ctx` 是鸭子类型（只要有 on / get / effect）。
 * `test/nudge.mjs` 拿 mock ctx 直接驱动，不需要起宿主 —— 事件语义最容易错，
 * 而错了在真机上只表现为「弹了不该弹的 / 该弹的没弹」，没有断言就永远发现不了。
 *
 * @module nudge
 */

import { createHash, randomUUID } from 'node:crypto';

/** 三类提醒。数字是展示优先级：越小越该先处理（与 nudge 的 SEVERITY 一致）。 */
export const KINDS = ['needs_choice', 'failed', 'completed'];

/** 类别 → 严重度（越小越严重）。渲染端与排序都以它为唯一口径。 */
export const SEVERITY = { needs_choice: 0, failed: 1, completed: 2 };

/** 类别 → 文案。岛体不弹窗，所以只有折叠徽标与行内标签用到它。 */
export const KIND_LABEL = { needs_choice: '待你选择', failed: '失败', completed: '完成' };

/** 明细行的字符上限。岛体展开后一行放得下，超了截断加省略号。 */
const DETAIL_LIMIT = 120;

/** 标题行的上限。折叠态与 HUD 行都只放得下一小段。 */
const TITLE_LIMIT = 42;

/** 标题缓存上限：超了整体清空，避免长跑的进程里无界增长（nudge 同款做法）。 */
const TITLE_CACHE_MAX = 400;

/** 已上报的工具失败 callId 上限，同上。 */
const REPORTED_CALL_MAX = 400;

/** 提醒 TTL 的默认值（分钟）。 */
const DEFAULT_TTL_MINUTES = 30;

/**
 * 把一段文本压成一行。
 *
 * 三件事：空白合并 → 砍掉真实堆栈帧（`at fn (file:12:3)` 那种，正文里
 * 「at 」是自然语言的句子要留住）→ 超长截断。卡片/岛体只放得下一行，
 * 原始堆栈留在会话里查。
 * @param {unknown} value 原始文本
 * @param {number} [limit] 最多保留的字数
 * @returns {string}
 */
export function condenseText(value, limit = DETAIL_LIMIT) {
	const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
	if (text === '') return '';
	const frame = text.search(/\s+at\s+(?:async\s+)?[^\s(]*\s*\(?[^)]*:\d+:\d+/u);
	const head = (frame > 0 ? text.slice(0, frame) : text).trim();
	if (head === '') return '';
	return head.length > limit ? `${head.slice(0, limit - 1)}…` : head;
}

/**
 * 标题压缩（比明细更短）。
 * @param {unknown} value 原始文本
 * @returns {string}
 */
export function clipTitle(value) {
	return condenseText(value, TITLE_LIMIT);
}

/**
 * 工具失败的一句话明细。
 *
 * `tool/result` 只有在 HarnessError 时才会把 `error.info` 放进 `data.error`；
 * 普通 Error 的正文只在工具结果消息的 content 里。所以**正文优先、结构化错误兜底**
 * —— 反过来会让普通工具失败全部漏成 "unknown"（nudge 踩过这个坑）。
 * @param {any} data `tool/result` 事件的 data
 * @returns {string}
 */
export function toolFailureDetail(data) {
	const blocks = Array.isArray(data?.message?.content) ? data.message.content : [];
	const text = blocks
		.filter((block) => block?.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text)
		.join(' ')
		.replace(/^\s*error:\s*/iu, '')
		.trim();
	if (text !== '') return `工具调用失败：${condenseText(text)}`;
	const error = data?.error ?? {};
	const fallback = error.message ?? error.code ?? error.name ?? data?.name ?? 'unknown';
	return `工具调用失败：${condenseText(fallback)}`;
}

/**
 * 静音时段判断。
 *
 * `HH:MM-HH:MM` 的列表，逗号分隔；跨零点（`22:00-08:00`）按「>= from 或 < to」判。
 * **非法行直接被忽略**，而不是让整条配置失效 —— 用户手写配置时写错一行
 * 就整段不生效，界面上看不出任何异常，那是最难排查的一类失败。
 * @param {string|string[]} ranges 配置值
 * @param {Date} [now] 当前时间
 * @returns {boolean} 是否处于静音
 */
export function inMuteRange(ranges, now = new Date()) {
	const list = Array.isArray(ranges) ? ranges : String(ranges ?? '').split(',');
	const minutes = now.getHours() * 60 + now.getMinutes();
	for (const raw of list) {
		const item = String(raw ?? '').trim();
		if (item === '') continue;
		const hit = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/u.exec(item);
		if (hit === null || Number(hit[2]) >= 60 || Number(hit[4]) >= 60) continue;
		const from = Number(hit[1]) * 60 + Number(hit[2]);
		const to = Number(hit[3]) * 60 + Number(hit[4]);
		if (from > 1439 || to > 1439) continue;
		if (from === to) continue;
		if (from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to) return true;
	}
	return false;
}

/**
 * 稳定序列化：键按字典序，用于内容指纹。
 * 不能用 JSON.stringify（对象键序不稳定会让同一份内容算出两个 rev）。
 * @param {unknown} value 任意 JSON 值
 * @returns {string}
 */
export function stableStringify(value) {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
	const keys = Object.keys(value).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * 提醒队列：合并、去重、TTL、静音与开关判定。
 *
 * 与 nudge 的 AlertCenter 的差异只有一处必要：**没有「投递」这一步**。
 * 提醒留在队列里等 app 来 `GET /nudges`，而不是到点就 spawn 一个窗口。
 * 合并窗口的意义因此从「避免连续弹窗」变成「避免同一件事把计数打散」。
 */
export class NudgeCenter {
	/**
	 * @param {object} config 生效配置（`liveConfig()` 之后的那份）
	 * @param {{now?: () => Date, log?: (level: string, message: string) => void}} [deps]
	 */
	constructor(config, deps = {}) {
		this.config = config;
		this.clock = deps.now ?? (() => new Date());
		this.log = deps.log ?? (() => {});
		/** @type {Map<string, object>} 队列：id → 条目 */
		this.pending = new Map();
		this.disposed = false;
	}

	/**
	 * 记录一条提醒。
	 * @param {'completed'|'needs_choice'|'failed'} kind 类别
	 * @param {{sessionId?: string, title?: string, detail?: string, project?: string}} [detail] 内容
	 * @returns {object|null} 被接受到的那条（未接受返回 null，便于测试直接断言）
	 */
	push(kind, detail = {}) {
		if (this.disposed) return null;
		if (kindOf(kind) === null) return null;
		if (this.config.nudgeEnabled === false) return null;
		if (this.switchOf(kind) !== true) return null;

		const sessionId = String(detail.sessionId ?? 'unknown');
		const now = this.clock();
		if (inMuteRange(this.config.nudgeMuteRanges ?? '', now)) return null;

		// 合并窗口在语义上等价于「同一会话同一类别的重复事件在窗口内算同一条」。
		// 与 nudge 的 1.2s 合并窗口对齐：窗口内的重复只是计数 +1，不新建条目。
		const windowMs = Math.max(0, Number(this.config.nudgeMergeWindowMs ?? 1200));
		const atMs = now.getTime();
		for (const item of this.pending.values()) {
			if (item.kind !== kind || item.sessionId !== sessionId) continue;
			if (atMs - item.ts > windowMs) continue;
			// A displayed snapshot acknowledges only the exact version the user saw.
			// Rotate its opaque ID before updating the merged batch, so an older
			// in-flight acknowledgement cannot consume the newer event.
			this.pending.delete(item.id);
			item.id = randomUUID();
			this.pending.set(item.id, item);
			item.count += 1;
			item.atMs = atMs;
			item.ts = atMs;
			item.at = this.formatTime(now);
			// 明细更新：后到的那条通常更接近失败现场（例如 tool/result 在 turn/end 之后）
			const incoming = condenseText(detail.detail);
			if (incoming !== '') item.detail = incoming;
			this.trim();
			return item;
		}

		const item = {
			id: randomUUID(),
			kind,
			severity: SEVERITY[kind],
			sessionId,
			title: clipTitle(detail.title),
			project: condenseText(detail.project, 24),
			detail: condenseText(detail.detail),
			at: this.formatTime(now),
			atMs,
			ts: atMs,
			count: 1,
		};
		this.pending.set(item.id, item);
		this.trim();
		return item;
	}

	/**
	 * 这个类别当前是否开着。未知类别一律关。
	 * @param {string} kind 类别
	 * @returns {boolean}
	 */
	switchOf(kind) {
		const key = kind === 'completed' ? 'nudgeOnCompleted'
			: kind === 'failed' ? 'nudgeOnFailed'
				: 'nudgeOnChoice';
		return this.config[key] !== false;
	}

	/**
	 * 丢过期与超量条目，并保持队列最多 `nudgeMaxItems` 条。
	 *
	 * 上限取 maxItems 而不是更大的数：app 侧只显示这么多，
	 * 多存的每一条都只会在 `/nudges` 响应里白占体积。
	 * 丢最旧的（`ts` 升序先出），因为新提醒更贴近用户此刻在等的事。
	 */
	trim() {
		const ttlMs = Math.max(1, Number(this.config.nudgeTtlMinutes ?? DEFAULT_TTL_MINUTES)) * 60_000;
		const cutoff = this.clock().getTime() - ttlMs;
		for (const [id, item] of this.pending) {
			if (item.ts < cutoff) this.pending.delete(id);
		}
		const cap = Math.min(8, Math.max(1, Number(this.config.nudgeMaxItems ?? 4)));
		if (this.pending.size <= cap) return;
		const ordered = [...this.pending.values()].sort((a, b) => a.ts - b.ts);
		while (ordered.length > cap) {
			const oldest = ordered.shift();
			this.pending.delete(oldest.id);
		}
	}

	/**
	 * 当前队列（按严重度、再按时间排）。
	 * @returns {Array<object>}
	 */
	list() {
		this.trim();
		return [...this.pending.values()].sort(
			(a, b) => (a.severity - b.severity) || (b.ts - a.ts),
		);
	}

	/**
	 * 内容指纹。app 侧靠它判「要不要重新渲染」——不含时间戳的绝对值以外
	 * 的任何会自然漂移的量，所以队列不动 → rev 不动。
	 * @returns {string}
	 */
	rev() {
		const body = this.list().map((item) => [item.id, item.kind, item.count, item.ts, item.title, item.detail, item.project]);
		return createHash('sha1').update(stableStringify(body)).digest('hex').slice(0, 16);
	}

	/**
	 * 确认（移除）若干条。
	 * @param {string[]} ids 要移除的 id
	 * @returns {number} 实际移除的条数
	 */
	ack(ids) {
		let removed = 0;
		for (const id of Array.isArray(ids) ? ids : []) {
			if (this.pending.delete(String(id))) removed += 1;
		}
		return removed;
	}

	/**
	 * 确认全部。
	 * @returns {number} 实际移除的条数
	 */
	ackAll() {
		const removed = this.pending.size;
		this.pending.clear();
		return removed;
	}

	/**
	 * `HH:MM` 格式的时间串。
	 * @param {Date} date 时间
	 * @returns {string}
	 */
	formatTime(date) {
		return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
	}

	/** 卸载：清空队列，之后的 push 一律不接受。 */
	dispose() {
		this.disposed = true;
		this.pending.clear();
	}
}

/**
 * 归一化类别：只认三种，其余返回 null（调用方据此丢弃）。
 * @param {unknown} kind 原始值
 * @returns {'completed'|'needs_choice'|'failed'|null}
 */
function kindOf(kind) {
	return KINDS.includes(kind) ? kind : null;
}

/**
 * 从会话对象取项目名（cwd 的最后一段）。
 *
 * 岛体只放得下一个能认出来的短名字。**不把完整路径带进提醒** —— 它会跟着
 * `/nudges` 的 JSON 走到 app 进程与渲染层，而那些层并不需要它。
 * @param {any} session 会话对象
 * @returns {string}
 */
export function projectOf(session) {
	const cwd = session?.header?.cwd;
	if (typeof cwd !== 'string' || cwd === '') return '';
	const parts = cwd.split(/[\\/]+/).filter((part) => part !== '');
	return parts.length > 0 ? parts[parts.length - 1] : '';
}

/**
 * 把 nudge 的事件语义接到某个 cordis ctx 上。
 *
 * 只做四件事：注册 `session/event`、注册 `approval/request`、包装
 * `userQuestions.ask`、把 `NudgeCenter` 的句柄返回给调用方。
 *
 * @param {any} ctx cordis 上下文（鸭子类型：on / get / effect）
 * @param {object} config 生效配置（`liveConfig()` 之后那份，实时视图）
 * @param {{log?: (level: string, message: string) => void, now?: () => Date, center?: NudgeCenter, getConfig?: () => object}} [deps]
 * @returns {{center: NudgeCenter|null, dispose: () => void}}
 */
export function attachNudges(ctx, config, deps = {}) {
	const log = deps.log ?? (() => {});
	const center = deps.center ?? new NudgeCenter(config, { log, now: deps.now });
	let disposed = false;
	// Event delivery must not depend on the native bridge polling for config updates.
	const refreshConfig = () => {
		try {
			const current = deps.getConfig?.();
			if (current !== null && typeof current === 'object') center.config = current;
		} catch { /* Keep the last usable config when the provider is unavailable. */ }
	};
	/** @type {Map<string, string>} */
	const titles = new Map();
	/** @type {Set<string>} 已上报过的工具失败 */
	const reportedCalls = new Set();

	/**
	 * 会话标题。
	 *
	 * 三个来源按可信度递减：`sessionTitle` 服务（DSH 自己折叠 `session/title`
	 * 事件的结论）→ 本地缓存 → sessionId 前 8 位。
	 * **不读 `session.header.title`**：0.2.x 的 SessionHeader 没有这个字段。
	 * @param {any} session 会话
	 * @param {string} sessionId 会话 id
	 * @returns {string}
	 */
	const titleOf = (session, sessionId) => {
		const id = String(sessionId ?? session?.header?.id ?? 'unknown');
		try {
			const live = ctx.get?.('sessionTitle')?.get?.(session)?.title;
			if (typeof live === 'string' && live !== '') {
				remember(id, live);
				return live;
			}
		} catch { /* 服务可能还没就绪，代理到本地缓存 */ }
		const cached = titles.get(id);
		if (typeof cached === 'string' && cached !== '') return cached;
		return id.slice(0, 8);
	};

	/**
	 * 写标题缓存，超上限整体清空。
	 * @param {string} id 会话 id
	 * @param {string} title 标题
	 */
	const remember = (id, title) => {
		if (titles.size > TITLE_CACHE_MAX) titles.clear();
		titles.set(id, title);
	};

	/**
	 * 子代理会话不提醒：父会话已经把子代理的回合与工具错误汇总了，
	 * 每个子任务再提醒一次，等于给一次长任务刷出一串噪音。
	 * @param {any} header 会话 header
	 * @returns {boolean}
	 */
	const isSubagent = (header) => header?.parentSession != null || Number(header?.delegationDepth) > 0;

	const onSessionEvent = (session, raw) => {
		if (disposed) return;
		refreshConfig();
		const type = raw?.type;
		const data = raw?.data ?? {};
		const header = session?.header;
		const sessionId = String(header?.id ?? 'unknown');

		if (type === 'session/title') {
			if (typeof data.title === 'string' && data.title !== '') remember(sessionId, data.title);
			return;
		}

		if (isSubagent(header)) return;

		if (type === 'tool/result' && center.switchOf('failed') && center.config.nudgeAlertOnToolError !== false) {
			const callId = data?.message?.source?.callId ?? data?.callId;
			// 判据是世界状态而不是单一字段：`data.error` 只在 HarnessError 时出现，
			// 拿它当唯一判据会让普通工具失败漏报（nudge 的同一条结论）。
			const failed = data?.message?.isError === true || data?.error !== undefined || data?.isError === true;
			if (!failed || typeof callId !== 'string') return;
			if (reportedCalls.has(callId)) return;
			if (reportedCalls.size > REPORTED_CALL_MAX) reportedCalls.clear();
			reportedCalls.add(callId);
			center.push('failed', {
				sessionId,
				title: titleOf(session, sessionId),
				project: projectOf(session),
				detail: toolFailureDetail(data),
			});
			return;
		}

		if (type !== 'turn/end') return;
		const reason = data.reason ?? {};
		const base = {
			sessionId,
			title: titleOf(session, sessionId),
			project: projectOf(session),
		};

		if (reason.kind === 'error') {
			const error = reason.error ?? reason.failure ?? {};
			center.push('failed', { ...base, detail: String(error.message ?? error.code ?? '回合异常结束') });
			return;
		}
		// aborted 是用户自己按了停止 —— 他知道这一轮没跑完，再提醒一次只是噪音。
		if (reason.kind === 'aborted') return;
		if (reason.kind === 'blocked') {
			// blocked = 本回合根本没有执行（归档会话、过期 goal 等）。
			// 它不是完成，也不一定需要立刻选择，所以用失败色比绿色完成更接近事实。
			center.push('failed', { ...base, detail: '回合被策略拦截' });
			return;
		}
		if (reason.kind !== 'completed' && reason.kind !== 'max-tokens') return;
		const done = reason.kind === 'max-tokens' ? '输出被长度上限截断' : '回合已完成';
		center.push('completed', { ...base, detail: done });
	};

	let sessionOff = null;
	try {
		sessionOff = ctx.on?.('session/event', onSessionEvent);
	} catch (error) {
		log('warn', `nudge: 挂 session/event 失败 — ${error?.message ?? error}`);
	}

	// 审批：waterfall 观察者。**必须 return next()**，否则审批链会被这个提醒插件劫持。
	let approvalOff = null;
	if (ctx.get?.('approval') !== undefined) {
		const handler = (request, next) => {
			if (disposed) return typeof next === 'function' ? next() : undefined;
			try {
				refreshConfig();
				const session = request?.agent?.session;
				center.push('needs_choice', {
					sessionId: String(request?.agent?.id ?? session?.header?.id ?? 'unknown'),
					title: titleOf(session, request?.agent?.id),
					project: projectOf(session),
					// ApprovalRequest 只有 displayReason / reason / toolName，
					// 没有 command / title / description。旧字段留着给自定义渠道。
					detail: String(
						request?.displayReason ?? request?.reason ?? request?.title
						?? request?.command ?? request?.description ?? request?.toolName
						?? '等待你批准一个操作',
					),
				});
			} catch { /* 提醒失败不能砸在审批链上 */ }
			return typeof next === 'function' ? next() : undefined;
		};
		try {
			approvalOff = ctx.on?.('approval/request', handler);
		} catch (error) {
			log('warn', `nudge: 挂 approval/request 失败 — ${error?.message ?? error}`);
		}
	}

	// 提问：`userQuestions.ask` 是唯一入口，只能包装。原样转发，卸载时还原**原函数**
	// 而不是 bind 后的副本 —— 留一个绑死旧实现的 own property，会让下一个包装者无法干净卸掉。
	let restoreQuestions = null;
	const questions = ctx.get?.('userQuestions');
	if (questions !== undefined && typeof questions.ask === 'function' && !questions.__nudgePatched) {
		const original = questions.ask;
		const originalDescriptor = Object.getOwnPropertyDescriptor(questions, 'ask');
		const forward = original.bind(questions);
		const patched = async (request) => {
			if (disposed) return forward(request);
			try {
				refreshConfig();
				const first = Array.isArray(request?.questions) ? request.questions[0] : request?.questions;
				const session = request?.agent?.session;
				center.push('needs_choice', {
					sessionId: String(request?.agent?.id ?? session?.header?.id ?? 'unknown'),
					title: titleOf(session, request?.agent?.id),
					project: projectOf(session),
					detail: String(first?.header ?? first?.question ?? first?.title ?? '等待你回答问题'),
				});
			} catch { /* 同上 */ }
			return forward(request);
		};
		if (!originalDescriptor || originalDescriptor.configurable) {
			Object.defineProperty(questions, 'ask', { value: patched, writable: true, configurable: true, enumerable: originalDescriptor?.enumerable ?? true });
		} else {
			questions.ask = patched;
		}
		Object.defineProperty(questions, '__nudgePatched', { value: true, configurable: true });
		restoreQuestions = () => {
			const current = Object.getOwnPropertyDescriptor(questions, 'ask');
			if (current?.value === patched) {
				if (originalDescriptor) Object.defineProperty(questions, 'ask', originalDescriptor);
				else delete questions.ask;
			}
			delete questions.__nudgePatched;
		};
	}

	const dispose = () => {
		if (disposed) return;
		disposed = true;
		for (const off of [sessionOff, approvalOff, restoreQuestions]) {
			try {
				if (typeof off === 'function') off();
			} catch { /* Continue cleaning up the remaining registrations. */ }
		}
		if (deps.disposeCenter !== false) center.dispose();
	};
	try {
		ctx.effect?.(() => dispose);
	} catch { /* ignore */ }

	return { center, dispose };
}
