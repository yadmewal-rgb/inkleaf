// Handwriting and text spell checker.
// Highlights misspelled words with a temporary red dotted underline (like GoodNotes),
// and offers one-tap spelling corrections, ignore, and custom dictionary.
//
// Words: vendor/words/en.txt, about 200,000 English words with every form (stopped, bigger, India's), British and
// American spellings, names, and Indian and legal terms; built from SCOWL (vendor/words/SCOWL-Copyright.txt).
// Each line is a commonness level (10 = most common) and its words; suggestions put common words first.
// It is read after the app has started, in small steps so writing never stutters; until then nothing is marked.
import { bus } from './util.js';

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
  sugestion: ['suggestion'],
  alot: ['a lot']
};

// word -> commonness level (10 = most common ... 80 = rare names)
const DICT = new Map();
let loaded = false, loading = null;

// Reads the word list in steps of 10,000 words, letting the page draw in between. Safe to call often.
export function loadDictionary(url = 'vendor/words/en.txt') {
  if (!loading) {
    loading = (async () => {
      const text = await (await fetch(url)).text();
      for (const line of text.split('\n')) {
        const tab = line.indexOf('\t');
        if (tab < 0) continue;
        const lv = Number(line.slice(0, tab));
        const words = line.slice(tab + 1).split(' ');
        for (let i = 0; i < words.length; i += 10000) {
          for (const w of words.slice(i, i + 10000)) if (w) DICT.set(w, lv);
          await new Promise(r => setTimeout(r, 0));
        }
      }
      loaded = true;
      bus.emit('spell-dict-updated', ''); // open notebooks check their pages now
    })().catch(e => { loading = null; console.warn('Spell check word list could not be read', e); });
  }
  return loading;
}
export const dictionaryReady = () => loaded;

// In-memory set for words ignored during this editing session
const sessionIgnored = new Set();

// The user's own words (localStorage), kept parsed: it is asked for every word on every check.
let userDict = null;
export function getUserDict() {
  if (!userDict) {
    try {
      const raw = localStorage.getItem(DICT_STORAGE_KEY);
      userDict = new Set(raw ? JSON.parse(raw) : []);
    } catch {
      userDict = new Set();
    }
  }
  return userDict;
}

export function addToUserDict(word) {
  if (!word) return;
  const clean = norm(word);
  const dict = getUserDict();
  dict.add(clean);
  try {
    localStorage.setItem(DICT_STORAGE_KEY, JSON.stringify([...dict]));
  } catch {}
  bus.emit('spell-dict-updated', clean);
}

export function ignoreWord(word) {
  if (!word) return;
  sessionIgnored.add(norm(word));
  bus.emit('spell-dict-updated', word);
}

// lowercase, curly apostrophes made straight
const norm = w => w.trim().toLowerCase().replace(/[’‘`´]/g, "'");
const known = w => DICT.has(w) || getUserDict().has(w) || sessionIgnored.has(w);

// Prefixes that make new words freely (non-violent, subnational, postcolonial): accepted when the rest is a word.
// Not un-, re-, pre-, co-...: they would let mistakes through ("untill" = un + till, "presure" = pre + sure), and the
// word list already has the real words made with them. In joined words a prefix may stand alone (socio-economic).
const PREFIXES = ['non', 'anti', 'post', 'sub', 'inter', 'intra', 'multi', 'semi', 'self', 'trans', 'super', 'counter', 'neo', 'socio', 'geo', 'bio', 'eco', 'agro', 'micro', 'macro'];

// Is one piece of a word (no hyphens) spelled right?
function pieceOk(p) {
  if (!p || p.length <= 1) return true;
  if (known(p)) return true;
  if (/'s$|s'$/.test(p) && known(p.slice(0, -2))) return true; // minister's, ministers'
  if (/'s$/.test(p) && known(p.slice(0, -2) + 's')) return true;
  const bare = p.normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (bare !== p && known(bare)) return true;
  for (const pre of PREFIXES) if (p.length - pre.length >= 4 && p.startsWith(pre) && known(p.slice(pre.length))) return true;
  return false;
}

// Is this word (as written, with its case) spelled right?
function isWordValid(w) {
  if (!w || w.length <= 1) return true; // lone letters (a, I, x)
  if (/\d/.test(w)) return true; // numbers, dates, 21st, 1990s, CO2, C6H12O6
  if (/[^\p{Script=Latin}'’‘`´.\-–—/]/u.test(w)) return true; // Hindi and other scripts, symbols: not checked
  if (/^[A-Z]{2,}s?$/.test(w)) return true; // acronyms: PDF, URL, UPSC, MLAs
  const lw = norm(w);
  if (known(lw)) return true;
  if (lw.includes('.')) return known(lw + '.') || lw.split('.').every(x => x.length <= 3); // e.g, i.e, U.S, Ph.D
  // well-known, Indo-Pak, either/or: every part a word
  const parts = lw.split(/[-–—/]+/).filter(Boolean);
  if (parts.length > 1) return parts.every((p, i) => pieceOk(p) || (i < parts.length - 1 && PREFIXES.includes(p)));
  return pieceOk(lw);
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
function edits1(w) {
  const out = new Set();
  for (let i = 0; i <= w.length; i++) {
    const a = w.slice(0, i), b = w.slice(i);
    if (b) out.add(a + b.slice(1)); // a letter left out
    if (b.length > 1) out.add(a + b[1] + b[0] + b.slice(2)); // two letters swapped
    for (const c of LETTERS) {
      if (b) out.add(a + c + b.slice(1)); // a wrong letter
      out.add(a + c + b); // a letter too many
    }
  }
  out.delete(w);
  return out;
}

