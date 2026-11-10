// Printed and painted artwork for the props, rendered with headless Chrome.
// node art.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const OUT = path.resolve(import.meta.dirname, '../../../assets/world-v2/art');
fs.mkdirSync(OUT, { recursive: true });
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'silence-art-'));
const page = (name, w, h, css, body) => {
  const file = path.join(tmp, name + '.html');
  fs.writeFileSync(file, `<!doctype html><meta charset=utf-8><style>*{box-sizing:border-box;margin:0}html,body{width:${w}px;height:${h}px;overflow:hidden}${css}</style>${body}`);
  execFileSync(CHROME, ['--headless=new', '--no-first-run', '--disable-gpu', `--user-data-dir=${tmp}/p`, `--window-size=${w},${h}`, '--hide-scrollbars', `--screenshot=${path.join(OUT, name + '.png')}`, 'file://' + file], { stdio: 'ignore' });
};
const paper = 'background:#c9bf9f;background-image:radial-gradient(ellipse at 30% 20%,#d8d0b4,transparent 60%),radial-gradient(ellipse at 80% 90%,#9c9170,transparent 55%);color:#1b1a16;font-family:Helvetica,Arial,sans-serif';

page('sign_voltage', 920, 680, `body{background:#c2ab2a;display:flex;flex-direction:column;align-items:center;justify-content:center;border:26px solid #151310;font-family:Impact,Helvetica,sans-serif;color:#141210}h1{font-size:150px;letter-spacing:6px}h2{font-size:78px;letter-spacing:3px}svg{height:190px}`, `<svg viewBox="0 0 100 100"><path d="M58 2 16 58h28l-10 40 46-60H50z" fill="#141210"/></svg><h1>DANGER</h1><h2>HIGH VOLTAGE</h2>`);

page('poster_missing', 800, 1100, `body{${paper};padding:44px;text-align:center}h1{font:900 124px Impact,Helvetica;letter-spacing:4px}.ph{height:440px;margin:18px auto;width:80%;background:#18160f;position:relative;overflow:hidden}.ph:after{content:'';position:absolute;left:30%;right:30%;top:18%;height:74%;border-radius:50% 50% 12% 12%;background:linear-gradient(#57513f,#26221a);filter:blur(5px)}h2{font:800 58px Helvetica}p{font:500 33px/1.32 Helvetica;margin-top:14px}`, `<h1>MISSING</h1><div class=ph></div><h2>DANIEL ROURKE, 34</h2><p>Last seen on the Ridge Trail near the relay road, October 9. Blue jacket, grey pack. Do not search after dark.</p>`);

page('poster_closed', 800, 1100, `body{background:#d7d2bd;padding:50px;font-family:Helvetica;color:#141310;border:18px solid #7a1f14}h1{font:900 110px Impact,Helvetica;color:#7a1f14;text-align:center;line-height:1}h2{font:800 46px Helvetica;margin:26px 0;text-align:center}li{font:500 36px/1.35 Helvetica;margin:18px 0 18px 36px}.f{position:absolute;left:68px;right:68px;bottom:62px;font:500 26px Helvetica;text-align:center}`, `<h1>BASIN<br>CLOSED</h1><h2>BY ORDER OF THE DISTRICT RANGER</h2><ul><li>No overnight stays.</li><li>Keep to marked trails.</li><li>Keep radios turned down.</li><li><b>Do not call out to anyone you cannot see.</b></li></ul><div class=f>Relay service suspended until further notice</div>`);

// Painted by hand on a board, in a hurry.
page('board_quiet', 1400, 420, `body{background:transparent;background:#6f6a5c;display:flex;align-items:center;justify-content:center}h1{font:900 300px 'Marker Felt','Chalkboard SE',Impact,sans-serif;color:#d8d3c2;letter-spacing:22px;transform:rotate(-1.6deg) skewX(-5deg);filter:url(#r);line-height:1}`, `<svg width=0 height=0 style=position:absolute><filter id=r><feTurbulence baseFrequency=".035" numOctaves="3" seed="4"/><feDisplacementMap in="SourceGraphic" scale="16"/></filter></svg><h1>QUIET</h1>`);

// A real trail map of the basin, drawn from the same geography the game uses.
const pathX = z => Math.sin(z * .021) * 18 + Math.sin(z * .069) * 6 + Math.sin(z * .15) * 1.8;
const riverX = z => 39 + Math.sin(z * .027) * 10 + Math.sin(z * .071) * 2 + Math.sin(z * .008) * 18;
const roadZ = x => -83 + Math.sin(x * .013) * 29 + Math.sin(x * .041) * 6.2 + Math.sin(x * .087) * 1.3;
const S = 1000 / 1040, map = (x, z) => [500 + x * S, 500 - z * S];
const line = pts => pts.map((p, i) => (i ? 'L' : 'M') + map(p[0], p[1]).map(v => v.toFixed(1)).join(' ')).join('');
const range = (a, b, d) => { const o = []; for (let v = a; v <= b; v += d) o.push(v); return o; };
const blots = [[-190, 12, 'RELAY'], [150, 128, 'LOOKOUT'], [-96, -136, 'LOGGING'], [-105, 86, 'CAMP'], [176, -214, 'CHAPEL'], [-30, 240, 'MINE'], [-18, -46, 'CABIN']];
const blotSvg = blots.map(([x, z, t]) => { const [a, b] = map(x, z); return `<g transform="translate(${a} ${b})"><path d="M-9 -9L9 9M-9 9L9 -9" stroke="#7a1f14" stroke-width="5"/><text x="15" y="10" font-size="30" font-weight="800">${t}</text></g>`; }).join('');
const rings = [470, 420, 370].map((r, i) => `<circle cx=500 cy=500 r=${r * S} fill=none stroke=#8d7f5d stroke-width=${3 - i} stroke-dasharray="${i * 6 + 10} 8"/>`).join('');
page('trail_map', 1000, 1000, `body{${paper}}text{font-family:Helvetica;fill:#1b1a16}`, `<svg width=1000 height=1000>${rings}
<path d="${line(range(-440, 440, 6).map(z => [riverX(z), z]))}" fill=none stroke=#37566a stroke-width=8 />
<path d="${line(range(-440, 440, 6).map(x => [x, roadZ(x)]))}" fill=none stroke=#3a342a stroke-width=6 />
<path d="${line(range(-430, 430, 6).map(z => [pathX(z), z]))}" fill=none stroke=#3a342a stroke-width=3 stroke-dasharray="11 8" />
${blotSvg}
<text x=500 y=60 text-anchor=middle font-size=46 font-weight=900 letter-spacing=6>STILLWATER BASIN</text>
<g transform="translate(905 905)"><path d="M0 -44L13 8L0 0L-13 8Z" fill="#1b1a16"/><text x=0 y=44 text-anchor=middle font-size=30 font-weight=800>N</text></g></svg>`);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fs.readdirSync(OUT));
