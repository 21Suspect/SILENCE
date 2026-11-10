// A top-down map of the generated world: relief, water, road, trails and every placed thing.
//   node --experimental-strip-types --no-warnings scripts/playtest/map.mjs [out.png]      (WORLD_SEED=n for another world)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const root = process.cwd();
await import(root + '/tests/helpers/register-ts-hooks.mjs');
globalThis.location = { search: '?world-v2' + (process.env.WORLD_SEED ? '&seed=' + process.env.WORLD_SEED : '') };
const W = await import(root + '/game/world.ts');
const L = await import(root + '/game/world-layout.ts');
const N = await import(root + '/game/world-noise.ts');
const out = path.resolve(process.argv[2] ?? 'work/map/layout.png');
const R = 520, PX = 1800, S = PX / (2 * R), CELL = 5;
const X = x => (x + R) * S, Y = z => (R - z) * S;      // north (+z) is up
let cells = '';
const shade = (h, slope, water) => {
  if (water) return '#3f6f86';
  const t = Math.max(0, Math.min(1, (h - 1) / 44)), l = 34 + t * 46 - Math.min(18, slope * 26);
  return `hsl(${105 - t * 70} ${28 - t * 18}% ${l}%)`;
};
for (let x = -R; x < R; x += CELL) for (let z = -R; z < R; z += CELL) {
  const cx = x + CELL / 2, cz = z + CELL / 2, h = W.heightAt(cx, cz);
  const slope = Math.hypot(W.heightAt(cx + 3, cz) - W.heightAt(cx - 3, cz), W.heightAt(cx, cz + 3) - W.heightAt(cx, cz - 3)) / 6;
  const water = N.channelOffset(cx, cz) < 3.2 && Math.abs(cz) < 470;
  cells += `<rect x="${X(x).toFixed(1)}" y="${Y(z + CELL).toFixed(1)}" width="${(CELL * S + .4).toFixed(1)}" height="${(CELL * S + .4).toFixed(1)}" fill="${shade(h, slope, water)}"/>`;
}
const line = (pts, stroke, width, dash = '') => `<polyline points="${pts.map(p => X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1)).join(' ')}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round" ${dash ? `stroke-dasharray="${dash}"` : ''}/>`;
const road = []; for (let x = L.ROAD_ENDS[1].x; x <= L.ROAD_ENDS[0].x; x += 3) road.push([x, W.roadZ(x)]);
const trail = []; for (let z = -446; z <= 446; z += 3) if (Math.hypot(W.pathX(z), z) < 446) trail.push([W.pathX(z), z]);
let svg = cells + line(road, '#1d1d1f', 7) + line(road, '#d8d2b6', 1, '8 10') + line(trail, '#c9a25e', 3.2);
for (const t of L.TRAIL_LINES) svg += line(t, '#e8c98a', 2.2, '7 4');
const NAMES = { cabin: 'Cabin', 'trailhead-board': 'Notice board', 'relay-mast': 'Relay station', lookout: 'Fire lookout', 'logging-camp': 'Logging yard', 'hunter-camp': 'Hunters’ camp', chapel: 'Chapel', mine: 'Mine', hide: 'High seat', well: 'Well', ruin: 'Burned homestead', pumphouse: 'Pump house', shrine: 'Shrine', graves: 'Grave plot', watertower: 'Water tower', fold: 'Stone fold', 'tunnel-east': 'East tunnel', 'tunnel-west': 'West tunnel', busstop: 'Bus stop', 'road-bridge': 'Road bridge' };
const NEW = new Set(['hide', 'well', 'ruin', 'pumphouse', 'shrine', 'graves', 'watertower', 'fold', 'tunnel-east', 'tunnel-west', 'busstop']);
const dotOf = { effigy: '#b0402c', streetlight: '#ffb14a', deerstand: '#6b4a2a', cairn: '#8c8c84', wall: '#55554f', wall_gap: '#55554f', pole: '#2a2a2a', trailmarker: '#e8e2c8', roadsign: '#d9b21c', outhouse: '#3a2f25', bench: '#7a5a34' };
for (const s of L.SCATTER_PLACEMENTS) { const c = dotOf[s.asset]; if (c) svg += `<circle cx="${X(s.x).toFixed(1)}" cy="${Y(s.z).toFixed(1)}" r="${s.asset === 'streetlight' ? 4.5 : s.asset === 'effigy' ? 4 : 2.6}" fill="${c}" stroke="#111" stroke-width=".6"/>`; else if (s.asset.startsWith('rock_')) svg += `<circle cx="${X(s.x).toFixed(1)}" cy="${Y(s.z).toFixed(1)}" r="2.2" fill="#9a9a94" opacity=".8"/>`; }
for (const p of L.POI_PLACEMENTS) {
  const name = NAMES[p.id]; if (!name) continue;
  const fresh = NEW.has(p.id), x = X(p.x), y = Y(p.z);
  svg += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9" fill="${fresh ? '#e4572e' : '#f4f1e6'}" stroke="#111" stroke-width="2"/>`
    + `<text x="${(x + 13).toFixed(1)}" y="${(y + 5).toFixed(1)}" font-size="19" font-weight="700" fill="#111" stroke="#f4f1e6" stroke-width="4" paint-order="stroke">${name}</text>`;
}
svg += `<circle cx="${X(L.SPAWN.x)}" cy="${Y(L.SPAWN.z)}" r="7" fill="#2a7de1" stroke="#fff" stroke-width="2"/><text x="${X(L.SPAWN.x) + 12}" y="${Y(L.SPAWN.z) + 5}" font-size="17" font-weight="700" fill="#0b3d7a" stroke="#fff" stroke-width="4" paint-order="stroke">Start</text>`;
svg += `<g transform="translate(24 ${PX - 302})" font-size="17" fill="#111"><rect width="330" height="278" rx="8" fill="#f4f1e6" opacity=".92"/>`
  + [['#e4572e', 'New place (this pass)'], ['#f4f1e6', 'Existing place'], ['#b0402c', 'Effigy'], ['#ffb14a', 'Street lamp'], ['#7a5a34', 'Bench'], ['#55554f', 'Stone wall']].map(([c, t], i) => `<circle cx="22" cy="${26 + i * 26}" r="8" fill="${c}" stroke="#111" stroke-width="1.5"/><text x="40" y="${32 + i * 26}">${t}</text>`).join('')
  + `<line x1="12" y1="186" x2="34" y2="186" stroke="#1d1d1f" stroke-width="7"/><text x="40" y="192">Road</text><line x1="12" y1="212" x2="34" y2="212" stroke="#c9a25e" stroke-width="4"/><text x="40" y="218">Main trail</text><line x1="12" y1="238" x2="34" y2="238" stroke="#e8c98a" stroke-width="3" stroke-dasharray="7 4"/><text x="40" y="244">Footpath</text>`
  + `<line x1="12" y1="264" x2="${12 + 100 * S}" y2="264" stroke="#111" stroke-width="3"/><text x="${22 + 100 * S}" y="270">100 m</text></g>`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'silence-map-')), html = path.join(tmp, 'map.html');
fs.writeFileSync(html, `<!doctype html><meta charset=utf-8><style>*{margin:0}html,body{width:${PX}px;height:${PX}px;overflow:hidden;font-family:Helvetica,Arial,sans-serif}</style><svg width="${PX}" height="${PX}" xmlns="http://www.w3.org/2000/svg">${svg}</svg>`);
fs.mkdirSync(path.dirname(out), { recursive: true });
execFileSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--no-first-run', '--disable-gpu', `--user-data-dir=${tmp}/p`, `--window-size=${PX},${PX}`, '--hide-scrollbars', `--screenshot=${out}`, 'file://' + html], { stdio: 'ignore' });
fs.rmSync(tmp, { recursive: true, force: true });
console.log('wrote', out);