// Spelling suggestions, best first: fewest changes, then the more common word. Asked for only when a mark is tapped.
export function suggest(rawWord, max = 5) {
  const clean = cleanOf(rawWord);
  if (!clean) return [];
  const lw = norm(clean);
  if (COMMON_TYPOS[lw]) return COMMON_TYPOS[lw].map(s => matchCase(clean, s));
  const rank = w => DICT.get(w) ?? 50; // the user's own words count as fairly common
  // Rare names (level 80) only for a word written with a capital; two changes away only fairly common words.
  const top = /^\p{Lu}/u.test(clean) ? 80 : 70;
  const pick = (set, lim) => [...set].filter(c => c.length > 1 && known(c) && rank(c) <= lim)
    .sort((a, b) => rank(a) - rank(b) || (a[0] === lw[0] ? -1 : 0) - (b[0] === lw[0] ? -1 : 0));
  const e1 = edits1(lw);
  let out = pick(e1, top);
  if (out.length < 3 && lw.length <= 10) { // two changes: only when one gives too little (short words: it is slow)
    const e2 = new Set();
    for (const a of e1) for (const b of edits1(a)) if (!e1.has(b) && b !== lw && known(b)) e2.add(b);
    out = out.concat(pick(e2, Math.min(top, 60)));
  }
  // two common words run together: "alot", "inspite"
  for (let i = 1; i < lw.length - 1; i++) {
    const a = lw.slice(0, i), b = lw.slice(i);
    if ((a.length > 1 || a === 'a' || a === 'i') && rank(a) <= 35 && known(a) && b.length > 1 && rank(b) <= 35 && known(b)) out.unshift(a + ' ' + b);
  }
  return [...new Set(out)].slice(0, max).map(s => matchCase(clean, s));
}

// The word without the punctuation around it; a closing ' stays only after s (ministers').
const cleanOf = raw => {
  const w = (raw || '').trim().replace(/[’‘`´]/g, "'").replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}']+$/u, '');
  return /s'$/.test(w) ? w : w.replace(/'+$/, '');
};

// Check word and get suggestions (the suggestions are worked out only when read)
export function checkWord(rawWord) {
  if (!loaded || !rawWord) return { misspelled: false, suggestions: [] };
  const clean = cleanOf(rawWord);
  if (!clean || clean.length < 2) return { misspelled: false, suggestions: [] };
  if (isWordValid(clean)) return { misspelled: false, suggestions: [] };
  let sugs = null;
  return { misspelled: true, clean, get suggestions() { return sugs || (sugs = suggest(clean)); } };
}

// Match original case (Capitalized or lowercase)
function matchCase(orig, target) {
  if (!orig || !target) return target;
  if (orig.length > 1 && orig === orig.toUpperCase()) return target.toUpperCase();
  if (orig[0] === orig[0].toUpperCase() && orig.slice(1) === orig.slice(1).toLowerCase()) {
    return target[0].toUpperCase() + target.slice(1).toLowerCase();
  }
  return target.toLowerCase();
}

// Scan a page's handwriting index and typed text items for spelling mistakes.
// Returns an array of error objects:
// [{ id, kind: 'ink'|'tx', word, clean, suggestions, box: {x0, y0, x1, y1, w, h}, ids, item, color }]
// (suggestions is worked out when it is first read, i.e. when the mark is tapped)
export function findSpellingErrorsOnPage(page, hwData) {
  if (!page || !page.items || !loaded) return [];
  const errors = [];
  const seenIds = new Set();
  const withSugs = (o, res) => Object.defineProperty(o, 'suggestions', { get: () => res.suggestions, enumerable: true });

  // 1. Check handwriting runs if hw data exists
  if (hwData && hwData.r && Array.isArray(hwData.r)) {
    let strokesById = null;
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
            if (!strokesById) strokesById = new Map(page.items.filter(it => it.t === 's').map(it => [it.id, it]));
            const strokes = item.ids.map(id => strokesById.get(id)).filter(Boolean);
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
                errors.push(withSugs({
                  id: markId,
                  kind: 'ink',
                  word: w,
                  clean: res.clean,
                  box: { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 },
                  ids: item.ids,
                  color: strokeColor,
                  pageId: page.id
                }, res));
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
          errors.push(withSugs({
            id: markId,
            kind: 'tx',
            word: w,
            clean: res.clean,
            box: { x0: wx0, y0: wy0, x1: wx0 + ww, y1: wy0 + fs, w: ww, h: fs },
            item: it,
            color: it.c || '#1a1a1a',
            pageId: page.id
          }, res));
        }
      }
    }
  }

  return errors;
}
