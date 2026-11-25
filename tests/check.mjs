// Inkleaf's checks before a release. Run check.cmd (or: node check.mjs). Exits with an error if anything fails.
//   node check.mjs --quick         code and server only, no browser
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
import { chrome, sleep } from './lib.mjs';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const ROOT = path.resolve(process.env.INKLEAF_ROOT || path.join(here, '..'));
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let passed = 0;
const failed = [];
const ok = (name, cond, detail = '') => {
  if (cond) passed++; else failed.push(name + (detail !== '' ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''));
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${cond || detail === '' ? '' : '  -> ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))}`);
};
// A step that breaks counts as a failure; the rest still runs.
const step = async (name, fn) => { try { await fn(); } catch (e) { ok(name, false, String(e && e.message || e).slice(0, 300)); } };

// ------------------------------------------------------------------ 1. the code
console.log(`Checking ${ROOT}\n\n1. Code`);
const jsFiles = fs.readdirSync(path.join(ROOT, 'js')).filter(f => f.endsWith('.js'));
await step('code is readable', async () => {
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
await step('imports', async () => {
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
await step('styles', async () => {
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
await step('versions', async () => {
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
const site = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || p === '/sw.js' || !fs.existsSync(f) || !fs.statSync(f).isFile()) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(f).pipe(r);
});
await new Promise(r => site.listen(0, '127.0.0.1', r));
const WEB = `http://localhost:${site.address().port}`;
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
await step('the server starts', async () => {
  mf = new Miniflare({
    modules: [{ type: 'ESModule', path: 'entry.mjs', contents: ENTRY }, { type: 'ESModule', path: 'worker.js', contents: read('server/worker.js') }],
    compatibilityDate: '2025-09-01', durableObjects: { USER: { className: 'User', useSQLite: true } },
    bindings: { ORIGINS: WEB, QUOTA_MB: '500', OWNER_QUOTA_MB: '2000', ALLOWED: 'owner@test.local,friend@test.local' }, host: '127.0.0.1', port: 0
  });
  API = (await mf.ready).toString().replace(/\/$/, '').replace('127.0.0.1', 'localhost');
  ok('the server starts', true);
});
const js = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return t.slice(0, 120); } };
const auth = async (sub, who) => js(await fetch(`${API}/test-auth?sub=${sub}&email=${who}@test.local`));
const call = (t, p, o = {}) => fetch(API + p, { ...o, headers: { ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(o.headers || {}) } });
const socket = (p, first) => { const s = new WebSocket(API.replace('http', 'ws') + p); s.got = []; s.onopen = () => { if (first) s.send(JSON.stringify(first)); }; s.onmessage = e => s.got.push(JSON.parse(e.data)); s.onerror = () => {}; return s; };
if (API) await step('server tests', async () => {
  const own = await auth('22222', 'owner'), fr = await auth('33333', 'friend'), st = await auth('44444', 'stranger');
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
  ok('the app can read the usage count', /X-CF-Calls/i.test(me.headers.get('access-control-expose-headers') || '') && !!me.headers.get('x-cf-calls-today'));
  await call(st.token, '/me'); await call(st.token, '/signout', { method: 'POST' });
  ok('signing out works at once', (await call(st.token, '/me')).status === 401);
  ws.close(); g.close();
});

// ------------------------------------------------------------------ 3. the app, in a visible Chrome window
if (!process.argv.includes('--quick')) {
  console.log('\n3. The app (a Chrome window opens; please leave it alone)');
  const c = await chrome();
  let E = { D: `const D=await import('/js/db.js');` };
  const noErrors = name => { const e = [...new Set(c.errors)]; c.errors.length = 0; ok(`${name}: no errors`, !e.length, e.slice(0, 3).join(' ; ')); };
  const pointer = (pid, type) => `const v=document.querySelector('.vp');const P=(t,x,y)=>v.dispatchEvent(new PointerEvent(t,{pointerId:${pid},pointerType:'${type}',pressure:.6,clientX:x,clientY:y,button:0,buttons:t==='pointerup'?0:1,bubbles:true,cancelable:true}));`;
  const draw = (pts, type = 'mouse') => c.ev(`${pointer(5, type)}const pts=${JSON.stringify(pts)};P('pointerdown',...pts[0]);for(let i=1;i<pts.length;i++)for(let k=1;k<=6;k++){P('pointermove',pts[i-1][0]+(pts[i][0]-pts[i-1][0])*k/6,pts[i-1][1]+(pts[i][1]-pts[i-1][1])*k/6);await new Promise(r=>setTimeout(r,10));}P('pointerup',...pts.at(-1));await new Promise(r=>setTimeout(r,500));`);
  const key = (k, o = '') => c.ev(`document.activeElement?.blur();for(const t of ['keydown','keyup'])document.body.dispatchEvent(new KeyboardEvent(t,{key:'${k}',${o}bubbles:true}));await new Promise(r=>setTimeout(r,250));`);
  const pops = () => c.ev(`return document.querySelectorAll('.pop').length`);
  const noPops = `document.querySelectorAll('.pop').forEach(p=>p.remove());`;
  await step('writing', async () => {
    await c.size(1194, 834); await c.dark(true);
    await c.go(`${WEB}/?profile=check`);
    await c.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: WEB });
    noErrors('the library opens');
    const id = await c.ev(`${E.D}const d=await D.createDoc({title:'Check'});return d.id`);
    const open = async () => { await c.ev(`location.hash='#/d/${id}'`); await sleep(1700); };
    const reopen = async () => { await c.ev(noPops + `location.hash='#/'`); await sleep(1300); await open(); };
    const items = async () => { await sleep(700); return c.ev(`${E.D}return (await D.db.byDoc('${id}'))[0].items`); };
    await open();
    noErrors('a notebook opens');
    for (const [k, want] of Object.entries({ h: 'Highlighter', e: 'Eraser', l: 'Select', s: 'Shapes', t: 'Text', a: 'Tape', k: 'Laser', p: 'Pen' })) {
      await key(k);
      const on = await c.ev(`return (document.querySelector('.toolset .tool.on')||{}).title||''`);
      ok(`key ${k.toUpperCase()} chooses ${want}`, on.startsWith(want), on);
    }
    await draw([[300, 300], [360, 270], [420, 320], [480, 280]], 'pen'); ok('the pen draws', (await items()).length === 1);
    await key('h'); await draw([[300, 380], [600, 380]], 'pen'); ok('the highlighter draws', (await items()).length === 2);
    await key('s'); await draw([[300, 430], [450, 520]], 'pen'); ok('shapes draw', (await items()).length === 3);
    await key('a'); await draw([[520, 430], [700, 430]], 'pen'); ok('tape draws', (await items()).length === 4);
    await key('e'); await draw([[380, 250], [380, 340]], 'pen'); ok('the eraser erases', (await items()).length === 3);
    await key('z', 'ctrlKey:true,'); ok('undo', (await items()).length === 4);
    await key('y', 'ctrlKey:true,'); ok('redo', (await items()).length === 3);
    await key('z', 'ctrlKey:true,');
    noErrors('drawing');
    await sleep(500); // (pen input just now would make the next touches count as a palm)
    await key('l'); await draw([[270, 240], [400, 235], [510, 240], [515, 300], [510, 345], [400, 350], [270, 345], [268, 300], [270, 242]]);
    ok('the lasso selects', await c.ev(`return !document.querySelector('.selbar').hidden`));
    await c.ev(`[...document.querySelectorAll('.selbar .ic')].find(x=>x.title==='Colour').click();await new Promise(r=>setTimeout(r,300));const s=document.querySelectorAll('.pop .sw');s[1].click();return s.length`);
    const recoloured = await items();
    ok('selected writing changes colour', recoloured.some(i => i.t === 's' && i.c === '#e03131'), recoloured.map(i => i.t + i.c));
    noErrors('pop-ups');
    const n0 = (await items()).length;
    await c.send('Page.bringToFront');
    await c.ev(`document.activeElement?.blur();window.focus();await navigator.clipboard.writeText('OLD TEXT')`);
    const ctrl = async (k, code, vk) => { for (const t of ['rawKeyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type: t, key: k, code, windowsVirtualKeyCode: vk, modifiers: 2 }); await sleep(900); };
    await ctrl('c', 'KeyC', 67); await ctrl('v', 'KeyV', 86);
    let now = await items();
    ok('copied writing is what gets pasted', now.length === n0 + 1 && !now.some(i => i.t === 'tx'), now.map(i => i.t));
    await c.ev(`await navigator.clipboard.writeText('NEW TEXT')`); await ctrl('v', 'KeyV', 86);
    now = await items();
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
    await c.shot('check_editor_dark'); await c.dark(false); await sleep(300); await c.shot('check_editor_light');
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
    const live = w => c.ev(`const u=await import('/js/util.js');u.bus.emit('live-message',{live:true,type:'perm',docId:'${id}',canWrite:${w}});await new Promise(r=>setTimeout(r,200));return document.querySelector('.ro')!==null`);
    ok('sharing as view-only leaves the owner writing', await live(false) === false); await live(true);
    noErrors('gestures');
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
    await c.ev(`location.hash='#/'`); await sleep(1300);
    await c.ev(`${E.D}const d=await D.db.get('docs','${id}');const p=(await D.db.byDoc('${id}')).filter(x=>!d.pages.includes(x.id));return p.length`);
    await c.ev(`location.hash='#/d/${id}?p=2'`); await sleep(1700);
    await c.ev(more + `const m=[...document.querySelectorAll('.pop .mi')].find(b=>/^Pages: down/.test(b.textContent.trim()));m.click()`); await sleep(900);
    const where = () => c.ev(`await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const n=document.querySelector('.pageind').textContent.trim();const vr=document.querySelector('.vp').getBoundingClientRect();const pg=[...document.querySelectorAll('.world > *')].map(e=>e.getBoundingClientRect()).filter(r=>r.width>50&&r.height>50);const mid=vr.left+vr.width/2;const off=Math.min(...pg.map(r=>Math.abs(r.left+r.width/2-mid)));return {n,off:Math.round(off)}`);
    const a = await where();
    await c.size(834, 1194); await sleep(900); const b = await where();
    await c.shot('check_turned');
    await c.size(1194, 834); await sleep(900); const d = await where();
    ok('turning the iPad keeps the page in the middle (side by side)', a.n === b.n && b.n === d.n && a.off < 6 && b.off < 6 && d.off < 6, { a, b, d });
    for (const [w, h, n] of [[834, 1194, 'iPad'], [412, 915, 'phone']]) { await c.size(w, h, 2, true); await sleep(700); ok(`no sideways scrolling (${n})`, !await c.ev(`const x=document.documentElement;return x.scrollWidth>x.clientWidth+1`)); }
    await c.size(1194, 834);
    noErrors('screen sizes');
    // nothing left behind
    const left = await c.ev(`const u=await import('/js/util.js');location.hash='#/';await new Promise(r=>setTimeout(r,1000));const real=u.bus.on;let n=0;u.bus.on=(...x)=>{n++;const off=real.apply(u.bus,x);let z=false;return()=>{if(!z){z=true;n--;}return off();};};for(let i=0;i<3;i++){location.hash='#/d/${id}';await new Promise(r=>setTimeout(r,900));location.hash='#/x'+i;await new Promise(r=>setTimeout(r,900));}const a=n;location.hash='#/d/${id}';await new Promise(r=>setTimeout(r,900));location.hash='#/y';await new Promise(r=>setTimeout(r,900));u.bus.on=real;return n-a`);
    ok('opening notebooks leaves nothing behind', left === 0, `${left} listeners per visit`);
    await c.ev(`(await import('/js/sync.js')).openSettings()`); await sleep(700);
    ok('Settings opens', await c.ev(`return !!document.querySelector('dialog')`));
    noErrors('Settings');
  });

  if (API) await step('two devices', async () => {
    console.log('   ...two devices (about a minute)');
    const s1 = await auth('55555', 'owner'), s2 = await auth('55555', 'owner'), guest = await auth('66666', 'friend');
    await c.size(1400, 800, 1);
    await c.go(`${WEB}/privacy.html`, 800);
    const seed = (p, s) => c.ev(`const o=indexedDB.open('inkleaf-${p}',1);await new Promise((r,j)=>{o.onupgradeneeded=()=>{const d=o.result;for(const n of ['folders','docs','assets'])d.createObjectStore(n,{keyPath:'id'});d.createObjectStore('pages',{keyPath:'id'}).createIndex('docId','docId');d.createObjectStore('meta',{keyPath:'k'});};o.onsuccess=r;o.onerror=j;});const t=o.result.transaction('meta','readwrite');t.objectStore('meta').put({k:'cloud',v:${JSON.stringify(s)}});t.objectStore('meta').put({k:'cloudServer',v:'${API}'});await new Promise(r=>t.oncomplete=r);o.result.close();`);
    await seed('da', s1); await seed('db', s2); await seed('dg', guest);
    await c.ev(`document.body.innerHTML='<iframe id=a style="width:49%;height:760px"></iframe><iframe id=b style="width:49%;height:760px"></iframe>';a.src='/?profile=da';b.src='/?profile=db';`);
    await sleep(4000);
    const on = (f, x) => c.ev(`const w=document.getElementById('${f}').contentWindow;return await w.eval(${JSON.stringify(`(async()=>{${x}})()`)});`);
    const doc = (f, id) => on(f, `${E.D}return JSON.stringify((await D.db.get('docs','${id}'))||null)`).then(JSON.parse);
    const seq = async () => (await js(await call(s1.token, '/me'))).seq;
    const quiet = async (name, s = 12) => { const x = await seq(); await sleep(s * 1000); const n = (await seq()) - x; ok(name, n === 0, `${n} uploads in ${s} s`); };
    const ids = JSON.parse(await on('a', `${E.D}const f=await D.createFolder('Polity');const r=[f.id];for(const t of ['One','Two','Three','Four']){const d=await D.createDoc({title:t});for(let i=0;i<3;i++){const p=D.newPage(d.id,{w:d.w,h:d.h});await D.db.put('pages',p);d.pages.push(p.id);}d.modified=Date.now();await D.db.put('docs',d);r.push(d.id);}return JSON.stringify(r)`));
    const [fold, one, two, three, four] = ids;
    await sleep(6000);
    ok('new notebooks reach the other device', (await doc('b', four))?.pages.length === 4);
    await quiet('no uploads while nobody does anything');
    for (const f of ['a', 'b']) await on(f, `location.hash='#/d/${one}'`);
    await sleep(4000);
    await quiet('no uploads while both have the same notebook open');
    await on('a', `const v=document.querySelector('.vp'),q=v.getBoundingClientRect();const P=(t,x,y)=>v.dispatchEvent(new PointerEvent(t,{pointerId:5,pointerType:'mouse',clientX:q.left+x,clientY:q.top+y,button:0,buttons:t==='pointerup'?0:1,bubbles:true}));P('pointerdown',200,200);for(let i=0;i<20;i++){P('pointermove',200+i*6,200+Math.sin(i)*15);await new Promise(r=>setTimeout(r,15));}P('pointerup',320,205);`);
    await sleep(4000);
    ok('writing reaches the other device', (await on('b', `${E.D}return (await D.db.byDoc('${one}')).reduce((n,p)=>n+p.items.length,0)`)) === 1);
    // binned on A while open on B
    await on('b', `location.hash='#/d/${four}'`); await sleep(2500);
    await on('a', `location.hash='#/';${E.D}await D.trashDoc(await D.db.get('docs','${four}'))`); await sleep(6000);
    ok('a notebook binned elsewhere stays in the bin, though open here', !!(await doc('a', four)).trashed && !!(await doc('b', four)).trashed);
    // B offline, only reading
    await on('b', `location.hash='#/';const S=await import('/js/sync.js');S._setHttp(()=>Promise.reject(new TypeError('offline')));S._setSocket(()=>({close(){},send(){},readyState:3}));`); await sleep(1200);
    await on('a', `${E.D}const g=i=>D.db.get('docs',i),t=Date.now();await D.db.put('docs',{...(await g('${one}')),title:'RENAMED',modified:t});await D.db.put('docs',{...(await g('${two}')),folderId:'${fold}',modified:t});await D.db.put('docs',{...(await g('${three}')),trashed:t,modified:t});`);
    await sleep(2500);
    for (const id of [one, two, three]) { await on('b', `location.hash='#/d/${id}'`); await sleep(1400); await on('b', `for(let i=0;i<2;i++){document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'PageDown',bubbles:true}));await new Promise(r=>setTimeout(r,600));}`); await sleep(1100); }
    await on('b', `location.hash='#/'`); await sleep(1400);
    await on('b', `const S=await import('/js/sync.js');S._setHttp((u,o)=>fetch(u,o));S._setSocket(u=>new WebSocket(u));await S.initSync();`); await sleep(2500);
    await on('b', `await (await import('/js/sync.js')).syncNow(false)`); await sleep(5000);
    for (const f of ['a', 'b']) {
      const [x, y, z] = [await doc(f, one), await doc(f, two), await doc(f, three)], who = f === 'a' ? 'device A' : 'device B';
      ok(`reading elsewhere does not undo a rename (${who})`, x.title === 'RENAMED', x.title);
      ok(`reading elsewhere does not undo a move (${who})`, y.folderId === fold);
      ok(`reading elsewhere does not undo the bin (${who})`, !!z.trashed);
      ok(`the reading place still travels (${who})`, x.lastPage === 3, x.lastPage);
    }
    await quiet('no uploads afterwards', 8);
    // a view-only guest
    const sh = await js(await call(s1.token, '/share/' + one, { method: 'POST', body: JSON.stringify({ allowedEmails: 'friend@test.local' }) }));
    await c.ev(`b.src='/?profile=dg#/live/${sh.shareId}'`); await sleep(5000);
    ok('a view-only guest sees the notebook, read-only', await on('b', `return !!document.querySelector('.vp') && document.querySelector('.ro')!==null`));
    await on('b', `const x=[...document.querySelectorAll('button')].find(q=>/Read-only/.test(q.title));if(x)x.click();await new Promise(r=>setTimeout(r,300));`);
    ok('and cannot switch writing on', await on('b', `return document.querySelector('.ro')!==null`));
    const e = [...new Set(c.errors)].filter(x => !/offline/.test(x));
    ok('two devices: no errors', !e.length, e.slice(0, 3).join(' ; '));
  });
  await c.close();
}

if (mf) await mf.dispose().catch(() => {});
site.close();
console.log(`\n${passed} passed, ${failed.length} failed.`);
if (failed.length) { console.log('\nDO NOT PUBLISH. Failed:'); for (const f of failed) console.log('  - ' + f); } else console.log('Everything is fine: ready to publish.');
process.exit(failed.length ? 1 : 0);
