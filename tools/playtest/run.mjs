/**
 * The playtest: N seeds x play styles, each a whole night against the real creature, in parallel, then the report.
 *
 *   node --experimental-strip-types --no-warnings tools/playtest/run.mjs [--seeds 20] [--from 1] [--styles trail,smart]
 *        [--minutes 15] [--jobs 12] [--out work/playtest]
 *   node --experimental-strip-types --no-warnings tools/playtest/run.mjs --report-only [--out work/playtest]
 *
 * Logs go to <out>/logs/<style>-<seed>.json, the report to <out>/report.txt and stdout. Exits 1 if a guarantee broke.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize, formatReport } from './report.mjs';

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../..');
const flag = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const STYLES = ['trail', 'wander', 'still', 'sprint', 'indoors', 'smart', 'careless'];
const styles = (flag('styles', 'all') === 'all' ? STYLES : flag('styles').split(','));
const seeds = +flag('seeds', 20), from = +flag('from', 1), minutes = +flag('minutes', 15);
const jobs = Math.max(1, +flag('jobs', Math.max(1, availableParallelism() - 2)));
const out = resolve(root, flag('out', 'work/playtest')), logs = resolve(out, 'logs');
mkdirSync(logs, { recursive: true });

if (!process.argv.includes('--report-only')) {
  const queue = [];
  for (let seed = from; seed < from + seeds; seed++) for (const style of styles) queue.push(`${style}:${seed}`);
  const started = performance.now();
  let done = 0;
  const worker = () => new Promise(resolveWorker => {
    const next = () => {
      const job = queue.shift();
      if (!job) { resolveWorker(); return; }
      const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', resolve(here, 'night.mjs'), job, String(minutes)], { env: { ...process.env, SILENCE_PLAYTEST_OUT: logs }, stdio: ['ignore', 'pipe', 'pipe'] });
      let text = '', errors = '';
      child.stdout.on('data', d => { text += d; });
      child.stderr.on('data', d => { errors += d; });
      child.on('close', code => {
        done++;
        const line = text.trim().split('\n').at(-1) ?? '';
        if (code) process.stderr.write(`\n${job} failed (${code}):\n${errors.slice(-2000)}\n`);
        else { try { const r = JSON.parse(line); process.stderr.write(`\r${done} done, ${((performance.now() - started) / 1000).toFixed(0)} s: ${job} ${r.violations.length ? r.violations.join(',') : 'ok'}          `); } catch { process.stderr.write(`\n${job}: ${line}\n`); } }
        next();
      });
    };
    next();
  });
  await Promise.all(Array.from({ length: jobs }, worker));
  process.stderr.write('\n');
}

const wanted = new Set(styles);
const files = readdirSync(logs).filter(f => f.endsWith('.json')).filter(f => wanted.has(f.split('-')[0]));
const all = files.map(f => JSON.parse(readFileSync(resolve(logs, f), 'utf8'))).filter(l => l.seed >= from && l.seed < from + seeds).sort((a, b) => a.style.localeCompare(b.style) || a.seed - b.seed);
const summary = summarize(all);
const text = formatReport(summary);
writeFileSync(resolve(out, 'report.txt'), text + '\n');
writeFileSync(resolve(out, 'summary.json'), JSON.stringify({ perStyle: summary.perStyle, expectations: summary.expectations, violations: summary.violations, rows: summary.runs.map(r => ({ style: r.log.style, seed: r.log.seed, ...r.row, violations: r.violations })) }, null, 1));
console.log(text);
process.exit(summary.violations.length || summary.expectations.some(e => !e.ok) ? 1 : 0);
