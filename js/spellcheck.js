// Handwriting and text spell checker.
// Highlights misspelled words with a temporary red dotted underline (like GoodNotes),
// and offers one-tap spelling corrections, ignore, and custom dictionary.
import { bus } from './util.js';
import { VOCAB_TEXT } from './vocab.js';

const DICT_STORAGE_KEY = 'inkleaf.user_dict';

// Common English misspellings map for instant, high-confidence suggestions
export const COMMON_TYPOS = {
  thier: ['their', 'there'],
  teh: ['the'],
  definately: ['definitely'],
  definate: ['definite'],
  recieve: ['receive'],
  recieved: ['received'],
  recieving: ['receiving'],
  seperate: ['separate'],
  seperated: ['separated'],
  seperation: ['separation'],
  untill: ['until'],
  wierd: ['weird'],
  beleive: ['believe'],
  beleived: ['believed'],
  beleiver: ['believer'],
  occured: ['occurred'],
  occuring: ['occurring'],
  truely: ['truly'],
  writting: ['writing'],
  mispell: ['misspell'],
  mispelled: ['misspelled'],
  goverment: ['government'],
  tommorow: ['tomorrow'],
  tommorrow: ['tomorrow'],
  wich: ['which', 'witch'],
  adress: ['address'],
  adresses: ['addresses'],
  arguement: ['argument'],
  beggining: ['beginning'],
  calender: ['calendar'],
  colleague: ['colleague'],
  collegue: ['colleague'],
  concious: ['conscious'],
  embarass: ['embarrass'],
  embarassed: ['embarrassed'],
  enviornment: ['environment'],
  existance: ['existence'],
  foward: ['forward'],
  gaurantee: ['guarantee'],
  happenning: ['happening'],
  independant: ['independent'],
  knowlege: ['knowledge'],
  millenium: ['millennium'],
  neccessary: ['necessary'],
  noticable: ['noticeable'],
  ocassion: ['occasion'],
  occassion: ['occasion'],
  posession: ['possession'],
  privelege: ['privilege'],
  recommand: ['recommend'],
  succesful: ['successful'],
  suprise: ['surprise'],
  tendancy: ['tendency'],
  unforunately: ['unfortunately'],
  wether: ['whether', 'weather'],
  accross: ['across'],
  appartment: ['apartment'],
  basicly: ['basically'],
  buisness: ['business'],
  catagory: ['category'],
  comming: ['coming'],
  diferent: ['different'],
  dissapear: ['disappear'],
  dissapoint: ['disappoint'],
  fourty: ['forty'],
  freind: ['friend'],
  grammer: ['grammar'],
  guage: ['gauge'],
  hieght: ['height'],
  immediatly: ['immediately'],
  interupt: ['interrupt'],
  liesure: ['leisure'],
  maintainance: ['maintenance'],
  milage: ['mileage'],
  minumum: ['minimum'],
  neice: ['niece'],
  oppurtunity: ['opportunity'],
  peice: ['piece'],
  pronounciation: ['pronunciation'],
  publically: ['publicly'],
  questionaire: ['questionnaire'],
  religous: ['religious'],
  rember: ['remember'],
  resistence: ['resistance'],
  rythm: ['rhythm'],
  shedule: ['schedule'],
  succede: ['succeed'],
  supercede: ['supersede'],
  threshhold: ['threshold'],
  twelth: ['twelfth'],
  vaccuum: ['vacuum'],
  vehical: ['vehicle'],
  yeild: ['yield'],
  speling: ['spelling'],
  mistaks: ['mistakes'],
  corection: ['correction'],
  sugestion: ['suggestion']
};

// Built-in 40,700+ clean English offline vocabulary
const DICT = new Set(VOCAB_TEXT.split(' '));

// In-memory set for words ignored during this editing session
const sessionIgnored = new Set();

