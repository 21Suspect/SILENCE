/**
 * Reads the bot's night logs (scripts/playtest/bot.mjs) and checks the guarantees from docs/creature-ai-plan.md,
 * "Amendment: scripted opening": both encounters seen in time, no grab before the opening ends, nothing placed or
 * removed in view, presence sounds sparse and never while it is looked at, no long dead air in free roam, the stun's
 * three phases the right length. Per play style it reports when things happen and how often.
 */
import { OPENING } from '../../game/creature-director.ts';

/** The rules, with their limits. */
export const RULES = {
  glimpseBy: OPENING.glimpseBy, treeBy: OPENING.treeBy,
  presenceGap: 30,
  /** The dead-air rule fires at 150 s; it then has to come and make its sound, which may take a little while. */
  silence: 150 + 45,
  stun: { slowing: [.5, .72], starting: [1.4, 1.65], held: [.6, 2.6] },
  /** Sounds per ten minutes of night, all kinds: fewer is dead, more is spam (the median, and the p90 of nights). And the ambient ones alone. */
  soundsPer10: [4, 12], soundsP90Max: 16, presencePer10: [3, 7],
  /** The reactive sounds mean something once: one hiss per stun engagement, one roar per hunt. Seconds. */
  hissQuiet: 45, roarGap: 75,
  /** An ambient sound is no use straight after a loud one, nor straight after the creature was seen. Seconds. */
  loudQuiet: 25, sightQuiet: 30,
  /** Deaths per night, by style: a careless player dies in most nights, a careful one usually survives the first ten minutes. */
  deaths: { careless: [1.2, 1.6], wander: [1.0, 1.4], still: [.6, 1.0], indoors: [.6, 1.0], sprint: [.5, .9], smart: [.3, .6], trail: [.3, .6] },
};
const AMBIENT = new Set(['clicks', 'knock', 'branch', 'call']), LOUD = new Set(['reveal', 'hiss', 'roar', 'grab']);

