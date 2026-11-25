// Drives a visible Chrome window over its debugging port. Nothing here touches the owner's own Chrome profile.
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const sleep = ms => new Promise(r => setTimeout(r, ms));
const EXE = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(p => fs.existsSync(p));

export async function chrome() {
  if (!EXE) throw new Error('Google Chrome was not found on this computer');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkleaf-check-'));
  const cp = spawn(EXE, ['--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check',
    '--window-size=1260,900', '--window-position=40,20', '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', 'about:blank']);
  let port = 0;
  for (let i = 0; i < 60 && !port; i++) { await sleep(250); try { port = Number(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { /* not yet */ } }
  if (!port) throw new Error('Chrome did not start');
  const tab = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page');
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const wait = new Map(), errors = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && wait.has(m.id)) { const [a, b] = wait.get(m.id); wait.delete(m.id); if (m.error) b(new Error(JSON.stringify(m.error))); else a(m.result); }
    if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails; errors.push((d.exception?.description || d.text).split('\n').slice(0, 2).join(' | ')); }
  };
  const send = (method, params = {}) => new Promise((a, b) => { const i = ++id; wait.set(i, [a, b]); ws.send(JSON.stringify({ id: i, method, params })); });
  for (const d of ['Page', 'Runtime', 'Network']) await send(d + '.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }); // keep drawing frames when another window is in front
  const ev = async x => {
    const r = await send('Runtime.evaluate', { expression: `(async()=>{${x}})()`, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return {
    send, ev, errors,
    size: (w, h, dpr = 1.5, touch = false) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile: touch }),
    dark: on => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: on ? 'dark' : 'light' }] }),
    go: async (u, ms = 1800) => { await send('Page.navigate', { url: u }); await sleep(ms); },
    shot: async n => {
      const d = 'C:/Users/Yadram/AgentTools/shots';
      if (!fs.existsSync(d)) return;
      fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    },
    close: async () => { try { await send('Browser.close'); } catch { /* gone */ } await sleep(800); cp.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* still in use */ } }
  };
}
