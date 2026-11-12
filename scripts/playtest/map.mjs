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
const C = await import(root + '/game/coastal-geography.ts');
const out = path.resolve(process.argv[2] ?? 'work/map/layout.png');
const R = 800, PX = 2400, S = PX / (2 * R), CELL = 3;
const X = x => (x + R) * S, Y = z => (R - z) * S;      // north (+z) is up
let cells = '';
const shade = (x,z,h,dx,dz,water) => {
  if (water!==undefined && h<water+.04) {
    const depth=Math.max(0,water-h), coast=C.coastDistance(x,z)<0;
    return coast ? `hsl(204 39% ${Math.max(19,35-depth*.9)}%)` : `hsl(196 32% ${Math.max(25,42-depth*1.1)}%)`;
  }
  const lit=Math.max(.48,Math.min(1.3,1+(dx-dz)*.22));
  const coastal=C.coastDistance(x,z), lakeside=C.lakeDistance(x,z);
  let rgb=coastal<C.beachWidth(x,z)?[174,159,116]:lakeside<7?[115,126,94]:h>55?[105,108,104]:[69,95,65];
  const snow=C.snowCoverage(x,z,h,Math.hypot(dx,dz));
  rgb=rgb.map((v,i)=>(v*(1-snow)+[231,237,239][i]*snow)*lit);
  return `rgb(${rgb.map(v=>Math.min(255,Math.round(v))).join(',')})`;
};
for (let x = -R; x < R; x += CELL) for (let z = -R; z < R; z += CELL) {
  const cx=x+CELL/2,cz=z+CELL/2,h=W.heightAt(cx,cz);
  const dx=(W.heightAt(cx+3,cz)-W.heightAt(cx-3,cz))/6,dz=(W.heightAt(cx,cz+3)-W.heightAt(cx,cz-3))/6;
  const water=W.riverSurfaceAt(cx,cz);
  cells += `<rect x="${X(x).toFixed(1)}" y="${Y(z+CELL).toFixed(1)}" width="${(CELL*S+.4).toFixed(1)}" height="${(CELL*S+.4).toFixed(1)}" fill="${shade(cx,cz,h,dx,dz,water)}"/>`;
}
const line = (pts, stroke, width, dash = '') => `<polyline points="${pts.map(p => X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1)).join(' ')}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round" ${dash ? `stroke-dasharray="${dash}"` : ''}/>`;
const road = []; for (let x = L.ROAD_ENDS[1].x; x <= L.ROAD_ENDS[0].x; x += 3) road.push([x, W.roadZ(x)]);
const trails = []; let trail = [];
for (let z = L.MAIN_TRAIL_BOUNDS.south; z <= L.MAIN_TRAIL_BOUNDS.north; z += 3) {
  if (W.trailPresence(W.pathX(z),z)>.2 && C.coastDistance(W.pathX(z),z)>2 && C.lakeDistance(W.pathX(z),z)>2) trail.push([W.pathX(z), z]);
  else if (trail.length) { trails.push(trail); trail=[]; }
}
if (trail.length) trails.push(trail);
let svg = `<g shape-rendering="crispEdges">${cells}</g>` + line(road, '#1d1d1f', 7) + line(road, '#d8d2b6', 1, '8 10') + trails.map(t=>line(t, '#c9a25e', 3.2)).join('');
const KIND_COLOUR = { loop: '#ff7a3d', spur: '#e8c98a', onward: '#e8c98a', link: '#e8c98a', cross: '#f2dfae' };
L.TRAIL_LINES.forEach((t, i) => { const kind = L.TRAIL_META?.[i]?.kind ?? 'spur'; svg += kind === 'loop' ? line(t, '#ff7a3d', 3.4) : line(t, KIND_COLOUR[kind], 2.2, '7 4'); });
for (const f of L.FORDS ?? []) svg += `<circle cx="${X(f.x).toFixed(1)}" cy="${Y(f.z).toFixed(1)}" r="7" fill="#7fd0e8" stroke="#0b3d52" stroke-width="2.4"/><circle cx="${X(f.x).toFixed(1)}" cy="${Y(f.z).toFixed(1)}" r="2.4" fill="#0b3d52"/>`;
for (const j of L.JUNCTIONS ?? []) svg += `<rect x="${(X(j.x) - 3.2).toFixed(1)}" y="${(Y(j.z) - 3.2).toFixed(1)}" width="6.4" height="6.4" fill="#f4f1e6" stroke="#111" stroke-width="1" transform="rotate(45 ${X(j.x).toFixed(1)} ${Y(j.z).toFixed(1)})"/>`;
const NAMES = { cabin: 'Cabin', 'trailhead-board': 'Notice board', 'relay-mast': 'Relay station', lookout: 'Fire lookout', 'logging-camp': 'Logging yard', 'hunter-camp': 'Hunters’ camp', chapel: 'Chapel', mine: 'Mine', hide: 'High seat', well: 'Well', ruin: 'Burned homestead', pumphouse: 'Pump house', shrine: 'Shrine', graves: 'Grave plot', watertower: 'Water tower', fold: 'Stone fold', 'tunnel-east': 'East tunnel', 'tunnel-west': 'West tunnel', busstop: 'Bus stop', 'road-bridge': 'Road bridge' };
const dotOf = { effigy: '#b0402c', streetlight: '#ffb14a', deerstand: '#6b4a2a', cairn: '#8c8c84', wall: '#55554f', wall_gap: '#55554f', pole: '#2a2a2a', trailmarker: '#e8e2c8', roadsign: '#d9b21c', outhouse: '#3a2f25', bench: '#7a5a34' };
for (const s of L.SCATTER_PLACEMENTS) { const c = dotOf[s.asset]; if (c) svg += `<circle cx="${X(s.x).toFixed(1)}" cy="${Y(s.z).toFixed(1)}" r="${s.asset === 'streetlight' ? 4.5 : s.asset === 'effigy' ? 4 : 2.6}" fill="${c}" stroke="#111" stroke-width=".6"/>`; else if (s.asset.startsWith('rock_')) svg += `<circle cx="${X(s.x).toFixed(1)}" cy="${Y(s.z).toFixed(1)}" r="2.2" fill="#9a9a94" opacity=".8"/>`; }
for (const p of L.POI_PLACEMENTS) {
  const name = NAMES[p.id]; if (!name) continue;
  const x = X(p.x), y = Y(p.z), left=x>PX-270, labelX=x+(left?-14:14), anchor=left?'end':'start';
  svg += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9" fill="#f4f1e6" stroke="#111" stroke-width="2"/>`
    + `<text x="${labelX.toFixed(1)}" text-anchor="${anchor}" y="${(y + 5).toFixed(1)}" font-size="19" font-weight="700" fill="#111" stroke="#f4f1e6" stroke-width="4" paint-order="stroke">${name}</text>`;
}
svg += `<circle cx="${X(L.SPAWN.x)}" cy="${Y(L.SPAWN.z)}" r="7" fill="#2a7de1" stroke="#fff" stroke-width="2"/><text x="${X(L.SPAWN.x) + 12}" y="${Y(L.SPAWN.z) + 5}" font-size="17" font-weight="700" fill="#0b3d7a" stroke="#fff" stroke-width="4" paint-order="stroke">Start</text>`;
svg += `<g transform="translate(24 ${PX - 372})" font-size="17" fill="#111"><rect width="330" height="350" rx="8" fill="#f4f1e6" opacity=".92"/>`
  + [['#3f6f86', 'Lake / river / sea'], ['#f4f1e6', 'Landmark'], ['#b0402c', 'Effigy'], ['#ffb14a', 'Street lamp'], ['#7a5a34', 'Bench'], ['#55554f', 'Stone wall']].map(([c, t], i) => `<circle cx="22" cy="${26 + i * 26}" r="8" fill="${c}" stroke="#111" stroke-width="1.5"/><text x="40" y="${32 + i * 26}">${t}</text>`).join('')
  + `<line x1="12" y1="186" x2="34" y2="186" stroke="#1d1d1f" stroke-width="7"/><text x="40" y="192">Road</text><line x1="12" y1="212" x2="34" y2="212" stroke="#c9a25e" stroke-width="4"/><text x="40" y="218">Main trail</text><line x1="12" y1="238" x2="34" y2="238" stroke="#e8c98a" stroke-width="3" stroke-dasharray="7 4"/><text x="40" y="244">Footpath</text>`
  + `<line x1="12" y1="264" x2="34" y2="264" stroke="#ff7a3d" stroke-width="4"/><text x="40" y="270">Hiking loop</text><circle cx="23" cy="290" r="6" fill="#7fd0e8" stroke="#0b3d52" stroke-width="2"/><text x="40" y="296">Ford</text><rect x="19.5" y="309.5" width="7" height="7" fill="#f4f1e6" stroke="#111" transform="rotate(45 23 313)"/><text x="40" y="320">Junction</text>`
  + `<line x1="12" y1="340" x2="${12 + 100 * S}" y2="340" stroke="#111" stroke-width="3"/><text x="${22 + 100 * S}" y="346">100 m</text></g>`;
