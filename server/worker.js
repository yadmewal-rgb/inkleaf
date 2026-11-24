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
    'Access-Control-Expose-Headers': 'X-Seq, X-Parts, X-Gz',
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
        const r = await stub.newSession(who.email, String(label || '').slice(0, 80), rt, who.sub);
        return withCors(json({ token: who.sub + '.' + r.secret, email: who.email, drive: r.drive }), cors);
      }

      // Guest access to a shared notebook via share link: /live/:shareId/...
      if (url.pathname.startsWith('/live/')) {
        const segs = url.pathname.slice('/live/'.length).split('/').filter(Boolean);
        const shareId = segs[0] || '';
        const [sub, secret] = shareId.split('_');
        if (!sub || !secret || !/^\d+$/.test(sub)) return withCors(json({ error: 'invalid-share-id' }, 400), cors);
        const stub = env.USER.get(env.USER.idFromName(sub));
        return withCors(await stub.fetch(req), cors);
      }

      // Everything else belongs to one person: the device key says whose Durable Object to ask.
      let key = '';
      if (url.pathname === '/ws') key = url.searchParams.get('u') || '';
      else key = ((req.headers.get('Authorization') || '').match(/^Bearer\s+([^.\s]+)\./) || [])[1] || '';
      if (!/^[0-9]{5,40}$/.test(key)) return withCors(json({ error: 'signin' }, 401), cors);
      const stub = env.USER.get(env.USER.idFromName(key));
      return withCors(await stub.fetch(req), cors);
    } catch (e) {
      const msg = String(e && e.message || e);
      if (msg.includes('Exceeded allowed rows read') || msg.includes('free tier')) {
        return withCors(json({ error: 'quota_exceeded', message: 'Exceeded allowed rows read in Durable Objects free tier.' }, 429), cors);
      }
      return withCors(json({ error: 'server', message: msg }, 500), cors);
    }
  }
};

