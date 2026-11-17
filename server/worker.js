// Inkleaf sync service: a Cloudflare Worker plus one Durable Object per person.
//
// - Sign-in: the app signs in with Google once per device and sends the Google access token to POST /auth.
//   The Worker asks Google who it belongs to, checks the address is allowed (secret ALLOWED: comma-separated
//   e-mail addresses), and the person's Durable Object hands out a long-lasting device key "<sub>.<secret>".
// - Data: each person's Durable Object keeps their records in its own SQLite storage. The service does not
//   read notebooks; it stores versioned blobs. Every change gets the next sequence number (s), so a device
//   asks "what changed since s?" and a write can say "only if it is still version s" (base).
// - Live: each device keeps a WebSocket open to its person's Durable Object, which says {s} after every change.
// - Kinds: f folder, d notebook, p page, a attached file (PDF, picture), b weekly snapshot.
import { DurableObject } from 'cloudflare:workers';

const CLIENT_ID = '473809010149-3hhf0nu5aisisgvu3gnaee49lfgdlga2.apps.googleusercontent.com';
const PART = 1_500_000;             // largest piece of a blob in one row (SQLite rows are limited to 2 MB)
const KINDS = new Set(['f', 'd', 'p', 'a', 'b']);
const FEED = "('f','d','p','a')";   // kinds that go out in the changes feed (snapshots are listed separately)

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Expose-Headers': 'X-Seq',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

const withCors = (res, cors) => {
  if (res.status === 101) return res; // a WebSocket hand-over cannot be rewrapped
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(cors)) r.headers.set(k, v);
  return r;
};

async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomKey() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Who does this Google access token belong to? Only tokens issued to Inkleaf's own client are accepted.
async function googleUser(accessToken, env) {
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(accessToken));
  if (!r.ok) return null;
  const t = await r.json();
  const cid = env.CLIENT_ID || CLIENT_ID;
  if (t.aud !== cid && t.azp !== cid) return null;
  if (!t.sub || !t.email || String(t.email_verified) !== 'true') return null;
  return { sub: String(t.sub), email: String(t.email).toLowerCase() };
}

