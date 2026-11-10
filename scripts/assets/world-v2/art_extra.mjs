// Signs added after the first judging round. node art_extra.mjs
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
page('sign_road', 1000, 740, 'body{background:#b58a1c;border:24px solid #1a1712;outline:10px solid #b58a1c;outline-offset:-46px;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#16130e;font-family:Impact,Helvetica,sans-serif}h1{font-size:150px;letter-spacing:4px;line-height:1}h2{font-size:70px;letter-spacing:2px;margin-top:22px}', '<h1>NO SERVICES</h1><h2>NEXT 41 MILES</h2>');
page('sign_mine', 1400, 540, 'body{background:#6b6657;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#d6d0bd;font-family:Impact,Helvetica,sans-serif}h1{font-size:172px;letter-spacing:12px;line-height:1;transform:rotate(-.8deg)}h2{font-size:78px;letter-spacing:7px;margin-top:14px;color:#7c1d12;transform:rotate(.5deg)}', '<h1>DANGER</h1><h2>SHAFT IS NOT EMPTY</h2>');
page('label_fuse', 900, 300, 'body{background:#cfc6ab;display:flex;align-items:center;justify-content:space-around;color:#1b1812;font-family:Helvetica,Arial,sans-serif}.b{width:44px;height:300px;background:#8b2015}h1{font:900 118px Impact,Helvetica;line-height:1;letter-spacing:2px}p{font:700 34px Helvetica;line-height:1.2}', '<div class=b></div><h1>30A</h1><p>600 V TIME-DELAY<br>STILLWATER MINE<br>REPLACE ONLY WITH<br>SAME RATING</p><div class=b></div>');
page('stencil_drum', 800, 340, 'body{background:#6e1d12;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#d8d2b6;font-family:Impact,Helvetica,sans-serif;letter-spacing:6px}h1{font-size:120px;line-height:1}h2{font-size:62px;line-height:1.1}', '<h1>DIESEL</h1><h2>55 GAL  DIST. 7</h2>');
page('sign_trail', 170, 340, 'body{background:#3b3a30;display:flex;flex-direction:column;align-items:center;justify-content:space-around;padding:18px 0;color:#d8d2b6;font-family:Impact,Helvetica,sans-serif}div{width:110px;height:170px;background:#c9c0a3;clip-path:polygon(0 0,100% 0,100% 100%,0 100%);opacity:.92}svg{height:90px}', '<div></div><svg viewBox="0 0 100 60"><path d="M6 30H70M50 8 76 30 50 52" fill="none" stroke="#d8d2b6" stroke-width="12"/></svg>');
fs.rmSync(tmp, { recursive: true, force: true });
console.log('done');
