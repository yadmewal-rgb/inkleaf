// Builds en.txt, Inkleaf's spell-check word list, from SCOWL 2020.12.07 (http://wordlist.aspell.net/, licence in
// SCOWL-Copyright.txt) plus extra-india.txt and extra-law.txt (level 50).
// Usage: download and unpack scowl-2020.12.07.tar.gz, then: node vendor/words/build.cjs <path to scowl's final folder>
// Kept: English, American, British (-ise and -ize), Canadian and Australian spellings and their accepted variants,
// up to level 70 for words, contractions and abbreviations, and up to 80 for names (rarer words would hide mistakes).
// en.txt: one line per commonness level ("10" = the most common ... "80"), a tab, then its words, lowercase.
const fs = require('fs'), path = require('path');
const dir = process.argv[2], here = __dirname;
const NAME = /^(english|american|british|british_z|canadian|australian|variant_1|british_variant_1|special-roman-numerals)(-(words|upper|proper-names|contractions|abbreviations))?\.(\d+)$/;
const level = new Map();
const add = (w, lv) => {
  w = w.trim().toLowerCase().replace(/’/g, "'");
  if (!w || w.length > 40 || /\s/.test(w)) return;
  for (const f of [w, w.normalize('NFD').replace(/[\u0300-\u036f]/g, '')]) if (!level.has(f) || level.get(f) > lv) level.set(f, lv); // café also as cafe
};
for (const name of fs.readdirSync(dir)) {
  const m = NAME.exec(name);
  if (!m) continue;
  const lv = Number(m[4]), kind = m[3] || '';
  if (lv > 80 || (lv > 70 && kind !== 'upper' && kind !== 'proper-names')) continue;
  for (const w of fs.readFileSync(path.join(dir, name)).toString('latin1').split(/\r?\n/)) add(w, lv);
}
for (const f of ['extra-india.txt', 'extra-law.txt']) for (const w of fs.readFileSync(path.join(here, f), 'utf8').split(/\s+/)) add(w, 50);
const byLevel = new Map();
for (const [w, lv] of level) { if (!byLevel.has(lv)) byLevel.set(lv, []); byLevel.get(lv).push(w); }
const out = [...byLevel.keys()].sort((a, b) => a - b).map(lv => lv + '\t' + byLevel.get(lv).sort().join(' ')).join('\n') + '\n';
fs.writeFileSync(path.join(here, 'en.txt'), out);
console.log(level.size, 'words,', out.length, 'bytes');
