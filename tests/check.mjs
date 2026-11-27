// Inkleaf's checks before a release. Run check.cmd (or: node check.mjs). Exits with an error if anything fails.
//   node check.mjs --quick         code and server only, no browser
//   node check.mjs --only=writing  only these parts (comma list): code, server, library, writing, devices
//                                  (a part always runs from its beginning)
//   INKLEAF_ROOT=<folder>          check another copy of the app (to see that an old bug is really caught)
import fs from 'fs';
import http from 'http';
import path from 'path';
import zlib from 'zlib';
import { execFileSync } from 'child_process';
import { ESLint } from 'eslint';
import globals from 'globals';
import postcss from 'postcss';
import { Miniflare } from 'miniflare';
import { ownChrome, INJECT, sleep, pause, waited } from './lib.mjs';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const ROOT = path.resolve(process.env.INKLEAF_ROOT || path.join(here, '..'));
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let passed = 0;
const failed = [];
const c = ownChrome(); // the tab in the owner's Chrome
const ONLY = ((process.argv.find(a => a.startsWith('--only=')) || '').slice(7)).split(',').map(x => x.trim()).filter(Boolean);
const want = part => !ONLY.length || ONLY.includes(part);
// Time report: how long each check took since the one before it, and how much of that was fixed waiting.
const times = [], parts = [];
let tLast = Date.now(), wLast = waited();
const mark = () => { tLast = Date.now(); wLast = waited(); };
const ok = (name, cond, detail = '') => {
  times.push({ name, ms: Date.now() - tLast, wait: waited() - wLast }); mark();
  if (cond) passed++; else failed.push(name + (detail !== '' ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''));
  c.log((cond ? '✓ ' : '✗ ') + name, cond ? '' : 'f');
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${cond || detail === '' ? '' : '  -> ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))}`);
};
// A step that breaks counts as a failure; the rest still runs.
const step = async (name, fn) => { try { await fn(); } catch (e) { ok(name, false, String(e && e.message || e).slice(0, 300)); } };
// A part of the check that runs in the tab. If it fails although the tab was out of sight for a while, that proves
// nothing, so it is run again, once. (A failure while the tab was in front the whole time always counts.)
const section = async (name, fn) => {
  const t0 = Date.now(), w0 = waited();
  try { await sectionRun(name, fn); } finally { parts.push({ name, ms: Date.now() - t0, wait: waited() - w0 }); }
};
const sectionRun = async (name, fn) => {
  mark();
  for (let go = 1; ; go++) {
    const p0 = passed, f0 = failed.length, h0 = c.hiddenTimes;
    await step(name, fn);
    if (failed.length === f0 || c.hiddenTimes === h0 || go === 2 || c.closed) return;
    console.log('   The tab was out of sight during this part, so it does not count. Running it again.');
    c.log('Out of sight during this part: running it again', 'h');
    passed = p0;
    failed.length = f0;
    c.errors.length = 0;
  }
};
// A step outside the tab, timed for the report, run only when its part is wanted.
const tstep = async (part, name, fn) => {
  if (part && !want(part)) return;
  const t0 = Date.now(), w0 = waited();
  mark();
  await step(name, fn);
  parts.push({ name, ms: Date.now() - t0, wait: waited() - w0 });
};
// Goes on as soon as fn() gives a truthy value (asked every 150 ms, for at most about `max` ms) and returns the last
// value; a check after it still decides. Used instead of fixed waits, so the check takes only as long as the app needs.
const until = async (fn, max = 8000) => {
  let v;
  for (let t = 0; t < max; t += 150) { v = await fn().catch(() => undefined); if (v) return v; await pause(150); }
  return v;
};
const fresh = () => Math.random().toString(36).slice(2, 8); // a new test library every time, whatever older tabs still do

// ------------------------------------------------------------------ 1. the code
console.log(`Checking ${ROOT}\n\n1. Code`);
const jsFiles = fs.readdirSync(path.join(ROOT, 'js')).filter(f => f.endsWith('.js'));
await tstep('code', 'code is readable', async () => {
  const rules = Object.fromEntries(['no-undef', 'no-dupe-keys', 'no-dupe-args', 'no-dupe-else-if', 'no-duplicate-case', 'no-redeclare', 'no-func-assign', 'no-import-assign',
    'no-const-assign', 'no-unreachable', 'no-self-assign', 'no-self-compare', 'no-unsafe-finally', 'no-unsafe-negation', 'no-constant-binary-expression', 'no-dupe-class-members',
    'use-isnan', 'valid-typeof', 'no-setter-return', 'getter-return'].map(r => [r, 2]));
  const eslint = new ESLint({
    cwd: ROOT, overrideConfigFile: true, overrideConfig: [
      { files: ['js/*.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.browser, pdfjsLib: 'readonly', PDFLib: 'readonly', google: 'readonly' } }, rules },
      { files: ['sw.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: globals.serviceworker }, rules },
      { files: ['server/*.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.serviceworker, WebSocketPair: 'readonly' } }, rules }]
  });
  for (const r of await eslint.lintFiles(['js/*.js', 'sw.js', 'server/*.js'])) {
    const bad = r.messages.filter(m => m.severity === 2);
    ok(`${path.relative(ROOT, r.filePath)}: no errors`, !bad.length, bad.slice(0, 3).map(m => `line ${m.line}: ${m.message}`).join('; '));
  }
});
await tstep('code', 'imports', async () => {
  const exp = {}, missing = [];
  for (const f of jsFiles) {
    const s = read('js/' + f), x = exp[f] = new Set();
    for (const m of s.matchAll(/^export\s+(?:async\s+)?(?:function\*?|class)\s+(\w+)/gm)) x.add(m[1]);
    for (const m of s.matchAll(/^export\s+(?:const|let|var)\s+(.+)$/gm)) for (const n of m[1].matchAll(/(?:^|,\s*)(\w+)\s*=/g)) x.add(n[1]);
    for (const m of s.matchAll(/^export\s*\{([^}]*)\}/gm)) m[1].split(',').forEach(n => x.add(n.trim().split(/\s+as\s+/).pop()));
  }
  for (const f of jsFiles) for (const m of read('js/' + f).matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/([\w-]+\.js)'/g)) {
    for (const n of m[1].split(',').map(t => t.trim().split(/\s+as\s+/)[0]).filter(Boolean)) if (!exp[m[2]] || !exp[m[2]].has(n)) missing.push(`${f} -> ${m[2]}: ${n}`);
  }
  ok('every import exists', !missing.length, missing.join('; '));
});
await tstep('code', 'styles', async () => {
  const seen = new Map(), clash = [];
  postcss.parse(read('css/app.css')).walkRules(r => {
    if (r.parent.type === 'atrule' && /keyframes/.test(r.parent.name)) return;
    const ctx = r.parent.type === 'atrule' ? '@' + r.parent.name + r.parent.params : '', d = {};
    r.walkDecls(x => { d[x.prop] = x.value; });
    for (const s of r.selectors) {
      const k = ctx + ' ' + s, o = seen.get(k) || {};
      for (const p in d) if (p in o && o[p] !== d[p]) clash.push(`${s} {${p}} line ${r.source.start.line}`);
      seen.set(k, { ...o, ...d });
    }
  });
  ok('no style rule contradicts another', !clash.length, clash.join('; '));
});
const cache = (/const CACHE = 'inkleaf-(v\d+)'/.exec(read('sw.js')) || [])[1], ver = (/APP_VER = '(v\d+)'/.exec(read('js/sync.js')) || [])[1];
await tstep('code', 'versions', async () => {
  ok('sw.js and Settings show the same version', cache && cache === ver, `${cache} / ${ver}`);
  const list = [...read('sw.js').split('SHELL = [')[1].split('];')[0].matchAll(/'([^']+)'/g)].map(m => m[1]);
  ok('every file kept for offline use exists', list.every(f => f === './' || fs.existsSync(path.join(ROOT, f))), list.filter(f => f !== './' && !fs.existsSync(path.join(ROOT, f))));
  ok('every script is kept for offline use', jsFiles.every(f => list.includes('js/' + f)), jsFiles.filter(f => !list.includes('js/' + f)));
  if (!process.env.INKLEAF_ROOT) {
    const git = (...a) => execFileSync('C:\\Program Files\\Git\\cmd\\git.exe', a, { cwd: ROOT }).toString().trim();
    const appChanged = git('diff', '--name-only', 'origin/main', '--', 'js', 'css', 'index.html', 'sw.js', 'vendor', 'icons');
    const live = (/const CACHE = 'inkleaf-(v\d+)'/.exec(git('show', 'origin/main:sw.js')) || [])[1];
    ok('the version number was raised', !appChanged || live !== cache, `still ${cache}, but these changed: ${appChanged.split('\n').join(', ')}`);
  }
});

// ------------------------------------------------------------------ a local copy of the app and of the sync server
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
// The opening check needs a network that is slow (delay ms), gone ('down') or silent ('hang': connected, no answer),
// and the offline copy (sw.js) only then. It runs the app under /app/ (like /inkleaf/ on GitHub Pages), so the copy
// covers only /app/: never this check tab, nor the other parts at /. swVer = pretend a new release.
// /sw.js is a copy-keeper that removes itself and all copies: one left from an older check (an old check tab keeps it
// alive) is replaced by it as soon as the app starts at /, so the other parts never get files from an old copy.
const KILL = "self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.map(x=>caches.delete(x)))).then(()=>self.registration.unregister())));";
const net = { sw: false, delay: 0, mode: '', swVer: '', hung: [] };
const netReset = () => { Object.assign(net, { sw: false, delay: 0, mode: '', swVer: '' }); for (const r of net.hung.splice(0)) r.destroy(); };
const site = http.createServer(async (q, r) => {
  if (c.handle(q, r)) return;
  if (net.mode === 'down') { r.destroy(); return; }
  if (net.mode === 'hang') { net.hung.push(r); return; }
  if (net.delay) await pause(net.delay);
  let p = decodeURIComponent(q.url.split('?')[0]);
  if (p === '/sw.js') { r.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }); r.end(KILL); return; }
  const inApp = p === '/app' || p.startsWith('/app/');
  if (inApp) p = p.slice(4) || '/';
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (p === '/sw.js' && (!inApp || !net.sw)) { r.writeHead(404); r.end(); return; }
  if (p === '/sw.js') {
    let code = read('sw.js');
    // A pretend release: another CACHE name (its sync.js version test is switched off, the files are the same).
    if (net.swVer) code = code.replace(/const CACHE = '[^']+'/, () => `const CACHE = '${net.swVer}'`).replace('if (!sync.includes(', 'if (false && !sync.includes(');
    r.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }); r.end(code); return;
  }
  if (!f.startsWith(ROOT) || p === '/sw.js' || !fs.existsSync(f) || !fs.statSync(f).isFile()) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  if (p === '/index.html') { r.end(fs.readFileSync(f, 'utf8').replace('<head>', '<head>' + INJECT)); return; }
  fs.createReadStream(f).pipe(r);
});
// Always the same address, used for nothing else: the tab empties its storage when it is done.
await new Promise((res, rej) => { site.once('error', e => rej(e.code === 'EADDRINUSE' ? new Error('A check is already running.') : e)); site.listen(8099, '127.0.0.1', res); });
const WEB = 'http://localhost:8099';
const ENTRY = `import W, { User as U } from './worker.js';
export class User extends U {}
export default { async fetch(req, env) {
  const u = new URL(req.url);
  if (u.pathname !== '/test-auth') return W.fetch(req, env);
  const sub = u.searchParams.get('sub'), email = u.searchParams.get('email');
  const r = await env.USER.get(env.USER.idFromName(sub)).newSession(email, 'test', null, sub);
  return Response.json({ token: sub + '.' + r.secret, email });
} };`;
let mf = null, API = '';
console.log('\n2. Sync server');
if (want('server') || want('devices')) await tstep('', 'the server starts', async () => {
  mf = new Miniflare({
    modules: [{ type: 'ESModule', path: 'entry.mjs', contents: ENTRY }, { type: 'ESModule', path: 'worker.js', contents: read('server/worker.js') }],
    compatibilityDate: '2025-09-01', durableObjects: { USER: { className: 'User', useSQLite: true } },
    bindings: { ORIGINS: WEB, QUOTA_MB: '500', OWNER_QUOTA_MB: '2000', ALLOWED: 'owner@test.local,friend@test.local,other@test.local' }, host: '127.0.0.1', port: 0
  });
  API = (await mf.ready).toString().replace(/\/$/, '').replace('127.0.0.1', 'localhost');
  ok('the server starts', true);
});
// Rows read per request (Cloudflare's free plan: about 5 million a day). On 2026-11-27 every "what changed?" read the
// whole library and the day's limit ran out by the afternoon. tests/rows.mjs measures it on a library of 3,000 pages.
await tstep('server', 'rows read per request', async () => {
  const out = JSON.parse(execFileSync(process.execPath, [path.join(here, 'rows.mjs'), '--json'], { cwd: ROOT, timeout: 240000 }).toString().trim().split(/\r?\n/).pop());
  const at = name => (out.find(o => o.name.startsWith(name)) || { r: 1e9 }).r;
  ok('"what changed?" reads only what changed', at('/changes, 3 new') <= 20, at('/changes, 3 new') + ' rows for 3 changes');
  ok('the server waking up reads almost nothing', at('server wakes up') <= 50, at('server wakes up') + ' rows');
  ok('a new device reads about one row per record', at('/changes from 0') <= 600, at('/changes from 0') + ' rows for 500 records');
  ok('opening a shared notebook reads only its pages', at('/live/') <= 100, at('/live/') + ' rows');
  const worst = out.filter(o => !/from 0|live/.test(o.name)).sort((a, b) => b.r - a.r)[0];
  ok('no everyday request reads more than 50 rows', worst.r <= 50, worst.r + ' rows: ' + worst.name);
});
const js = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return t.slice(0, 120); } };
const auth = async (sub, who) => js(await fetch(`${API}/test-auth?sub=${sub}&email=${who}@test.local`));
const call = (t, p, o = {}) => fetch(API + p, { ...o, headers: { ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(o.headers || {}) } });
const socket = (p, first) => { const s = new WebSocket(API.replace('http', 'ws') + p); s.got = []; s.onopen = () => { if (first) s.send(JSON.stringify(first)); }; s.onmessage = e => s.got.push(JSON.parse(e.data)); s.onerror = () => {}; return s; };
if (API && want('server')) await tstep('server', 'server tests', async () => {
  const own = await auth('22222', 'owner'), fr = await auth('33333', 'friend'), st = await auth('44444', 'other'); // st: allowed, but not on the share's list
  const put = (k, id, o, info) => call(own.token, `/blob/${k}/${id}?size=10&base=0&gz=1${info ? '&info=' + encodeURIComponent(JSON.stringify(info)) : ''}`, { method: 'PUT', body: zlib.gzipSync(JSON.stringify(o)) });
  const ws = socket('/ws?u=22222', { token: own.token });
  await sleep(900);
  ok('live connection opens', !!ws.got[0]?.hello, ws.got);
  const pages = Array.from({ length: 150 }, (_, i) => 'pg' + i);
  ok('saving works', (await put('d', 'doc1', { id: 'doc1', pages })).status === 200);
  for (const p of pages) await put('p', p, { id: p, docId: 'doc1', items: [] }, { docId: 'doc1' });
  ok('other devices are told about a change', ws.got.some(m => m.s > 1));
  ok('two devices saving at once is noticed', (await call(own.token, '/blob/d/doc1?size=10&base=0', { method: 'PUT', body: 'x' })).status === 409);
  ok('a wrong key is refused', (await call('22222.fake', '/changes?since=0')).status === 401);
  const sh = await js(await call(own.token, '/share/doc1', { method: 'POST', body: JSON.stringify({ allowedEmails: 'friend@test.local' }) }));
  const open = t => call(t, `/live/${sh.shareId}/doc`);
  const f = await open(fr.token), fb = await js(f);
  ok('a friend opens a shared notebook of 150 pages', f.status === 200 && fb.pages.length === 150, fb.error ? fb : '');
  ok('a stranger cannot', (await open(st.token)).status === 403);
  ok('someone not signed in cannot', (await open(null)).status === 401);
  ok('a made-up key cannot', (await open('22222.fake')).status === 401 && (await open('33333.fake')).status === 401);
  ok('e-mail addresses cannot be read from outside', (await call('22222.fake', '/internal/email')).status === 404);
  ok('the share list cannot be written from outside', (await call('22222.fake', '/registry/add', { method: 'POST', body: '{"shareId":"x","targetEmail":"y"}' })).status === 404);
  let links = 0;
  for (let i = 0; i < 40; i++) {
    await put('d', 's' + i, { id: 's' + i, pages: ['pg0'] });
    const s = await js(await call(own.token, '/share/s' + i, { method: 'POST', body: '{}' }));
    if ((await call(null, `/live/${s.shareId}/doc`)).status === 200) links++;
  }
  ok('every share link works', links === 40, `${links} of 40`);
  const g = socket(`/live/${sh.shareId}/ws?token=${encodeURIComponent(fr.token)}`);
  await sleep(900);
  const ink = d => g.send(JSON.stringify({ live: true, docId: d, pageId: 'pg0', delta: { add: [1] } }));
  if (g.readyState === 1) {
    ink('doc1'); await sleep(400);
    ok('a view-only guest cannot send ink', !ws.got.some(m => m.delta));
    await call(own.token, '/share/doc1/permission', { method: 'PUT', body: JSON.stringify({ canWrite: true, allowedEmails: 'friend@test.local' }) }); await sleep(300);
    ink('doc1'); await sleep(400);
    ok('a guest who may write can', ws.got.some(m => m.delta && m.docId === 'doc1'));
    ink('otherdoc'); await sleep(400);
    ok('but only in the shared notebook', !ws.got.some(m => m.docId === 'otherdoc'));
  } else ok('a guest connects', false);
  for (let n = 0; n < 2; n++) await call(own.token, `/part/up1/${n}`, { method: 'PUT', body: new Uint8Array(1000) });
  ok('big files arrive in pieces', (await call(own.token, '/commit/a/big1?size=2000', { method: 'POST', body: JSON.stringify({ up: 'up1', parts: 2 }) })).status === 200);
  ok('files can be deleted', (await call(own.token, '/blob/a/big1', { method: 'DELETE' })).status === 200);
  const me = await call(own.token, '/me', { headers: { Origin: WEB } });
  const meBody = await js(me);
  ok('the app can read the usage count', /X-CF-Calls/i.test(me.headers.get('access-control-expose-headers') || '') && !!me.headers.get('x-cf-calls-today') && !!me.headers.get('x-cf-total-today'));
  ok('cumulative usage hides names and shows other users',
    Array.isArray(meBody.usageUsers)
    && meBody.usageUsers.some(u => u.label === 'You' && u.me)
    && meBody.usageUsers.some(u => /^Other user/.test(u.label) && !u.me)
    && !/test\.local/i.test(JSON.stringify(meBody.usageUsers))
    && meBody.cfTotalToday >= meBody.cfCallsToday
    && meBody.cfTotalToday === meBody.usageUsers.reduce((s, x) => s + x.cfCalls, 0),
    meBody.usageUsers);
  for (let i = 0; i < 4; i++) await put('p', 'pg' + i, { id: 'pg' + i, docId: 'doc1', items: [{ id: 's' + i }] }, { docId: 'doc1' });
  const meAfter = await js(await call(own.token, '/me'));
  ok('cumulative usage stays exact after page mutations', meAfter.cfTotalToday === meAfter.usageUsers.reduce((s, x) => s + x.cfCalls, 0), meAfter.usageUsers);
  ok('direct OCR report increments cumulative Gemini usage', (await call(own.token, '/usage-ocr', { method: 'POST' })).status === 200 && (await js(await call(own.token, '/me'))).ocrTotalToday >= 1);
  ok('internal config and usage routes stay blocked outside', (await call('22222.fake', '/config/allowed')).status === 404 && (await call('22222.fake', '/usage/summary')).status === 404);
  ok('only owner can manage allowed users in-app',
    (await call(fr.token, '/admin/users')).status === 403
    && (await call(own.token, '/admin/users', { method: 'POST', body: JSON.stringify({ email: 'extra@test.local' }) })).status === 200
    && (await js(await call(own.token, '/me'))).friends.includes('extra@test.local')
    && (await call(own.token, '/admin/users', { method: 'DELETE', body: JSON.stringify({ email: 'extra@test.local' }) })).status === 200
    && !(await js(await call(own.token, '/me'))).friends.includes('extra@test.local'));
  // Removing someone signs out their devices (v99): at once, and someone never allowed is refused too.
  await call(own.token, '/admin/users', { method: 'POST', body: JSON.stringify({ email: 'extra@test.local' }) });
  const ex = await auth('77777', 'extra');
  const exWs = socket('/ws?u=77777', { token: ex.token });
  await sleep(600);
  const exIn = (await call(ex.token, '/me')).status === 200 && !!exWs.got[0]?.hello;
  const del = await js(await call(own.token, '/admin/users', { method: 'DELETE', body: JSON.stringify({ email: 'extra@test.local' }) }));
  await sleep(300);
  ok('removing a user signs out their devices at once', exIn && del.signedOut === true && (await call(ex.token, '/me')).status === 401 && exWs.readyState === 3, { exIn, signedOut: del.signedOut, ws: exWs.readyState });
  ok('the old device key of a removed user stays refused', (await call(ex.token, '/changes?since=0')).status === 401);
  const nope = await auth('88888', 'nobody');
  ok('someone not allowed at all is signed out on first use', (await call(nope.token, '/me')).status === 401 && (await call(nope.token, '/me')).status === 401);
  ok('allowed people stay signed in', (await call(fr.token, '/me')).status === 200 && (await call(own.token, '/me')).status === 200);
  await call(st.token, '/me'); await call(st.token, '/signout', { method: 'POST' });
  ok('signing out works at once', (await call(st.token, '/me')).status === 401);
  ws.close(); g.close();
});

// ------------------------------------------------------------------ 3. the app, in a tab of the owner's Chrome
if (!process.argv.includes('--quick') && (want('library') || want('writing') || want('devices') || want('opening'))) {
  console.log('\n3. The app (a tab opens in your Chrome; please keep it in front)');
  c.log('The app', 'h');
  await step('the check tab opens', async () => { await c.open(WEB); await c.go(`${WEB}/privacy.html`, 300); });
  let E = { D: `const D=await import('/js/db.js');` };
  const noErrors = name => { const e = [...new Set(c.errors)]; c.errors.length = 0; ok(`${name}: no errors`, !e.length, e.slice(0, 3).join(' ; ')); };
  const pointer = (pid, type) => `const v=document.querySelector('.vp');const P=(t,x,y)=>v.dispatchEvent(new PointerEvent(t,{pointerId:${pid},pointerType:'${type}',pressure:.6,clientX:x,clientY:y,button:0,buttons:t==='pointerup'?0:1,bubbles:true,cancelable:true}));`;
  const draw = (pts, type = 'mouse') => c.ev(`${pointer(5, type)}const pts=${JSON.stringify(pts)};P('pointerdown',...pts[0]);for(let i=1;i<pts.length;i++)for(let k=1;k<=6;k++){P('pointermove',pts[i-1][0]+(pts[i][0]-pts[i-1][0])*k/6,pts[i-1][1]+(pts[i][1]-pts[i-1][1])*k/6);await new Promise(r=>setTimeout(r,10));}P('pointerup',...pts.at(-1));await new Promise(r=>setTimeout(r,500));`);
  const key = (k, o = '') => c.ev(`document.activeElement?.blur();for(const t of ['keydown','keyup'])document.body.dispatchEvent(new KeyboardEvent(t,{key:'${k}',${o}bubbles:true}));await new Promise(r=>setTimeout(r,250));`);
  const pops = () => c.ev(`return document.querySelectorAll('.pop').length`);
  const noPops = `document.querySelectorAll('.pop').forEach(p=>p.remove());`;
  const edReady = `const q=document.querySelector('.pageind');return !!(document.querySelector('.vp')&&q&&q.textContent.trim())`; // a notebook is open
  const edGone = `return !document.querySelector('.vp')`;
  if (want('library')) await section('library', async () => {
    c.errors.length = 0;
    const clear = `for(const k of ['hw','geminiModel','sidebarCollapsed'])localStorage.removeItem('inkleaf.'+k);`;
    await c.ev(clear + `localStorage.setItem('inkleaf.hw','1');localStorage.setItem('inkleaf.geminiModel','gemini-3.5-flash-lite')`); // shows the AI label in the search box
    await c.size(820, 1180); // an iPad held upright
    await c.go(`${WEB}/?profile=check${fresh()}`);
    // What is in the top bar, what lies on top of something else, and whether the lines of both headers meet.
    const look = () => c.ev(`const R=e=>{if(!e||!e.getClientRects().length)return null;const r=e.getBoundingClientRect();return r.width<1?null:r};
      const hit=(a,b)=>a&&b&&a.left<b.right-1&&b.left<a.right-1&&a.top<b.bottom-1&&b.top<a.bottom-1;
      const q=x=>document.querySelector(x),head=q('.lib-head'),box=R(head.querySelector('.search')),label=R(head.querySelector('.hw-ai-badge'));
      const rest=[...head.children].filter(e=>!e.classList.contains('search-wrap')).map(e=>[e.title||e.textContent,R(e)]).filter(x=>x[1]);
      const on=[];for(const [n,r] of rest){if(hit(box,r))on.push('search box on '+n);if(hit(label,r))on.push('label on '+n);}
      if(hit(label,R(head.querySelector('.search-ic'))))on.push('label on the search sign');
      if(box&&label&&(label.left<box.left||label.right>box.right))on.push('label outside the search box');
      return {name:!!R(head.querySelector('.brand')),button:!!R(head.querySelector('.sidebar-toggle-btn')),side:Math.round((R(q('.lib-sidebar'))||{right:0}).right),sideButtons:q('.side-head').querySelectorAll('button').length,on,lines:[Math.round(R(head).bottom),Math.round(R(q('.side-head')).bottom)]}`);
    const press = async x => { await c.ev(`document.querySelector('${x}').click()`); await sleep(600); };
    let v = await look();
    ok('sidebar open: name and button are only in the sidebar', v.side === 250 && !v.name && !v.button && v.sideButtons === 1, v);
    ok('sidebar open: both headers are the same height', v.lines[0] === v.lines[1], v.lines);
    for (const [w, h] of [[820, 1180], [768, 1024], [1194, 834], [1366, 900]]) { await c.size(w, h); await sleep(500); v = await look(); ok(`sidebar open, ${w} wide: nothing covers anything in the top bar`, !v.on.length, v.on); }
    await c.size(820, 1180); await sleep(400);
    await press('.side-head button'); v = await look();
    ok('the sidebar button closes it; the top bar then has the name and the button', v.side === 0 && v.name && v.button, v);
    ok('sidebar closed: nothing covers anything in the top bar', !v.on.length, v.on);
    await press('.lib-head .sidebar-toggle-btn'); v = await look();
    ok('the top bar button opens it again', v.side === 250 && !v.name && !v.button, v);
    for (const [w, h] of [[694, 834], [507, 834], [412, 915], [375, 812]]) { await c.size(w, h); await sleep(500); v = await look(); ok(`${w} wide: nothing covers anything in the top bar`, !v.on.length && v.button, v); }
    await press('.lib-head .sidebar-toggle-btn');
    ok('phone: the button opens the drawer', await c.ev(`return document.querySelector('.lib-sidebar').classList.contains('mobile-open')`));
    await press('.side-head button');
    ok('phone: the drawer button closes it', await c.ev(`return !document.querySelector('.lib-sidebar').classList.contains('mobile-open')`));
    // OneDrive-style per-folder and per-notebook syncing indicators
    await c.size(1194, 834);
    const syncIds = await c.ev(`${E.D}const S=await import('/js/sync.js'),U=await import('/js/util.js');const f1=await D.createFolder('SyncTop');const f2=await D.createFolder('SyncSub',f1.id);const d1=await D.createDoc({title:'SyncNote',folderId:f2.id});U.bus.emit('synced');await new Promise(r=>setTimeout(r,300));S._setSyncTargets([d1.id],[f2.id,f1.id]);await new Promise(r=>setTimeout(r,150));return {f1:f1.id,f2:f2.id,d1:d1.id}`);
    ok('main menu shows rotating sync sign on syncing folder', await c.ev(`const b=document.querySelector('[data-sync-folder="${syncIds.f1}"] .item-sync-badge');return !!b && !b.hidden`));
    await c.ev(`location.hash='#/f/${syncIds.f1}'`); await sleep(400);
    ok('opening folder shows rotating sync sign on syncing subfolder', await c.ev(`const b=document.querySelector('[data-sync-folder="${syncIds.f2}"] .item-sync-badge');return !!b && !b.hidden`));
    await c.ev(`location.hash='#/f/${syncIds.f2}'`); await sleep(400);
    ok('opening subfolder shows rotating sync sign on syncing notebook', await c.ev(`const b=document.querySelector('[data-sync-doc="${syncIds.d1}"] .item-sync-badge');return !!b && !b.hidden`));
    await c.ev(`(await import('/js/sync.js'))._setSyncTargets([],[]);await new Promise(r=>setTimeout(r,100));location.hash='#/'`); await sleep(300);
    ok('syncing signs hide when sync stops', await c.ev(`return [...document.querySelectorAll('.item-sync-badge')].every(e=>e.hidden)`));
    // Folder colours (v99): one colour per folder everywhere, and the whole folder takes it, not only a dot.
    const colours = await c.ev(`${E.D}for(const n of ['Polity','History','Economy'])await D.createFolder(n);
      location.hash='#/x';await new Promise(r=>setTimeout(r,200));location.hash='#/';
      for(let t=0;t<40&&document.querySelectorAll('.card-folder').length<4;t++)await new Promise(r=>setTimeout(r,100));
      const fc=e=>(e&&[...e.classList].find(x=>x.startsWith('fc-')))||'';
      return [...document.querySelectorAll('.card-folder')].map(card=>{const id=card.dataset.syncFolder,svg=card.querySelector('.cover > span:first-child > svg');
        return {card:fc(card.querySelector('.cover')),side:fc(document.querySelector('.side-btn[data-sync-folder="'+id+'"] .folder-ic')),fill:svg?getComputedStyle(svg).fill:'',dots:card.querySelectorAll('.folder-dot').length};});`);
    ok('a folder has the same colour in the sidebar and on its card', colours.length === 4 && colours.every(x => x.card && x.card === x.side), colours);
    ok('the whole folder is coloured, not only a dot', colours.length === 4 && colours.every(x => x.fill && x.fill !== 'none' && !x.dots), colours);
    // v100: a chosen colour is kept in the folder record (so it syncs), and colours chosen before move into it once.
    const moved = await c.ev(`${E.D}const L=await import('/js/library.js');const fs=(await D.db.all('folders')).filter(f=>!f.deleted);
      await L.setFolderColor(fs[0],'purple');
      localStorage.setItem('inkleaf.folderColors',JSON.stringify({[fs[1].id]:'yellow'}));
      location.hash='#/x';await new Promise(r=>setTimeout(r,200));location.hash='#/';
      for(let t=0;t<40&&localStorage.getItem('inkleaf.folderColors')!==null;t++)await new Promise(r=>setTimeout(r,100));
      await new Promise(r=>setTimeout(r,300));
      const a=await D.db.get('folders',fs[0].id),b=await D.db.get('folders',fs[1].id);
      const side=id=>{const e=document.querySelector('.side-btn[data-sync-folder="'+id+'"] .folder-ic');return e?[...e.classList].find(x=>x.startsWith('fc-')):'';};
      return {a:a.color,b:b.color,left:localStorage.getItem('inkleaf.folderColors'),sideA:side(a.id),sideB:side(b.id)};`);
    ok('a chosen folder colour is kept in the folder itself', moved.a === 'purple' && moved.sideA === 'fc-purple', moved);
    ok('colours chosen before v100 are moved into the folders', moved.b === 'yellow' && moved.sideB === 'fc-yellow' && moved.left === null, moved);
    noErrors('the library top bar');
    await c.ev(clear);
  });
  if (want('writing')) await section('writing', async () => {
    c.errors.length = 0;
    await c.size(1194, 834); await c.dark(true);
    await c.go(`${WEB}/?profile=check${fresh()}`);
    noErrors('the library opens');
    const id = await c.ev(`${E.D}const d=await D.createDoc({title:'Check'});return d.id`);
    const open = async (q = '') => { await c.ev(`location.hash='#/d/${id}${q}'`); await until(() => c.ev(edReady)); await sleep(400); };
    const closed = async () => { await until(() => c.ev(edGone), 6000); await sleep(200); }; // the editor is gone once it has saved
    const reopen = async () => { await c.ev(noPops + `location.hash='#/'`); await closed(); await open(); };
    // The page's items; with want(items), as soon as they are what is expected (saving takes a moment).
    const items = async want => {
      const get = () => c.ev(`${E.D}return (await D.db.byDoc('${id}'))[0].items`);
      if (!want) { await sleep(700); return get(); }
      return (await until(async () => { const v = await get(); return want(v) && v; }, 4000)) || get();
    };
    const count = n => v => v.length === n;
    await open();
    noErrors('a notebook opens');
    for (const [k, want] of Object.entries({ h: 'Highlighter', e: 'Eraser', l: 'Select', s: 'Shapes', t: 'Text', a: 'Tape', k: 'Laser', p: 'Pen' })) {
      await key(k);
      const on = await c.ev(`return (document.querySelector('.toolset .tool.on')||{}).title||''`);
      ok(`key ${k.toUpperCase()} chooses ${want}`, on.startsWith(want), on);
    }
    await draw([[300, 300], [360, 270], [420, 320], [480, 280]], 'pen'); ok('the pen draws', (await items(count(1))).length === 1);
    await key('h'); await draw([[300, 380], [600, 380]], 'pen'); ok('the highlighter draws', (await items(count(2))).length === 2);
    await key('s'); await draw([[300, 430], [450, 520]], 'pen'); ok('shapes draw', (await items(count(3))).length === 3);
    await key('a'); await draw([[520, 430], [700, 430]], 'pen'); ok('tape draws', (await items(count(4))).length === 4);
    await key('e'); await draw([[380, 250], [380, 340]], 'pen'); ok('the eraser erases', (await items(count(3))).length === 3);
    await key('z', 'ctrlKey:true,'); ok('undo', (await items(count(4))).length === 4);
    await key('y', 'ctrlKey:true,'); ok('redo', (await items(count(3))).length === 3);
    await key('z', 'ctrlKey:true,');
    noErrors('drawing');
    await sleep(500); // (pen input just now would make the next touches count as a palm)
    await key('l'); await draw([[270, 240], [400, 235], [510, 240], [515, 300], [510, 345], [400, 350], [270, 345], [268, 300], [270, 242]]);
    ok('the lasso selects', await c.ev(`return !document.querySelector('.selbar').hidden`));
    await c.ev(`[...document.querySelectorAll('.selbar .ic')].find(x=>x.title==='Colour').click();await new Promise(r=>setTimeout(r,300));const s=document.querySelectorAll('.pop .sw');s[1].click();return s.length`);
    const recoloured = await items(v => v.some(i => i.t === 's' && i.c === '#e03131'));
    ok('selected writing changes colour', recoloured.some(i => i.t === 's' && i.c === '#e03131'), recoloured.map(i => i.t + i.c));
    noErrors('pop-ups');
    const n0 = (await items(() => true)).length; // the recolouring above is saved already
    await c.ev(`document.activeElement?.blur();window.focus();await navigator.clipboard.writeText('OLD TEXT')`);
    const ctrl = async (k, ms = 0) => { await key(k, 'ctrlKey:true,'); if (ms) await sleep(ms); };
    await ctrl('c', 500); await ctrl('v');
    let now = await items(v => v.length === n0 + 1);
    ok('copied writing is what gets pasted', now.length === n0 + 1 && !now.some(i => i.t === 'tx'), now.map(i => i.t));
    await c.ev(`await navigator.clipboard.writeText('NEW TEXT')`); await ctrl('v');
    now = await items(v => v.some(i => i.s === 'NEW TEXT'));
    ok('text from another app pastes', now.some(i => i.s === 'NEW TEXT'));
    ok('everything has a place in the stack', now.every(i => i.z !== undefined));
    await key('p');
    const sw = () => c.ev(`return [...document.querySelectorAll('.opts button.sw')].map(b=>b.style.getPropertyValue('--c'))[2]`);
    await c.ev(`document.querySelectorAll('.opts button.sw')[2].dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,300));document.querySelectorAll('.pop .sw')[14].click()`); await sleep(400);
    const chosen = await sw();
    const size = () => c.ev(`return [...document.querySelectorAll('.opts .sz')][1].title.split(' (')[0]`);
    for (let i = 0; i < 2; i++) { await c.ev(`[...document.querySelectorAll('.opts .sz')][1].click()`); await sleep(250); }
    await c.ev(`const r=document.querySelector('.mm-range');r.value=1.8;r.dispatchEvent(new Event('input'));r.dispatchEvent(new Event('change'))`); await sleep(300);
    await reopen();
    ok('an edited pen colour is kept', chosen === '#66d9e8' && await sw() === chosen, await sw());
    ok('an edited pen size is kept', await size() === '1.8 mm', await size());
    ok('tip-size dots show on a dark tool bar', await c.ev(`return [...document.querySelectorAll('.opts .sz .dot')].every(d=>getComputedStyle(d).boxShadow!=='none')`));
    await c.dark(false);
    await c.ev(`document.querySelectorAll('.opts button.sw')[3].dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`); await sleep(600);
    await c.ev(`document.querySelectorAll('.opts button.sw')[3].dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`); await sleep(200);
    ok('a long press opens one pop-up', await pops() === 1, await pops());
    await c.ev(noPops);
    const touch = async s => { await c.ev(pointer(0, 'touch') + s); };
    const tp = (t, pid, type, x, y) => `v.dispatchEvent(new PointerEvent('${t}',{pointerId:${pid},pointerType:'${type}',clientX:${x},clientY:${y},bubbles:true,cancelable:true,pressure:.5,button:0,buttons:${t === 'pointerup' ? 0 : 1}}));`;
    await touch(tp('pointerdown', 71, 'pen', 500, 600) + tp('pointermove', 71, 'pen', 520, 610) + tp('pointerup', 71, 'pen', 540, 620) + tp('pointerdown', 72, 'touch', 700, 700)); await sleep(800);
    ok('a resting palm opens no menu', await pops() === 0); await touch(tp('pointerup', 72, 'touch', 700, 700) + noPops); await sleep(600);
    await touch(tp('pointerdown', 73, 'touch', 400, 600) + tp('pointerdown', 74, 'touch', 700, 600)); await sleep(800);
    ok('two fingers held open no menu', await pops() === 0); await touch(tp('pointerup', 73, 'touch', 400, 600) + tp('pointerup', 74, 'touch', 700, 600) + noPops); await sleep(900);
    await touch(tp('pointerdown', 75, 'touch', 600, 650)); await sleep(800);
    ok('one finger held opens the menu', await pops() === 1); await touch(tp('pointerup', 75, 'touch', 600, 650) + noPops);
    await sleep(600); await touch(tp('pointerdown', 76, 'pen', 600, 650)); await sleep(800);
    ok('the Apple Pencil held still opens the menu', await pops() === 1); await touch(tp('pointerup', 76, 'pen', 600, 650) + noPops); await sleep(600);
    await touch(`v.dispatchEvent(new PointerEvent('pointerdown',{pointerId:77,pointerType:'pen',clientX:600,clientY:650,bubbles:true,cancelable:true,pressure:.5,button:5,buttons:32}));`); await sleep(800);
    ok('the pen eraser held still opens no menu', await pops() === 0); await touch(tp('pointerup', 77, 'pen', 600, 650) + noPops);
    const live = w => c.ev(`const u=await import('/js/util.js');u.bus.emit('live-message',{live:true,type:'perm',docId:'${id}',canWrite:${w}});await new Promise(r=>setTimeout(r,200));return document.querySelector('.ro')!==null`);
    ok('sharing as view-only leaves the owner writing', await live(false) === false); await live(true);
    noErrors('gestures');
    // Spell check (v101): the SCOWL word list knows real words, catches mistakes, and pages are checked when they are
    // opened, not only after writing on them.
    const sp = await c.ev(`const S=await import('/js/spellcheck.js');await S.loadDictionary();
      const good="The organisation's colour stopped bigger India's don't ministers' well-known socio-economic Lok Sabha Ashoka Nehru judiciary habeas corpus UPSC 21st e.g. “quoted”".split(' ');
      const bad='recieve goverment untill presure parliment'.split(' ');
      return {fp:good.filter(w=>S.checkWord(w).misspelled),fn:bad.filter(w=>!S.checkWord(w).misspelled),sug:S.checkWord('parliment').suggestions[0],cap:S.checkWord('Goverment').suggestions[0]}`);
    ok('spell check knows real words (British spellings, word forms, names, Indian and legal terms)', sp.fp.length === 0, sp.fp);
    ok('spell check catches mistakes and suggests the right word, in the same case', !sp.fn.length && sp.sug === 'parliament' && sp.cap === 'Government', sp);
    const spDoc = await c.ev(`${E.D}const d=await D.createDoc({title:'Spell'});const p=(await D.db.byDoc(d.id))[0];p.items=[{id:'tx1',t:'tx',x:80,y:80,w:300,s:'The goverment of India',fs:16,c:'#000',z:1,m:Date.now()}];await D.db.put('pages',p);return d.id`);
    await c.ev(noPops + `location.hash='#/d/${spDoc}'`);
    const marks = await until(() => c.ev(`return document.querySelectorAll('.spell-mark').length`), 5000);
    ok('a page is checked when the notebook opens', marks === 1, marks);
    await c.ev(`document.querySelector('.spell-mark')?.click()`); await sleep(300);
    const sugBtn = await c.ev(`return [...document.querySelectorAll('.spell-sug-word')].map(s=>s.textContent).join(',')`);
    ok('tapping the mark shows the suggestion', sugBtn.split(',')[0] === 'government', sugBtn);
    await c.ev(noPops + `location.hash='#/d/${id}'`); await until(() => c.ev(edReady));
    // More menu
    const more = `document.querySelectorAll('.pop').forEach(p=>p.remove());[...document.querySelectorAll('button')].find(b=>b.title==='More'&&b.offsetParent).click();await new Promise(r=>setTimeout(r,150));`;
    const labels = await c.ev(more + `return [...document.querySelectorAll('.pop .mi')].map(b=>b.textContent.trim())`);
    for (const l of labels.filter(x => /^(PDF|Earlier|History|Notebook details|Replay|Highlights|Tagged|Flashcards|Ruler|Put the ruler|Zoom window|Page template|Gestures)/.test(x))) {
      await c.ev(more + `[...document.querySelectorAll('.pop .mi')].find(b=>b.textContent.trim()===${JSON.stringify(l)})?.click();await new Promise(r=>setTimeout(r,400));document.querySelectorAll('dialog .modal-head .ic').forEach(b=>b.click());`);
      noErrors(`More > ${l}`);
    }
    // side by side pages, and turning the iPad
    await reopen();
    await c.ev(`${E.D}const d=await D.db.get('docs','${id}');for(let i=0;i<3;i++){const p=D.newPage(d.id,{w:d.w,h:d.h});await D.db.put('pages',p);d.pages.push(p.id);}d.modified=Date.now();await D.db.put('docs',d)`);
    await c.ev(`location.hash='#/'`); await closed();
    await c.ev(`${E.D}const d=await D.db.get('docs','${id}');const p=(await D.db.byDoc('${id}')).filter(x=>!d.pages.includes(x.id));return p.length`);
    await open('?p=2');
    await c.ev(more + `const m=[...document.querySelectorAll('.pop .mi')].find(b=>/^Pages: down/.test(b.textContent.trim()));m.click()`); await sleep(900);
    const where = () => c.ev(`await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const n=document.querySelector('.pageind').textContent.trim();const vr=document.querySelector('.vp').getBoundingClientRect();const pg=[...document.querySelectorAll('.world > *')].map(e=>e.getBoundingClientRect()).filter(r=>r.width>50&&r.height>50);const mid=vr.left+vr.width/2;const off=Math.min(...pg.map(r=>Math.abs(r.left+r.width/2-mid)));return {n,off:Math.round(off)}`);
    const a = await where();
    await c.size(834, 1194); await sleep(900); const b = await where();
    await c.size(1194, 834); await sleep(900); const d = await where();
    ok('turning the iPad keeps the page in the middle (side by side)', a.n === b.n && b.n === d.n && a.off < 6 && b.off < 6 && d.off < 6, { a, b, d });
    for (const [w, h, n] of [[834, 1194, 'iPad'], [412, 915, 'phone']]) { await c.size(w, h); await sleep(700); ok(`no sideways scrolling (${n})`, !await c.ev(`const x=document.documentElement;return x.scrollWidth>x.clientWidth+1`)); }
    await c.size(1194, 834);
    noErrors('screen sizes');
    // nothing left behind
    const left = await c.ev(`const u=await import('/js/util.js');const W=async f=>{for(let t=0;t<6000&&!f();t+=50)await new Promise(r=>setTimeout(r,50));await new Promise(r=>setTimeout(r,250));};const on=()=>{${edReady}},off=()=>{${edGone}};location.hash='#/';await W(off);const real=u.bus.on;let n=0;u.bus.on=(...x)=>{n++;const off=real.apply(u.bus,x);let z=false;return()=>{if(!z){z=true;n--;}return off();};};for(let i=0;i<3;i++){location.hash='#/d/${id}';await W(on);location.hash='#/x'+i;await W(off);}const a=n;location.hash='#/d/${id}';await W(on);location.hash='#/y';await W(off);u.bus.on=real;return n-a`);
    ok('opening notebooks leaves nothing behind', left === 0, `${left} listeners per visit`);
    const assetReads = await c.ev(`${E.D}const S=await import('/js/sync.js'),U=await import('/js/util.js');
      if(!window.PDFLib)await new Promise((r,j)=>{const s=document.createElement('script');s.src='/vendor/pdf-lib.min.js';s.onload=r;s.onerror=j;document.head.append(s);});
      const pd=await PDFLib.PDFDocument.create();for(let i=0;i<39;i++)pd.addPage([300,400]);const pdfBytes=await pd.save();
      await D.db.put('assets',{id:'shared_pdf_test',mime:'application/pdf',name:'s.pdf',data:pdfBytes.buffer.slice(pdfBytes.byteOffset,pdfBytes.byteOffset+pdfBytes.byteLength),modified:Date.now()},true);
      const makeBig=async t=>{const d=await D.createDoc({title:t});const ps=[];for(let i=0;i<39;i++){const p=D.newPage(d.id,{w:d.w,h:d.h,pdf:{a:'shared_pdf_test',i}});ps.push(p);d.pages.push(p.id);}await D.db.putMany('pages',ps);d.thumb='data:image/gif;base64,R0lGODlhAQABAAAAACw=';d.modified=Date.now();await D.db.put('docs',d);return d.id;};
      const d1=await makeBig('PDF A'),d2=await makeBig('PDF B');
      const realGet=D.db.get;let reads=0;D.db.get=(s,k)=>{if(s==='assets'&&k==='shared_pdf_test')reads++;return realGet(s,k);};
      location.hash='#/d/'+d1;await new Promise(r=>setTimeout(r,800));
      const tabB=[...document.querySelectorAll('.tabs .tab')].find(t=>t.title==='PDF B'||t.textContent.includes('PDF B'));
      if(tabB)tabB.click();else location.hash='#/d/'+d2;
      await new Promise(r=>setTimeout(r,800));
      const tabA=[...document.querySelectorAll('.tabs .tab')].find(t=>t.title==='PDF A'||t.textContent.includes('PDF A'));
      const clickedTab=!!tabA;
      if(tabA)tabA.click();else location.hash='#/d/'+d1;
      await new Promise(r=>setTimeout(r,800));
      D.db.get=realGet;
      const cfU=S.updateCfUsageFromServer(10,100000,true,10,[{me:true,label:'You',cfCalls:9}]);
      return {reads,clickedTab,okCf:cfU.users[0].cfCalls>=cfU.calls&&cfU.totalCalls>=cfU.users[0].cfCalls};`);
    // At most one read by the sync (readyAssets) and one by the PDF renderer (pdfDoc), whatever the page count and tab switches.
    ok('switching multi-page PDF tabs avoids repeated asset reads', assetReads.clickedTab && assetReads.reads <= 2 && assetReads.okCf, assetReads);
    await c.ev(`(await import('/js/sync.js')).openSettings()`); await sleep(700);
    ok('Settings opens', await c.ev(`return !!document.querySelector('dialog')`));
    ok('Settings shows the top account card', await c.ev(`return !!document.querySelector('dialog .account-card')`));
    await c.ev(`document.querySelector('dialog .modal-head .ic')?.click();await new Promise(r=>setTimeout(r,200));${E.D}const S=await import('/js/sync.js');await D.db.setMeta('cloud',{token:'111.fake',email:'owner@test.local'});S._setHttp(async()=>new Response('{"items":[]}',{status:200,headers:{'Content-Type':'application/json'}}));await S.initSync();await S.openSettings();`); await sleep(500);
    ok('Settings shows Sign out prominently when signed in', await c.ev(`return [...document.querySelectorAll('dialog .account-card button')].some(b=>b.textContent.trim()==='Sign out')`));
    // v101 bug: each device pushed its own model choice, so "Auto" (or any choice) made on one device was undone by the next.
    const ms = await c.ev(`const S=await import('/js/sync.js');const H=await import('/js/hwsearch.js');const puts=[];
      const run=async(server,local)=>{if(local)localStorage.setItem('inkleaf.geminiModel',local);else localStorage.removeItem('inkleaf.geminiModel');puts.length=0;
        S._setHttp(async(u,o)=>{if(o&&o.method==='PUT')puts.push(JSON.parse(o.body));return new Response(JSON.stringify({geminiKey:'',geminiModel:server}),{status:200,headers:{'Content-Type':'application/json'}});});
        await S.syncUserSettings();await new Promise(r=>setTimeout(r,50));return {local:localStorage.getItem('inkleaf.geminiModel'),puts:puts.map(p=>p.geminiModel).filter(Boolean)};};
      const a=await run('auto','gemini-3.8-flash'),b=await run('gemini-3.7-flash','gemini-3.8-flash'),d=await run('','gemini-3.8-flash');
      H.setHwModel('auto');S._setHttp(async()=>new Response('{"items":[]}',{status:200,headers:{'Content-Type':'application/json'}}));return {a,b,d};`);
    ok('AI model chosen on another device wins (Auto too); this device sends its own only when the server has none',
      ms.a.local === null && !ms.a.puts.length && ms.b.local === 'gemini-3.7-flash' && !ms.b.puts.length && ms.d.local === 'gemini-3.8-flash' && ms.d.puts[0] === 'gemini-3.8-flash', ms);
    await c.ev(`document.querySelector('dialog .modal-head .ic')?.click();await (await import('/js/sync.js')).signOut();`);
    noErrors('Settings');
  });

  if (API && want('devices')) await section('two devices', async () => {
    console.log('   ...two devices (under a minute)');
    c.log('Two devices (under a minute)', 'h');
    c.errors.length = 0;
    const me = '5' + Date.now(), run = fresh(); // a new account and new devices
    const s1 = await auth(me, 'owner'), s2 = await auth(me, 'owner'), guest = await auth('6' + Date.now(), 'friend');
    await c.size(1400, 800);
    await c.go(`${WEB}/privacy.html`, 800);
    const seed = (p, s) => c.ev(`const o=indexedDB.open('inkleaf-${p}',1);await new Promise((r,j)=>{o.onupgradeneeded=()=>{const d=o.result;for(const n of ['folders','docs','assets'])d.createObjectStore(n,{keyPath:'id'});d.createObjectStore('pages',{keyPath:'id'}).createIndex('docId','docId');d.createObjectStore('meta',{keyPath:'k'});};o.onsuccess=r;o.onerror=j;});const t=o.result.transaction('meta','readwrite');t.objectStore('meta').put({k:'cloud',v:${JSON.stringify(s)}});t.objectStore('meta').put({k:'cloudServer',v:'${API}'});await new Promise(r=>t.oncomplete=r);o.result.close();`);
    await seed('da' + run, s1); await seed('db' + run, s2); await seed('dg' + run, guest);
    await c.ev(`document.body.innerHTML='<iframe id=a style="width:49%;height:760px"></iframe><iframe id=b style="width:49%;height:760px"></iframe>';a.src='/?profile=da${run}';b.src='/?profile=db${run}';`);
    const on = (f, x) => c.ev(`const w=document.getElementById('${f}').contentWindow;return await w.eval(${JSON.stringify(`(async()=>{${x}})()`)});`);
    const libOn = f => on(f, `return !!document.querySelector('.lib-head')`).catch(() => false);
    await until(async () => await libOn('a') && await libOn('b'), 15000); await sleep(1500); // both apps are up and signed in
    const doc = (f, id) => on(f, `${E.D}return JSON.stringify((await D.db.get('docs','${id}'))||null)`).then(JSON.parse);
    const seq = async () => (await js(await call(s1.token, '/me'))).seq;
    // Until the server has had no upload for 1.5 s (at most 12 s): what was still being sent has arrived.
    const settle = async () => { let last = await seq(), same = 0; for (let t = 0; t < 12000 && same < 3; t += 500) { await pause(500); const n = await seq(); same = n === last ? same + 1 : 0; last = n; } };
    // Then not one upload for s seconds. (The endless upload of v93 made about 7 a second.)
    // Notebooks, pages, folders and files uploaded since seq x. (Weekly backups are not in this list: each device
    // makes its first one 8 s after it starts, which is no endless upload; they have their own check at the end.)
    const feedSince = async x => (await js(await call(s1.token, '/changes?since=' + x))).items || [];
    // To name them when a quiet check fails: kind, which record, and its time stamps.
    const what = async list => {
      const out = [];
      for (const it of list.slice(0, 6)) {
        let o = {};
        try { const b = await call(s1.token, `/blob/${it.k}/${it.id}/0`); const buf = Buffer.from(await b.arrayBuffer()); o = JSON.parse((it.gz ? zlib.gunzipSync(buf) : buf).toString()); } catch {}
        const name = names[it.id] || it.id.slice(0, 8);
        out.push(`${it.k} ${name}${o.title ? ' "' + o.title + '"' : ''} modified=${o.modified || '-'} editedAt=${o.editedAt || '-'} lastOpened=${o.lastOpened || '-'} items=${Array.isArray(o.items) ? o.items.length : '-'}`);
      }
      return out.join(' | ');
    };
    const names = {};
    const quiet = async (name, s = 6) => { await settle(); const x = await seq(); await sleep(s * 1000); const up = await feedSince(x); ok(name, !up.length, up.length ? `${up.length} uploads in ${s} s: ${await what(up)}` : ''); };
    const edOn = (f, yes = true) => until(() => on(f, `return ${yes ? '' : '!'}document.querySelector('.vp')`), 8000);
    const ids = JSON.parse(await on('a', `${E.D}const f=await D.createFolder('Polity');const r=[f.id];for(const t of ['One','Two','Three','Four']){const d=await D.createDoc({title:t});for(let i=0;i<3;i++){const p=D.newPage(d.id,{w:d.w,h:d.h});await D.db.put('pages',p);d.pages.push(p.id);}d.modified=Date.now();await D.db.put('docs',d);r.push(d.id);}return JSON.stringify(r)`));
    const [fold, one, two, three, four] = ids;
    Object.assign(names, { [fold]: 'folder Polity', [one]: 'One', [two]: 'Two', [three]: 'Three', [four]: 'Four' });
    await until(async () => (await doc('b', four))?.pages.length === 4, 15000);
    ok('new notebooks reach the other device', (await doc('b', four))?.pages.length === 4);
    await quiet('no uploads while nobody does anything');
    for (const f of ['a', 'b']) await on(f, `location.hash='#/d/${one}'`);
    await edOn('a'); await edOn('b');
    await quiet('no uploads while both have the same notebook open');
    await on('a', `const v=document.querySelector('.vp'),q=v.getBoundingClientRect();const P=(t,x,y)=>v.dispatchEvent(new PointerEvent(t,{pointerId:5,pointerType:'mouse',clientX:q.left+x,clientY:q.top+y,button:0,buttons:t==='pointerup'?0:1,bubbles:true}));P('pointerdown',200,200);for(let i=0;i<20;i++){P('pointermove',200+i*6,200+Math.sin(i)*15);await new Promise(r=>setTimeout(r,15));}P('pointerup',320,205);`);
    const inkOnB = () => on('b', `${E.D}return (await D.db.byDoc('${one}')).reduce((n,p)=>n+p.items.length,0)`);
    await until(async () => await inkOnB() === 1, 12000);
    ok('writing reaches the other device', await inkOnB() === 1);
    // a folder colour chosen on A shows on B (v100)
    await on('a', `${E.D}const L=await import('/js/library.js');await L.setFolderColor(await D.db.get('folders','${fold}'),'green');`);
    const colourOnB = () => on('b', `${E.D}return (await D.db.get('folders','${fold}'))?.color||''`);
    await until(async () => await colourOnB() === 'green', 12000);
    ok('a folder colour chosen on one device shows on the other', await colourOnB() === 'green', await colourOnB());
    // binned on A while open on B
    await on('b', `location.hash='#/d/${four}'`); await edOn('b'); await sleep(800);
    await on('a', `location.hash='#/';${E.D}await D.trashDoc(await D.db.get('docs','${four}'))`);
    await until(async () => !!(await doc('b', four)).trashed, 12000);
    await settle(); await sleep(1500); // time for device B to undo it, if it wrongly would
    ok('a notebook binned elsewhere stays in the bin, though open here', !!(await doc('a', four)).trashed && !!(await doc('b', four)).trashed);
    // B offline, only reading
    await on('b', `location.hash='#/';const S=await import('/js/sync.js');S._setHttp(()=>Promise.reject(new TypeError('offline')));S._setSocket(()=>({close(){},send(){},readyState:3}));`); await sleep(1200);
    await on('a', `${E.D}const g=i=>D.db.get('docs',i),t=Date.now();await D.db.put('docs',{...(await g('${one}')),title:'RENAMED',modified:t});await D.db.put('docs',{...(await g('${two}')),folderId:'${fold}',modified:t});await D.db.put('docs',{...(await g('${three}')),trashed:t,modified:t});`);
    await settle(); // device A has sent its changes
    for (const id of [one, two, three]) { await on('b', `location.hash='#/d/${id}'`); await edOn('b'); await sleep(300); await on('b', `for(let i=0;i<2;i++){document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'PageDown',bubbles:true}));await new Promise(r=>setTimeout(r,600));}`); await sleep(1100); }
    await on('b', `location.hash='#/'`); await edOn('b', false); await sleep(300);
    await on('b', `const S=await import('/js/sync.js');S._setHttp((u,o)=>fetch(u,o));S._setSocket(u=>new WebSocket(u));await S.initSync();`); await sleep(2500);
    await on('b', `await (await import('/js/sync.js')).syncNow(false)`);
    await settle(); await sleep(1500); // all sent, and time for an undo to arrive, if one wrongly would
    for (const f of ['a', 'b']) {
      const [x, y, z] = [await doc(f, one), await doc(f, two), await doc(f, three)], who = f === 'a' ? 'device A' : 'device B';
      ok(`reading elsewhere does not undo a rename (${who})`, x.title === 'RENAMED', x.title);
      ok(`reading elsewhere does not undo a move (${who})`, y.folderId === fold);
      ok(`reading elsewhere does not undo the bin (${who})`, !!z.trashed);
      ok(`the reading place still travels (${who})`, x.lastPage === 3, x.lastPage);
    }
    await quiet('no uploads afterwards');
    // The 8-s first backup only happens if the device already has a notebook; device B gets them about then, so it can
    // miss it and wait for the hourly one (fine in the app, a race here). Run the hourly step now on both: a device
    // without a backup makes its first, one that has one must not make another. Then wait for both to arrive.
    for (const f of ['a', 'b']) await on(f, `await (await import('/js/sync.js')).autoBackup()`);
    const backups = async () => ((await js(await call(s1.token, '/list/b'))).items || []).length;
    await until(async () => (await backups()) >= 2, 10000); await pause(1000);
    const nb = await backups();
    const bkOf = f => on(f, `${E.D}const l=(await D.db.getMeta('autobk'))||[];const n=(await D.db.all('docs')).filter(d=>!d.deleted&&!d.sys).length;return JSON.stringify({notebooks:n,local:l.map(x=>({t:x.t,cloud:!!x.cloud}))})`).catch(e => 'unreadable: ' + e.message);
    ok('each device makes its first backup once, not more', nb === 2, nb === 2 ? '' : `${nb} backups from 2 devices; A ${await bkOf('a')}; B ${await bkOf('b')}`);
    // a view-only guest
    const sh = await js(await call(s1.token, '/share/' + one, { method: 'POST', body: JSON.stringify({ allowedEmails: 'friend@test.local' }) }));
    await c.ev(`b.src='/?profile=dg${run}#/live/${sh.shareId}'`);
    await until(() => on('b', `return !!document.querySelector('.vp') && document.querySelector('.ro')!==null`).catch(() => false), 12000);
    ok('a view-only guest sees the notebook, read-only', await on('b', `return !!document.querySelector('.vp') && document.querySelector('.ro')!==null`));
    await on('b', `const x=[...document.querySelectorAll('button')].find(q=>/Read-only/.test(q.title));if(x)x.click();await new Promise(r=>setTimeout(r,300));`);
    ok('and cannot switch writing on', await on('b', `return document.querySelector('.ro')!==null`));
    const e = [...new Set(c.errors)].filter(x => !/offline/.test(x));
    ok('two devices: no errors', !e.length, e.slice(0, 3).join(' ; '));
  });
  // Opening (v101): from the copy kept on the device, without waiting for the network. Times are the app's own clock:
  // ms from the start of loading until the first screen is up (performance mark 'inkleaf-ready').
  if (want('opening')) await section('opening', async () => {
    console.log('   ...opening fast, and without a network');
    c.log('Opening: fast, and without a network', 'h');
    c.errors.length = 0;
    await c.size(1194, 834);
    const prof = 'op' + fresh(), secs = x => x ? (x / 1000).toFixed(2) + ' s' : 'never';
    let n = 0;
    const open = async () => {
      const k = ++n;
      await c.ev(`location.href='/app/?profile=${prof}&n=${k}'`).catch(() => {});
      return until(() => c.ev(`return location.search.includes('n=${k}') && performance.getEntriesByName('inkleaf-ready')[0]?.startTime`), 20000);
    };
    netReset(); net.delay = 250; // a slow network: every answer takes a quarter of a second
    const before = await open(); // without the offline copy every file comes over the network, as every start did before v101
    net.delay = 0; net.sw = true;
    await open();
    ok('the offline copy is made on the first visit', !!await until(() => c.ev('return !!navigator.serviceWorker.controller'), 15000));
    net.delay = 250;
    const after = await open();
    const swInfo = await c.ev("const r=await navigator.serviceWorker.getRegistration();const k=await caches.keys();const n=[];for(const x of k)n.push(x+':'+(await (await caches.open(x)).keys()).length);return JSON.stringify({ctl:navigator.serviceWorker.controller?.scriptURL,active:r?.active?.state,waiting:!!r?.waiting,installing:!!r?.installing,caches:n})").catch(e => e.message);
    ok('opens fast on a slow network', before && after && after < before / 2, `${secs(before)} without the copy, ${secs(after)} with it; ${swInfo}`);
    console.log(`         opening on a slow network: ${secs(before)} without the copy, ${secs(after)} with it`);
    net.delay = 0; net.mode = 'hang';
    const hang = await open();
    ok('opens when the network answers nothing', hang && hang < 4000, secs(hang));
    netReset(); net.sw = true; net.mode = 'down';
    ok('opens offline', !!await open());
    net.mode = ''; net.swVer = 'inkleaf-v999'; // a new release appears
    await c.ev('(await navigator.serviceWorker.getRegistration())?.update().catch(()=>{})');
    const news = await until(() => c.ev(`const t=[...document.querySelectorAll('.toast')].find(t=>/new version/.test(t.textContent));return t&&getComputedStyle(t).pointerEvents`), 15000);
    ok('a new version is fetched in the background and offered, with a button that takes taps', news === 'auto', news);
    await c.ev(`[...document.querySelectorAll('.toast button')].find(b=>b.textContent==='Reload')?.click()`).catch(() => {});
    const keys = await until(async () => { const v = await c.ev(`return !document.querySelector('.toast-act')&&performance.getEntriesByName('inkleaf-ready')[0]&&(await caches.keys()).join(',')`); return v === 'inkleaf-v999' && v; }, 10000);
    ok('Reload loads it, and the old copy is removed', keys === 'inkleaf-v999', keys);
    await c.ev('for(const r of await navigator.serviceWorker.getRegistrations())await r.unregister();for(const k of await caches.keys())await caches.delete(k);');
    netReset();
    await c.ev("location.href='/privacy.html'").catch(() => {}); // nothing left inside /app/, so the copy-keeper really goes
    await until(() => c.ev("return location.pathname==='/privacy.html'"), 5000);
    const e = [...new Set(c.errors)];
    ok('opening: no errors', !e.length, e.slice(0, 3).join(' ; '));
  });
  await c.close(failed.length ? `${failed.length} of ${passed + failed.length} checks FAILED. Do not publish.` : `All ${passed} checks passed. You can close this tab.`, failed.length > 0);
  if (failed.length && c.hiddenTimes) console.log('\nNote: the check tab was out of sight at times, which can make checks fail. Run it again before judging.');
}

if (mf) await mf.dispose().catch(() => {});
site.close();
// Time report: the parts, then the slowest checks. In brackets: how much of it was fixed waiting.
const sec = ms => (ms / 1000).toFixed(1).padStart(6) + ' s';
console.log('\nTime (fixed waiting in brackets):');
for (const p of parts) console.log(`  ${sec(p.ms)}  (${sec(p.wait).trim()})  ${p.name}`);
console.log('Slowest checks (time since the check before it):');
for (const t of [...times].sort((a, b) => b.ms - a.ms).slice(0, 15)) console.log(`  ${sec(t.ms)}  (${sec(t.wait).trim()})  ${t.name}`);
if (ONLY.length) console.log(`\nOnly these parts were run: ${ONLY.join(', ')}. Run the whole check before publishing.`);
console.log(`\n${passed} passed, ${failed.length} failed.`);
if (failed.length) { console.log('\nDO NOT PUBLISH. Failed:'); for (const f of failed) console.log('  - ' + f); } else console.log(ONLY.length ? 'Everything in these parts is fine. This was not the whole check: run it all before publishing.' : 'Everything is fine: ready to publish.');
process.exit(failed.length ? 1 : 0);
