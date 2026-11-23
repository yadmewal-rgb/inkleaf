// Settings, colours and sizes the editor uses (no state: these never change while Inkleaf runs).

export const GAP = 14, MIN_S = 0.2, MAX_S = 6;
export const COARSE = matchMedia('(pointer: coarse)').matches;
export const MAXPX = COARSE ? 5.5e6 : 9e6; // cap on pixels per whole-page canvas (memory on tablets)
export const REGION_PX = COARSE ? 6e6 : 12e6; // cap when only the visible part of a page is drawn (zoomed in)
export const REGION_PAD = 0.15;               // extra drawn around the visible part, as a fraction of the screen
export const PULL_PX = 90;                    // how far to drag up past the last page to add a new one
export const PALM_MS = 350;                  // touches this soon after the stylus was seen are treated as the palm
export const INK = '#1c1d21', INK_ON_DARK = '#f1f3f5';

export const PEN_COLORS = [INK, '#e03131', '#1971c2', '#2f9e44', '#f08c00', '#9c36b5', '#ffffff'];
export const HL_COLORS = ['#ffd43b', '#8ce99a', '#74c0fc', '#faa2c1', '#ffa94d'];
export const SHAPES = [['rect', 'Rectangle'], ['ellipse', 'Ellipse'], ['line', 'Line'], ['arrow', 'Arrow']];

export const MM = 0.3528; // one page unit (a PDF point) in millimetres
export const mmToPt = mm => Math.round(mm / MM * 100) / 100;

export const TAPE_COLORS = ['#e9d8a6', '#f4b6c2', '#a9d6e5', '#c9c9c9', '#2b2d42'];
export const LASER_COLORS = ['#ff2d2d', '#22c55e', '#3b82f6'];
export const RULER_L = 170 / MM, RULER_W = 46; // the on-screen ruler: 17 cm long, in page units
export const ZOOM_TOOLS = ['pen', 'hl', 'eraser'];

export const NOTE_COLORS = ['#ffe066', '#ffc9c9', '#b2f2bb', '#a5d8ff', '#d0bfff'];
export const FILL_COLORS = ['#ffe3e3', '#fff3bf', '#d3f9d8', '#d0ebff', '#e5dbff', '#dee2e6'];
export const HIST_GAP = 5 * 60e3, HIST_MAX = 25, HIST_DAYS = 14; // page history: one snapshot per 5 minutes of writing
// Tags that can be put on anything on a page: n = name, c = colour, s = the sign shown in the badge.
export const TAGS = {
  imp: { n: 'Important', c: '#e03131', s: '!' }, q: { n: 'Question', c: '#1971c2', s: '?' },
  todo: { n: 'To do', c: '#f08c00', s: '○' }, def: { n: 'Definition', c: '#2f9e44', s: 'D' },
  done: { n: 'Done', c: '#868e96', s: '✓' }
};
export const SEC_COLORS = ['#1971c2', '#e8590c', '#2f9e44', '#9c36b5', '#e03131', '#0c8599'];
export const fmtWhen = t => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
export const TM = {
  open: false,
  running: false,
  t0: 0,
  acc: 0,
  dur: 20 * 60000,
  breakDur: 2 * 60000,
  mode: 'focus',
  type: 'pomodoro',
  round: 1,
  loops: 4,
  compact: true,
  pos: null,
  activeTag: 'pre ans reading',
  activeColor: '#e03131',
  autoStart: true,
  presets: [
    { id: 'p1', name: 'Focus', dur: 25, breakDur: 5, color: '#e03131', loops: 4, autoStart: true },
    { id: 'p2', name: 'pre ans reading', dur: 20, breakDur: 2, color: '#e8590c', loops: 4, autoStart: true },
    { id: 'p3', name: 'Study', dur: 30, breakDur: 5, color: '#2f9e44', loops: 4, autoStart: true }
  ]
}; // Pomodoro timer, tags & clock, shared across notebooks

export const DEFAULTS = {
  noteColor: '#ffe066',
  tape:{ color: '#e9d8a6', size: mmToPt(7) },
  laser: { color: '#ff2d2d' },
  flow: 'v',      // 'v' = pages run down the screen, 'h' = side by side, one at a time
  tool: 'pen',
  pen: { color: INK, size: mmToPt(0.7), style: 'fountain' },
  scribble: true, // a zigzag over ink erases it
  favs: [],       // favourite pens: [{color, size, style}]
  hl: { color: '#ffd43b', size: mmToPt(5.5), mode: 'free' }, // mode: free, or follow PDF text as hl / ul / st
  hlTray: false,  // false = keep highlights tray closed by default; open on demand from More > Highlights
  hlCards: false, // automatic flashcards from highlights
  hlSort: 'marked', // 'marked' = in order marked (Page 1, 11, 9...), 'page' = notebook page order (1, 9, 11...)
  eraser: { size: mmToPt(5.5), mode: 'stroke', only: 'all' },
  shape: { kind: 'rect', color: '#1971c2', size: mmToPt(0.8), fill: null },
  text: { color: INK, size: 16, b: false, i: false, u: false, ff: 'sans', al: 'l' },
  fingerDraw: null, // null = automatic: fingers draw until a stylus has been seen
  applePencilOnly: false, // strict palm rejection: only stylus leaves ink, fingers scroll/zoom
  penHoverPreview: true, // hover cursor shows tip size, color, barrel roll & tilt before touching
  openRead: null,
  penSeen: false,
  scrollbar: 'left', // 'left' = left edge (never touches right hand), 'right' = right edge, 'hidden' = hidden
  spellcheck: true // handwriting and text spell check as you write (red dotted underline)
};

// opts: page (1-based page to open at), q (text to find), pane / other (side by side: this pane's index, the other notebook)
