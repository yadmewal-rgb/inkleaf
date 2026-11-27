// Runs the app checks in a normal tab of the owner's own Chrome (their wish, 2026-11-25: no separate window).
// The tab shows the app in a frame and asks this program what to do next. It lives on its own local address, so it
// cannot reach the real Inkleaf library, and the app in it gets a pretend clipboard.
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';

const EXE = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(p => fs.existsSync(p));

// Out of sight (another tab in front, or the window covered) Chrome hardly runs the app, so everything waits.
const GIVE_UP = 10 * 60e3;
const tab = { hidden: false, since: 0, times: 0, closed: '' };
function setHidden(on) {
  if (on === tab.hidden) return;
  tab.hidden = on;
  if (!on) return;
  tab.since = Date.now();
  tab.times++;
  console.log('   PAUSED: click the "Inkleaf check" tab in Chrome to go on.');
}

// Waiting only counts while the check tab can be seen, and allows it a moment to catch up after being out of sight.
// waited() = milliseconds spent in fixed waits so far (for the time report at the end of the check).
let sleptMs = 0;
export const waited = () => sleptMs;
export const sleep = async ms => { sleptMs += ms; await pause(ms); };
// The same wait, not counted as fixed waiting: for "wait until it is ready" loops.
export const pause = async ms => {
  for (let left = ms; left > 0 && !tab.closed;) {
    const t = Date.now();
    await new Promise(r => setTimeout(r, Math.min(100, left)));
    left = tab.hidden ? Math.max(left, 1500) : left - (Date.now() - t);
  }
};

// Put in front of everything else in the app's page, for the checks only.
export const INJECT = `<script>
(() => {
  const tell = m => { if (!/ResizeObserver loop/.test(m)) top.postMessage({ inkleafError: m }, location.origin); };
  addEventListener('error', e => { if (e.message) tell(String(e.error && e.error.stack || e.message).split('\\n').slice(0, 2).join(' | ')); });
  addEventListener('unhandledrejection', e => tell(String(e.reason && (e.reason.stack || e.reason.message) || e.reason).split('\\n').slice(0, 2).join(' | ')));
  let text = '';
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async t => { text = String(t); }, readText: async () => text, read: async () => [], write: async () => {} } });
})();
</script>`;

