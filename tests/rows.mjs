// How many database rows each kind of request to the sync server reads and writes (Cloudflare's free plan allows
// about 5 million rows read and 100,000 written a day). Runs the real server/worker.js locally (Miniflare, the same
// engine as Cloudflare) on a library of a realistic size, and counts with the engine's own per-query numbers.
// Run: node tests/rows.mjs [--why]   (no Chrome needed; --why names the statements that read many rows)
// check.mjs runs it with --json and fails when a common request reads too many rows.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Miniflare } from 'miniflare';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const SIZE = { p: 3000, d: 200, a: 300, f: 20, b: 8 }; // pages, notebooks, files (PDFs), folders, backups
const ENTRY = `import W, { User as U } from './worker.js';
const counts = new Map(); // which Durable Object -> its cursors since the last /__rows
export class User extends U {
  constructor(ctx, env) {
    const sql = ctx.storage.sql, exec = sql.exec.bind(sql), mine = [];
    counts.set(ctx.id.toString(), mine);
    sql.exec = (...a) => { const c = exec(...a); c.q = String(a[0]).trim().slice(0, 100); mine.push(c); return c; };
    super(ctx, env);
  }
  async fetch(req) {
    const u = new URL(req.url), mine = counts.get(this.ctx.id.toString());
    if (u.pathname === '/__rows') {
      let r = 0, w = 0;
      const big = [];
      for (const c of mine.splice(0)) { r += c.rowsRead; w += c.rowsWritten; if (c.rowsRead > 50) big.push(c.rowsRead + ': ' + c.q); }
      return Response.json({ r, w, big });
    }
    if (u.pathname === '/__seed') { // a library of a realistic size, straight into the tables
      const k = u.searchParams.get('k'), n = Number(u.searchParams.get('n'));
      for (let i = 0; i < n; i++) {
        const s = this.nextSeq();
        this.sql.exec('INSERT INTO recs (k, id, s, size, parts, info, gz) VALUES (?, ?, ?, ?, 1, ?, 0)', k, k + i, s, k === 'a' ? 200000 : 2000, '{}');
        this.sql.exec('INSERT INTO parts (k, id, n, data) VALUES (?, ?, 0, ?)', k, k + i, k === 'd' ? new TextEncoder().encode(JSON.stringify({ id: k + i, pages: Array.from({ length: 15 }, (_, j) => 'p' + ((i * 15 + j) % 3000)) })) : new Uint8Array(k === 'a' ? 1000 : 200)); // a notebook lists its 15 pages
      }
      return Response.json({ ok: true });
    }
    return super.fetch(req);
  }
}
export default { async fetch(req, env) {
  const u = new URL(req.url);
  if (u.pathname === '/test-auth') {
    const r = await env.USER.get(env.USER.idFromName(u.searchParams.get('sub'))).newSession(u.searchParams.get('email'), 'test', null, u.searchParams.get('sub'));
    return Response.json({ token: u.searchParams.get('sub') + '.' + r.secret });
  }
  if (u.pathname.startsWith('/__')) return env.USER.get(env.USER.idFromName(u.searchParams.get('sub'))).fetch(req);
  return W.fetch(req, env);
} };`;

const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'inkleaf-rows-'));
const start = () => new Miniflare({
  modules: [{ type: 'ESModule', path: 'entry.mjs', contents: ENTRY }, { type: 'ESModule', path: 'worker.js', contents: fs.readFileSync(path.join(ROOT, 'server/worker.js'), 'utf8') }],
  compatibilityDate: '2025-09-01', durableObjects: { USER: { className: 'User', useSQLite: true } }, durableObjectsPersist: persist,
  bindings: { ORIGINS: 'http://localhost', QUOTA_MB: '500', OWNER_QUOTA_MB: '2000', ALLOWED: 'owner@test.local' }
});
let mf = start(), API = (await mf.ready).toString().replace(/\/$/, '');
const SUB = '7' + Date.now();
const get = async (p, o = {}) => (await fetch(API + p, o));
const tok = (await (await get(`/test-auth?sub=${SUB}&email=owner@test.local`)).json()).token;
const auth = { Authorization: 'Bearer ' + tok };
for (const [k, n] of Object.entries(SIZE)) await get(`/__seed?sub=${SUB}&k=${k}&n=${n}`);
const rows = async () => (await get(`/__rows?sub=${SUB}`)).json();
await rows();
const seq = (await (await get('/me', { headers: auth })).json()).seq;
await rows();

const out = [];
const measure = async (name, fn) => { await rows(); await fn(); const r = await rows(); out.push({ name, ...r }); };
await measure('/me (Settings opened, app start)', () => get('/me', { headers: auth }));
await measure('/changes, nothing new (the usual sync question)', () => get('/changes?since=' + seq, { headers: auth }));
await measure('/changes, 3 new records', () => get('/changes?since=' + (seq - 3), { headers: auth }));
await measure('/changes from 0 (a new device, first 500)', () => get('/changes?since=0&limit=500', { headers: auth }));
await measure('/list/b (Backups list, weekly backup)', () => get('/list/b', { headers: auth }));
await measure('/blob/p/p5/0 (download one page)', () => get('/blob/p/p5/0', { headers: auth }));
await measure('PUT /blob/p/p5 (upload one page)', () => get('/blob/p/p5', { method: 'PUT', headers: auth, body: new Uint8Array(300) }));
await measure('PUT /blob/a/new (upload a file)', () => get('/blob/a/newfile', { method: 'PUT', headers: auth, body: new Uint8Array(300) }));
await measure('/settings', () => get('/settings', { headers: auth }));
await measure('/usage-ocr', () => get('/usage-ocr', { method: 'POST', headers: auth }));
await measure('/shares', () => get('/shares', { headers: auth }));
await measure('/shared-with-me', () => get('/shared-with-me', { headers: auth }));
const sh = await (await get('/share/d3', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({}) })).json();
await measure('/live/<share> (someone opens a shared notebook)', () => get('/live/' + sh.shareId, { headers: auth }));

// The server waking up (after about a minute without requests, and on live-connection messages after 10 s):
await mf.dispose(); mf = start(); API = (await mf.ready).toString().replace(/\/$/, '');
await measure('server wakes up, then /changes, nothing new', () => get('/changes?since=' + seq, { headers: auth }));
await mf.dispose();
fs.rmSync(persist, { recursive: true, force: true });

if (process.argv.includes('--json')) { console.log(JSON.stringify(out)); process.exit(0); }
console.log(`Library: ${SIZE.p} pages, ${SIZE.d} notebooks, ${SIZE.a} files, ${SIZE.f} folders, ${SIZE.b} backups\n`);
console.log('rows read  rows written  request');
for (const o of out) { console.log(String(o.r).padStart(9), String(o.w).padStart(13), ' ', o.name); if (process.argv.includes('--why')) for (const b of o.big) console.log('             ' + b); }