const allowedEmail = (email, env) => (env.ALLOWED || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean).includes(email);

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    try {
      if (url.pathname === '/' && req.method === 'GET') return withCors(json({ app: 'inkleaf-sync', ok: true }), cors);

      // Sign-in. {code}: a Google authorization code (the app's normal way): exchanged here for a refresh token
      // too, so the service can later hand devices fresh Google Drive passes. {access_token}: older app versions.
      if (url.pathname === '/auth' && req.method === 'POST') {
        const { access_token: given, code, label } = await req.json().catch(() => ({}));
        let at = given, rt = null;
        if (code) {
          if (!env.GOOGLE_SECRET) return withCors(json({ error: 'no-google-secret' }, 500), cors);
          const t = await (await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ code, client_id: env.CLIENT_ID || CLIENT_ID, client_secret: env.GOOGLE_SECRET, redirect_uri: 'postmessage', grant_type: 'authorization_code' })
          })).json().catch(() => ({}));
          at = t.access_token; rt = t.refresh_token || null;
          if (!at) return withCors(json({ error: 'google-rejected', detail: t.error || '' }, 401), cors);
        }
        if (!at) return withCors(json({ error: 'no-token' }, 400), cors);
        const who = await googleUser(at, env);
        if (!who) return withCors(json({ error: 'google-rejected' }, 401), cors);
        if (!allowedEmail(who.email, env)) return withCors(json({ error: 'not-allowed', email: who.email }, 403), cors);
        const stub = env.USER.get(env.USER.idFromName(who.sub));
        const r = await stub.newSession(who.email, String(label || '').slice(0, 80), rt);
        return withCors(json({ token: who.sub + '.' + r.secret, email: who.email, drive: r.drive }), cors);
      }

      // High-speed asset streaming via Cloudflare R2 (supports HTTP Range 206 for large PDFs)
      if (url.pathname.startsWith('/asset/') && env.BUCKET) {
        const id = url.pathname.slice(7);
        if (req.method === 'GET' || req.method === 'HEAD') {
          const range = req.headers.get('range');
          const obj = await env.BUCKET.get(id, range ? { range: req.headers } : undefined);
          if (!obj) return withCors(json({ error: 'not-found' }, 404), cors);
          const headers = new Headers();
          obj.writeHttpMetadata(headers);
          headers.set('etag', obj.httpEtag);
          headers.set('accept-ranges', 'bytes');
          headers.set('cache-control', 'public, max-age=31536000, immutable');
          return withCors(new Response(req.method === 'HEAD' ? null : obj.body, {
            status: obj.range ? 206 : 200,
            headers
          }), cors);
        }
        if (req.method === 'PUT') {
          const key = ((req.headers.get('Authorization') || '').match(/^Bearer\s+([^.\s]+)\./) || [])[1] || '';
          if (!/^[0-9]{5,40}$/.test(key)) return withCors(json({ error: 'signin' }, 401), cors);
          const mime = req.headers.get('content-type') || 'application/pdf';
          await env.BUCKET.put(id, req.body, { httpMetadata: { contentType: mime } });
          return withCors(json({ ok: true, id }), cors);
        }
        if (req.method === 'DELETE') {
          await env.BUCKET.delete(id);
          return withCors(json({ ok: true }), cors);
        }
      }

      // Everything else belongs to one person: the device key says whose Durable Object to ask.
      let key = '';
      if (url.pathname === '/ws') key = url.searchParams.get('u') || '';
      else key = ((req.headers.get('Authorization') || '').match(/^Bearer\s+([^.\s]+)\./) || [])[1] || '';
      if (!/^[0-9]{5,40}$/.test(key)) return withCors(json({ error: 'signin' }, 401), cors);
      const stub = env.USER.get(env.USER.idFromName(key));
      return withCors(await stub.fetch(req), cors);
    } catch (e) {
      return withCors(json({ error: 'server', message: String(e && e.message || e) }, 500), cors);
    }
  }
};

