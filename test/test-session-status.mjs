// Offline Host fixtures only. A Session history or GUI read is a test failure.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionStates } from '../lib/session-status.js';

function fixture({ ttlMs = 10_000 } = {}) {
  const handlers = new Map(), agents = new Map(), remote = [], projections = new Map();
  let now = 1_800_000_000_000, listReads = 0, projectionReads = 0;
  const services = {
    agents: { list() { listReads++; return [...agents.values()]; }, get: id => agents.get(id) },
    sessionProjections: { cachedSnapshot(s, keys) { projectionReads++; assert.deepEqual(keys,['title']); return { values:{title:projections.get(s)?.title} }; }, snapshot() { assert.fail('no lazy projection folds'); } },
    typertGateway: { getPendingRemoteEvents: () => remote },
  };
  const ctx = { get: key => services[key], on(key, fn, opts) { assert.equal(opts?.global, true); handlers.set(key, fn); return () => handlers.delete(key); } };
  const states = new SessionStates({ now: () => now, ttlMs });
  function agent(id, status = 'idle', extra = {}) {
    const session = { id, header: { id, cwd: 'X:/fixture', ...extra }, get snapshotEvents() { throw Error('no session scan'); } };
    const a = { id, status, session }; agents.set(id, a); projections.set(session, { title: `title-${id}`, userQuestions: { active: [] } }); return a;
  }
  const emit = (a, type, data) => handlers.get('session/event')(a.session, { type, data, time: ++now });
  const begin = (kind, a, details = {}) => { let resolve, reject; const next = () => new Promise((ok, bad) => { resolve = ok; reject = bad; }); const outcome = handlers.get(kind)({ agent: a, ...details }, next); return { resolve, reject, outcome }; };
  return { states, agent, emit, begin, ctx, remote, projections, handlers, get reads() { return [listReads, projectionReads]; }, get items() { return states.snapshot().items; }, get rev() { return states.snapshot().rev; }, attach() { states.attach(ctx); } };
}

test('recover live roots only; ordinary tool traffic neither samples history nor wakes clients', t => {
  const f = fixture(); t.after(() => f.states.dispose());
  const root = f.agent('root', 'running', { parentSession: 'old-fork' }); f.agent('idle'); f.agent('hidden', 'running', { cwd: undefined }); f.agent('child', 'running', { origin: 'subagent' }); f.agent('nested', 'running', { delegationDepth: 2 });
  f.attach(); assert.deepEqual(f.items.map(({id,label,status}) => [id,label,status]), [['root','title-root','running']]);
  const rev = f.rev, at = f.items[0].at, reads = f.reads;
  for (let i=0;i<1_000;i++) { f.emit(root,'tool/call',{name:'read',callId:'x'}); f.emit(root,'tool/result',{message:{toolCallId:'x',isError:true}}); }
  assert.deepEqual(f.reads, reads); assert.equal(f.rev,rev);
  f.emit(root,'session/title',{title:'新名'}); assert.notEqual(f.rev, rev); assert.equal(f.items[0].label,'新名'); assert.equal(f.items[0].at,at);
});

test('idle renames do not create status but the next active row gets the event title, even without a projection', t => {
  const f=fixture(); t.after(()=>f.states.dispose()); const a=f.agent('idle'); const get=f.ctx.get;
  f.ctx.get=k=>k==='sessionProjections'?undefined:get(k); f.attach(); const rev=f.rev;
  f.emit(a,'session/title',{title:'空闲时命名'}); assert.equal(f.rev,rev); assert.deepEqual(f.items,[]);
  f.emit(a,'turn/start',{}); assert.equal(f.items[0].label,'空闲时命名');
});

test('real parallel question/approval lifetimes survive partial settlements; errors do not hijack waterfall', async t => {
  const f = fixture(); t.after(() => f.states.dispose()); const a = f.agent('a','running'); f.attach();
  const q = f.begin('user-questions/request',a), p = f.begin('approval/request',a,{toolName:'pwsh'}); const waiting = f.items[0]; assert.equal(waiting.status,'waiting');
  q.resolve({answers:[]}); assert.deepEqual(await q.outcome,{answers:[]}); assert.equal(f.items[0].at,waiting.at);
  p.reject(new Error('fixture unavailable')); await assert.rejects(p.outcome,/fixture unavailable/); assert.equal(f.items[0].status,'running');
  const internal = f.begin('approval/request',a,{toolName:'mnemon_runtime_memory'}); assert.equal(f.items[0].status,'running'); internal.resolve('rejected'); await internal.outcome;
  const q2 = f.begin('user-questions/request',a); assert.ok(f.items[0].at > waiting.at); q2.resolve({answers:[]}); await q2.outcome;
});

