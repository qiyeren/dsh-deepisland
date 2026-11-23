// Exercise the real startBridge request handler; every listen/probe is fake,
// and any bridge.json writes target a private temporary HOME/APPDATA.
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createIsolatedModule } from './isolated-module.mjs';
import { isolateBridgeEnvironment } from './bridge-sandbox.mjs';

test('protected read-only session feed: wait, wake, heartbeat, expiry, disconnect, pressure and shutdown', async t => {
  const env=isolateBridgeEnvironment(), fixture=createIsolatedModule();
  const oldCreate=http.createServer;
  let bridge, handler;
  // Host timers are intentionally unref'd; this referenced deadline also
  // fails the fixture instead of allowing a broken long poll to hang the run.
  const deadline=setTimeout(()=>{},5000);
  t.after(async()=>{ clearTimeout(deadline); await bridge?.close(); http.createServer=oldCreate; fixture.cleanup(); env.cleanup(); });
  http.createServer=fn=>{
    handler=fn; const server=new EventEmitter();
    server.listen=(port,host)=>{ assert.equal(host,'127.0.0.1'); queueMicrotask(()=>server.emit('listening')); };
    server.close=done=>done(); return server;
  };
  const {startBridge,name}=await fixture.importModule();
  const {SessionStates}=await fixture.importModule('session-status.js');
  const listeners=new Map(), s={id:'root',header:{cwd:'X:/sandbox',id:'root'}}, port=32091;
  const ctx={on(k,cb){listeners.set(k,cb);return ()=>listeners.delete(k);},get(k){return k==='agents'?{list:()=>[],get:()=>undefined}:undefined;}};
  const store=new SessionStates({heartbeatMs:150,ttlMs:40,maxWaiters:2});
  bridge=await startBridge({port,sessionStates:store}); assert.equal(bridge.port,port);
  const request=(since,method='GET',headers={})=>{
    const req=Object.assign(new EventEmitter(),{method,url:'/session-states'+(since?'?since='+encodeURIComponent(since):''),headers:{host:`127.0.0.1:${port}`,...headers}});
    const res=new EventEmitter(); let resolve; const done=new Promise(ok=>resolve=ok);
    res.writeHead=(status,headers)=>Object.assign(res,{status,headers});
    res.end=raw=>{res.writableEnded=true;resolve({status:res.status,headers:res.headers,body:JSON.parse(raw)});};
    handler(req,res); return {req,res,done};
  };
  assert.equal((await request().done).status,503,'disabled/unattached must not invent an empty snapshot');
  store.attach(ctx);
  const first=await request().done; assert.equal(first.status,200); assert.deepEqual(first.body,{ok:true,plugin:name,rev:first.body.rev,items:[]});
  assert.equal(first.headers['Cache-Control'],'no-store'); assert.equal(typeof first.body.rev,'string');
  for(const headers of [{host:'localhost'},{origin:'https://example.invalid'},{'sec-fetch-mode':'cors'}]) assert.equal((await request(null,'GET',headers).done).status,403);
  for(const method of ['POST','OPTIONS','HEAD']) assert.equal((await request(null,method).done).status,405);
  const held=request(first.body.rev), cancelled=request(first.body.rev);
  assert.equal((await request(first.body.rev).done).status,429); assert.equal(held.res.writableEnded,undefined);
  cancelled.res.emit('close'); assert.equal(cancelled.req.listenerCount('aborted'),0); assert.equal(cancelled.res.listenerCount('close'),0);
  const aborted=request(first.body.rev); aborted.req.emit('aborted'); assert.equal(aborted.res.listenerCount('close'),0);
  const emit=(type,data)=>listeners.get('session/event')(s,{type,data});
  emit('turn/start',{}); const started=await held.done; const row=started.body.items[0];
  assert.deepEqual(Object.keys(row).sort(),['at','id','label','status']); assert.equal(row.status,'running');
  assert.notEqual(started.body.rev,first.body.rev); assert.equal((await request('old-owner:1').done).body.rev,started.body.rev);
  const heartbeat=request(started.body.rev);
  for(let i=0;i<200;i++) { emit('tool/call',{name:'read',callId:'x'}); emit('tool/result',{message:{toolCallId:'x'}}); }
  assert.equal(heartbeat.res.writableEnded,undefined); assert.deepEqual((await heartbeat.done).body,started.body);
  const ending=request(started.body.rev); emit('turn/end',{reason:{kind:'error'}}); const failed=await ending.done; assert.equal(failed.body.items[0].status,'failed');
  const expired=await request(failed.body.rev).done; assert.deepEqual(expired.body.items,[]); assert.notEqual(expired.body.rev,failed.body.rev);
  const closing=request(expired.body.rev); await bridge.close(); bridge=null; assert.equal((await closing.done).status,503); assert.equal(listeners.size,0); assert.equal(closing.res.listenerCount('close'),0);
});