// Load persistent user custom dictionary from localStorage
export function getUserDict() {
  try {
    const raw = localStorage.getItem(DICT_STORAGE_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

export function addToUserDict(word) {
  if (!word) return;
  const clean = word.toLowerCase().trim();
  const dict = getUserDict();
  dict.add(clean);
  try {
    localStorage.setItem(DICT_STORAGE_KEY, JSON.stringify([...dict]));
  } catch {}
  bus.emit('spell-dict-updated', clean);
}

export function ignoreWord(word) {
  if (!word) return;
  sessionIgnored.add(word.toLowerCase().trim());
  bus.emit('spell-dict-updated', word);
}

// Levenshtein distance
function lev(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = [];
  for (let i = 0; i <= a.length; i++) d[i] = [i];
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[a.length][b.length];
}

// Check if a single cleaned English word is valid
function isWordValid(w, userDict) {
  if (!w || w.length <= 1) return true; // ignore lone letters (a, i, x)
  if (/^\d+$/.test(w) || /^[\d/.,%$#@!+:-]+$/.test(w)) return true; // numbers, dates (20/11/2026), math
  if (/^[A-Z0-9_]+$/.test(w)) return true; // ALL_CAPS acronyms or codes (PDF, URL, API)
  // Chemical formulas like C6H12O6, CO2, H2O, O2 (letters mixed with digits)
  if (/[a-zA-Z]+[0-9]+|[0-9]+[a-zA-Z]+/i.test(w)) return true;

  const lw = w.toLowerCase();
  if (DICT.has(lw) || userDict.has(lw) || sessionIgnored.has(lw)) return true;

  // Suffix checks (stemming)
  if (lw.endsWith('s') && (DICT.has(lw.slice(0, -1)) || userDict.has(lw.slice(0, -1)))) return true;
  if (lw.endsWith('es') && (DICT.has(lw.slice(0, -2)) || userDict.has(lw.slice(0, -2)))) return true;
  if (lw.endsWith('ed') && (DICT.has(lw.slice(0, -2)) || DICT.has(lw.slice(0, -1)) || userDict.has(lw.slice(0, -2)))) return true;
  // study -> studied, carry -> carried
  if (lw.endsWith('ied') && (DICT.has(lw.slice(0, -3) + 'y') || userDict.has(lw.slice(0, -3) + 'y'))) return true;
  // study -> studies, category -> categories
  if (lw.endsWith('ies') && (DICT.has(lw.slice(0, -3) + 'y') || userDict.has(lw.slice(0, -3) + 'y'))) return true;
  if (lw.endsWith('ing') && (DICT.has(lw.slice(0, -3)) || DICT.has(lw.slice(0, -3) + 'e') || userDict.has(lw.slice(0, -3)))) return true;
  if (lw.endsWith('ly') && (DICT.has(lw.slice(0, -2)) || userDict.has(lw.slice(0, -2)))) return true;
  if (lw.endsWith('ers') && (DICT.has(lw.slice(0, -3)) || DICT.has(lw.slice(0, -1)) || userDict.has(lw.slice(0, -3)))) return true;
  // science -> scientific, specific
  if (lw.endsWith('ific') && (DICT.has(lw.slice(0, -4) + 'ce') || DICT.has(lw.slice(0, -4) + 'e') || DICT.has(lw.slice(0, -4)))) return true;
  // ecology, geology, biology, autoecology, synecology
  if (lw.endsWith('ology') || lw.endsWith('ological') || lw.endsWith('ecology')) return true;

  // Prefix checks
  if (lw.startsWith('un') && (DICT.has(lw.slice(2)) || userDict.has(lw.slice(2)))) return true;
  if (lw.startsWith('re') && (DICT.has(lw.slice(2)) || userDict.has(lw.slice(2)))) return true;
  if (lw.startsWith('auto') && (DICT.has(lw.slice(4)) || userDict.has(lw.slice(4)))) return true;
  if (lw.startsWith('syn-') && (DICT.has(lw.slice(4)) || userDict.has(lw.slice(4)))) return true;

  return false;
}

// Fast candidate generation using edit distance 1
function getCandidates(w, maxResults = 3) {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const cands = new Set();
  for (let i = 0; i < w.length; i++) cands.add(w.slice(0, i) + w.slice(i + 1));
  for (let i = 0; i < w.length - 1; i++) cands.add(w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2));
  for (let i = 0; i < w.length; i++) {
    for (const c of letters) cands.add(w.slice(0, i) + c + w.slice(i + 1));
  }
  for (let i = 0; i <= w.length; i++) {
    for (const c of letters) cands.add(w.slice(0, i) + c + w.slice(i));
  }
  const userDict = getUserDict();
  const valid = [];
  for (const cand of cands) {
    if (cand.length >= 2 && (DICT.has(cand) || userDict.has(cand))) {
      valid.push(cand);
      if (valid.length >= maxResults) break;
    }
  }
  return valid;
}

// Check word and get suggestions
export function checkWord(rawWord) {
  if (!rawWord) return { misspelled: false, suggestions: [] };
  const clean = rawWord.trim().replace(/^[^a-zA-Z0-9']+|[^a-zA-Z0-9']+$/g, '');
  if (!clean || clean.length < 2) return { misspelled: false, suggestions: [] };

  const userDict = getUserDict();
  if (isWordValid(clean, userDict)) return { misspelled: false, suggestions: [] };

  const lw = clean.toLowerCase();

  // 1. Direct typo table match (fast & exact)
  if (COMMON_TYPOS[lw]) {
    const sugs = COMMON_TYPOS[lw].map(s => matchCase(clean, s));
    return { misspelled: true, clean, suggestions: sugs };
  }

  // 2. Fast candidate generation (edit distance 1)
  const cands = getCandidates(lw, 3);
  if (cands.length > 0) {
    return {
      misspelled: true,
      clean,
      suggestions: cands.map(c => matchCase(clean, c))
    };
  }

  return {
    misspelled: true,
    clean,
    suggestions: []
  };
}

// Match original case (Capitalized or lowercase)
function matchCase(orig, target) {
  if (!orig || !target) return target;
  if (orig[0] === orig[0].toUpperCase() && orig.slice(1) === orig.slice(1).toLowerCase()) {
    return target[0].toUpperCase() + target.slice(1).toLowerCase();
  }
  if (orig === orig.toUpperCase()) return target.toUpperCase();
  return target.toLowerCase();
}

// Scan a page's handwriting index and typed text items for spelling mistakes.
// Returns an array of error objects:
// [{ id, kind: 'ink'|'tx', word, clean, suggestions, box: {x0, y0, x1, y1, w, h}, ids, item, color }]
export function findSpellingErrorsOnPage(page, hwData) {
  if (!page || !page.items) return [];
  const errors = [];
  const seenIds = new Set();

  // 1. Check handwriting runs if hw data exists
  if (hwData && hwData.r && Array.isArray(hwData.r)) {
    for (const run of hwData.r) {
      if (!run.t) continue;
      // Check handwriting if run has word breakdown
      if (run.w && Array.isArray(run.w)) {
        for (const item of run.w) {
          const w = item.t;
          if (!w) continue;
          const res = checkWord(w);
          if (res.misspelled) {
            // Find stroke items for these IDs to compute bounding box
            const strokes = (page.items || []).filter(it => it.t === 's' && item.ids.includes(it.id));
            if (!strokes.length) continue;
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            let strokeColor = '#1a1a1a';
            for (const s of strokes) {
              if (s.c) strokeColor = s.c;
              const p = s.p;
              for (let i = 0; i < p.length; i += 3) {
                const x = p[i], y = p[i + 1];
                if (x < x0) x0 = x; if (x > x1) x1 = x;
                if (y < y0) y0 = y; if (y > y1) y1 = y;
              }
            }
            if (x0 < x1 && y0 < y1) {
              const markId = `sp-ink-${item.ids.slice(0, 2).join('-')}`;
              if (!seenIds.has(markId)) {
                seenIds.add(markId);
                errors.push({
                  id: markId,
                  kind: 'ink',
                  word: w,
                  clean: res.clean,
                  suggestions: res.suggestions,
                  box: { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 },
                  ids: item.ids,
                  color: strokeColor,
                  pageId: page.id
                });
              }
            }
          }
        }
      }
    }
  }

  // 2. Check typed text items (it.t === 'tx')
  for (const it of page.items) {
    if (it.t !== 'tx' || !it.s) continue;
    const words = it.s.split(/\s+/).filter(Boolean);
    const fs = it.fs || 16;
    for (const w of words) {
      const res = checkWord(w);
      if (res.misspelled) {
        // Approximate word position in text box
        const idx = it.s.indexOf(w);
        const prefix = it.s.slice(0, idx);
        const charW = fs * 0.55;
        const wx0 = it.x + (prefix.length % 40) * charW;
        const line = Math.floor(prefix.length / 40);
        const wy0 = it.y + line * fs * 1.3;
        const ww = Math.max(20, w.length * charW);
        const markId = `sp-tx-${it.id}-${idx}`;
        if (!seenIds.has(markId)) {
          seenIds.add(markId);
          errors.push({
            id: markId,
            kind: 'tx',
            word: w,
            clean: res.clean,
            suggestions: res.suggestions,
            box: { x0: wx0, y0: wy0, x1: wx0 + ww, y1: wy0 + fs, w: ww, h: fs },
            item: it,
            color: it.c || '#1a1a1a',
            pageId: page.id
          });
        }
      }
    }
  }

  return errors;
}
