import { randomUUID } from 'node:crypto';

// DSH 0.2.2-rc.3: agents is the *live* registry (unlike sessionController.list).
// Read only committed events, live waterfall settlements and a bounded in-memory
// recovery tail. No GUI, persisted history, user content or reminder queue.
const MAX_ROWS = 64, MAX_ITEMS = 6, MAX_QUESTIONS = 32, MAX_REMOTE = 128;
const QUESTION = 'user-questions/request', APPROVAL = 'approval/request';
const INTERNAL_TOOL = /^(?:(?:subagent|subagent_fork|send_message|list_agents|wait_agent|workflow|ralph)$|mnemon_|mcp__mnemon__)/iu;
const terminal = new Map([['completed','done'], ['error','failed'], ['blocked','failed'], ['max-tokens','interrupted'], ['aborted','interrupted'], ['interrupted','interrupted']]);
const priority = s => s === 'waiting' ? 0 : s === 'running' ? 1 : 2;
const compare = (a,b) => priority(a.status)-priority(b.status) || b.at-a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
function ordinary(s) {
  const h = s?.header;
  // Same externally addressable session boundary as session-controller.state;
  // old user-created forks may have parentSession and must not be hidden.
  return typeof h?.id === 'string' && h.id.length > 0 && h.id.length <= 256 &&
    typeof h.cwd === 'string' && h.cwd.length > 0 && !h.origin && !(h.delegationDepth > 0);
}
function label(value) {
  return typeof value === 'string' ? value.slice(0,160).replace(/[\x00-\x1f\x7f]/g,' ').trim() : '';
}
function cachedTitle(ctx, session) {
  try {
    // `snapshot` may fold an entire cold cell. `cachedSnapshot` cannot, and
    // the selected wire value here is just a string, not a questions archive.
    return ctx.get?.('sessionProjections')?.cachedSnapshot(session, ['title'])?.values?.title;
  } catch { return undefined; }
}
const MAX_TAIL = 64;
function noteCall(calls, id, stage) {
  if (typeof id !== 'string' || !id || id.length > 512) return;
  if (!calls.has(id) && calls.size >= MAX_QUESTIONS) calls.delete(calls.keys().next().value);
  calls.set(id, stage);
}
function pendingResult(content) {
  // Only the service's tiny JSON marker is of interest, never question/answer
  // text or arbitrary tool payloads. DSH emits it as one text block.
  const text=content?.[0]?.type === 'text' && content[0].text;
  if (typeof text!=='string' || text.length>2048) return false;
  try { return JSON.parse(text)?.pending===true; } catch { return false; }
}
function foldQuestion(calls, type, d) {
  if (type==='tool/call' && d?.name==='ask_user_question') noteCall(calls,d.callId,'called');
  else if (type==='tool/ptc-dispatch' && d?.name==='ask_user_question') {
    if (!d.isError && pendingResult(d.content)) noteCall(calls,d.subCallId,'continued');
    else calls.delete(d.subCallId);
  }
  else if (type==='tool/result' && calls.has(d?.message?.toolCallId)) {
    const id=d.message.toolCallId;
    if ((!d.error && !d.message.isError && pendingResult(d.message.content)) ||
        (calls.get(id)==='timed' && d.error?.code==='TOOL_OUTCOME_UNKNOWN')) calls.set(id,'continued');
    else calls.delete(id);
  } else if (type==='user/message' && d?.source?.kind==='user-question-reply') calls.delete(d.source.callId);
  else if (type==='turn/end') for (const [id,stage] of calls) if (stage!=='continued') calls.delete(id);
}
// Recovery only: index-addressed, already-attached Session slots, capped even
// for enormous logs. Do not call snapshotEvents(), sessionQuery, or a controller.
// No matching record inside this window means no inferred wait.
function recoverTail(session) {
  const calls=new Map(), approvals=new Set(); let title;
  const end=session.seq;
  if (Number.isSafeInteger(end) && end>=0 && typeof session.eventAt==='function') {
    const start=Math.max(0,end-MAX_TAIL,session.inheritedEventCount ?? 0);
    for (let seq=start;seq<end;seq++) {
      const e=session.eventAt(seq), d=e?.data;
      if (!e) continue;
      foldQuestion(calls,e.type,d);
      if (e.type==='session/title') title=label(d?.title);
      if (e.type==='turn/start' || e.type==='turn/end') approvals.clear();
      if (e.type==='approval/asked' && typeof d?.toolName==='string' && !INTERNAL_TOOL.test(d.toolName) && typeof d.id==='string') approvals.add(d.id);
      if (e.type==='approval/decided') approvals.delete(d?.id);
    }
  }
  return {calls,approvals,title};
}