test('continued timed question survives timeout/end until admitted reply, and old terminal expires', async t => {
  const f = fixture({ttlMs:20}); t.after(() => f.states.dispose()); const a = f.agent('a','running'); f.attach();
  f.emit(a,'tool/call',{name:'ask_user_question',callId:'q'}); const q = f.begin('user-questions/request',a,{wait:{callId:'q',timed:true}}); const rev=f.rev;
  q.reject(Object.assign(Error('foreground window elapsed'),{code:'ASK_TIMED_OUT'})); await assert.rejects(q.outcome);
  f.emit(a,'tool/result',{message:{toolCallId:'q',content:[{type:'text',text:'{"pending":true,"callId":"q"}'}]}}); assert.equal(f.rev,rev);
  f.emit(a,'turn/end',{reason:{kind:'completed'}}); assert.equal(f.items[0].status,'waiting');
  f.emit(a,'user/message',{source:{kind:'user-question-reply',callId:'q'}}); assert.equal(f.items[0].status,'done');
});

test('terminal reason is explicit, disconnect/dispose is not a cancellation, rows are ranked/bounded', t => {
  const f = fixture(); t.after(() => f.states.dispose()); f.attach();
  for(const [kind,status] of [['aborted','interrupted'],['interrupted','interrupted'],['error','failed'],['blocked','failed'],['completed','done'],['max-tokens','interrupted']]) {
    const a = f.agent(kind); f.emit(a,'turn/start',{}); f.emit(a,'turn/end',{reason:{kind}}); assert.equal(f.items.find(r=>r.id===kind)?.status,status);
  }
  const a=f.agent('ordinary'); f.emit(a,'turn/start',{}); f.handlers.get('session/disposed')(a.session); assert.ok(!f.items.find(r=>r.id==='ordinary'));
  for(let i=0;i<90;i++) f.emit(f.agent(`s${i}`),'turn/start',{});
  f.begin('user-questions/request',f.agent('priority','running')); assert.equal(f.items.length,6); assert.equal(f.items[0].id,'priority');
  f.states.dispose(); assert.equal(f.handlers.size,0);
});

test('cold approval requires live pending + unresolved ordinary audit id; unrelated decisions do not clear it', t => {
  const f=fixture(); t.after(()=>f.states.dispose());
  for(const [id,name] of [['ordinary','write'],['internal','mnemon_private'],['unknown',null]]) {
    const a=f.agent(id,'running'); a.session.seq=2;
    a.session.eventAt = i => i===0 ? {type:'turn/start',data:{}} : name ? {type:'approval/asked',data:{id:'r-'+id,toolName:name}} : {type:'step/start'};
    f.remote.push({agentId:id,event:'approval/request'});
  }
  f.attach(); const status=id=>f.items.find(r=>r.id===id)?.status;
  assert.equal(status('ordinary'),'waiting'); assert.equal(status('internal'),'running'); assert.equal(status('unknown'),'running');
  const s={session:{header:{id:'ordinary',cwd:'X:/fixture'}}}; f.emit(s,'approval/decided',{id:'unrelated',outcome:'rejected'}); assert.equal(status('ordinary'),'waiting');
  f.emit(s,'approval/decided',{id:'r-ordinary',outcome:'unavailable'}); assert.equal(status('ordinary'),'running');
});

test('registry failure cannot fail attach; a runtime abort cannot turn an unfinished task into interrupted', async t => {
  const f=fixture(); t.after(()=>f.states.dispose()); const get=f.ctx.get; f.ctx.get=k=>k==='agents'?{list(){ throw Error('registry detached'); }}:get(k);
  f.attach(); const a=f.agent('late','running'); f.emit(a,'turn/start',{});
  const signal=new AbortController(); const q=f.begin('user-questions/request',a,{signal:signal.signal}); assert.equal(f.items[0].status,'waiting');
  signal.abort(); assert.equal(f.items[0].status,'running'); q.reject(Error('withdrawn')); await assert.rejects(q.outcome,/withdrawn/);
  f.emit(a,'turn/end',{reason:{kind:'forked'}}); assert.deepEqual(f.items,[]);
});

test('cold/reattach pending gateway and continued questions outrank idle; fresh owners never share a revision', t => {
  const f=fixture(); t.after(()=>f.states.dispose()); const a=f.agent('restored','running'), b=f.agent('continued'); f.agent('idle');
  f.remote.push({agentId:a.id,event:'user-questions/request'});
  b.session.seq=30_000; let reads=0;
  b.session.eventAt = seq => { assert.ok(seq>=29_936); reads++; return seq===29_998 ? {type:'tool/call',data:{name:'ask_user_question',callId:'q'}} : seq===29_999 ? {type:'tool/result',data:{message:{toolCallId:'q',content:[{type:'text',text:'{"pending":true}'}]}}} : {type:'step/start'}; };

  f.attach(); assert.equal(reads,64); assert.deepEqual(f.items.map(r=>r.status),['waiting','waiting']); assert.notEqual(f.rev,new SessionStates().snapshot().rev);
  f.remote.length=0; f.emit(a,'turn/end',{reason:{kind:'completed'}}); assert.equal(f.items.find(r=>r.id===a.id).status,'done');
});