const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (a, q) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + .5))]; };
const mmss = t => !Number.isFinite(t) ? '-' : `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

/**
 * The body's speed through a stun, sampled every .1 s from the moment it was pinned, for the stuns that caught it at a charge
 * (4.5 m/s or more): the median across stuns at each time, and the fastest single drop between two samples.
 */
export function stunCurve(logs, grid = 21) {
  const curves = [];
  for (const log of logs) for (const st of log.stuns) {
    const sp = (st.speeds ?? []).filter(x => x[1] !== 'none');
    if (sp.length < 6 || sp[0][2] < 4.5) continue;
    const at = t => { let i = sp.findIndex(x => x[0] >= t); if (i < 0) return sp.at(-1)[2]; if (i === 0) return sp[0][2]; const a = sp[i - 1], b = sp[i]; return a[2] + (b[2] - a[2]) * (t - a[0]) / Math.max(1e-6, b[0] - a[0]); };
    curves.push({ v: Array.from({ length: grid }, (_, k) => at(k / 10)), blocked: sp.some(x => x[3]), phases: sp.map(x => x[1]) });
  }
  const clean = curves.filter(c => !c.blocked);
  const drop = Math.max(0, ...curves.flatMap(c => c.v.slice(1).map((x, i) => c.v[i] - x)));
  return { n: curves.length, blocked: curves.length - clean.length, median: Array.from({ length: grid }, (_, k) => median(clean.map(c => c.v[k]))), worstDrop: drop };
}

/** One night's numbers and the rules it broke. */
export function judgeRun(log) {
  const violations = [], v = (rule, detail) => violations.push({ rule, detail });
  const seen = phase => log.opening.find(e => e.event === 'seen' && e.phase === phase);
  const variantAt = phase => { const s = log.opening.find(e => e.type === 'seen' && e.kind === (phase === 'glimpse' ? 'glimpse' : 'tree')); return s?.variant; };
  const free = log.opening.find(e => e.type === 'phase' && e.to === 'free');
  const e1 = seen('glimpse'), e2 = seen('tree'), indoorsRun = log.style === 'indoors';
  const freeAt = free?.t ?? Infinity, end = log.duration;
  // 1-2. The encounters, by their deadlines (the opening's clock pauses only while indoors and unseen).
  if (!e1 || e1.at > RULES.glimpseBy + 1e-6) v('glimpse-late', e1 ? `seen at ${mmss(e1.at)} (opening clock)` : 'never seen');
  if (!e2 || e2.at > RULES.treeBy + 1e-6) v('tree-late', e2 ? `seen at ${mmss(e2.at)} (opening clock)` : 'never seen');
  if (indoorsRun) {
    const waited = log.timeline.some(e => e.type === 'transition' && e.kind === 'treeline');
    if (!waited && log.indoorsSeconds > 60) v('indoors-not-presented', 'it never waited at the treeline in view of the door');
  }
  if (!free) v('never-free', 'the opening never ended');
  // 3. No grab before the opening ends.
  for (const g of log.grabs) if (g.phase !== 'free') v('grab-in-opening', `grabbed at ${mmss(g.t)} in ${g.phase}`);
  // 4. Never placed or removed in view: the bot's own check, and the host's.
  for (const p of log.visibilityPops) v('pop-in-view', `${p.appeared ? 'appeared' : 'vanished'} in view at ${mmss(p.t)}, ${p.distance.toFixed(0)} m (${p.phase} ${p.script ?? ''})`);
  for (const e of log.timeline) if (e.type === 'transition' && e.inView && e.action !== 'strike') v('host-in-view', `${e.action} ${e.kind} flagged in view at ${mmss(e.t)}`);
  // 5. Presence sounds: never two within 30 s; clicks and knocks never while it is looked at.
  const presence = log.sounds.filter(s => s.presence).sort((a, b) => a.t - b.t);
  let minGap = Infinity;
  for (let i = 1; i < presence.length; i++) { const gap = presence[i].t - presence[i - 1].t; minGap = Math.min(minGap, gap); if (gap < RULES.presenceGap - 1e-6) v('presence-gap', `${presence[i - 1].kind} then ${presence[i].kind} ${gap.toFixed(1)} s apart at ${mmss(presence[i].t)}`); }
  for (const s of log.sounds) if (AMBIENT.has(s.kind) && s.seen) v('sound-while-seen', `${s.kind} while looked at, at ${mmss(s.t)}`);
  // 5b. Each reactive sound means something once. One hiss per stun engagement (not again within hissQuiet unless a hunt began), one
  // roar per hunt (not within roarGap of the last, in free roam), and ambient sounds in free roam never right after a loud one or a sighting.
  const sorted = [...log.sounds].sort((a, b) => a.t - b.t), freeFrom = free?.t ?? Infinity;
  const hisses = sorted.filter(s => s.kind === 'hiss'), roars = sorted.filter(s => s.kind === 'roar' && s.t >= freeFrom);
  for (let i = 1; i < hisses.length; i++) if (hisses[i].t - hisses[i - 1].t < RULES.hissQuiet && !sorted.some(s => s.kind === 'roar' && s.t > hisses[i - 1].t && s.t <= hisses[i].t)) v('hiss-repeat', `hiss ${(hisses[i].t - hisses[i - 1].t).toFixed(1)} s after the last at ${mmss(hisses[i].t)}`);
  for (let i = 1; i < roars.length; i++) if (roars[i].t - roars[i - 1].t < RULES.roarGap) v('roar-repeat', `roar ${(roars[i].t - roars[i - 1].t).toFixed(1)} s after the last at ${mmss(roars[i].t)}`);
  for (const s of sorted) {
    if (!AMBIENT.has(s.kind) || s.t < freeFrom) continue;
    const loud = sorted.filter(o => LOUD.has(o.kind) && o.t < s.t && s.t - o.t < RULES.loudQuiet).at(-1);
    if (loud) v('ambient-after-loud', `${s.kind} ${(s.t - loud.t).toFixed(1)} s after a ${loud.kind} at ${mmss(s.t)}`);
    const sight = log.sightings.filter(g => (g.end ?? g.t) < s.t && s.t - (g.end ?? g.t) < RULES.sightQuiet).at(-1);
    if (sight && s.kind !== 'call') v('ambient-after-sighting', `${s.kind} ${(s.t - (sight.end ?? sight.t)).toFixed(1)} s after it was seen at ${mmss(s.t)}`);
  }
  // 6. Dead air in free roam: the longest stretch with neither a sighting nor a sound (a wake-up starts it afresh).
  const evidence = [freeAt, ...log.sounds.map(s => s.t), ...log.sightings.flatMap(s => [s.t, s.end ?? s.t]), ...log.deaths.map(d => d.t + 4)].filter(t => t >= freeAt).sort((a, b) => a - b);
  let silence = 0;
  if (Number.isFinite(freeAt)) { evidence.push(end); for (let i = 1; i < evidence.length; i++) silence = Math.max(silence, evidence[i] - evidence[i - 1]); }
  if (silence > RULES.silence) v('dead-air', `${silence.toFixed(0)} s of nothing in free roam`);
  // 7. The stun's shape.
  for (const s of log.stuns) {
    // A grab in the middle of getting going ends the stun's measurement there.
    if (s.interrupted) continue;
    const { slowing = 0, held = 0, starting = 0 } = s.phases;
    if (slowing < RULES.stun.slowing[0] || slowing > RULES.stun.slowing[1]) v('stun-shape', `slowing ${slowing.toFixed(2)} s at ${mmss(s.t)}`);
    if (held < RULES.stun.held[0] || held > RULES.stun.held[1]) v('stun-shape', `held ${held.toFixed(2)} s at ${mmss(s.t)}`);
    if (starting && (starting < RULES.stun.starting[0] || starting > RULES.stun.starting[1])) v('stun-shape', `starting ${starting.toFixed(2)} s at ${mmss(s.t)}`);
    // No hard brake, no instant restart: the body's own speed through the stun.
    // (Running into a trunk stops it dead whatever the stun does: those samples are not the stun's.)
    const samples = (s.speeds ?? []).filter(x => x[1] === 'slowing'), start = (s.speeds ?? []).filter(x => x[1] === 'starting').map(x => x[2]);
    for (let i = 1; i < samples.length; i++) if (!samples[i][3] && samples[i - 1][2] - samples[i][2] > 2.6) v('stun-hard-brake', `speed fell ${samples[i - 1][2].toFixed(1)} to ${samples[i][2].toFixed(1)} m/s in .1 s at ${mmss(s.t)}`);
    if (start.length && start[0] > 2.2) v('stun-instant-restart', `restarted at ${start[0].toFixed(1)} m/s at ${mmss(s.t)}`);
  }
  const minutes = end / 60, inFree = Math.max(0, end - freeAt) / 60;
  const firstDeath = log.deaths[0]?.t ?? Infinity;
  const closeInFree = log.sightings.filter(s => s.t >= freeAt && s.minDistance < 15).length;
  const row = {
    e1: e1?.at, e1real: e1?.t, v1: variantAt('glimpse'), e2: e2?.at, e2real: e2?.t, v2: variantAt('tree'), free: freeAt,
    hunt1: log.hunts.find(h => h.t >= freeAt)?.t ?? Infinity, hunts: log.hunts.length,
    deaths: log.deaths.length, firstDeath, survived10: firstDeath >= 600,
    sounds: log.sounds.length, soundsPer10: log.sounds.length / Math.max(.1, minutes) * 10, presencePer10: presence.length / Math.max(.1, minutes) * 10,
    kinds: Object.fromEntries([...new Set(log.sounds.map(s => s.kind))].map(k => [k, log.sounds.filter(s => s.kind === k).length])),
    minPresenceGap: minGap, silence, sightings: log.sightings.length, sightingsFree: log.sightings.filter(s => s.t >= freeAt).length,
    sightingSeconds: log.sightings.reduce((a, s) => a + s.seconds, 0), closeInFree,
    stuns: log.stuns.length, held: log.stuns.map(s => +(s.phases.held ?? 0).toFixed(2)), gained: log.stuns.map(s => +((s.endDistance ?? 0) - s.startDistance).toFixed(1)),
    minutes, freeMinutes: inFree, ended: log.ended,
  };
  return { row, violations };
}

/** Every run judged, grouped by style, with the distributions and the style-level expectations. */
export function summarize(logs) {
  const runs = logs.map(log => ({ log, ...judgeRun(log) }));
  const styles = [...new Set(logs.map(l => l.style))];
  const perStyle = styles.map(style => {
    const rs = runs.filter(r => r.log.style === style), rows = rs.map(r => r.row);
    const finite = a => a.filter(Number.isFinite);
    return {
      style, runs: rs.length,
      e1: { median: median(finite(rows.map(r => r.e1))), max: Math.max(...finite(rows.map(r => r.e1))), real: median(finite(rows.map(r => r.e1real))) },
      e2: { median: median(finite(rows.map(r => r.e2))), max: Math.max(...finite(rows.map(r => r.e2))), real: median(finite(rows.map(r => r.e2real))) },
      treeVariants: Object.fromEntries([...new Set(rows.map(r => r.v2 ?? 'none'))].map(k => [k, rows.filter(r => (r.v2 ?? 'none') === k).length])),
      free: median(finite(rows.map(r => r.free))),
      hunt1: { median: median(finite(rows.map(r => r.hunt1))), min: Math.min(...finite(rows.map(r => r.hunt1))), none: rows.filter(r => !Number.isFinite(r.hunt1)).length },
      deaths: { mean: rows.reduce((a, r) => a + r.deaths, 0) / rows.length, died: rows.filter(r => r.deaths > 0).length, survived10: rows.filter(r => r.survived10).length, firstDeath: median(finite(rows.map(r => r.firstDeath))) },
      soundsPer10: { median: median(rows.map(r => r.soundsPer10)), p10: pct(rows.map(r => r.soundsPer10), .1), p90: pct(rows.map(r => r.soundsPer10), .9) },
      minutes: rows.reduce((a, r) => a + r.minutes, 0),
      distances: Object.fromEntries([...new Set(rs.flatMap(r => r.log.sounds.map(x => x.kind)))].map(k => { const d = rs.flatMap(r => r.log.sounds.filter(x => x.kind === k).map(x => x.distance)); return [k, { median: median(d), max: Math.max(...d) }]; })),
      stunCurve: stunCurve(rs.map(r => r.log)),
      presencePer10: median(rows.map(r => r.presencePer10)),
      silence: { median: median(rows.map(r => r.silence)), max: Math.max(...rows.map(r => r.silence)) },
      sightingsFree: median(rows.map(r => r.sightingsFree)), closeInFree: rows.filter(r => r.closeInFree > 0 || r.hunts > 0).length,
      stuns: rows.reduce((a, r) => a + r.stuns, 0), held: rows.flatMap(r => r.held), gained: rows.flatMap(r => r.gained),
      kinds: rows.reduce((a, r) => { for (const [k, n] of Object.entries(r.kinds)) a[k] = (a[k] ?? 0) + n; return a; }, {}),
      violations: rs.flatMap(r => r.violations.map(v => ({ ...v, seed: r.log.seed }))),
    };
  });
  const expectations = [];
  const expect = (style, ok, text) => expectations.push({ style, ok, text });
  for (const s of perStyle) {
    if (s.style === 'careless') expect(s.style, s.deaths.died >= Math.ceil(s.runs * .6), `dies in most nights (${s.deaths.died}/${s.runs})`);
    const band = RULES.deaths[s.style];
    if (band) expect(s.style, s.deaths.mean >= band[0] && s.deaths.mean <= band[1], `deaths per night in ${band[0]}-${band[1]} (mean ${s.deaths.mean.toFixed(2)})`);
    if (s.style === 'smart') {
      expect(s.style, s.deaths.survived10 >= Math.ceil(s.runs * .6), `usually survives the first ten minutes (${s.deaths.survived10}/${s.runs})`);
      expect(s.style, s.closeInFree >= Math.ceil(s.runs * .7), `but is not safe: hunted or seen within 15 m in free roam (${s.closeInFree}/${s.runs})`);
    }
    const [lo, hi] = RULES.soundsPer10, [plo, phi] = RULES.presencePer10;
    expect(s.style, s.soundsPer10.median >= lo && s.soundsPer10.median <= hi, `sounds per ten minutes in ${lo}-${hi} (median ${s.soundsPer10.median.toFixed(1)})`);
    expect(s.style, s.soundsPer10.p90 < RULES.soundsP90Max, `p90 of sounds per ten minutes under ${RULES.soundsP90Max} (p90 ${s.soundsPer10.p90.toFixed(1)})`);
    expect(s.style, s.presencePer10 >= plo && s.presencePer10 <= phi, `ambient (presence) sounds per ten minutes in ${plo}-${phi} (median ${s.presencePer10.toFixed(1)})`);
  }
  return { runs, perStyle, expectations, violations: runs.flatMap(r => r.violations.map(v => ({ ...v, style: r.log.style, seed: r.log.seed }))) };
}

/** The table and the violations, as text. */
export function formatReport(summary) {
  const lines = [];
  const pad = (s, n) => String(s).padEnd(n), num = (x, d = 0) => Number.isFinite(x) ? x.toFixed(d) : '-';
  lines.push(pad('style', 9) + pad('runs', 5) + pad('enc1 med/max', 13) + pad('enc2 med/max', 13) + pad('tree/cross/line', 16) + pad('free', 6) + pad('1st hunt med/min', 17) + pad('deaths avg (died, ok@10)', 25) + pad('snd/10m med p10-p90', 20) + pad('amb/10m', 8) + pad('silence med/max', 16) + pad('viol', 5));
  for (const s of summary.perStyle) {
    const tv = s.treeVariants;
    lines.push(pad(s.style, 9) + pad(s.runs, 5) + pad(`${mmss(s.e1.median)}/${mmss(s.e1.max)}`, 13) + pad(`${mmss(s.e2.median)}/${mmss(s.e2.max)}`, 13)
      + pad(`${tv.tree ?? 0}/${tv.cross ?? 0}/${tv.treeline ?? 0}`, 16) + pad(mmss(s.free), 6)
      + pad(`${mmss(s.hunt1.median)}/${mmss(s.hunt1.min)}${s.hunt1.none ? ` (${s.hunt1.none} none)` : ''}`, 17)
      + pad(`${num(s.deaths.mean, 2)} (${s.deaths.died}, ${s.deaths.survived10})`, 25)
      + pad(`${num(s.soundsPer10.median, 1)} ${num(s.soundsPer10.p10, 1)}-${num(s.soundsPer10.p90, 1)}`, 20) + pad(num(s.presencePer10, 1), 8)
      + pad(`${num(s.silence.median)}/${num(s.silence.max)} s`, 16) + pad(s.violations.length, 5));
  }
  lines.push('', 'sounds by kind (total over the runs; per ten minutes in brackets):');
  const KINDS = ['reveal', 'roar', 'hiss', 'grab', 'clicks', 'branch', 'knock', 'call'];
  lines.push('  ' + pad('style', 9) + KINDS.map(k => pad(k, 13)).join(''));
  for (const s of summary.perStyle) lines.push('  ' + pad(s.style, 9) + KINDS.map(k => pad(`${s.kinds[k] ?? 0} (${num((s.kinds[k] ?? 0) / Math.max(.1, s.minutes) * 10, 1)})`, 13)).join(''));
  lines.push('sound distance from the player, median/max m: ' + summary.perStyle.map(s => `${s.style} ${Object.entries(s.distances).map(([k, d]) => `${k} ${num(d.median)}/${num(d.max)}`).join(' ')}`).join(' | '));
  const helds = summary.perStyle.flatMap(s => s.held), gained = summary.perStyle.flatMap(s => s.gained);
  if (helds.length) lines.push(`stuns: ${helds.length}, held ${[...new Set(helds.map(h => h.toFixed(1)))].sort().join('/')} s, distance gained over a stun median ${num(median(gained), 1)} m (p10 ${num(pct(gained, .1), 1)}, p90 ${num(pct(gained, .9), 1)})`);
  const allCurves = summary.perStyle.flatMap(s => s.stunCurve ? [s.stunCurve] : []);
  if (allCurves.some(c => c.n)) {
    const n = allCurves.reduce((a, c) => a + c.n, 0), blocked = allCurves.reduce((a, c) => a + c.blocked, 0);
    const k = allCurves[0].median.length, curve = Array.from({ length: k }, (_, i) => median(allCurves.flatMap(c => Number.isFinite(c.median[i]) ? Array(Math.max(1, c.n - c.blocked)).fill(c.median[i]) : [])));
    lines.push(`stun speed through a charge stopped by the torch (${n} stuns, ${blocked} touching a trunk left out), median m/s every .1 s from the pin:`);
    lines.push('  ' + curve.map((v, i) => `${(i / 10).toFixed(1)}:${num(v, 1)}`).join(' '));
    lines.push(`  steepest drop between two samples .1 s apart: ${num(Math.max(...allCurves.map(c => c.worstDrop)), 1)} m/s`);
  }
  lines.push('', 'expectations:');
  for (const e of summary.expectations) lines.push(`  ${e.ok ? 'ok  ' : 'FAIL'} ${e.style}: ${e.text}`);
  lines.push('', `violations: ${summary.violations.length}`);
  const byRule = {};
  for (const x of summary.violations) (byRule[x.rule] ??= []).push(x);
  for (const [rule, list] of Object.entries(byRule)) {
    lines.push(`  ${rule}: ${list.length}`);
    for (const x of list.slice(0, 6)) lines.push(`    ${x.style} seed ${x.seed}: ${x.detail}`);
  }
  return lines.join('\n');
}
