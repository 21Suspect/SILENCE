// Top-down maps of generated worlds. node --experimental-strip-types tools/world-map.mjs <outDir> <seed> [seed ...]
// Each seed runs in its own process because every module computes its world once at load.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '..');
if (process.argv[2] === '--child') {
  const seed = process.argv[3], out = process.argv[4];
  await import(path.join(root, 'tests/helpers/register-ts-hooks.mjs'));
  globalThis.location = { search: `?world-v2&seed=${seed}` };
  const w = await import(path.join(root, 'game/sim/world/world.ts'));
  const l = await import(path.join(root, 'game/sim/world/world-layout.ts'));
  const n = await import(path.join(root, 'game/sim/world/world-noise.ts'));
  const { naturalLayout } = await import(path.join(root, 'game/sim/world/placement.ts'));
  const STEP = 3, SIDE = 340, h = [], tree = [];
  for (let j = 0; j < SIDE; j++) for (let i = 0; i < SIDE; i++) h.push(+w.rawHeight((i - SIDE / 2) * STEP, (j - SIDE / 2) * STEP).toFixed(2));
  const layout = naturalLayout({ heightAt: w.rawHeight, exclusion: w.vegetationExclusion, biomeAt: w.biomeAt, riverX: w.riverX, riverPresence: w.riverPresence, roadZ: w.roadZ, radius: w.WORLD_RADIUS });
  for (let cx = -16; cx < 16; cx++) for (let cz = -16; cz < 16; cz++) for (const t of layout.cell(cx, cz).trees) tree.push(Math.round(t.x), Math.round(t.z));
  const river = [], road = [], main = [];
  for (let z = -470; z <= 470; z += 6) { river.push([w.riverX(z), z]); main.push([w.pathX(z), z]); }
  const noise = await import('../game/sim/world/world-noise.ts');
  const branches = noise.BRANCHES.map(b => { const out = []; for (let z = b.z0; z <= b.z1; z += 4) out.push([noise.branchX(b, z), z]); return { kind: b.kind, line: out }; });
  for (let x = -470; x <= 470; x += 6) road.push([x, w.roadZ(x)]);
  fs.writeFileSync(out, JSON.stringify({ seed, STEP, SIDE, h, tree, river, branches, road, main, trails: l.TRAIL_LINES, pois: l.POI_PLACEMENTS, scatter: l.SCATTER_PLACEMENTS.map(p => [p.asset, Math.round(p.x), Math.round(p.z)]), spawn: l.SPAWN }));
  process.exit(0);
}
const outDir = path.resolve(process.argv[2]);
const seeds = process.argv.slice(3);
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'silence-map-'));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
for (const seed of seeds) {
  const data = path.join(tmp, `${seed}.json`);
  execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', new URL(import.meta.url).pathname, '--child', seed, data], { stdio: ['ignore', 'ignore', 'inherit'], cwd: root });
  const html = path.join(tmp, `${seed}.html`);
  fs.writeFileSync(html, `<!doctype html><meta charset=utf-8><style>*{margin:0}body{background:#111}</style><canvas id=c width=1020 height=1020></canvas><script>
  const D=${fs.readFileSync(data, 'utf8')};
  const c=document.getElementById('c').getContext('2d'),S=1020,W=D.SIDE*D.STEP,X=x=>(x+W/2)/W*S,Z=z=>(z+W/2)/W*S;
  const im=c.createImageData(D.SIDE,D.SIDE);
  const H=(i,j)=>D.h[Math.max(0,Math.min(D.SIDE-1,j))*D.SIDE+Math.max(0,Math.min(D.SIDE-1,i))];
  for(let j=0;j<D.SIDE;j++)for(let i=0;i<D.SIDE;i++){
    const h=H(i,j),dx=H(i+1,j)-H(i-1,j),dz=H(i,j+1)-H(i,j-1),shade=Math.max(.25,Math.min(1.5,1+(dx-dz)*.1));
    const t=Math.max(0,Math.min(1,(h+1)/26));let r=74+t*62,g=88+t*48,b=58+t*36;
    if(h>26){const m=Math.min(1,(h-26)/22);r+=m*50;g+=m*38;b+=m*48;}
    const k=(j*D.SIDE+i)*4;im.data[k]=r*shade;im.data[k+1]=g*shade;im.data[k+2]=b*shade;im.data[k+3]=255;
  }
  const off=document.createElement('canvas');off.width=off.height=D.SIDE;off.getContext('2d').putImageData(im,0,0);
  c.imageSmoothingQuality='high';c.drawImage(off,0,0,S,S);
  c.fillStyle='rgba(16,36,22,.55)';for(let i=0;i<D.tree.length;i+=2)c.fillRect(X(D.tree[i])-.9,Z(D.tree[i+1])-.9,1.9,1.9);
  const line=(p,col,w,dash)=>{c.beginPath();p.forEach((q,i)=>i?c.lineTo(X(q[0]),Z(q[1])):c.moveTo(X(q[0]),Z(q[1])));c.strokeStyle=col;c.lineWidth=w;c.setLineDash(dash||[]);c.stroke();c.setLineDash([]);};
  for(const b of D.branches??[])line(b.line,'#3f7fa6',b.kind==='braid'?4.4:3.6);
  line(D.river,'#3f7fa6',6);line(D.road,'#24211d',4.5);line(D.road,'#8a8474',1.4,[9,8]);line(D.main,'#e3d5ac',2,[6,4]);
  D.trails.forEach(t=>line(t,'#f3e3b4',2.4));
  const colors={rock_a:'#a39e93',rock_b:'#a39e93',rock_c:'#a39e93',rock_d:'#a39e93',pole:'#222',deerstand:'#ffb45e',canline:'#ff7a7a',totem:'#ff4f4f',trailmarker:'#fff3c9',cairn:'#d6d2c4',roadsign:'#ffe05c',mailbox:'#7fd77f',guardrail:'#ddd'};
  for(const [a,x,z] of D.scatter){c.fillStyle=colors[a]||'#c9b48c';c.beginPath();c.arc(X(x),Z(z),a.startsWith('rock')?4.2:2.3,0,6.3);c.fill();}
  c.font='800 17px Helvetica';c.textBaseline='middle';
  const names={cabin:'CABIN','trailhead-board':'TRAILHEAD','relay-mast':'RELAY',lookout:'FIRE TOWER','logging-camp':'LOGGING','hunter-camp':'CAMP',chapel:'CHAPEL',mine:'MINE'};
  for(const p of D.pois){const n=names[p.id];if(!n)continue;const a=X(p.x),b=Z(p.z);c.fillStyle='#000';c.fillRect(a-7,b-7,14,14);c.fillStyle='#ffd24a';c.fillRect(a-5,b-5,10,10);c.lineWidth=4;c.strokeStyle='#000';c.strokeText(n,a+11,b);c.fillStyle='#fff';c.fillText(n,a+11,b);}
  c.fillStyle='#fff';c.strokeStyle='#000';c.lineWidth=3;c.beginPath();c.arc(X(D.spawn.x),Z(D.spawn.z),9,0,6.3);c.fill();c.stroke();c.lineWidth=4;c.strokeText('START',X(D.spawn.x)+14,Z(D.spawn.z));c.fillStyle='#fff';c.fillText('START',X(D.spawn.x)+14,Z(D.spawn.z));
  c.font='900 34px Helvetica';c.lineWidth=5;c.strokeText('SEED '+D.seed,18,36);c.fillText('SEED '+D.seed,18,36);
  </script>`);
  execFileSync(CHROME, ['--headless=new', '--no-first-run', '--disable-gpu', `--user-data-dir=${tmp}/p`, '--window-size=1020,1020', '--hide-scrollbars', '--virtual-time-budget=4000', `--screenshot=${path.join(outDir, `map-${seed}.png`)}`, 'file://' + html], { stdio: 'ignore' });
  console.log('map', seed);
}
fs.rmSync(tmp, { recursive: true, force: true });