export class User extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS sessions (h TEXT PRIMARY KEY, created INTEGER, seen INTEGER, label TEXT);
      CREATE TABLE IF NOT EXISTS recs (k TEXT, id TEXT, s INTEGER, size INTEGER, parts INTEGER, info TEXT, gz INTEGER, PRIMARY KEY (k, id));
      CREATE INDEX IF NOT EXISTS recs_s ON recs (s);
      CREATE INDEX IF NOT EXISTS recs_s_k ON recs (s, k);
      CREATE INDEX IF NOT EXISTS recs_k_size ON recs (k, size);
      CREATE TABLE IF NOT EXISTS parts (k TEXT, id TEXT, n INTEGER, data BLOB, PRIMARY KEY (k, id, n));
      CREATE TABLE IF NOT EXISTS pending (up TEXT, n INTEGER, data BLOB, t INTEGER, PRIMARY KEY (up, n));
      CREATE TABLE IF NOT EXISTS shares (secret TEXT PRIMARY KEY, docId TEXT, canWrite INTEGER, created INTEGER, allowedEmails TEXT);
      CREATE INDEX IF NOT EXISTS shares_docId ON shares (docId);
      CREATE TABLE IF NOT EXISTS inbox_shares (id INTEGER PRIMARY KEY AUTOINCREMENT, shareId TEXT, kind TEXT, docId TEXT, title TEXT, cover TEXT, ownerEmail TEXT, targetEmail TEXT, canWrite INTEGER, created INTEGER, folderId TEXT, folderName TEXT);
      CREATE INDEX IF NOT EXISTS inbox_shares_target ON inbox_shares (targetEmail);
      CREATE INDEX IF NOT EXISTS inbox_shares_owner ON inbox_shares (ownerEmail, docId);
      CREATE UNIQUE INDEX IF NOT EXISTS inbox_shares_uniq ON inbox_shares (shareId, targetEmail);
    `);
    try { this.sql.exec('ALTER TABLE shares ADD COLUMN allowedEmails TEXT'); } catch {}
    try { this.sql.exec('ALTER TABLE shares ADD COLUMN folderId TEXT'); } catch {}
    try { this.sql.exec('ALTER TABLE shares ADD COLUMN folderName TEXT'); } catch {}
    try { this.sql.exec('ALTER TABLE inbox_shares ADD COLUMN folderId TEXT'); } catch {}
    try { this.sql.exec('ALTER TABLE inbox_shares ADD COLUMN folderName TEXT'); } catch {}
    this._kvCache = new Map();
    this._sessCache = new Map();
  }

  async getEmail() { return this.kvGet('email') || ''; }

  kvGet(k) {
    if (this._kvCache && this._kvCache.has(k)) return this._kvCache.get(k);
    const r = this.sql.exec('SELECT v FROM kv WHERE k = ?', k).toArray()[0];
    const val = r ? r.v : null;
    if (!this._kvCache) this._kvCache = new Map();
    this._kvCache.set(k, val);
    return val;
  }
  kvSet(k, v) {
    if (!this._kvCache) this._kvCache = new Map();
    this._kvCache.set(k, String(v));
    this.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', k, String(v));
  }
  seq() { return Number(this.kvGet('seq') || 0); }
  nextSeq() { const s = this.seq() + 1; this.kvSet('seq', s); return s; }

  // Called by the Worker after Google confirmed who this is. Returns the secret half of a new device key, and
  // whether this person's Google Drive is linked (a refresh token is kept, so files can go to their Drive).
  async newSession(email, label, refreshToken, sub) {
    const secret = randomKey(), now = Date.now();
    this.kvSet('email', email);
    if (sub) this.kvSet('sub', sub);
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

  usedBytes() {
    if (this._cachedBytes != null) return this._cachedBytes;
    const cached = this.kvGet('total_bytes');
    if (cached != null) {
      this._cachedBytes = Number(cached);
      return this._cachedBytes;
    }
    const b = Number(this.sql.exec('SELECT COALESCE(SUM(size), 0) AS b FROM recs WHERE size > 0').toArray()[0].b);
    this._cachedBytes = b;
    this.kvSet('total_bytes', b);
    return b;
  }
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
    if (!this._sessCache) this._sessCache = new Map();
    const cached = this._sessCache.get(h);
    if (cached && Date.now() - cached < 600e3) return h;
    const r = this.sql.exec('SELECT h, seen FROM sessions WHERE h = ?', h).toArray()[0];
    if (!r) return null;
    this._sessCache.set(h, Date.now());
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

  trackUsage(isOcr = false, ocrCount = 1, increment = true) {
    const today = new Date().toISOString().slice(0, 10);
    if (!this._dailyUsage || this._dailyUsage.date !== today) {
      const saved = this.kvGet('usage_' + today);
      if (saved) {
        try { this._dailyUsage = JSON.parse(saved); } catch {}
      }
      if (!this._dailyUsage || this._dailyUsage.date !== today) {
        this._dailyUsage = { date: today, cfCalls: 0, ocrCalls: 0 };
      }
    }
    if (increment) {
      this._dailyUsage.cfCalls = (this._dailyUsage.cfCalls || 0) + 1;
      if (isOcr) {
        this._dailyUsage.ocrCalls = (this._dailyUsage.ocrCalls || 0) + ocrCount;
      }
      this._usageUnsaved = (this._usageUnsaved || 0) + 1;
      if (this._usageUnsaved >= 10) {
        this._usageUnsaved = 0;
        this.kvSet('usage_' + today, JSON.stringify(this._dailyUsage));
      }
    }
    return this._dailyUsage;
  }

  usageHeaders() {
    const today = new Date().toISOString().slice(0, 10);
    const u = this._dailyUsage && this._dailyUsage.date === today ? this._dailyUsage : { cfCalls: 0, ocrCalls: 0 };
    return {
      'X-CF-Calls-Today': String(u.cfCalls || 0),
      'X-OCR-Calls-Today': String(u.ocrCalls || 0)
    };
  }

  async fetch(req) {
    try {
      const url = new URL(req.url), p = url.pathname.split('/').filter(Boolean);
      const isOcr = p[0] === 'ocr';
      const ocrN = Number(url.searchParams.get('n') || 1);
      this.trackUsage(isOcr, ocrN);

      const resp = await this._fetch(req);
      const h = new Headers(resp.headers);
      const uh = this.usageHeaders();
      for (const k in uh) h.set(k, uh[k]);
      return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
    } catch (err) {
      const msg = String(err?.message || err);
      if (msg.includes('Exceeded allowed rows read') || msg.includes('free tier')) {
        return json({ error: 'quota_exceeded', message: 'Exceeded allowed rows read in Durable Objects free tier.' }, 429);
      }
      return json({ error: 'server', message: msg }, 500);
    }
  }

  async _fetch(req) {
    const url = new URL(req.url), p = url.pathname.split('/').filter(Boolean);

    // Internal registry routes for "Shared with me"
    if (p[0] === 'registry') {
      if (p[1] === 'for') {
        const target = (url.searchParams.get('email') || '').trim().toLowerCase();
        const rows = this.sql.exec('SELECT * FROM inbox_shares WHERE targetEmail = ? ORDER BY created DESC', target).toArray();
        return json({ shares: rows });
      }
      if (p[1] === 'add' && req.method === 'POST') {
        const b = await req.json().catch(() => ({}));
        if (b.shareId && b.targetEmail) {
          this.sql.exec(
            'INSERT OR REPLACE INTO inbox_shares (shareId, kind, docId, title, cover, ownerEmail, targetEmail, canWrite, created, folderId, folderName) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            b.shareId, b.kind || 'd', b.docId || '', b.title || '', b.cover || '', String(b.ownerEmail || '').toLowerCase(), String(b.targetEmail || '').toLowerCase(), b.canWrite ? 1 : 0, b.created || Date.now(), b.folderId || '', b.folderName || ''
          );
        }
        return json({ ok: true });
      }
      if (p[1] === 'del' && req.method === 'POST') {
        const b = await req.json().catch(() => ({}));
        if (b.ownerEmail && b.docId) {
          this.sql.exec('DELETE FROM inbox_shares WHERE ownerEmail = ? AND docId = ?', String(b.ownerEmail).toLowerCase(), b.docId);
        }
        return json({ ok: true });
      }
    }

    if (p[0] === 'ws') { // live connection; the device key comes as the first message, never in the address
      if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'websocket' }, 426);
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ ok: false });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // Unauthenticated Guest Routes for Live Share: /live/:shareId/...
    if (p[0] === 'live' && p[1]) {
      const shareId = p[1];
      const [, secret] = shareId.split('_');
      if (!secret) return json({ error: 'no-secret' }, 400);
      const sh = this.sql.exec('SELECT docId, canWrite, allowedEmails FROM shares WHERE secret = ?', secret).toArray()[0];
      if (!sh) return json({ error: 'invalid-share' }, 404);

      // Access control if restricted to specific emails
      if (sh.allowedEmails && sh.allowedEmails.trim()) {
        const allowed = sh.allowedEmails.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        const ownerEmail = String(this.kvGet('email') || '').toLowerCase();
        let guestToken = '';
        if (p[2] === 'ws') guestToken = url.searchParams.get('token') || '';
        else guestToken = ((req.headers.get('Authorization') || '').match(/^Bearer\s+(\S+)$/) || [])[1] || '';

        if (!guestToken) {
          return json({ error: 'signin-required', message: 'This notebook is private. Please sign in with Google to view it.' }, 401);
        }
        const guestSub = guestToken.split('.')[0];
        if (!guestSub || !/^\d+$/.test(guestSub)) {
          return json({ error: 'signin-required', message: 'Invalid session. Please sign in with Google.' }, 401);
        }
        let guestEmail = '';
        try {
          const guestStub = this.env.USER.get(this.env.USER.idFromName(guestSub));
          guestEmail = (await guestStub.getEmail().catch(() => null) || '').toLowerCase();
          if (!guestEmail) {
            const resp = await guestStub.fetch(new Request('http://internal/internal/email'));
            if (resp.ok) guestEmail = (await resp.json()).email || '';
          }
        } catch {}
        guestEmail = (guestEmail || '').toLowerCase();
        if (!guestEmail) {
          return json({ error: 'signin-required', message: 'Could not verify your sign-in. Please sign in again.' }, 401);
        }
        if (guestEmail !== ownerEmail && !allowed.includes(guestEmail)) {
          return json({ error: 'forbidden', message: `Signed in as ${guestEmail}, but this notebook is only shared with ${sh.allowedEmails}.` }, 403);
        }
      }

      // WebSocket connection for live guest: /live/:shareId/ws
      if (p[2] === 'ws') {
        if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'websocket' }, 426);
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1]);
        pair[1].serializeAttachment({ ok: true, guest: true, docId: sh.docId, canWrite: !!sh.canWrite, secret });
        pair[1].send(JSON.stringify({ hello: true, live: true, docId: sh.docId, canWrite: !!sh.canWrite }));
        return new Response(null, { status: 101, webSocket: pair[0] });
      }

      // Guest metadata & doc structure: /live/:shareId/doc (or /live/:shareId)
      if (!p[2] || p[2] === 'doc') {
        const docRec = this.sql.exec("SELECT id, s, size, parts, info, gz FROM recs WHERE k = 'd' AND id = ?", sh.docId).toArray()[0];
        if (!docRec) return json({ error: 'doc-missing' }, 404);
        const docPart = this.sql.exec("SELECT data FROM parts WHERE k = 'd' AND id = ? AND n = 0", sh.docId).toArray()[0];
        let pageIds = [];
        if (docPart && docPart.data) {
          try {
            const res = new Response(docPart.data);
            const stream = docRec.gz ? res.body.pipeThrough(new DecompressionStream('gzip')) : res.body;
            const docObj = await new Response(stream).json();
            pageIds = docObj.pages || [];
          } catch (e) {}
        }
        let pageRecs = [];
        if (pageIds.length > 0) {
          const placeholders = pageIds.map(() => '?').join(',');
          pageRecs = this.sql.exec(`SELECT id, s, size, parts, info, gz FROM recs WHERE k = 'p' AND id IN (${placeholders})`, ...pageIds).toArray();
        } else {
          pageRecs = this.sql.exec("SELECT id, s, size, parts, info, gz FROM recs WHERE k = 'p' AND size >= 0").toArray()
            .filter(r => {
              try { const inf = JSON.parse(r.info || '{}'); return inf.docId === sh.docId; } catch { return false; }
            });
        }
        return json({
          ok: true,
          docId: sh.docId,
          canWrite: !!sh.canWrite,
          doc: docRec,
          pages: pageRecs
        });
      }

      // Guest blob retrieval: /live/:shareId/blob/:k/:id/:n
      if (p[2] === 'blob' && p[3] && p[4] && req.method === 'GET') {
        const k = p[3], id = p[4], n = Number(p[5] || 0);
        // Security check: restrict guest access to the shared doc, its pages, and assets
        if (k !== 'd' && k !== 'p' && k !== 'a') return json({ error: 'forbidden' }, 403);
        if (k === 'd' && id !== sh.docId) return json({ error: 'forbidden' }, 403);
        if (k === 'p') {
          const pr = this.sql.exec("SELECT info FROM recs WHERE k = 'p' AND id = ?", id).toArray()[0];
          let docMatches = false;
          try { docMatches = JSON.parse(pr?.info || '{}').docId === sh.docId; } catch {}
          if (!docMatches) return json({ error: 'forbidden' }, 403);
        }
        const r = this.sql.exec('SELECT s, parts, gz FROM recs WHERE k = ? AND id = ?', k, id).toArray()[0];
        const part = this.sql.exec('SELECT data FROM parts WHERE k = ? AND id = ? AND n = ?', k, id, n).toArray()[0];
        if (!r || !part) return json({ error: 'missing' }, 404);
        return new Response(part.data, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Parts': String(r.parts || 1),
            'X-Gz': r.gz ? '1' : '0'
          }
        });
      }
    }

    if (url.pathname === '/internal/email') {
      return json({ email: this.kvGet('email') || '' });
    }

    const token = ((req.headers.get('Authorization') || '').match(/^Bearer\s+(\S+)$/) || [])[1];
    const sess = await this.session(token);
    if (!sess) return json({ error: 'signin' }, 401);

    const tokenSub = (token || '').split('.')[0] || '';
    if (tokenSub && !this.kvGet('sub')) this.kvSet('sub', tokenSub);
    const mySub = this.kvGet('sub') || tokenSub;

    // POST /share/:docId : create or get a live share link
    if (p[0] === 'share' && p[1] && req.method === 'POST') {
      const docId = p[1];
      const { canWrite = false, allowedEmails = '', title = '', cover = '', kind = 'd', folderId = '', folderName = '' } = await req.json().catch(() => ({}));
      let sh = this.sql.exec('SELECT secret, canWrite, allowedEmails, folderId, folderName FROM shares WHERE docId = ?', docId).toArray()[0];
      const secret = sh ? sh.secret : randomKey().slice(0, 16);
      const emails = String(allowedEmails || '').trim().toLowerCase();
      const effFolderId = folderId || (sh ? sh.folderId : '') || '';
      const effFolderName = folderName || (sh ? sh.folderName : '') || '';
      if (!sh) {
        this.sql.exec('INSERT INTO shares (secret, docId, canWrite, created, allowedEmails, folderId, folderName) VALUES (?, ?, ?, ?, ?, ?, ?)', secret, docId, canWrite ? 1 : 0, Date.now(), emails, effFolderId, effFolderName);
      } else {
        this.sql.exec('UPDATE shares SET allowedEmails = ?, folderId = ?, folderName = ? WHERE secret = ?', emails, effFolderId, effFolderName, secret);
      }
      const shareId = `${mySub}_${secret}`;
      const myEmail = String(this.kvGet('email') || '').toLowerCase();
      if (allowedEmails !== undefined) {
        try {
          const reg = this.env.USER.get(this.env.USER.idFromName('shares_registry'));
          await reg.fetch(new Request('http://internal/registry/del', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ownerEmail: myEmail, docId })
          }));
          if (emails) {
            for (const targetEmail of emails.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) {
              await reg.fetch(new Request('http://internal/registry/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  shareId,
                  kind: kind || (docId.startsWith('f_') ? 'f' : 'd'),
                  docId,
                  title: title || 'Shared item',
                  cover: cover || '',
                  ownerEmail: myEmail,
                  targetEmail,
                  canWrite: canWrite ? 1 : 0,
                  created: Date.now(),
                  folderId: effFolderId,
                  folderName: effFolderName
                })
              }));
            }
          }
        } catch (e) {
          console.warn('Failed to register share in inbox:', e);
        }
      }
      return json({ shareId, canWrite: sh ? !!sh.canWrite : !!canWrite, allowedEmails: sh ? (sh.allowedEmails || '') : emails, secret, folderId: effFolderId, folderName: effFolderName });
    }

    // GET /shared-with-me : list items shared with this user
    if (p[0] === 'shared-with-me' && req.method === 'GET') {
      const myEmail = String(this.kvGet('email') || '').toLowerCase();
      if (!myEmail) return json({ shares: [] });
      try {
        const reg = this.env.USER.get(this.env.USER.idFromName('shares_registry'));
        const resp = await reg.fetch(new Request('http://internal/registry/for?email=' + encodeURIComponent(myEmail)));
        if (resp.ok) return resp;
      } catch (e) {
        console.warn('Registry fetch error:', e);
      }
      return json({ shares: [] });
    }

    // GET /shares : list all active shares created by this user
    if (p[0] === 'shares' && req.method === 'GET') {
      const rows = this.sql.exec('SELECT docId, secret, canWrite, allowedEmails, folderId, folderName FROM shares').toArray();
      return json({ shares: rows });
    }

    // GET /share/:docId : check status of live share
    if (p[0] === 'share' && p[1] && req.method === 'GET') {
      const docId = p[1];
      const sh = this.sql.exec('SELECT secret, canWrite, allowedEmails, folderId, folderName FROM shares WHERE docId = ?', docId).toArray()[0];
      if (!sh) return json({ shared: false });
      return json({ shared: true, shareId: `${mySub}_${sh.secret}`, canWrite: !!sh.canWrite, allowedEmails: sh.allowedEmails || '', secret: sh.secret, folderId: sh.folderId || '', folderName: sh.folderName || '' });
    }

    // PUT /share/:docId/permission : toggle allow friend to write & allowed emails
    if (p[0] === 'share' && p[1] && p[2] === 'permission' && req.method === 'PUT') {
      const docId = p[1];
      const { canWrite = false, allowedEmails, title = '', cover = '', kind = 'd', folderId = '', folderName = '' } = await req.json().catch(() => ({}));
      let sh = this.sql.exec('SELECT secret, allowedEmails, folderId, folderName FROM shares WHERE docId = ?', docId).toArray()[0];
      const effFolderId = folderId || (sh ? sh.folderId : '') || '';
      const effFolderName = folderName || (sh ? sh.folderName : '') || '';
      if (allowedEmails !== undefined) {
        this.sql.exec('UPDATE shares SET canWrite = ?, allowedEmails = ?, folderId = ?, folderName = ? WHERE docId = ?', canWrite ? 1 : 0, String(allowedEmails || '').trim().toLowerCase(), effFolderId, effFolderName, docId);
      } else {
        this.sql.exec('UPDATE shares SET canWrite = ?, folderId = ?, folderName = ? WHERE docId = ?', canWrite ? 1 : 0, effFolderId, effFolderName, docId);
      }
      for (const ws of this.ctx.getWebSockets()) {
        const a = ws.deserializeAttachment() || {};
        if (a.guest && a.docId === docId) {
          a.canWrite = !!canWrite;
          ws.serializeAttachment(a);
        }
      }
      this.broadcastLive(docId, { live: true, type: 'perm', docId, canWrite: !!canWrite, allowedEmails });

      // Update registry
      try {
        const reg = this.env.USER.get(this.env.USER.idFromName('shares_registry'));
        const myEmail = String(this.kvGet('email') || '').toLowerCase();
        await reg.fetch(new Request('http://internal/registry/del', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ownerEmail: myEmail, docId })
        }));
        sh = this.sql.exec('SELECT secret, allowedEmails, folderId, folderName FROM shares WHERE docId = ?', docId).toArray()[0];
        const emails = allowedEmails !== undefined ? String(allowedEmails || '').trim().toLowerCase() : (sh ? sh.allowedEmails : '');
        if (sh && mySub && emails) {
          const shareId = `${mySub}_${sh.secret}`;
          for (const targetEmail of emails.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) {
            await reg.fetch(new Request('http://internal/registry/add', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                shareId,
                kind: kind || (docId.startsWith('f_') ? 'f' : 'd'),
                docId,
                title: title || 'Shared item',
                cover: cover || '',
                ownerEmail: myEmail,
                targetEmail,
                canWrite: canWrite ? 1 : 0,
                created: Date.now(),
                folderId: effFolderId,
                folderName: effFolderName
              })
            }));
          }
        }
      } catch (e) {
        console.warn('Failed to update share registry:', e);
      }

      return json({ ok: true, canWrite: !!canWrite, allowedEmails, folderId: effFolderId, folderName: effFolderName });
    }

    // DELETE /share/:docId : revoke live share link
    if (p[0] === 'share' && p[1] && req.method === 'DELETE') {
      const docId = p[1];
      this.sql.exec('DELETE FROM shares WHERE docId = ?', docId);
      this.broadcastLive(docId, { live: true, type: 'revoked', docId });
      try {
        const reg = this.env.USER.get(this.env.USER.idFromName('shares_registry'));
        await reg.fetch(new Request('http://internal/registry/del', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ownerEmail: String(this.kvGet('email') || '').toLowerCase(),
            docId
          })
        }));
      } catch (e) {}
      return json({ ok: true });
    }

    // GET /settings : fetch user profile preferences (Gemini key & model preference)
    if (p[0] === 'settings' && req.method === 'GET') {
      return json({
        geminiKey: this.kvGet('geminiKey') || '',
        geminiModel: this.kvGet('geminiModel') || ''
      });
    }

    // PUT /settings : sync user profile preferences across all devices
    if (p[0] === 'settings' && req.method === 'PUT') {
      const b = await req.json().catch(() => ({}));
      if (b.geminiKey !== undefined) this.kvSet('geminiKey', b.geminiKey);
      if (b.geminiModel !== undefined) this.kvSet('geminiModel', b.geminiModel);
      return json({ ok: true });
    }

    // GET /google-token : a fresh pass for this person's Google Drive app folder, where PDFs and pictures are kept.
    if (p[0] === 'google-token' && req.method === 'GET') {
      const t = await this.googleToken();
      return t ? json({ access_token: t, exp: this.gexp }) : json({ error: 'no-google' }, 404);
    }

    // POST /ocr : Handwriting transcription via Gemini Flash
    if (p[0] === 'ocr' && req.method === 'POST') {
      const apiKey = this.kvGet('geminiKey') || this.env.GEMINI_KEY;
      if (!apiKey) return json({ error: 'no-gemini-key' }, 501);
      const body = await req.json().catch(() => ({}));
      const image = body.image;
      const mimeType = body.mimeType || 'image/jpeg';
      const n = Math.max(1, Math.min(40, Number(body.n) || 1));
      const allowedModels = new Set([
        'gemini-4-hydrogen',
        'gemini-3.8-flash',
        'gemini-3.8-flash-lite',
        'gemini-3.7-flash',
        'gemini-3.7-flash-lite',
        'gemini-3.6-flash',
        'gemini-3.6-flash-lite',
        'gemini-3.5-flash',
        'gemini-3.5-flash-lite'
      ]);
      const model = allowedModels.has(body.model) ? body.model : 'gemini-3.8-flash';
      if (!image) return json({ error: 'no-image' }, 400);

      const prompt = n > 1
        ? `You are an expert handwriting transcription assistant. This image has ${n} numbered rows of handwritten English text (each row has a red number at the left). Transcribe each row carefully. Preserve all words, numbers, punctuation and spaces as written. Return ONLY a valid JSON array of ${n} strings in order, one per row. If a row contains only a mark or doodle, use "".`
        : 'Transcribe all handwritten words and notes in this image. Return ONLY the transcribed text. Do not add quotes, markdown, or commentary.';

      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      let res = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mimeType, data: image } }
            ]
          }],
          generationConfig: {
            temperature: 0,
            responseMimeType: n > 1 ? 'application/json' : 'text/plain'
          }
        })
      });

      // Automatic fallback if requested model is 404 (not enabled/released) or 429 (quota hit)
      if (!res.ok && model !== 'gemini-3.5-flash-lite' && (res.status === 404 || res.status === 429 || res.status === 503)) {
        const fallbackUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`;
        const fallbackRes = await fetch(fallbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: prompt },
                { inline_data: { mime_type: mimeType, data: image } }
              ]
            }],
            generationConfig: {
              temperature: 0,
              responseMimeType: n > 1 ? 'application/json' : 'text/plain'
            }
          })
        });
        if (fallbackRes.ok) {
          res = fallbackRes;
        }
      }

      if (!res.ok) {
        const err = await res.text().catch(() => '');
        return json({ error: 'gemini-failed', detail: err.slice(0, 200) }, 502);
      }

      const data = await res.json();
      const raw = (data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
      let text = raw;
      if (n > 1) {
        try {
          const clean = raw.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```$/g, '').trim();
          text = JSON.parse(clean);
        } catch { text = []; }
      }
      return json({ ok: true, text });
    }

    // POST /ai/outline : AI-generated Table of Contents / Outline from PDF headings & text
    if (p[0] === 'ai' && p[1] === 'outline' && req.method === 'POST') {
      const apiKey = this.kvGet('geminiKey') || this.env.GEMINI_KEY;
      if (!apiKey) return json({ error: 'no-gemini-key' }, 501);
      const body = await req.json().catch(() => ({}));
      const text = body.text || '';
      const numPages = Number(body.numPages) || 100;
      if (!text.trim()) return json({ ok: true, outline: [] });

      const prompt = `You are a document indexing assistant. Here is raw text from the Table of Contents or section headers of a ${numPages}-page PDF:\n\n${text.slice(0, 35000)}\n\nExtract and return a clean, comprehensive Table of Contents JSON array of objects. Each object must have:
- "title": Clean section title (string, remove trailing dots, numbers, or page markers)
- "page": Target 1-based page number (integer, max ${numPages})
- "depth": 0 for main chapters/parts, 1 for subsections, 2 for sub-subsections

Return ONLY the valid JSON array without commentary or code fences.`;

      const allowedModels = new Set([
        'gemini-4-hydrogen',
        'gemini-3.8-flash', 'gemini-3.8-flash-lite', 'gemini-3.7-flash', 'gemini-3.7-flash-lite',
        'gemini-3.6-flash', 'gemini-3.6-flash-lite', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'
      ]);
      const reqModel = this.kvGet('geminiModel') || 'gemini-3.8-flash';
      const model = allowedModels.has(reqModel) ? reqModel : 'gemini-3.8-flash';
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      try {
        let res = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
          })
        });
        if (!res.ok) {
          const fallbackUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`;
          res = await fetch(fallbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
            })
          });
        }
        if (res.ok) {
          const j = await res.json();
          const raw = (j?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            return json({ ok: true, outline: parsed });
          }
        }
      } catch (err) {
        console.warn('AI outline error:', err);
      }
      return json({ ok: true, outline: [] });
    }

    // GET /meta/k/id : one record's entry, if the service holds it.
    if (p[0] === 'meta' && KINDS.has(p[1]) && p[2] && req.method === 'GET') {
      const r = this.sql.exec('SELECT k, id, s, size, parts, info, gz FROM recs WHERE k = ? AND id = ?', p[1], p[2]).toArray()[0];
      return r ? json(r) : json({ error: 'missing' }, 404);
    }

    // GET /changes?since=s : what changed after s, oldest first (metadata only; blobs are fetched one by one).
    if (p[0] === 'changes' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0), limit = Math.min(1000, Number(url.searchParams.get('limit') || 500));
      const curSeq = this.seq();
      if (since >= curSeq) {
        return json({ items: [], more: false, seq: curSeq });
      }
      const rows = this.sql.exec(`SELECT k, id, s, size, parts, info, gz FROM recs WHERE s > ? AND k IN ${FEED} ORDER BY s LIMIT ?`, since, limit + 1).toArray();
      return json({ items: rows.slice(0, limit), more: rows.length > limit, seq: curSeq });
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
      const oldSize = (cur && cur.size > 0 ? cur.size : 0);
      const newSize = (size > 0 ? size : 0);
      this._cachedBytes = Math.max(0, this.usedBytes() - oldSize + newSize);
      this.kvSet('total_bytes', this._cachedBytes);
      if (k !== 'b') this.broadcast(s);
      return json({ s });
    }

    // DELETE /blob/k/id : an attached file leaves a marker in the feed (size -1) so other devices drop it too;
    // a snapshot just goes.
    if (p[0] === 'blob' && KINDS.has(p[1]) && p[2] && req.method === 'DELETE') {
      const curDel = this.sql.exec('SELECT size FROM recs WHERE k = ? AND id = ?', p[1], p[2]).toArray()[0];
      const oldSize = (curDel && curDel.size > 0 ? curDel.size : 0);
      this._cachedBytes = Math.max(0, this.usedBytes() - oldSize);
      this.kvSet('total_bytes', this._cachedBytes);
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
      const myEmail = String(this.kvGet('email') || '').toLowerCase();
      const allowedList = (this.env.ALLOWED || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      const friends = allowedList.filter(e => e !== myEmail);
      const u = this.trackUsage(false, 0, false);
      return json({
        email: this.kvGet('email'),
        devices: n,
        bytes: this.usedBytes(),
        quota: this.quota(),
        drive: !!this.kvGet('grt'),
        seq: this.seq(),
        friends,
        cfCallsToday: u?.cfCalls || 0,
        cfLimit: 100000,
        ocrCallsToday: u?.ocrCalls || 0,
        ocrLimit: 1500,
        merged: true
      });
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

  broadcastLive(docId, msg, excludeWs = null) {
    const raw = typeof msg === 'string' ? msg : JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === excludeWs) continue;
      const a = ws.deserializeAttachment() || {};
      if (a.ok && (a.docId === docId || !a.guest)) {
        try { ws.send(raw); } catch {}
      }
    }
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
    if (m.ping) { ws.send(JSON.stringify({ pong: true, s: this.seq() })); return; }
    // Live ink streaming across the share room
    if (m.live && m.docId) {
      if (a.guest && !a.canWrite) return; // View-only guest cannot send edits
      this.broadcastLive(m.docId, m, ws);
    }
  }

  async webSocketClose(ws, code) { try { ws.close(code, 'bye'); } catch { /* already closed */ } }
}
