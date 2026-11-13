// In-game stills in one command, from a headless Chrome that stays up between calls (no browser pane, no page reloads).
//
//   node tools/shots/shoot.mjs --module work/gfx/cabin-shots.js --ids front,inside --tag cab20
//   node tools/shots/shoot.mjs ... --reload          reload the game first (after rebuilding a GLB; code edits reload by themselves)
//   node tools/shots/shoot.mjs --eval 'expression'   print what an expression gives in the game tab
//   node tools/shots/shoot.mjs --stop                shut the headless Chrome down
//
// Needs the dev server (npm run dev, :5173) and Google Chrome. Chrome runs headless with its own empty profile in work/.chrome-shots,
// listening on 127.0.0.1:9333 for this script only; the game tab stays loaded (its frame loop parked between calls, so it costs
// next to nothing idle), so a second call goes straight to the poses.
// `--module` is a file (repository-relative) exporting `prepare(id)`: it poses the game for that still and resolves when it is
// settled. The screenshot is the composited page (HUD and menus included), written to work/gfx/shots/<tag>-<id>.png.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
// SHOTS_PORT runs a second, separate headless Chrome (its own profile and tab), so two jobs can take stills without sharing a tab.
const PORT = Number(process.env.SHOTS_PORT ?? 9333), OUT = path.join(ROOT, 'work/gfx/shots');
const PROFILE = path.join(ROOT, PORT === 9333 ? 'work/.chrome-shots' : `work/.chrome-shots-${PORT}`);
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const flag = name => process.argv.includes(`--${name}`);
const url = arg('url', 'http://localhost:5173/'), [width, height] = arg('size', '1280x800').split('x').map(Number);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function endpoint() { try { return await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { return undefined; } }

if (flag('stop')) {
  const v = await endpoint();
  if (v) { const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r)); ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })); await sleep(300); }
  console.log(v ? 'stopped' : 'not running'); process.exit(0);
}

// Start Chrome once, detached, so it outlives this call.
if (!await endpoint()) {
  fs.mkdirSync(PROFILE, { recursive: true });
  spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${PROFILE}`,
    `--window-size=${width},${height}`, '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--mute-audio',
    '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'],
  { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 100 && !await endpoint(); i++) await sleep(100);
}

// The game tab: reuse it if it is open.
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
let page = targets.find(t => t.type === 'page' && t.url.startsWith(url)) ?? targets.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
let next = 0; const waiting = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
// A tab that crashed or a target that went away answers with an error, not a result: say so instead of failing further on.
// Every call is capped (a screenshot waits for a frame, and a stalled GPU process never gives one): fail loudly, never hang.
const send = (method, params = {}, limit = 180000) => new Promise((resolve, reject) => {
  const id = ++next, timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${method}: no answer in ${limit / 1000} s (try --stop, then run again)`)); }, limit);
  waiting.set(id, m => { clearTimeout(timer); if (m.error) reject(new Error(`${method}: ${m.error.message} (try --stop, then run again)`)); else resolve(m); });
  ws.send(JSON.stringify({ id, method, params }));
});
// Runtime.evaluate's own timeout covers only the synchronous part: an awaited promise that never settles (a page reloaded or
// hung mid-pose) would hang the call for good, so the wait is capped here too.
const evaluate = async (expression, timeout = 120000) => {
  let timer;
  const r = await Promise.race([send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${timeout / 1000} s`)), timeout + 5000); })]).finally(() => clearTimeout(timer));
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
  return r.result?.result?.value;
};

// Between calls the game's frame loop is parked (its requestAnimationFrame callback held, not run), so a game left loaded costs
// the machine next to nothing. Freezing the tab instead (Page.setWebLifecycleState) cut Vite's live-reload socket: on waking,
// Vite reloaded the page, and the reloaded game drew black at 1/10 the speed. Wake it first.
const PARK = `(() => { window.__shotRaf ??= window.requestAnimationFrame; window.requestAnimationFrame = cb => { window.__shotParked = cb; return 0; }; return true; })()`;
const WAKE = `(() => { const raf = window.__shotRaf; if (raf) { window.requestAnimationFrame = raf; const cb = window.__shotParked; window.__shotParked = undefined; if (cb) raf.call(window, cb); } return true; })()`;
await send('Page.enable');
await send('Page.setWebLifecycleState', { state: 'active' });
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
const here = await evaluate('location.href').catch(() => '');
if (here.startsWith(url)) await evaluate(WAKE).catch(() => {});
if (!here.startsWith(url) || flag('reload')) {
  await send('Page.navigate', { url });
  await sleep(1500);
}
// Ready: the game exposes its dev hooks and has streamed what is around the player.
const t0 = Date.now();
while (!await evaluate('!!(window.__SILENCE__ && window.__WORLD__)').catch(() => false)) {
  if (Date.now() - t0 > 90000) throw new Error('the game did not come up (is npm run dev running?)');
  await sleep(250);
}

// `--eval <expression>` prints what an expression gives in the game tab (awaited, as JSON), for a quick look without a still.
if (arg('eval')) { console.log(JSON.stringify(await evaluate(arg('eval')), null, 1)); await evaluate(PARK).catch(() => {}); ws.close(); process.exit(0); }
const module = arg('module'), ids = (arg('ids', '') || '').split(',').filter(Boolean), tag = arg('tag', 'shot');
const done = async () => { await evaluate(PARK).catch(() => {}); ws.close(); };
if (!module || !ids.length) { console.log('ready; nothing asked (pass --module and --ids)'); await done(); process.exit(0); }
const spec = `/@fs${path.resolve(ROOT, module)}?t=${Date.now()}`;
fs.mkdirSync(OUT, { recursive: true });
const ready = async () => { const t = Date.now(); while (!await evaluate('!!(window.__SILENCE__ && window.__WORLD__)').catch(() => false)) { if (Date.now() - t > 90000) throw new Error('the game did not come back'); await sleep(250); } };
for (const id of ids) {
  const started = Date.now();
  const prepare = () => evaluate(`(async () => { const M = await import(${JSON.stringify(spec)}); await M.prepare(${JSON.stringify(id)}); return true; })()`);
  // An edit to a game or shot file makes Vite reload the page under us: wait for it to come back and pose again, once.
  try { await prepare(); } catch (error) { console.log(`retrying ${id} (${String(error.message).split('\n')[0]})`); await sleep(1500); await ready(); await prepare(); }
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(OUT, `${tag}-${id}.png`);
  fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
  console.log(`${path.relative(ROOT, file)}  ${((Date.now() - started) / 1000).toFixed(1)} s`);
}
await done();
