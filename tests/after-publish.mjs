// After a push: did GitHub Pages and Cloudflare really take the new version? Exits with an error if not.
import fs from 'fs';
import { execFileSync } from 'child_process';
const root = new URL('..', import.meta.url);
const git = (...a) => execFileSync('C:/Program Files/Git/cmd/git.exe', a, { cwd: root }).toString().trim();
const sha = git('rev-parse', 'origin/main');
const want = /const CACHE = '([^']+)'/.exec(git('show', 'origin/main:sw.js'))[1];
if (git('rev-parse', 'HEAD') !== sha) console.log('Note: this PC has commits that are not pushed; checking the pushed version.');
let site = '', build = '', said = '';
for (let i = 0; i < 40; i++) {
  try { site = (/const CACHE = '([^']+)'/.exec(await (await fetch('https://yadmewal-rgb.github.io/inkleaf/sw.js?t=' + Date.now())).text()) || [])[1] || ''; } catch { site = 'unreachable'; }
  try {
    const j = await (await fetch(`https://api.github.com/repos/yadmewal-rgb/inkleaf/commits/${sha}/check-runs`)).json();
    const c = (j.check_runs || []).find(x => /inkleaf-sync/.test(x.name));
    build = c ? c.conclusion || c.status : j.message ? 'unknown: ' + j.message.slice(0, 60) : 'not started';
  } catch { build = 'unreachable'; }
  const now = `website ${site} (want ${want}), Cloudflare build: ${build}`;
  if (now !== said) console.log(said = now);
  if (build === 'failure' || build === 'cancelled') break;
  if (site === want && build === 'success') break;
  await new Promise(r => setTimeout(r, 15000));
}
let alive = false;
try { alive = (await (await fetch('https://inkleaf-sync.yadmewal.workers.dev/')).json()).ok === true; } catch { /* down */ }
const good = site === want && build === 'success' && alive;
console.log(`Sync server answers: ${alive ? 'yes' : 'NO'}`);
console.log(good ? 'ALL GOOD: the new version is live everywhere.' : 'PROBLEM: not everything took the new version. Do not call this release done.');
process.exit(good ? 0 : 1);
