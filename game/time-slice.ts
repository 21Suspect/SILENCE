/**
 * Long CPU jobs (rebuilding the ring of grass round the player every few metres) are written as generators that `yield` whenever the
 * current slice has used up its budget; the game runs one slice per frame instead of the whole job in one. The job itself stays
 * ordinary code: `if (slice.over()) yield;` at the places where it is safe to stop.
 */
export type Slice = { begin(): void; over(): boolean };

export function createSlice(budgetMs: number, clock: () => number = () => performance.now()): Slice {
  let start = 0;
  return { begin() { start = clock(); }, over() { return clock() - start >= budgetMs; } };
}

/** Runs one slice of `job`; true once it has finished. */
export function runSlice(job: Generator<void, void, void>, slice: Slice): boolean {
  slice.begin();
  return job.next().done === true;
}

/** Runs `job` to the end in one go (loading, or a jump too far for the old result to be any use). */
export function runToEnd(job: Generator<void, void, void>) {
  while (!job.next().done);
}