export class User extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS sessions (h TEXT PRIMARY KEY, created INTEGER, seen INTEGER, label TEXT);
      CREATE TABLE IF NOT EXISTS recs (k TEXT, id TEXT, s INTEGER, size INTEGER, parts INTEGER, info TEXT, gz INTEGER, PRIMARY KEY (k, id));
      CREATE INDEX IF NOT EXISTS recs_s ON recs (s);
      CREATE TABLE IF NOT EXISTS parts (k TEXT, id TEXT, n INTEGER, data BLOB, PRIMARY KEY (k, id, n));
      CREATE TABLE IF NOT EXISTS pending (up TEXT, n INTEGER, data BLOB, t INTEGER, PRIMARY KEY (up, n));
    `);
  }

  kvGet(k) { const r = this.sql.exec('SELECT v FROM kv WHERE k = ?', k).toArray()[0]; return r ? r.v : null; }
  kvSet(k, v) { this.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', k, String(v)); }
  seq() { return Number(this.kvGet('seq') || 0); }
  nextSeq() { const s = this.seq() + 1; this.kvSet('seq', s); return s; }

  // Called by the Worker after Google confirmed who this is. Returns the secret half of a new device key, and
  // whether this person's Google Drive is linked (a refresh token is kept, so files can go to their Drive).
  async newSession(email, label, refreshToken) {
    const secret = randomKey(), now = Date.now();
    this.kvSet('email', email);
    if (refreshToken) { this.kvSet('grt', refreshToken); this.gat = null; }
    this.sql.exec('INSERT INTO sessions (h, created, seen, label) VALUES (?, ?, ?, ?)', await sha256(secret), now, now, label || '');
    return { secret, drive: !!this.kvGet('grt') };
  }

  // A Google access token (an hour long) for this person's Drive app folder, from the kept refresh token.
  async googleToken() {
    if (this.gat && Date.now() < this.gexp - 120e3) return this.gat;
    const rt = this.kvGet('grt');
    if (!rt || !this.env.GOOGLE_SECRET) return null;
    const t = await (await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ refresh_token: rt, client_id: this.env.CLIENT_ID || CLIENT_ID, client_secret: this.env.GOOGLE_SECRET, grant_type: 'refresh_token' })
    })).json().catch(() => ({}));
    if (!t.access_token) {
      if (t.error === 'invalid_grant') this.sql.exec("DELETE FROM kv WHERE k = 'grt'"); // revoked or expired: sign in again links it anew
      return null;
    }
    this.gat = t.access_token;
    this.gexp = Date.now() + (Number(t.expires_in) || 3600) * 1000;
    return this.gat;
  }

  usedBytes() { return Number(this.sql.exec('SELECT COALESCE(SUM(size), 0) AS b FROM recs WHERE size > 0').toArray()[0].b); }
  // Each person's share of the service: QUOTA_MB, except the owner (the first address in ALLOWED), who gets
  // OWNER_QUOTA_MB. The owner's address stays in the ALLOWED secret, never in the code.
  quota() {
    const owner = (this.env.ALLOWED || '').split(',')[0].trim().toLowerCase();
    const mine = owner && owner === String(this.kvGet('email') || '').toLowerCase();
    return (Number(mine ? this.env.OWNER_QUOTA_MB : this.env.QUOTA_MB) || Number(this.env.QUOTA_MB) || 500) * 1048576;
  }

  async session(token) {
    const secret = String(token || '').split('.')[1];
    if (!secret) return null;
    const h = await sha256(secret);
    const r = this.sql.exec('SELECT h, seen FROM sessions WHERE h = ?', h).toArray()[0];
    if (!r) return null;
    if (Date.now() - r.seen > 3600e3) this.sql.exec('UPDATE sessions SET seen = ? WHERE h = ?', Date.now(), h);
    return h;
  }

  // End the live connections of one signed-out device (it then shows "sign in again").
  closeSockets(h) {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && a.h === h) { try { ws.close(4001, 'signed out'); } catch { /* closing */ } }
    }
  }

  // Tell every connected device that something changed (they then ask for the changes).
  broadcast(s) {
    const msg = JSON.stringify({ s });
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && a.ok) { try { ws.send(msg); } catch { /* closing */ } }
    }
  }

  async fetch(req) {
    const url = new URL(req.url), p = url.pathname.split('/').filter(Boolean);

    if (p[0] === 'ws') { // live connection; the device key comes as the first message, never in the address
      if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'websocket' }, 426);
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ ok: false });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    const token = ((req.headers.get('Authorization') || '').match(/^Bearer\s+(\S+)$/) || [])[1];
    const sess = await this.session(token);
    if (!sess) return json({ error: 'signin' }, 401);

    // GET /google-token : a fresh pass for this person's Google Drive app folder, where PDFs and pictures are kept.
    if (p[0] === 'google-token' && req.method === 'GET') {
      const t = await this.googleToken();
      return t ? json({ access_token: t, exp: this.gexp }) : json({ error: 'no-google' }, 404);
    }

    // GET /meta/k/id : one record's entry, if the service holds it.
    if (p[0] === 'meta' && KINDS.has(p[1]) && p[2] && req.method === 'GET') {
      const r = this.sql.exec('SELECT k, id, s, size, parts, info, gz FROM recs WHERE k = ? AND id = ?', p[1], p[2]).toArray()[0];
      return r ? json(r) : json({ error: 'missing' }, 404);
    }

    // GET /changes?since=s : what changed after s, oldest first (metadata only; blobs are fetched one by one).
    if (p[0] === 'changes' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0), limit = Math.min(1000, Number(url.searchParams.get('limit') || 500));
      const rows = this.sql.exec(`SELECT k, id, s, size, parts, info, gz FROM recs WHERE s > ? AND k IN ${FEED} ORDER BY s LIMIT ?`, since, limit + 1).toArray();
      return json({ items: rows.slice(0, limit), more: rows.length > limit, seq: this.seq() });
    }

    // GET /list/b : all records of one kind (the weekly snapshots).
    if (p[0] === 'list' && KINDS.has(p[1]) && req.method === 'GET') {
      return json({ items: this.sql.exec('SELECT k, id, s, size, parts, info, gz FROM recs WHERE k = ? AND size >= 0 ORDER BY s', p[1]).toArray() });
    }

    // GET /blob/k/id/n : one piece of a stored blob.
    if (p[0] === 'blob' && KINDS.has(p[1]) && p[2] && req.method === 'GET') {
      const r = this.sql.exec('SELECT s FROM recs WHERE k = ? AND id = ?', p[1], p[2]).toArray()[0];
      const part = this.sql.exec('SELECT data FROM parts WHERE k = ? AND id = ? AND n = ?', p[1], p[2], Number(p[3] || 0)).toArray()[0];
      if (!r || !part) return json({ error: 'missing' }, 404);
      return new Response(part.data, { headers: { 'Content-Type': 'application/octet-stream', 'X-Seq': String(r.s) } });
    }

    // PUT /part/upload-id/n : one piece of a large blob, held until it is committed.
    if (p[0] === 'part' && p[1] && req.method === 'PUT') {
      const data = await req.arrayBuffer();
      if (data.byteLength > PART + 1024) return json({ error: 'too-big' }, 413);
      this.sql.exec('INSERT OR REPLACE INTO pending (up, n, data, t) VALUES (?, ?, ?, ?)', p[1], Number(p[2] || 0), data, Date.now());
      return json({ ok: true });
    }

    // PUT /blob/k/id (body = the whole blob, when it fits in one piece) or POST /commit/k/id {up, parts}:
    // store a new version. base (query) = the version the device last saw; a mismatch answers 409 with the
    // current version, and the device merges and tries again. No base = store regardless (attached files).
    if ((p[0] === 'blob' && req.method === 'PUT') || (p[0] === 'commit' && req.method === 'POST')) {
      const k = p[1], id = p[2];
      if (!KINDS.has(k) || !id || id.length > 80) return json({ error: 'bad' }, 400);
      let body = null, up = null, parts = 1;
      if (p[0] === 'blob') {
        body = await req.arrayBuffer();
        if (body.byteLength > PART + 1024) return json({ error: 'too-big' }, 413);
      } else {
        const j = await req.json();
        up = String(j.up || ''); parts = Number(j.parts) || 0;
        const have = this.sql.exec('SELECT COUNT(*) AS c FROM pending WHERE up = ?', up).toArray()[0].c;
        if (!up || !parts || have !== parts) return json({ error: 'parts-missing', have }, 400);
      }
      const q = url.searchParams, cur = this.sql.exec('SELECT s, size FROM recs WHERE k = ? AND id = ?', k, id).toArray()[0];
      if (q.has('base') && Number(q.get('base')) !== (cur ? cur.s : 0)) return json({ error: 'conflict', s: cur ? cur.s : 0 }, 409);
      // Each person's share of the service is capped (QUOTA_MB, default 500), so the account keeps room for others.
      const newSize = Number(q.get('size') || (body ? body.byteLength : 0));
      if (k === 'a' && this.usedBytes() - (cur && cur.size > 0 ? cur.size : 0) + newSize > this.quota()) { // files only: writing always gets through
        if (up) this.sql.exec('DELETE FROM pending WHERE up = ?', up);
        return json({ error: 'full', used: this.usedBytes(), quota: this.quota() }, 507);
      }
      const s = this.nextSeq();
      this.sql.exec('DELETE FROM parts WHERE k = ? AND id = ?', k, id);
      if (body) this.sql.exec('INSERT INTO parts (k, id, n, data) VALUES (?, ?, 0, ?)', k, id, body);
      else {
        this.sql.exec('INSERT INTO parts (k, id, n, data) SELECT ?, ?, n, data FROM pending WHERE up = ?', k, id, up);
        this.sql.exec('DELETE FROM pending WHERE up = ?', up);
      }
      this.sql.exec('DELETE FROM pending WHERE t < ?', Date.now() - 864e5); // pieces of uploads that never finished
      const size = Number(q.get('size') || (body ? body.byteLength : 0));
      this.sql.exec(`INSERT INTO recs (k, id, s, size, parts, info, gz) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (k, id) DO UPDATE SET s = excluded.s, size = excluded.size, parts = excluded.parts, info = excluded.info, gz = excluded.gz`,
        k, id, s, size, parts, q.get('info') || '', q.get('gz') === '1' ? 1 : 0);
      if (k !== 'b') this.broadcast(s);
      return json({ s });
    }

    // DELETE /blob/k/id : an attached file leaves a marker in the feed (size -1) so other devices drop it too;
    // a snapshot just goes.
    if (p[0] === 'blob' && KINDS.has(p[1]) && p[2] && req.method === 'DELETE') {
      this.sql.exec('DELETE FROM parts WHERE k = ? AND id = ?', p[1], p[2]);
      // A snapshot just goes; so does a file that moved to the person's Google Drive (?moved=1): it still exists.
      if (p[1] === 'b' || url.searchParams.get('moved') === '1') { this.sql.exec('DELETE FROM recs WHERE k = ? AND id = ?', p[1], p[2]); return json({ ok: true }); }
      const s = this.nextSeq();
      this.sql.exec(`INSERT INTO recs (k, id, s, size, parts, info, gz) VALUES (?, ?, ?, -1, 0, '', 0)
        ON CONFLICT (k, id) DO UPDATE SET s = excluded.s, size = -1, parts = 0`, p[1], p[2], s);
      this.broadcast(s);
      return json({ s });
    }

    if (p[0] === 'me' && req.method === 'GET') {
      const n = this.sql.exec('SELECT COUNT(*) AS c FROM sessions').toArray()[0].c;
      return json({ email: this.kvGet('email'), devices: n, bytes: this.usedBytes(), quota: this.quota(), drive: !!this.kvGet('grt'), seq: this.seq() });
    }

    if (p[0] === 'signout' && req.method === 'POST') {
      this.sql.exec('DELETE FROM sessions WHERE h = ?', sess);
      this.closeSockets(sess);
      return json({ ok: true });
    }

    // GET /sessions : the devices signed in to this account (name, when signed in, when last used, which is this one).
    // DELETE /sessions/<id> : sign that device out (id = the first 16 characters of its key's hash).
    if (p[0] === 'sessions' && req.method === 'GET') {
      const rows = this.sql.exec('SELECT h, created, seen, label FROM sessions ORDER BY seen DESC').toArray();
      return json({ items: rows.map(r => ({ id: r.h.slice(0, 16), label: r.label || 'Device', created: r.created, seen: r.seen, current: r.h === sess })) });
    }
    if (p[0] === 'sessions' && p[1] && req.method === 'DELETE') {
      const r = this.sql.exec('SELECT h FROM sessions WHERE substr(h, 1, 16) = ?', p[1]).toArray()[0];
      if (!r) return json({ error: 'missing' }, 404);
      this.sql.exec('DELETE FROM sessions WHERE h = ?', r.h);
      this.closeSockets(r.h);
      return json({ ok: true, self: r.h === sess });
    }

    return json({ error: 'not-found' }, 404);
  }

  async webSocketMessage(ws, msg) {
    let m = null;
    try { m = JSON.parse(typeof msg === 'string' ? msg : new TextDecoder().decode(msg)); } catch { /* not ours */ }
    if (!m) return;
    const a = ws.deserializeAttachment() || {};
    if (!a.ok) {
      const h = m.token ? await this.session(m.token) : null;
      if (h) {
        ws.serializeAttachment({ ok: true, h });
        ws.send(JSON.stringify({ hello: true, s: this.seq() }));
      } else ws.close(4001, 'signin');
      return;
    }
    if (m.ping) ws.send(JSON.stringify({ pong: true, s: this.seq() }));
  }

  async webSocketClose(ws, code) { try { ws.close(code, 'bye'); } catch { /* already closed */ } }
}