export class SessionStates {
  constructor({ now = Date.now, ttlMs = 10_000, heartbeatMs = 20_000, maxWaiters = 8 } = {}) {
    this.now = now; this.ttlMs = ttlMs; this.heartbeatMs = heartbeatMs; this.maxWaiters = maxWaiters;
    this.rows = new Map(); this.titles = new WeakMap(); this.items = []; this.off = []; this.waiters = new Set();
    this.instance = randomUUID(); this.generation = 0; this.rev = this.instance + ':0';
    this.timer = null; this.nextTick = Infinity; this.closed = false;
  }
  snapshot() { return { rev: this.rev, items: this.items }; }
  attach(ctx) {
    if (this.ctx || this.closed) throw Error('session states already attached or disposed');
    this.ctx = ctx;
    const on = (key, fn, prepend = false) => this.off.push(ctx.on(key, fn, {global:true, prepend}));
    try {
      on('session/event', (s,e) => this.event(s,e));
      on('session/disposed', s => this.detachSession(s));
      on('agent/disposed', ({agent}) => this.detachSession(agent.session));
      on('agent/created', ({agent}) => { try { this.seedAgent(agent); } catch { /* never fail Agent creation */ } });
      on('agent/status', ({agent,status}) => {
        const s = agent.session;
        if (!ordinary(s)) return;
        if (status === 'running') this.running(s);
        else if (status === 'idle') {
          const r = this.rows.get(s.header.id);
          if (r?.phase === 'running') { r.phase = ''; this.update(r); }
        }
      });
      // Observe the actual human-interaction waterfalls, not model arguments or
      // approval/asked alone: the host's `never` policy bypasses the waterfall.
      // Prepend and delegate exactly once; a reject/abort is NOT an approval.
      for (const key of [APPROVAL, QUESTION]) on(key, (req,next) => this.interaction(key,req,next), true);
      this.recover();
    } catch (error) { this.dispose(); throw error; }
    return this;
  }
  record(s, title) {
    const id = s.header.id;
    let r = this.rows.get(id);
    if (!r) {
      const text = this.titles.get(s) || label(title || cachedTitle(this.ctx,s));
      r = {id, label:text || id.replace(/^session-/, '').slice(0,12), phase:'', status:'', at:0,
        endsAt:0, waits:new Set(), calls:new Map(), remote:new Set(), recoveredApprovals:new Set()};
      this.rows.set(id,r);
    }
    return r;
  }
  update(r, renamed = false) {
    if (this.closed || this.rows.get(r.id) !== r) return;
    const waiting = r.waits.size || r.remote.size || [...r.calls.values()].some(stage => stage!=='called');
    const next = waiting ? 'waiting' : r.phase;
    if (r.status === next && next && !renamed) return;
    if (r.status !== next) { r.status = next; r.at = Math.max(this.now(),r.at+1); }
    if (!next) this.drop(r);
    this.publish();
  }
  drop(r) {
    this.rows.delete(r.id); this.clearWaits(r);
  }
  clearWaits(r) {
    for (const token of r.waits) token.cancel();
    r.waits.clear();
  }
  publish() {
    const rows = [...this.rows.values()].sort(compare);
    while (rows.length > MAX_ROWS) this.drop(rows.pop());
    const items = rows.slice(0,MAX_ITEMS).map(({id,label,status,at})=>({id,label,status,at}));
    if (items.length !== this.items.length || items.some((r,i) => {
      const old = this.items[i]; return r.id!==old.id || r.label!==old.label || r.status!==old.status || r.at!==old.at;
    })) {
      this.items = items; this.rev = `${this.instance}:${++this.generation}`;
      for (const wake of [...this.waiters]) wake();
    }
    this.schedule();
  }
  running(s) {
    const r = this.record(s); r.phase = 'running'; r.endsAt = 0; this.update(r);
  }
  detachSession(s) {
    const r = this.rows.get(s?.header?.id); if (!r) return;
    // Detachment provides no verdict about how the driver stopped.
    this.clearWaits(r); r.remote.clear(); r.calls.clear(); r.recoveredApprovals.clear();
    if (r.phase === 'running') r.phase = '';
    this.update(r);
  }
  event(s,e) {
    const type=e?.type, d=e?.data;
    // Fast path: ignore the dominating events BEFORE touching services, any
    // content/arguments or projections. tool/result only checks one bounded set.
    if (type === 'tool/call' || type === 'tool/ptc-dispatch') { if (d?.name !== 'ask_user_question') return; }
    else if (type === 'user/message') { if (d?.source?.kind !== 'user-question-reply') return; }
    else if (type === 'tool/result') {
      const r=this.rows.get(s?.header?.id);
      if (!r?.calls.has(d?.message?.toolCallId)) return;
    } else if (!['turn/start','turn/end','session/title','approval/decided'].includes(type)) return;
    if (this.closed || !ordinary(s) || e.seq < s.inheritedEventCount) return;
    let r = this.rows.get(s.header.id);
    if (type === 'turn/start') { this.running(s); return; }
    if (type === 'session/title') {
      const text=label(d?.title);
      if (text) this.titles.set(s,text); // remember an idle rename without creating an activity row
      if (r && text && text !== r.label) { r.label=text; this.update(r,true); }
      return;
    }
    if (type === 'turn/end') {
      const status=terminal.get(d?.reason?.kind);
      if (!status && !r) return;
      r ??= this.record(s); this.clearWaits(r); r.remote.clear();
      r.recoveredApprovals.clear(); foldQuestion(r.calls,type,d);
      if (r.phase !== status) { r.phase=status || ''; r.endsAt=status ? this.now()+this.ttlMs : 0; }
      this.update(r); this.schedule(); return;
    }
    if (type === 'approval/decided') {
      if (r?.recoveredApprovals.delete(d?.id) && !r.recoveredApprovals.size) { r.remote.delete(APPROVAL); this.update(r); }
      return;
    }
    if (!r && type!=='tool/ptc-dispatch') return;
    r ??= this.record(s); foldQuestion(r.calls,type,d); this.update(r);
  }
  interaction(kind, req, next) {
    const s=req?.agent?.session;
    if (this.closed || !ordinary(s) || req.signal?.aborted || (kind===APPROVAL && INTERNAL_TOOL.test(req.toolName))) return next();
    const r=this.record(s);
    if (r.waits.size >= MAX_QUESTIONS) return next();
    // This can also be a Host-originated request outside an agent turn.
    if (!r.phase && req.agent.status==='running') r.phase='running';
    // A timed foreground request can hand off to a durable continued card;
    // its call/result or admitted late reply, not a transport error, closes it.
    const timedId = kind===QUESTION && req.wait?.timed ? req.wait.callId : undefined;
    if (timedId) noteCall(r.calls,timedId,'timed');
    let end = reason => {
      token.cancel(); r.waits.delete(token);
      if (timedId && r.calls.get(timedId)==='timed' && !['ASK_TIMED_OUT','NO_PROVIDER'].includes(reason?.code)) r.calls.set(timedId,'called');
      this.update(r);
    };
    const signal=req.signal;
    const abort=()=>end?.(signal.reason);
    const token={cancel() { end=null; signal?.removeEventListener('abort',abort); }};
    r.waits.add(token); signal?.addEventListener('abort',abort,{once:true}); this.update(r);
    const settled = value => { end?.(); return value; };
    const rejected = error => { end?.(error); throw error; };
    try { const result = next(); return result?.then ? Promise.resolve(result).then(settled,rejected) : settled(result); }
    catch(error) { return rejected(error); }
  }
  remoteById() {
    const map = new Map();
    try {
      const entries = this.ctx.get?.('typertGateway')?.getPendingRemoteEvents();
      if (!Array.isArray(entries)) return map;
      for (const e of entries.slice(-MAX_REMOTE)) {
        if (e.event !== APPROVAL && e.event !== QUESTION) continue;
        if (!map.has(e.agentId)) map.set(e.agentId,new Set());
        map.get(e.agentId).add(e.event);
      }
    } catch { /* No unverified pending state. */ }
    return map;
  }
  seedAgent(agent, remote = new Set()) {
    const s = agent?.session;
    if (!ordinary(s) || this.rows.has(s.header.id)) return;
    const facts = recoverTail(s);
    if (!facts.approvals.size) remote.delete(APPROVAL); // gateway supplies no tool name
    if (agent.status !== 'running' && !remote.size && ![...facts.calls.values()].includes('continued')) return;
    const r=this.record(s,facts.title); r.phase=agent.status==='running'?'running':''; r.remote=remote;
    r.calls=facts.calls; r.recoveredApprovals=facts.approvals; this.update(r);
  }
  recover() {
    if (this.closed || !this.ctx) return;
    try {
      const agents=this.ctx.get?.('agents'); if (!agents) return;
      const remote=this.remoteById();
      const seen=new Set();
      const seed = (agent,pending) => {
        if (!agent || seen.has(agent.id) || seen.size>=MAX_ROWS) return;
        seen.add(agent.id);
        try { this.seedAgent(agent,pending); } catch { /* skip an unreadable live entry */ }
      };
      for (const [id,pending] of remote) seed(agents.get(id),pending);
      for (const agent of (agents.list?.() ?? []).slice(-MAX_ROWS).reverse()) seed(agent);
    } catch { /* startup ordering or registry teardown; later live events are still authoritative */ }
  }
  recheckRemote() {
    const fresh=this.remoteById();
    // Only bootstrapped waterfalls lack a settlement callback. Recheck THEIR
    // membership, not turns or logs; no recurring work after the last settles.
    for (const r of this.rows.values()) {
      if (!r.remote.size) continue;
      for (const kind of r.remote) if (!fresh.get(r.id)?.has(kind)) r.remote.delete(kind);
      this.update(r);
    }
  }
  schedule() {
    let deadline=Infinity;
    for (const r of this.rows.values()) {
      if (r.endsAt) deadline=Math.min(deadline,r.endsAt);
      if (r.remote.size) deadline=Math.min(deadline,this.now()+1000);
    }
    if (this.closed || deadline===this.nextTick) return;
    // Keep an earlier armed timer, even on frequent unrelated changes.
    if (this.timer && deadline!==Infinity && this.nextTick<deadline) return;
    clearTimeout(this.timer); this.timer=null; this.nextTick=deadline;
    if (deadline===Infinity) return;
    this.timer=setTimeout(()=>{
      this.nextTick=Infinity; this.timer=null;
      if ([...this.rows.values()].some(r=>r.remote.size)) this.recheckRemote();
      for(const r of this.rows.values()) if (r.endsAt && this.now()>=r.endsAt) { r.endsAt=0; r.phase=''; this.update(r); }
      this.schedule();
    },Math.max(1,deadline-this.now())); this.timer.unref?.();
  }
  // Conditional read and subscription are synchronous; a transition cannot
  // land between the comparison and registration. A cancelled HTTP reader
  // stops only its own wait, never the observed Session.
  serve(since, req, res, reply) {
    if (this.closed || !this.ctx) return reply(503,{ok:false,error:'session states unavailable'});
    // Reconnecting native clients receive the current retained cut. Only Host
    // (re)attachment seeds from live agents; HTTP reads never rescan them.
    const send = () => reply(200,{ok:true,...this.snapshot()});
    if (since!==this.rev) return send();
    if (this.waiters.size>=this.maxWaiters) return reply(429,{ok:false,error:'too many state readers'});
    const clean = () => {
      clearTimeout(timer); this.waiters.delete(wake);
      res.off('close',clean); req.off('aborted',clean);
    };
    const wake = () => {
      clean(); if (res.destroyed || res.writableEnded) return;
      // A failed or half-closed reader must never throw into the Host event or
      // prevent a different subscriber/teardown callback from completing.
      try { if (this.closed) reply(503,{ok:false,error:'session states unavailable'}); else send(); }
      catch { res.destroy?.(); }
    };
    const timer=setTimeout(wake,this.heartbeatMs); timer.unref?.();
    this.waiters.add(wake); res.once('close',clean); req.once('aborted',clean);
  }
  dispose() {
    if (this.closed) return;
    this.closed=true; clearTimeout(this.timer);
    for (const off of this.off.splice(0).reverse()) { try { off?.(); } catch { /* continue cleanup */ } }
    for (const r of this.rows.values()) this.clearWaits(r);
    for (const wake of [...this.waiters]) wake();
    this.ctx=null; this.rows.clear(); this.titles=new WeakMap(); this.items=[];
  }
}
