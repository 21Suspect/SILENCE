// Receives the PNGs (as data URLs) and JSON that the in-page helper (page.js) posts, and writes them into a directory.
//   node tools/ghosting/receiver.mjs <dir>      listens on 127.0.0.1:5198 (the port page.js posts to)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) { console.error('usage: node tools/ghosting/receiver.mjs <dir>'); process.exit(1); }
fs.mkdirSync(dir, { recursive: true });
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Headers', '*'); res.end(); return; }
  const file = path.basename(new URL(req.url, 'http://x').searchParams.get('file') || 'out.bin');
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    let body = Buffer.concat(chunks);
    if (body.toString('latin1', 0, 40).startsWith('data:image/png;base64,')) body = Buffer.from(body.toString().slice(22), 'base64');
    fs.writeFileSync(path.join(dir, file), body);
    res.end(`ok ${body.length}`);
  });
}).listen(5198, '127.0.0.1', () => console.log(`receiving into ${dir} on 127.0.0.1:5198`));
