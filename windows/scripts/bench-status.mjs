// Windows-only, no install or DSH runtime. From repo root:
// node windows/scripts/bench-status.mjs [baseline|candidate|paired] [seconds-per-window]
// Paired order ABBA; both consume the very same 782 files. Prints individual JSON results.
// Real Electron main, preload, renderer, IPC, polling, HTTP client and candidate reducer/long poll.
// Desktop-facing APIs are virtual: no tray, focus, clipboard, shell, OS cursor or shown window.
// The Node mock host + synthetic persistence/generator CPU are included on BOTH sides. Does not
// measure DSH's other plugins, installation, live desktop composition, hover or startup costs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { zstdCompressSync } from 'node:zlib';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const base = '92e4d3e489a7740c3f334e28e44b4ffd38fc967c';
const mode = process.argv[2] || 'paired', seconds = Number(process.argv[3] || 12);
assert.ok(['baseline','candidate','paired'].includes(mode));
assert.ok(Number.isInteger(seconds) && seconds >= 4 && seconds <= 120);
assert.equal(process.platform, 'win32', 'No desktop or non-Windows fallback');
const electronBin = require('electron'); // local windows/node_modules only; do not download or install
assert.equal(typeof electronBin, 'string');
assert.ok(path.resolve(electronBin).startsWith(path.join(repo, 'windows', 'node_modules')+path.sep));
const tempParent = fs.realpathSync(os.tmpdir());
const work = fs.mkdtempSync(path.join(tempParent, 'notch-status-bench-'));
const root = path.join(work, 'dsh'), oldTime = new Date('2025-01-01T00:00:00Z');
const sessionId = 'session-bench-0000', title = 'synthetic-0', projects = 17, histories = 782;
const activeFile = path.join(root, 'sessions', 'p0', sessionId, 'session.v4.jsonl.zstd');
const frame = obj => zstdCompressSync(Buffer.from(JSON.stringify(obj)+'\n'));
let seed;
function fixtures() {
  const proj = path.join(root, 'storages','session_projcache','sessions'); fs.mkdirSync(proj,{recursive:true});
  for (let n=0; n<histories; n++) {
    const id = 'session-bench-'+String(n).padStart(4,'0'), dir = path.join(root,'sessions','p'+n%projects,id);
    const header = frame({type:'session',id,version:4,cwd:'X:/synthetic',createdAt:+oldTime});
    if (n === 0) seed = header;
    fs.mkdirSync(dir,{recursive:true}); const file = path.join(dir,'session.v4.jsonl.zstd');
    fs.writeFileSync(file,header); fs.utimesSync(file,oldTime,oldTime);
    fs.writeFileSync(path.join(proj,id+'.json'),JSON.stringify({record:{rows:{title:{val:`synthetic-${n}`,seq:1}}}}));
  }
}
function git(...args) { return execFileSync('git',['-C',repo,...args],{windowsHide:true}); }
const snapshots = new Map();
function sourceCopy(dir, label) {
  const from = path.join(repo,'windows','src'), src = path.join(dir,'src');
  // Freeze both arms; a concurrent source edit cannot silently mix B1 and B2.
  const saved = snapshots.get(label);
  if (saved) {
    fs.cpSync(path.join(saved.dir,'src'),src,{recursive:true});
    if (label==='candidate') fs.copyFileSync(path.join(saved.dir,'session-status.mjs'),path.join(dir,'session-status.mjs'));
    return saved.hash;
  }
  fs.mkdirSync(src);
  const names = label === 'baseline' ? git('ls-tree','--name-only',base+':windows/src').toString().trim().split('\n') : fs.readdirSync(from);
  const hash = createHash('sha256');
  for (const name of names.sort()) {
    assert.match(name,/^[\w.-]+\.(?:js|css|html)$/);
    const buf = label === 'baseline' ? git('show',base+':windows/src/'+name) : fs.readFileSync(path.join(from,name));
    hash.update(name+'\0').update(buf);
    if (name === 'main.js') {
      // Private copy: replace only the Electron desktop boundary, not the status loop / interval.
      const text = buf.toString(), needle = "require('electron')";
      assert.equal(text.split(needle).length,2); fs.writeFileSync(path.join(src,name),text.replace(needle,'global.__benchDesktop'));
    } else fs.writeFileSync(path.join(src,name),buf);
  }
  if (label === 'candidate') {
    const host = fs.readFileSync(path.join(repo,'lib','session-status.js')); hash.update('session-status.js\0').update(host);
    fs.writeFileSync(path.join(dir,'session-status.mjs'),host);
  }
  const digest = hash.digest('hex'); snapshots.set(label,{dir,hash:digest}); return digest;
}
// Serialized into the private Electron app's CJS entrypoint. Self-contained (no parent closure).
function boot() {
  const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
  const http = require('node:http'), real = require('electron'), {app} = real;
  const spec = require('./params.json');
  function fail(e) { fs.writeFileSync(path.join(__dirname,'failure.txt'),String(e?.stack || e)); app.exit(1); }
  process.on('uncaughtException',fail); process.on('unhandledRejection',fail);
  const here = p => path.join(__dirname,p);
  app.setName(spec.name); app.setPath('appData',process.env.APPDATA);
  for (const [key,p] of Object.entries({userData:'userData',sessionData:'sessionData',crashDumps:'crashes',logs:'logs'})) {
    fs.mkdirSync(here(p),{recursive:true}); app.setPath(key,here(p));
  }
  app.commandLine.appendSwitch('disable-background-networking');
  assert.equal(app.getPath('userData'),here('userData'));
  // Fail closed before loading any subject code. This also guards the old 47311 fallback.
  for (const method of ['get','request']) { const orig=http[method]; http[method]=function(opts,...args) {
    if (opts?.host !== '127.0.0.1' || opts.port !== spec.port) { fail(Error('unauthorized bench destination')); throw Error('blocked'); }
    return orig.call(this,opts,...args);
  }; }
  const { bridgePort, bridgeFilePath } = require('./src/bridge.js');
  assert.equal(bridgeFilePath(),path.join(process.env.APPDATA,'DSHNotch','bridge.json'));
  assert.equal(bridgePort(),spec.port); assert.ok(![47311,47312].includes(spec.port));
  const sessions = path.join(process.env.DSH_ROOT,'sessions');
  const readdir = fs.readdirSync; let scans=0;
  fs.readdirSync = function(dir,...opts) { if (dir === sessions) scans++; return readdir.call(this,dir,...opts); };
  let wc, sends=0, last=null, visible=false;
  const area = {x:0,y:0,width:1200,height:800}, display={workArea:area,bounds:area};
  const denied = () => { throw Error('forbidden desktop action'); };
  global.__benchDesktop = {
    app: new Proxy(app,{get(o,k) {
      if (k === 'getLoginItemSettings') return () => ({openAtLogin:false});
      if (k === 'setLoginItemSettings') return denied;
      if (k === 'requestSingleInstanceLock') return () => { assert.equal(o.getPath('userData'),here('userData')); assert.ok(o.requestSingleInstanceLock()); return true; };
      return typeof o[k] === 'function' ? o[k].bind(o) : o[k];
    }}),
    BrowserWindow: class {
      constructor(opts) {
        const win = new real.BrowserWindow({...opts,show:false,alwaysOnTop:false,focusable:false,skipTaskbar:true,
          webPreferences:{...opts.webPreferences,offscreen:true}});
        wc = win.webContents;
        const send = wc.send.bind(wc); wc.send = (ch,...args) => { const v=send(ch,...args); if (ch==='island:snapshot') { sends++; last=args[0]; } return v; };
        win.on('show',()=>fail(Error('OS window unexpectedly shown')));
        let b = {x:0,y:0,width:opts.width,height:opts.height};
        return { webContents:wc, loadFile:p=>win.loadFile(p), on:(...a)=>win.on(...a), once:(...a)=>win.once(...a),
          isDestroyed:()=>win.isDestroyed(), setAlwaysOnTop(){}, setVisibleOnAllWorkspaces(){}, setIgnoreMouseEvents(){},
          getBounds:()=>b, setBounds:n=>{b=n;}, isVisible:()=>visible, show:()=>{visible=true;}, hide:()=>{visible=false;}, focus:denied };
      }
    },
    Tray: class {setToolTip(){} setContextMenu(){} on(){} destroy(){}}, Menu:{buildFromTemplate:()=>({popup:denied})},
    screen:{getPrimaryDisplay:()=>display,getAllDisplays:()=>[display],getCursorScreenPoint:()=>({x:-100,y:-100}),on(){}},
    clipboard:{writeText:denied}, shell:{openExternal:denied,openPath:denied,showItemInFolder:denied},ipcMain:real.ipcMain,nativeImage:real.nativeImage,
  };
  app.on('ready',()=>real.session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(_d,cb)=>cb({cancel:true})));
  require('./src/main.js');
  const sleep = ms => new Promise(r=>setTimeout(r,ms));
  const until = async (fn,what) => { const end=Date.now()+10000; while (!fn()) { if(Date.now()>end) throw Error('missing '+what+': '+JSON.stringify(last)); await sleep(40); } };
  const host = action => new Promise((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port:spec.port,path:'/'+spec.key+'/'+action},res=>{
    let s='';res.on('data',c=>s+=c);res.on('end',()=>{try { assert.equal(res.statusCode,200,s); resolve(JSON.parse(s)); } catch(e){reject(e);} });
  });req.on('error',reject);});
  const metric = () => {
    const metrics=app.getAppMetrics();
    const getCpu=(pid)=>{ const n=metrics.find(x=>x.pid===pid)?.cpu?.cumulativeCPUUsage; assert.ok(Number.isFinite(n),'missing cumulative CPU for '+pid); return n*1000; };
    return {mainMs:getCpu(process.pid),rendererMs:getCpu(wc.getOSProcessId()),scans,sends};
  };
  async function measure(scene) {
    const a=metric(),t=performance.now(); await host('begin-'+scene); await sleep(spec.seconds*1000); const h=await host('end-'+scene);
    const b=metric(), wallMs=performance.now()-t, out={scene,wallMs:Math.round(wallMs)};
    for(const k of Object.keys(a)) out[k]=+(b[k]-a[k]).toFixed(3);
    return {...out,...h,totalMs:+(out.mainMs+out.rendererMs+h.hostMs).toFixed(3),oneCorePct:+(100*(out.mainMs+out.rendererMs+h.hostMs)/wallMs).toFixed(3)};
  }
  app.whenReady().then(async()=>{
    await until(()=>last?.bridge?.ok===true && (spec.label==='baseline' || last.bridge.statesOnline===true),'initial healthy snapshot');
    assert.ok(await wc.executeJavaScript('!!(window.island && document.getElementById("island"))'));
    await sleep(2200); const idle=await measure('idle');
    await host('turn-start'); await until(()=>visible && last.entries.some(e=>e.live && e.id===spec.id),'running');
    const running=last.entries[0].status, transitionStartSends=sends;
    const readPhase=()=>wc.executeJavaScript('document.getElementById("island").dataset.status');
    await sleep(600); assert.equal(await readPhase(),running,'renderer must consume the running snapshot');
    const storm=await measure('storm');
    const before=sends; await host('turn-end'); await until(()=>last.entries.some(e=>e.status==='done' && e.id===spec.id),'done');
    await sleep(200); const terminal=await readPhase(); assert.equal(terminal,'done','renderer must consume the terminal snapshot');
    const out={electron:process.versions.electron,running,terminal,initialThroughRunningSends:transitionStartSends,terminalSends:sends-before,idle,storm};
    assert.equal(storm.events,spec.seconds*10*16); assert.equal(idle.events,0);
    if(spec.label==='baseline') assert.ok(idle.scans>0 && storm.scans>0 && storm.sends>0);
    else { assert.equal(idle.scans+storm.scans,0); assert.equal(idle.sends+storm.sends,0); assert.equal(storm.statusRevisionChanged,false); }
    fs.writeFileSync(here('result.json'),JSON.stringify(out)); app.quit();
  }).catch(fail);
}

