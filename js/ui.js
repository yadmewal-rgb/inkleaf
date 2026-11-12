import { h, clamp } from './util.js';
import { I } from './icons.js';

export function toast(msg, ms = 2800) {
  const t = h('div', { class: 'toast' }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 300);
}

// actions: [{label, primary, danger, onClick}] - returning false from onClick keeps the dialog open.
export function modal({ title, body, actions = [], wide, onClose }) {
  const dlg = h('dialog', { class: 'modal' + (wide ? ' wide' : '') });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    dlg.close();
    dlg.remove();
    if (onClose) onClose();
  };
  const foot = h('div', { class: 'modal-foot' }, actions.map(a =>
    h('button', {
      class: 'btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : ''),
      type: 'button',
      onclick: async () => {
        const r = a.onClick ? await a.onClick() : undefined;
        if (r !== false) close();
      }
    }, a.label)));
  dlg.append(h('div', { class: 'modal-in' },
    h('div', { class: 'modal-head' },
      h('h2', null, title),
      h('button', { class: 'ic', type: 'button', title: 'Close', onclick: close, html: I.close })),
    h('div', { class: 'modal-body' }, body),
    actions.length ? foot : null));
  dlg.addEventListener('cancel', e => { e.preventDefault(); close(); });
  dlg.addEventListener('pointerdown', e => { if (e.target === dlg) close(); });
  document.body.append(dlg);
  dlg.showModal();
  return { close, el: dlg };
}

export function promptText(title, value = '', placeholder = '') {
  return new Promise(res => {
    let out = null;
    const inp = h('input', { class: 'inp', value, placeholder, maxLength: 120, autofocus: true });
    const m = modal({
      title,
      body: inp,
      onClose: () => res(out),
      actions: [
        { label: 'Cancel' },
        { label: 'OK', primary: true, onClick: () => { out = inp.value.trim(); } }
      ]
    });
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { out = inp.value.trim(); m.close(); }
    });
    inp.focus();
    inp.select();
  });
}

export function confirmBox(title, message, okLabel = 'OK', danger = false) {
  return new Promise(res => {
    let out = false;
    modal({
      title,
      body: h('p', { class: 'modal-text' }, message),
      onClose: () => res(out),
      actions: [
        { label: 'Cancel' },
        { label: okLabel, primary: !danger, danger, onClick: () => { out = true; } }
      ]
    });
  });
}

// Floating panel anchored to an element; closes on any outside press.
export function popover(anchor, content, { align = 'left' } = {}) {
  const pop = h('div', { class: 'pop' }, content);
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  const x = clamp(align === 'right' ? r.right - pw : r.left, 8, Math.max(8, innerWidth - pw - 8));
  let y = r.bottom + 6;
  if (y + ph > innerHeight - 8) y = Math.max(8, r.top - ph - 6);
  pop.style.left = x + 'px';
  pop.style.top = y + 'px';
  const onDoc = e => { if (!pop.contains(e.target)) close(); };
  function close() {
    pop.remove();
    document.removeEventListener('pointerdown', onDoc, true);
  }
  setTimeout(() => document.addEventListener('pointerdown', onDoc, true), 0);
  return close;
}

// items: [{label, icon, danger, onClick} | '-']
export function popMenu(anchor, items, opts) {
  let close = () => {};
  const list = h('div', { class: 'menu' }, items.map(it => it === '-'
    ? h('div', { class: 'sep' })
    : h('button', {
        class: 'mi' + (it.danger ? ' danger' : ''),
        type: 'button',
        onclick: () => { close(); it.onClick(); }
      }, it.icon ? h('span', { class: 'mi-ic', html: it.icon }) : null, it.label)));
  close = popover(anchor, list, opts);
  return close;
}

export const TEMPLATE_OPTS = [
  { v: 'blank', label: 'Blank' }, { v: 'ruled', label: 'Ruled' }, { v: 'narrow', label: 'Narrow ruled' }, { v: 'wide', label: 'Wide ruled' },
  { v: 'margin', label: 'Ruled with margin' }, { v: 'cornell', label: 'Cornell notes' }, { v: 'todo', label: 'Checklist' },
  { v: 'grid', label: 'Grid' }, { v: 'gridsmall', label: 'Small grid' }, { v: 'dots', label: 'Dotted' },
  { v: 'iso', label: 'Isometric dots' }, { v: 'music', label: 'Music staves' }
];
export const PAPER_OPTS = [
  { v: 'white', label: 'White', swatch: '#ffffff' }, { v: 'cream', label: 'Cream', swatch: '#fbf5e4' },
  { v: 'yellow', label: 'Yellow', swatch: '#fdf7c4' }, { v: 'blue', label: 'Blue', swatch: '#eaf3fb' },
  { v: 'green', label: 'Green', swatch: '#e9f4e6' }, { v: 'gray', label: 'Grey', swatch: '#ececec' },
  { v: 'dark', label: 'Dark', swatch: '#1e1f22' }
];

// A labelled row of single-choice chips. opts: [{v, label, swatch}]
export function chipGroup(label, opts, value, onChange) {
  const row = h('div', { class: 'chips' });
  let cur = value;
  const draw = () => row.replaceChildren(...opts.map(o =>
    h('button', {
      class: 'chip' + (cur === o.v ? ' on' : ''), type: 'button',
      onclick: () => { cur = o.v; onChange(o.v); draw(); }
    }, o.swatch ? h('span', { class: 'chip-sw', style: { background: o.swatch } }) : null, o.label)));
  draw();
  return h('div', { class: 'field' }, h('label', null, label), row);
}

export function busy(text) {
  const t = h('div', { class: 'busy-text' }, text);
  const el = h('div', { class: 'busy' }, h('div', { class: 'busy-card' }, h('div', { class: 'spinner' }), t));
  document.body.append(el);
  return { set: s => { t.textContent = s; }, done: () => el.remove() };
}
