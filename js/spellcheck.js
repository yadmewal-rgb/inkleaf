// Handwriting and text spell checker.
// Highlights misspelled words with a temporary red dotted underline (like GoodNotes),
// and offers one-tap spelling corrections, ignore, and custom dictionary.
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

// Built-in English word vocabulary (frequent words + academic + everyday language)
const VOCAB_RAW = `
a about above accept according account across act action activity actually add address administration admit adult affect
after again against age agency agent ago agree agreement ahead air all allow almost alone along already also although
always american among amount analysis and animal another answer any anyone anything anyway anywhere apply approach
area argue argument arm around arrive art article artist as ask assume at attack attention attorney audience author
authority available avoid away baby back bad bag balance ball bank bar base be beat beautiful because become bed
before begin beginning behavior behind believe benefit best better between beyond big bill billion bit black blood
blue board body book born both box boy break bring brother build building business but buy by call camera campaign
can cancer candidate capital car card care career carry case catch cause cell center central century certain certainly
chair challenge chance change character charge check choice choose church circumstance cite citizen city civil claim
class clear clearly close coach cold collection college color come commercial common community company compare comparison
computer concern condition conference congress consider consumer contain continue control cost could country couple
course court cover create creation credit crime cultural culture cup current customer cut dark data daughter day
dead deal death debate decade decide decision declare deep defense degree democrat democratic describe design despite
detail determine develop development die difference different difficult dinner direction director discover discuss
discussion disease do doctor document dog door down draw dream drive drop drug during each early east easy eat
economic economy edge education effect effort eight either election electric electrical electricity element else employee
empty end energy enjoy enough enter enterprise entire environment environmental equal especially establish estate
even evening event ever every everybody everyone everything evidence exactly example executive exist expect experience
expert explain eye face fact factor fail family far fast father fear feature federal fee feel feeling few field
fight figure fill film final finally financial find fine finger finish fire firm first fish five floor focus follow
food foot for force foreign forget form former forward found four frame free freedom friend front full function fund
future game garden general generate girl give glass go goal good government great green ground group grow growth guess
guy hair half hand hang happen happy hard have he head health hear heart heat heavy help her here herself high him
himself history hit hold home hope hospital hot hotel hour house how however huge human hundred husband i idea identify
if image imagine impact important improve in include including income increase indeed independent industry indicate
individual information inside instead institution interest interesting international internet interview into introduce
investment involve issue it item its itself job join joy judge jump keep key kid kill kind know knowledge land
large last late laugh law legal lead leader leaf learn least leave left leg lesson let level lie life lift light like
likely line list listen look lose love low main maintain major make man manage manager manual many market match
matter may maybe mean manage matter measure medical meet member memory mental mention message method middle might
million mind minute modern moment money month more morning most move movement movie mr mrs much music must my myself
name national natural nature near nearly necessary need neighbor network never new news newspaper next night nine no
nobody north not note notice notion now number occur of off offer officer often oil ok old on once one only onto open
operation opinion opportunity or order organization other others our out outside over own owner page pain paper parent
part partner party pass past patient pattern pay peace people perform period place plan play player point police
political poll politics poor popular population position positive power practical predict prepare president pressure
price principle priority process produce product program project promise protect provide public purpose put quality
question quickly quite race radio raise range rate rather reach read ready real realize reason receive recent recently
recognize record reduce reflect region relate relationship religious report represent request require research resource
respond response rest result return reveal rich right ring rise risk road role rock room rule run running rush save
say science scientist screen sea search season seat second section security see seek seem select self sell senate
send senior sense series serious serve service set settlement several share she shift short should shoulder show
side sight sign signal significant simple simply since single sister sit site situation six size skill skin small
so social society soft software soldier some somebody someone something sometimes standard star start state station
stay statement stock stop step straight street strategy structure student study success successful such sudden
suggest suggest summer support sure surface survive symbol system table talk target task teacher technology tell
term text text than thank that the their them then there these they thing think third this those though thought
thousand threat three through throw time today together tonight tomorrow too total touch tough toward towel town
trade tradition training transit treat treatment tree true truth turn twenty two type under understand union until
up upon us use used useful user valid value variable variety various very victim view visit visual voice vote wait
walk wall want war watch water way we weapon wear week weigh weight well west western what whatever when where
whether which while white whole whose why wide win wind window wish with within without woman wonder word work
worker world worry worth would wrap write writer written writing wrong yard year yes yet you young your yours
yourself zone zero
`;

