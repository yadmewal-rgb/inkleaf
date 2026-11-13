// Small shared helpers. Nothing here needs a secure context, so the app also runs over plain http on a LAN.

let c1 = 0, c2 = 0;
export const uid = () =>
  Date.now().toString(36) + (c1++ % 1296).toString(36).padStart(2, '0') + Math.random().toString(36).slice(2, 8);

// Monotonic z-order value for new items (later = on top).
export const nextZ = () => Date.now() * 1000 + (c2++ % 1000);

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function append(el, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else el.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
}

// Wait for a picture to load. (Not img.decode(): on iPad that refuses large photos which display perfectly well.)
export function imgReady(img) {
  return new Promise((res, rej) => {
    if (img.complete && img.naturalWidth) { res(img); return; }
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('this picture format cannot be read here'));
  });
}

// Replace an element's children; like h(), nested arrays are flattened and null / false are skipped.
export function fill(el, ...kids) {
  el.replaceChildren();
  append(el, kids);
  return el;
}

// Tiny element builder: h('div', {class:'x', onclick: fn}, child, ...)
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v; // only ever used with the static icon strings
      else if (k === 'style' && typeof v === 'object') {
        for (const s in v) {
          if (s.startsWith('--')) el.style.setProperty(s, v[s]); else el.style[s] = v[s];
        }
      } else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k in el && k !== 'style') { try { el[k] = v; } catch { el.setAttribute(k, v); } }
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, kids);
  return el;
}

export function debounce(fn, ms) {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

const scripts = new Map();
export function loadScript(src) {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => res();
      s.onerror = () => { scripts.delete(src); s.remove(); rej(new Error('Could not load ' + src)); };
      document.head.append(s);
    }));
  }
  return scripts.get(src);
}

// Distance from point P to segment AB.
export function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

// Point in polygon; poly is a flat [x0,y0,x1,y1,...] array.
export function inPoly(x, y, poly) {
  let c = false;
  const n = poly.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}

export const bus = {
  m: new Map(),
  on(ev, fn) {
    if (!this.m.has(ev)) this.m.set(ev, new Set());
    this.m.get(ev).add(fn);
    return () => this.m.get(ev).delete(fn);
  },
  emit(ev, data) {
    const s = this.m.get(ev);
    if (s) for (const fn of [...s]) { try { fn(data); } catch (e) { console.error(e); } }
  }
};

export function fmtDate(t) {
  if (!t) return '';
  const d = new Date(t), n = new Date();
  const sameDay = d.toDateString() === n.toDateString();
  if (sameDay) return 'Today, ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const opts = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== n.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString([], opts);
}

export const safeName = s => (s || 'notebook').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'notebook';

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function bufToB64(buf) {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64ToBuf(b64) {
  const s = atob(b64);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u.buffer;
}
