/**
 * One night, one bot: `node --experimental-strip-types --no-warnings scripts/playtest/night.mjs <style> <seed> [minutes] [log.json]`.
 * Writes the structured log (to the path given, else work/playtest/logs/<style>-<seed>.json) and prints one summary line.
 * Several jobs may be given as style:seed,style:seed,... in place of <style> <seed>; they run one after another.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { playNight } from './bot.mjs';
import { judgeRun } from './report.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const jobs = args[0]?.includes(':') ? args[0].split(',').map(j => { const [style, seed] = j.split(':'); return { style, seed: +seed }; }) : [{ style: args[0] ?? 'trail', seed: +(args[1] ?? 1) }];
const minutes = +(args[0]?.includes(':') ? args[1] ?? 15 : args[2] ?? 15);
const outDir = process.env.SILENCE_PLAYTEST_OUT ?? resolve(root, 'work/playtest/logs');
mkdirSync(outDir, { recursive: true });
for (const { style, seed } of jobs) {
  const started = performance.now();
  const log = await playNight({ style, seed, minutes });
  log.wallSeconds = (performance.now() - started) / 1000;
  const path = !args[0]?.includes(':') && args[3] ? resolve(args[3]) : resolve(outDir, `${style}-${seed}.json`);
  writeFileSync(path, JSON.stringify(log));
  const j = judgeRun(log);
  console.log(JSON.stringify({ style, seed, path, wall: +log.wallSeconds.toFixed(1), ...j.row, violations: j.violations.map(v => v.rule) }));
}
process.exit(0);