const PAGE = key => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Inkleaf check</title><style>
body{margin:0;font:14px/1.45 system-ui,sans-serif;background:#f4f3ef;color:#1c1d21;display:grid;grid-template-columns:330px 1fr;height:100vh;overflow:hidden}
#side{padding:14px;overflow:auto;border-right:1px solid #d5d3cc;background:#fff}h1{font-size:17px;margin:0 0 6px}
#state{padding:8px 10px;border-radius:8px;background:#e2efe9;margin-bottom:10px}#state.bad{background:#fbe0e0}#state.wait{background:#fff0c9}
#log div{padding:2px 0;border-bottom:1px solid #eee}#log .f{color:#c01818;font-weight:600}#log .h{font-weight:700;margin-top:8px}
#stage{position:relative;overflow:hidden}#f{border:0;background:#fff;position:absolute;left:0;top:0;transform-origin:0 0}
</style></head><body><div id="side"><h1>Inkleaf check</h1><div id="state">Starting...</div><div id="log"></div></div><div id="stage"><iframe id="f"></iframe></div>
<script>
const K='${key}',f=document.getElementById('f'),stage=document.getElementById('stage'),state=document.getElementById('state'),log=document.getElementById('log');
let W=1194,H=834,errs=[],ended=false;
const post=(p,o)=>fetch(p+'?k='+K,{method:'POST',body:JSON.stringify(o||{})});
const fit=()=>{const k=Math.min(1,stage.clientWidth/W,stage.clientHeight/H);f.style.width=W+'px';f.style.height=H+'px';f.style.transform='scale('+k+')';};
addEventListener('resize',fit);
addEventListener('message',e=>{if(e.origin===location.origin&&e.data&&e.data.inkleafError)errs.push(e.data.inkleafError);});
const say=(t,c)=>{state.textContent=t;state.className=c||'';};
const seen=()=>post('/__seen',{hidden:document.hidden}).catch(()=>{});
document.addEventListener('visibilitychange',()=>{if(!ended)seen();});
addEventListener('pagehide',()=>{if(!ended)navigator.sendBeacon('/__closed?k='+K);});
const visible=async()=>{if(!document.hidden)return;await seen();document.title='PAUSED - click here - Inkleaf check';say('Paused: please keep this tab in front.','wait');while(document.hidden)await new Promise(r=>setTimeout(r,300));await seen();document.title='Inkleaf check';await new Promise(r=>setTimeout(r,1500));};
// Nothing of the app keeps running in this tab, or keeps its test library open.
const blank=async()=>{if(f.contentWindow.location.href==='about:blank')return;await new Promise(r=>{f.onload=r;f.src='about:blank';});};
const jobs={
 size:async m=>{W=m.w;H=m.h;fit();},
 dark:async m=>{f.style.colorScheme=m.on?'dark':'light';},
 go:async m=>{await new Promise(r=>{f.onload=r;f.src=m.url;});},
 ev:async m=>f.contentWindow.eval('(async()=>{'+m.code+'})()'),
 clean:async()=>{await blank();for(const d of await indexedDB.databases())if(/^inkleaf/.test(d.name))await new Promise(r=>{const q=indexedDB.deleteDatabase(d.name);q.onsuccess=q.onerror=q.onblocked=r;});for(const k of Object.keys(localStorage))if(/^inkleaf/.test(k))localStorage.removeItem(k);if(navigator.serviceWorker)for(const r of await navigator.serviceWorker.getRegistrations())await r.unregister();for(const k of await caches.keys())if(/^inkleaf/.test(k))await caches.delete(k);},
 end:async m=>{ended=true;say(m.text,m.bad?'bad':'');document.title=(m.bad?'FAILED':'OK')+' - Inkleaf check';}
};
(async()=>{
 fit();
 while(!ended){
  let m;
  try{m=await (await fetch('/__next?k='+K)).json();}catch(e){if(!ended){ended=true;await blank();document.title='Stopped - Inkleaf check';say('The check program has stopped. You can close this tab.','bad');}return;}
  for(const l of m.log||[]){const d=document.createElement('div');d.textContent=l.t;d.className=l.c||'';log.append(d);d.scrollIntoView({block:'nearest'});}
  if(!m.type)continue;
  if(m.type!=='end'){await visible();say('Testing. Please leave this tab in front; you need not do anything.');}
  const out={id:m.id};
  try{const v=await jobs[m.type](m);out.value=v===undefined?null:v;}catch(e){out.error=String(e&&e.stack||e).slice(0,600);}
  await new Promise(r=>setTimeout(r)); // errors are reported a moment after they happen
  out.errs=errs;errs=[];
  await post('/__result',out).catch(()=>{});
 }
})();
</script></body></html>`;

export function ownChrome() {
  const key = crypto.randomBytes(16).toString('hex');
  const errors = [], wait = new Map(), queue = [];
  let log = [], poll = null, nextId = 0, connected = false;
  const send = (res, o) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
  const pump = () => {
    if (!poll || (!queue.length && !log.length)) return;
    const res = poll;
    poll = null;
    send(res, { ...(queue.shift() || {}), log });
    log = [];
  };
  const fail = why => { if (!tab.closed) tab.closed = why; for (const w of wait.values()) w.rej(new Error(why)); wait.clear(); };
  const job = (type, o = {}) => new Promise((res, rej) => {
    if (tab.closed) { rej(new Error(tab.closed)); return; }
    const id = ++nextId;
    let left = 90;
    const t = setInterval(() => { if (!tab.hidden && --left <= 0) { wait.delete(id); clearInterval(t); rej(new Error('the check tab did not answer')); } }, 1000);
    const done = fn => v => { clearInterval(t); fn(v); };
    wait.set(id, { res: done(res), rej: done(rej) });
    queue.push({ id, type, ...o });
    pump();
  });
  return {
    errors,
    get hiddenTimes() { return tab.times; },
    get closed() { return tab.closed; },
    // Answers the tab's requests; false = not one of them.
    handle(q, r) {
      const u = new URL(q.url, 'http://localhost');
      if (!u.pathname.startsWith('/__')) return false;
      if (u.searchParams.get('k') !== key) { r.writeHead(403); r.end(); return true; }
      if (u.pathname === '/__check') { r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); r.end(PAGE(key)); return true; }
      if (u.pathname === '/__next') { connected = true; if (poll) send(poll, {}); poll = r; pump(); return true; }
      let body = '';
      q.on('data', d => { body += d; });
      q.on('end', () => {
        const m = body ? JSON.parse(body) : {};
        if (u.pathname === '/__seen') setHidden(!!m.hidden);
        else if (u.pathname === '/__closed') fail('the check tab was closed');
        else if (u.pathname === '/__result') {
          errors.push(...(m.errs || []));
          const w = wait.get(m.id);
          wait.delete(m.id);
          if (w) { if (m.error) w.rej(new Error(m.error)); else w.res(m.value); }
        }
        send(r, {});
      });
      return true;
    },
    async open(web) {
      if (!EXE) { fail('Google Chrome was not found on this computer'); throw new Error(tab.closed); }
      spawn(EXE, [`${web}/__check?k=${key}`], { detached: true, stdio: 'ignore' }).unref(); // a new tab, if Chrome is already running
      for (let i = 0; i < 120 && !connected; i++) await new Promise(r => setTimeout(r, 250));
      if (!connected) { fail('the check tab did not open in Chrome'); throw new Error(tab.closed); }
      setInterval(() => { if (tab.hidden && Date.now() - tab.since > GIVE_UP) fail('the check tab was out of sight for 10 minutes; run the check again and keep it in front'); }, 1000).unref();
      await job('clean'); // whatever an earlier check that was cut off has left behind
    },
    log(t, c) { log.push({ t, c }); pump(); },
    // Fixed waits written inside the page code count too (each once; a wait inside a loop counts once).
    ev: code => { for (const m of code.matchAll(/setTimeout\(r,\s*(\d+)\)/g)) sleptMs += Number(m[1]); return job('ev', { code }); },
    size: (w, h) => job('size', { w, h }),
    dark: on => job('dark', { on }),
    go: async (url, ms = 1800) => { await job('go', { url }); await sleep(ms); },
    async close(text, bad) {
      await job('clean').catch(() => {});
      await job('end', { text, bad }).catch(() => {});
    }
  };
}