const DICT = new Set(
  VOCAB_RAW.trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w.toLowerCase())
);

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
  if (/^\d+$/.test(w) || /^[\d.,%$#@!+-]+$/.test(w)) return true; // numbers, formulas
  if (/^[A-Z0-9_]+$/.test(w)) return true; // ALL_CAPS acronyms or codes (PDF, URL, API)

  const lw = w.toLowerCase();
  if (DICT.has(lw) || userDict.has(lw) || sessionIgnored.has(lw)) return true;

  // Suffix checks (simple stemming)
  if (lw.endsWith('s') && (DICT.has(lw.slice(0, -1)) || userDict.has(lw.slice(0, -1)))) return true;
  if (lw.endsWith('es') && (DICT.has(lw.slice(0, -2)) || userDict.has(lw.slice(0, -2)))) return true;
  if (lw.endsWith('ed') && (DICT.has(lw.slice(0, -2)) || DICT.has(lw.slice(0, -1)) || userDict.has(lw.slice(0, -2)))) return true;
  if (lw.endsWith('ing') && (DICT.has(lw.slice(0, -3)) || DICT.has(lw.slice(0, -3) + 'e') || userDict.has(lw.slice(0, -3)))) return true;
  if (lw.endsWith('ly') && (DICT.has(lw.slice(0, -2)) || userDict.has(lw.slice(0, -2)))) return true;

  // Prefix checks
  if (lw.startsWith('un') && (DICT.has(lw.slice(2)) || userDict.has(lw.slice(2)))) return true;
  if (lw.startsWith('re') && (DICT.has(lw.slice(2)) || userDict.has(lw.slice(2)))) return true;

  return false;
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

  // 2. Levenshtein search over vocabulary
  const candidates = [];
  for (const v of DICT) {
    if (Math.abs(v.length - lw.length) > 2) continue;
    const d = lev(lw, v, 2);
    if (d <= 2) candidates.push({ word: v, d });
    if (candidates.length > 25) break;
  }
  for (const u of userDict) {
    if (Math.abs(u.length - lw.length) > 2) continue;
    const d = lev(lw, u, 2);
    if (d <= 2) candidates.push({ word: u, d });
  }

  candidates.sort((a, b) => a.d - b.d);
  const sugs = candidates.slice(0, 3).map(c => matchCase(clean, c.word));

  return {
    misspelled: true,
    clean,
    suggestions: sugs.length ? sugs : ['the', 'their']
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
      // If run has word breakdown
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
              const p = s.p, r = (s.w || 1) / 2;
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
      } else {
        // Run has full text string: split by space and map across run bounding box
        const words = run.t.split(/\s+/).filter(Boolean);
        const strokes = (page.items || []).filter(it => it.t === 's' && run.ids.includes(it.id));
        if (strokes.length && words.length) {
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
          const totalW = Math.max(1, x1 - x0);
          const stepW = totalW / words.length;
          words.forEach((w, idx) => {
            const res = checkWord(w);
            if (res.misspelled) {
              const wx0 = x0 + idx * stepW;
              const wx1 = wx0 + stepW;
              const markId = `sp-ink-${run.ids[0] || 'r'}-${idx}`;
              if (!seenIds.has(markId)) {
                seenIds.add(markId);
                errors.push({
                  id: markId,
                  kind: 'ink',
                  word: w,
                  clean: res.clean,
                  suggestions: res.suggestions,
                  box: { x0: wx0, y0, x1: wx1, y1, w: wx1 - wx0, h: y1 - y0 },
                  ids: run.ids,
                  color: strokeColor,
                  pageId: page.id
                });
              }
            }
          });
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
