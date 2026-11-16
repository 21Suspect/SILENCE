/**
 * What the loading corner (loading-hud.ts) says and how full its bar is, worked out from counts the engine already keeps while the
 * black veil is up: the loading manager's files, the GPU warm-up queue (render/gpu/gpu-warmup.ts) and the whole-scene warm-up
 * draws (engine.ts warmupRender). Pure: no DOM, no three.js, so it runs in Node (tests/ui/loading-progress.test.mjs).
 *
 * The game cannot know up front how much it will load: files arrive in batches, and a prop that streams in late queues more
 * warm-up work. So the bar is an estimate. It only ever moves forward, and it stops short of full until `finish` is called,
 * which the engine does at the moment the veil starts to lift.
 */
export type WarmPiece = { label: string; kind: string };
export type LoadingFrame = {
  /** A batch of files (models, textures, sounds) is still arriving. */
  assetsPending: boolean;
  /** Pieces left in the GPU warm-up queue, and the one it worked on last. */
  queuePending: number;
  queueLast?: WarmPiece;
  /** Whole-scene warm-up draws done, and how many there are (2, or 4 with street lamps). */
  warmupDraws: number;
  warmupTotal: number;
  /** Nothing is arriving and the queue is empty: the next whole-scene draw is about to run, or is running. */
  quiet: boolean;
};
export type LoadingReport = { fraction: number; label: string };

/**
 * How much of the bar each stage owns. A guess from one development-server load, where compiling every shader was the longest
 * single stretch; the rest is kept back for the last wait on the GPU. Retune after measuring on slower machines.
 */
export const LOADING_WEIGHTS = { assets: .3, queue: .25, draws: .4 };
/** The bar stays under this until `finish`: the last wait (the GPU catching up) has no count to show. */
export const LOADING_CAP = .95;

const NOUNS: Record<string, string> = {
  glb: 'Model', gltf: 'Model', bin: 'Model', jpg: 'Texture', jpeg: 'Texture', png: 'Texture', webp: 'Texture', ktx2: 'Texture',
  hdr: 'Sky', mp3: 'Sound', wav: 'Sound', ogg: 'Sound', json: 'Data',
};
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A file's URL as a few plain words: `/world/nature/rock_moss_set_02.glb` becomes "Model · Rock moss set". */
export function describeAsset(url: string): string {
  // A model's own textures are handed to the loaders as blob: or data: URLs, which say nothing about what they are.
  if (/^(blob|data):/i.test(url)) return 'Model textures';
  const path = url.split(/[?#]/)[0], file = path.slice(path.lastIndexOf('/') + 1), dot = file.lastIndexOf('.');
  const ext = dot > 0 ? file.slice(dot + 1).toLowerCase() : '', stem = dot > 0 ? file.slice(0, dot) : file;
  let decoded = stem;
  try { decoded = decodeURIComponent(stem); } catch { /* a stray % in a file name: keep it as it is */ }
  // The trailing number or resolution ("_02", "_4k") tells the reader nothing.
  const words = decoded.replace(/[_\-.]+/g, ' ').replace(/\s+(\d+k?|\d+x\d+)$/i, '').trim();
  const name = capital((words || decoded).toLowerCase()), noun = NOUNS[ext];
  return noun ? `${noun} · ${name}` : name;
}

/** A warm-up piece (a prop's texture upload or shader compile) as a few plain words. */
export function describeWarm({ label, kind }: WarmPiece): string {
  if (label === 'scene') return 'Final shader pass';
  if (label === 'ground variants') return 'Compiling ground shaders';
  return `${kind === 'texture' ? 'Uploading textures' : 'Compiling shaders'} · ${capital(label)}`;
}

export function createLoadingProgress() {
  let loaded = 0, total = 0, lastAsset = '', peakQueue = 0, best = 0, done = false;
  return {
    /** The loading manager's progress callback: one file finished. The counts only grow over a session. */
    asset(url: string, itemsLoaded: number, itemsTotal: number) { loaded = itemsLoaded; total = itemsTotal; lastAsset = describeAsset(url); },
    update(f: LoadingFrame): LoadingReport {
      if (done) return { fraction: 1, label: 'Ready' };
      peakQueue = Math.max(peakQueue, f.queuePending);
      const assets = total > 0 ? Math.min(1, loaded / total) : 0;
      // Before anything has been queued the stage counts as done once nothing is arriving, rather than sitting at nothing.
      const queue = peakQueue > 0 ? 1 - f.queuePending / peakQueue : f.quiet ? 1 : 0;
      const draws = f.warmupTotal > 0 ? Math.min(1, f.warmupDraws / f.warmupTotal) : 0;
      const raw = LOADING_WEIGHTS.assets * assets + LOADING_WEIGHTS.queue * queue + LOADING_WEIGHTS.draws * draws;
      // New work can arrive late (a prop streams in and queues more), which would pull the raw figure back: the bar keeps its place.
      best = Math.max(best, Math.min(LOADING_CAP, raw));
      const allDrawn = f.warmupTotal > 0 && f.warmupDraws >= f.warmupTotal;
      let label: string;
      if (f.quiet && !allDrawn) label = `Compiling shaders (${f.warmupDraws + 1} of ${f.warmupTotal})`;
      // The only thing queued once every draw is done is the whole scene again, in each light state; a stale last piece would misname it.
      else if (allDrawn && f.queuePending > 0) label = 'Final shader pass';
      else if (f.queuePending > 0 && f.queueLast) label = describeWarm(f.queueLast);
      else if (f.assetsPending && lastAsset) label = lastAsset;
      else if (allDrawn) label = 'Almost ready';
      else label = 'Preparing the forest';
      return { fraction: best, label };
    },
    /** The veil is about to lift: the bar is full from here on. */
    finish(): LoadingReport { done = true; best = 1; return { fraction: 1, label: 'Ready' }; },
  };
}

export type LoadingProgress = ReturnType<typeof createLoadingProgress>;
