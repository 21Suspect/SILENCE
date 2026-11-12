import type * as THREE from 'three';

/**
 * Streaming props reach the GPU in three costly ways: their textures (three 4096 px maps for a cabin), their shader programs, and
 * the first draw that needs both. Left to the first draw, a prop coming into range stalls one frame for 100-200 ms or more. This
 * queue does the same work earlier and in small pieces, one texture (or a few tiles of one) or one light state's programs at a time,
 * with a pause after each piece proportional to what it cost, so the average frame barely notices and no single frame carries a
 * whole model.
 *
 * The queue is pure scheduling (see tests/gpu-warmup.test.mjs); createGpuWarmup wires it to a renderer.
 */
export type WarmStep = { kind: 'texture'; texture: THREE.Texture } | { kind: 'compile'; object: THREE.Object3D; state: number };
/** What a texture piece achieved: finished, did a piece and has more, or could not start yet (its image is still arriving). */
export type PieceStatus = 'done' | 'more' | 'wait';
export type WarmTask = {
  label: string;
  textures: readonly THREE.Texture[];
  /** What to build shader programs for (the model's source scene) and how many light states there are to cover. */
  object?: THREE.Object3D;
  /** Whether the thing is already wanted on screen: it then gets the quicker duty cycle. */
  urgent?: () => boolean;
  /** True once the thing is gone (disposed): its remaining pieces are dropped. */
  cancelled?: () => boolean;
  /** Called once every piece is done (or the task was dropped), so whatever draws it can be shown. */
  onDone?: () => void;
};
export type WarmQueueOptions = {
  /** Shortest pause between pieces, ms. */
  minGap?: number;
  /** Pause after a piece, as a multiple of what the piece cost: 4 spends one frame in five on warming. */
  idlePause?: number;
  /** The same for a task that is already wanted. */
  urgentPause?: number;
  states?: number;
};

type Entry = { task: WarmTask; textures: THREE.Texture[]; state: number; waits: number };

export function createWarmQueue(options: WarmQueueOptions = {}) {
  const { minGap = 40, idlePause = 4, urgentPause = .25, states = 1 } = options;
  const entries: Entry[] = [];
  let readyAt = -Infinity, executed = 0;
  const wanted = (e: Entry) => !!e.task.urgent?.();
  const finish = (e: Entry) => { const i = entries.indexOf(e); if (i >= 0) entries.splice(i, 1); e.task.onDone?.(); };
  const complete = (e: Entry) => !e.textures.length && (!e.task.object || e.state >= states);
  return {
    add(task: WarmTask) {
      const entry: Entry = { task, textures: [...new Set(task.textures)], state: 0, waits: 0 };
      if (complete(entry)) { task.onDone?.(); return; }
      entries.push(entry);
    },
    get pending() { return entries.length; },
    get executed() { return executed; },
    /**
     * The next piece of work if the pause has passed. The caller runs it and reports back with `finished(cost, endedAt, status)`:
     * `cost` in ms, and for a texture piece the status it returned ('more' and 'wait' keep the texture at the front of its task).
     */
    next(now: number): { step: WarmStep; label: string; urgent: boolean; finished: (cost: number, endedAt: number, status?: PieceStatus) => void } | undefined {
      for (let i = entries.length - 1; i >= 0; i--) if (entries[i].task.cancelled?.()) { const [gone] = entries.splice(i, 1); gone.task.onDone?.(); }
      if (!entries.length || now < readyAt) return undefined;
      // Wanted-now tasks first, otherwise first come first served.
      const entry = entries.find(wanted) ?? entries[0], urgent = wanted(entry);
      let step: WarmStep;
      if (entry.textures.length) step = { kind: 'texture', texture: entry.textures[0] };
      else if (entry.task.object && entry.state < states) step = { kind: 'compile', object: entry.task.object, state: entry.state };
      else { finish(entry); return this.next(now); }
      return {
        step, label: entry.task.label, urgent,
        finished: (cost, endedAt, status = 'done') => {
          executed++;
          if (step.kind === 'texture') {
            if (status === 'wait') entry.waits++;
            // A texture that never gets its image is given up on after a while rather than blocking its model forever.
            if (status === 'done' || entry.waits > 600) { entry.textures.shift(); entry.waits = 0; }
          } else entry.state++;
          readyAt = endedAt + (status === 'wait' ? minGap : Math.max(minGap, cost * (urgent ? urgentPause : idlePause)));
          if (complete(entry)) finish(entry);
        },
      };
    },
    clear() { for (const e of entries.splice(0)) e.task.onDone?.(); },
  };
}
export type WarmQueue = ReturnType<typeof createWarmQueue>;

export type GpuWarmupOptions = WarmQueueOptions & {
  /** Do one piece of uploading `texture`. `urgent` says the model is already wanted on screen. */
  upload: (texture: THREE.Texture, urgent: boolean) => PieceStatus;
  /** Build every shader program of `object` as light state `state` (0..states-1) would use it. */
  compile: (object: THREE.Object3D, state: number) => void;
  clock?: () => number;
};

export function createGpuWarmup(options: GpuWarmupOptions) {
  const clock = options.clock ?? (() => performance.now()), queue = createWarmQueue(options);
  const log: { label: string; kind: string; ms: number; status?: string }[] = [];
  const run = (item: NonNullable<ReturnType<WarmQueue['next']>>) => {
    const start = clock();
    let status: PieceStatus = 'done';
    try {
      if (item.step.kind === 'texture') status = options.upload(item.step.texture, item.urgent);
      else options.compile(item.step.object, item.step.state);
    } catch (error) {
      console.warn('SILENCE: GPU warm-up step failed.', error);
      status = 'done';
    }
    const end = clock(), ms = end - start;
    item.finished(ms, end, status);
    if (log.length < 600) log.push({ label: item.label, kind: item.step.kind, ms: +ms.toFixed(2), status });
    return { label: item.label, kind: item.step.kind, ms, status };
  };
  return {
    add: (task: WarmTask) => queue.add(task),
    get pending() { return queue.pending; },
    /** Call once a frame; does at most one piece of work. Returns what it did (for diagnostics). */
    update() { const item = queue.next(clock()); return item ? run(item) : undefined; },
    /** Loading only, while a veil covers the screen: run everything now, without the pauses, for at most `budgetMs`. */
    drain(budgetMs: number) {
      const start = clock();
      while (queue.pending && clock() - start < budgetMs) { const item = queue.next(Infinity); if (!item) break; if (run(item).status === 'wait') break; }
      return queue.pending;
    },
    log: () => log.slice(),
    clear: () => queue.clear(),
  };
}
export type GpuWarmup = ReturnType<typeof createGpuWarmup>;
