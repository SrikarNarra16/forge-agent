/** Cut-off points for `--cancel-at random`: one per bucket (stratified), shuffled with a seed, so a handful of trials covers the whole run. */
const BUCKETS: Record<"a" | "b", ReadonlyArray<readonly [number, number]>> = {
  // Task B: orientation / reading / first review / edits applied / running tests
  b: [[2, 8], [8, 20], [20, 40], [40, 80], [80, 150]],
  // Task A is short (one edit in ~30 s)
  a: [[1, 3], [3, 6], [6, 12], [12, 20], [20, 30]],
};

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomCuts(n: number, seed: number, task: "a" | "b"): number[] {
  const random = rng(seed);
  const buckets = BUCKETS[task];
  const picks = Array.from({ length: n }, (_v, i) => {
    const [lo, hi] = buckets[i % buckets.length] ?? [1, 10];
    return Math.round((lo + random() * (hi - lo)) * 10) / 10;
  });
  for (let i = picks.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [picks[i], picks[j]] = [picks[j] as number, picks[i] as number];
  }
  return picks;
}