svg += `<g fill="#f5f2e9" font-family="Helvetica,Arial,sans-serif"><text x="38" y="60" font-size="36" font-weight="700" letter-spacing="9">SILENCE</text><text x="40" y="90" font-size="16" letter-spacing="3">COASTAL FOREST · CURRENT WORLD</text><text x="${PX-55}" y="62" text-anchor="middle" font-size="25">N</text><path d="M${PX-55} 78 l-9 28 9-8 9 8z" fill="#f5f2e9"/><text x="${X(150)}" y="${Y(-550)}" text-anchor="middle" font-size="24" font-style="italic" letter-spacing="6">OPEN SEA</text></g>`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'silence-map-')), html = path.join(tmp, 'map.html');
fs.writeFileSync(html, `<!doctype html><meta charset=utf-8><style>*{margin:0}html,body{width:${PX}px;height:${PX}px;overflow:hidden;font-family:Helvetica,Arial,sans-serif}</style><svg width="${PX}" height="${PX}" xmlns="http://www.w3.org/2000/svg">${svg}</svg>`);
fs.mkdirSync(path.dirname(out), { recursive: true });
execFileSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--no-first-run', '--disable-gpu', `--user-data-dir=${tmp}/p`, `--window-size=${PX},${PX}`, '--hide-scrollbars', `--screenshot=${out}`, 'file://' + html], { stdio: 'ignore' });
fs.rmSync(tmp, { recursive: true, force: true });
console.log('wrote', out);