async function run(label,index) {
  const dir=path.join(work,`${index}-${label}`); fs.mkdirSync(dir);
  const srcHash=sourceCopy(dir,label), roaming=path.join(dir,'roaming'), local=path.join(dir,'local'), home=path.join(dir,'home');
  const tmp=path.join(dir,'tmp');
  for(const p of [path.join(roaming,'DSHNotch'),local,home,tmp]) fs.mkdirSync(p,{recursive:true});
  const settings=path.join(roaming,'DSHNotch','client-config.json'); fs.writeFileSync(settings,JSON.stringify({hideWhenIdle:true,notchEnabled:true}));
  // Set paths for the mock Host process itself as well as for its Electron child.
  const privateEnv={DSH_ROOT:root,DSH_HOME:root,DSH_PROFILE_DIR:path.join(root,'profile'),APPDATA:roaming,LOCALAPPDATA:local,USERPROFILE:home,HOME:home,DSH_NOTCH_CONFIG:settings,TEMP:tmp,TMP:tmp};
  for(const k of Object.keys(process.env)) if(/^DSH_/i.test(k)) delete process.env[k];
  Object.assign(process.env,privateEnv);
  fs.writeFileSync(activeFile,seed); fs.utimesSync(activeFile,oldTime,oldTime);
  const handlers=new Map(), s={id:sessionId, header:{id:sessionId,cwd:'X:/synthetic'}}, a={id:sessionId,status:'idle',session:s};
  let store, seq=0, cpu, rev, measure, events=0, replies=0, batches=0, timer, projectionReads=0, beforeReads=0;
  if(label==='candidate') {
    const {SessionStates}=await import(pathToFileURL(path.join(dir,'session-status.mjs')));
    const services={agents:{list:()=>[a],get:id=>id===a.id?a:null},sessionProjections:{snapshot(){projectionReads++;return {values:{title,userQuestions:{active:[]}}};}},typertGateway:{getPendingRemoteEvents:()=>[]}};
    store=new SessionStates().attach({get:k=>services[k],on:(k,fn)=>{handlers.set(k,fn);return ()=>handlers.delete(k);}});
  }
  const newEvent=(type,data)=>({seq:++seq,type,data,time:Date.now()});
  const append=rows=>{
    fs.appendFileSync(activeFile,zstdCompressSync(Buffer.from(rows.map(r=>JSON.stringify(r)+'\n').join(''))));
    for(const e of rows) handlers.get('session/event')?.(s,e);
  };
  const batch=()=>{const rows=[]; for(let i=0;i<8;i++) {const id=`r${seq}`;rows.push(newEvent('tool/call',{name:'read',callId:id}),newEvent('tool/result',{message:{toolCallId:id}}));} append(rows);events+=rows.length;batches++;};
  const key=randomUUID(), plugin='@dsh-external/dsh-vibe-island';
  const server=http.createServer((req,res)=>{
    const u=new URL(req.url,'http://127.0.0.1'), name=u.pathname;
    const send=(code,obj)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(obj));};
    try {
      if(name==='/health') return send(200,{ok:true,plugin,port:server.address().port,pending:0});
      if(name==='/nudges') return send(200,{ok:true,plugin,rev:'empty',items:[]});
      if(name==='/session-states' && store) return store.serve(u.searchParams.get('since'),req,res,(code,body)=>{replies++;send(code,{plugin,...body});});
      if(name==='/'+key+'/turn-start') {a.status='running';append([newEvent('turn/start',{turn:1})]);}
      else if(name==='/'+key+'/turn-end') {a.status='idle';append([newEvent('turn/end',{reason:{kind:'completed'}})]);}
      else if(name==='/' + key + '/begin-idle' || name==='/' + key + '/begin-storm') {
        measure=name.endsWith('storm')?'storm':'idle'; events=batches=replies=0; rev=store?.snapshot().rev; beforeReads=projectionReads; cpu=process.cpuUsage();
        if(measure==='storm') {const start=performance.now(); const advance=()=>{batch();if(batches<seconds*10)timer=setTimeout(advance,Math.max(0,start+100*batches-performance.now()));};advance();}
      } else if(measure && name==='/' + key + '/end-'+measure) {
        const used=process.cpuUsage(cpu); const result={hostMs:(used.user+used.system)/1000,events,stateHttpReplies:replies,projectionReads:projectionReads-beforeReads,statusRevisionChanged:store?rev!==store.snapshot().rev:null};measure=null;return send(200,result);
      } else return send(404,{});
      send(200,{ok:true});
    } catch(e) {send(500,{error:String(e)});}
  });
  try {
    // Random private port chosen *before* bind: even a machine with a custom OS
    // ephemeral range cannot accidentally assign 47311/47312 to the fixture.
    for(let attempt=1;;attempt++) {
      try {
        await new Promise((ok,no)=>{
          const error=e=>{server.off('listening',ready);no(e);};
          const ready=()=>{server.off('error',error);ok();};
          server.once('error',error);server.once('listening',ready);
          server.listen({port:randomInt(49152,65536),host:'127.0.0.1',exclusive:true});
        }); break;
      } catch(e) { if(attempt>=16 || !['EADDRINUSE','EACCES'].includes(e.code)) throw e; }
    }
    const port=server.address().port; assert.ok(port>1023 && ![47311,47312].includes(port));
    fs.writeFileSync(path.join(roaming,'DSHNotch','bridge.json'),JSON.stringify({port}));
    const name='status-bench-'+randomUUID(); fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name,main:'boot.cjs'}));
    fs.writeFileSync(path.join(dir,'params.json'),JSON.stringify({label,port,seconds,id:sessionId,key,name}));
    fs.writeFileSync(path.join(dir,'boot.cjs'),`'use strict';(${boot})();`);
    const env={...process.env}; for(const k of Object.keys(env)) if(/^(DSH_|ELECTRON_|NODE_OPTIONS$|NODE_PATH$)/i.test(k)) delete env[k];
    Object.assign(env,privateEnv);
    const child=spawn(electronBin,['--no-error-dialogs','--disable-breakpad','--user-data-dir='+path.join(dir,'userData'),dir],{env,cwd:dir,windowsHide:true,stdio:'inherit'});
    const timeout=setTimeout(()=>child.kill(),(seconds*2+40)*1000);
    let code; try {code=await new Promise((ok,no)=>{child.on('error',no);child.on('exit',ok);});} finally {clearTimeout(timeout);}
    if(code!==0 || !fs.existsSync(path.join(dir,'result.json'))) throw Error(`isolated Electron ${label} exit=${code}: `+(fs.existsSync(path.join(dir,'failure.txt'))?fs.readFileSync(path.join(dir,'failure.txt'),'utf8'):'no result'));
    const row={label,srcHash,port,...JSON.parse(fs.readFileSync(path.join(dir,'result.json'),'utf8'))};console.log(JSON.stringify(row));
  } finally {clearTimeout(timer);store?.dispose();server.closeAllConnections();await new Promise(ok=>server.close(ok));}
}
try {
  fixtures(); const order=mode==='paired'?['baseline','candidate','candidate','baseline']:[mode];
  console.log(JSON.stringify({base,histories,projects,seconds,order,node:process.version,cpus:os.cpus().length,platform:os.release()}));
  for(const [i,label] of order.entries()) await run(label,i);
} finally {
  const resolved=fs.realpathSync(work); assert.equal(path.dirname(resolved),tempParent); assert.match(path.basename(resolved),/^notch-status-bench-[A-Za-z0-9]+$/);
  fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:250});
}
