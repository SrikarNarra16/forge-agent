/**
 * Re-fires the CodeLens change event ONLY while VS Code has not asked the provider for the document yet.
 *
 * Why not simply fire after the diff opened: measured on 4 Nov 2026 in the real VS Code (30 rounds each), a re-fire at +250 ms
 * discards the lens that is already drawn and delays it from 0.43 s to 0.69 s, and a later one would make it blink while
 * someone clicks it. So the normal path (VS Code asks for lenses as soon as the editor is created) must not be touched; only
 * the unusual case "no request has arrived" gets a nudge, at most `delaysMs.length` times. Pure and vscode-free; returns a
 * function that cancels the pending checks.
 */
export function refreshUnlessAsked(fire: () => void, wasAsked: () => boolean, alive: () => boolean, delaysMs: readonly number[] = [600, 1500]): () => void {
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  for (const delay of delaysMs) {
    timers.push(
      setTimeout(() => {
        if (alive() && !wasAsked()) fire();
      }, delay),
    );
  }
  return () => {
    for (const t of timers) clearTimeout(t);
  };
}
