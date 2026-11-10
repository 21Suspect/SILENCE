// Signs for the second batch of places. node art_poi2.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const OUT = path.resolve(import.meta.dirname, '../../../assets/world-v2/art');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'silence-art-'));
const page = (name, w, h, css, body) => {
  const file = path.join(tmp, name + '.html');
  fs.writeFileSync(file, '<!doctype html><meta charset=utf-8><style>*{box-sizing:border-box;margin:0}html,body{width:' + w + 'px;height:' + h + 'px;overflow:hidden}' + css + '</style>' + body);
  execFileSync(CHROME, ['--headless=new', '--no-first-run', '--disable-gpu', '--user-data-dir=' + tmp + '/p', '--window-size=' + w + ',' + h, '--hide-scrollbars', '--screenshot=' + path.join(OUT, name + '.png'), 'file://' + file], { stdio: 'ignore' });
};
page('sign_roadclosed', 1200, 520, 'body{background:#c9c4b2;border:22px solid #8a1d12;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#8a1d12;font-family:Impact,Helvetica,sans-serif}h1{font-size:210px;letter-spacing:8px;line-height:1}h2{font-size:64px;letter-spacing:5px;color:#1a1712;margin-top:14px}', '<h1>ROAD CLOSED</h1><h2>NO ACCESS BEYOND THIS POINT</h2>');
const rows = [['06:40', 'MILL ROAD', ''], ['09:15', 'MILL ROAD', ''], ['13:05', 'RELAY HILL', 'x'], ['17:50', 'MILL ROAD', ''], ['21:20', 'LAST BUS', 'x']];
page('timetable', 800, 1100, "body{background:#d2cbb2;background-image:radial-gradient(ellipse at 70% 15%,#ded8c2,transparent 60%),radial-gradient(ellipse at 20% 95%,#8f8566,transparent 60%);padding:46px;font-family:Helvetica,Arial,sans-serif;color:#1b1a16}h1{font:900 96px Impact,Helvetica;letter-spacing:3px;border-bottom:10px solid #1b1a16;padding-bottom:10px}h2{font:700 40px Helvetica;margin:18px 0 26px;letter-spacing:2px}table{width:100%;border-collapse:collapse;font:700 54px Helvetica}td{padding:20px 6px;border-bottom:3px solid #6e6650}td.t{width:230px;font-family:Courier,monospace}.x{text-decoration:line-through;text-decoration-thickness:7px;color:#5a5340}p{margin-top:40px;font:italic 700 46px 'Marker Felt','Chalkboard SE',Helvetica;color:#7a1f14;transform:rotate(-3deg)}", '<h1>ROUTE 9</h1><h2>WEEKDAYS &nbsp;·&nbsp; FOREST HALT</h2><table>' + rows.map(([t, d, x]) => '<tr class="' + x + '"><td class=t>' + t + '</td><td>' + d + '</td></tr>').join('') + '</table><p>service withdrawn — do not wait here</p>');
page('board_keepout', 1300, 560, "body{background:#6b6657;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#d6d0bd;font-family:'Marker Felt','Chalkboard SE',Impact,sans-serif}h1{font-size:230px;line-height:1;transform:rotate(-1.5deg);letter-spacing:6px}h2{font-size:92px;transform:rotate(1deg);letter-spacing:4px}", '<h1>KEEP OUT</h1><h2>it hears you</h2>');
page('sign_water', 900, 620, 'body{background:#c7c2ae;border:20px solid #1c2a33;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#1c2a33;font-family:Impact,Helvetica,sans-serif}h1{font-size:132px;letter-spacing:5px;line-height:1.05;text-align:center}h2{font-size:58px;letter-spacing:3px;margin-top:16px;color:#7a1f14}', '<h1>PUMP STATION 3</h1><h2>AUTHORISED PERSONS ONLY</h2>');
page('sign_tunnel', 1400, 600, 'body{background:#c2ab2a;border:26px solid #151310;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#141210;font-family:Impact,Helvetica,sans-serif}h1{font-size:200px;letter-spacing:8px;line-height:1}h2{font-size:84px;letter-spacing:5px;margin-top:10px}', '<h1>TUNNEL CLOSED</h1><h2>ROCKFALL &nbsp;·&nbsp; DO NOT ENTER</h2>');
page('plate_tunnel', 1200, 380, "body{background:#8d897c;border:14px solid #5b584e;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#1b1a17;font-family:Georgia,'Times New Roman',serif}h1{font-size:150px;letter-spacing:22px;line-height:1.05}h2{font-size:64px;letter-spacing:14px}", '<h1>ST. ANSELM</h1><h2>1 9 3 7</h2>');
fs.rmSync(tmp, { recursive: true, force: true });
