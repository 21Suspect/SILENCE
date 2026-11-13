// Turns what the page helper posted (tools/ghosting/page.js, run({ tag })) into the readable log.
//   node tools/ghosting/measure.mjs <dir> <tag>          writes <dir>/<tag>.md next to <tag>.json and prints it
//   node tools/ghosting/measure.mjs <dir> <tag> <other>  the same, plus the change from <other>.json (an earlier run) for the variants both hold
//
// Columns (per pose and variant):
//   ghost     image-space ghost index: the share of the picture's neighbour coherence lost against the same render with the parallax
//             off (metrics.mjs). 0 is clean; the first version of the ground shader scores .2 to .4 on a path.
//   coh       the neighbour coherence itself (correlation of the high-pass luminance between neighbouring pixels, ground tiles only).
//   layers    scan copies layered in a pixel, from the shader's own weights (mean, 90th percentile, share of pixels over 1.5 copies).
//   jump      how far the texture lookup jumps between neighbouring pixels, in pixels (share over 1 px and over 2 px; mean).
//   step px   how far one march step moves the lookup, in pixels (median, 90th percentile).
import fs from 'node:fs';
import path from 'node:path';

const [dir, tag, other] = process.argv.slice(2);
if (!dir || !tag) { console.error('usage: node tools/ghosting/measure.mjs <dir> <tag> [<earlier tag>]'); process.exit(1); }
const load = name => JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
const run = load(tag), before = other ? load(other) : null;

const f = (v, d = 2) => v === null || v === undefined || Number.isNaN(v) ? '-' : v.toFixed(d);
const pct = v => v === null || v === undefined ? '-' : `${(v * 100).toFixed(1)}%`;
const GROUPS = [
  ['The suspects, one at a time, on the first version of the ground shader', n => n.startsWith('first-')],
  ['The first version taken apart: the new shader with the old march, then one change at a time', n => n.startsWith('step-') || n === 'fixed-old-depth'],
  ['The game as it now ships, and its own switches', n => n === 'fixed' || n === 'reference' || (n.startsWith('fixed-') && n !== 'fixed-old-depth')],
];

const lines = [`# Ghosting log: ${tag}`, '', `Run ${run.when}, ${run.size[0]} x ${run.size[1]}.`, ''];
const poses = [...new Set(run.rows.map(r => r.pose))];
for (const pose of poses) {
  lines.push(`## ${pose}`, '');
  for (const [title, match] of GROUPS) {
    const rows = run.rows.filter(r => r.pose === pose && match(r.variant));
    if (!rows.length) continue;
    lines.push(`### ${title}`, '', '| variant | ghost | coh | layers mean | p90 | >1.5 copies | jump >1 px | >2 px | mean px | step px median | p90 |', '|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of rows) {
      const earlier = before?.rows.find(b => b.pose === r.pose && b.variant === r.variant);
      const delta = earlier ? ` (was ${f(earlier.ghostIndex, 3)})` : '';
      lines.push(`| ${r.variant} | ${f(r.ghostIndex, 3)}${delta} | ${f(r.coherenceMean, 3)} | ${f(r.layers.mean)} | ${f(r.layers.p90)} | ${pct(r.layers.over[0])} | ${pct(r.jump.over[0])} | ${pct(r.jump.over[1])} | ${f(r.jump.mean)} | ${f(r.stepPx.p50)} | ${f(r.stepPx.p90)} |`);
    }
    lines.push('');
  }
  const bark = run.rows.filter(r => r.pose === pose && r.trunkCoherence !== undefined && (r.variant === 'fixed' || r.variant === 'fixed-bark-off'));
  if (bark.length) {
    lines.push('### Bark relief (a box on a pine trunk; the ghost index is against the same render with the bark relief off)', '', '| variant | trunk coherence | bark ghost |', '|---|---|---|');
    for (const r of bark) lines.push(`| ${r.variant} | ${f(r.trunkCoherence, 3)} | ${f(r.trunkGhostIndex, 3)} |`);
    lines.push('');
  }
  lines.push(`Tiles: ${run.rows.find(r => r.pose === pose).tiles} ground tiles of 32 x 32 px. Crops: ${tag}-${pose}-crops-worst.png (the tiles the first version's parallax hurt most) and -best.png (hurt least); rows: first version, parallax off, fixed; the number is each tile's coherence.`, '');
}
const text = lines.join('\n');
fs.writeFileSync(path.join(dir, `${tag}.md`), text);
console.log(text);
