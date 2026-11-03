import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnReducer } from "../src/trueforge/events";
import { Batcher } from "../src/ui/batcher";
import type { ChatItem } from "../src/ui/protocol";
import { Transcript } from "../src/ui/transcript";
import { shouldStickToBottom } from "../src/ui/webview/scroll";
import { delta, modelMessage, turnCreated } from "./helpers/events";

afterEach(() => vi.useRealTimers());

describe("streaming 5,000 deltas", () => {
  it("posts a bounded number of webview messages (at most one per 30 ms) and ends with the complete text", () => {
    vi.useFakeTimers();
    const batches: ChatItem[][] = [];
    const transcript = new Transcript();
    const reducer = new TurnReducer();
    const flushTimes: number[] = [];
    const base = Date.now();
    const instrumented = new Batcher<ChatItem>((items) => {
      flushTimes.push(Date.now() - base);
      batches.push(items);
    }, 30);

    for (const e of [turnCreated(), modelMessage({ id: "m1" })]) reducer.apply(e);
    const N = 5000;
    let expected = "";
    for (let i = 0; i < N; i++) {
      const token = `t${i} `;
      expected += token;
      const change = reducer.apply(delta({ id: "m1", content: token, ...(i === N - 1 ? { finish: "stop" } : {}) }));
      for (const item of transcript.applyTurn(reducer.view, change)) instrumented.push(item);
      vi.advanceTimersByTime(1); // 5,000 deltas over 5 seconds of virtual time
    }
    vi.advanceTimersByTime(100);

    const elapsed = N + 100;
    expect(batches.length).toBeLessThanOrEqual(Math.ceil(elapsed / 30) + 1);
    expect(batches.length).toBeGreaterThan(50); // it does stream, it is not one big batch
    for (let i = 1; i < flushTimes.length; i++) expect((flushTimes[i] ?? 0) - (flushTimes[i - 1] ?? 0)).toBeGreaterThanOrEqual(30);
    // every batch holds the single assistant item (coalesced by id), and the last one has the full text
    expect(batches.every((b) => b.length === 1)).toBe(true);
    const last = batches.at(-1)?.[0];
    expect(last).toMatchObject({ kind: "assistant", streaming: false });
    expect(last && last.kind === "assistant" ? last.text : "").toBe(expected);
  });

  it("pushing 5,000 times schedules ONE timer per interval, not one per delta", () => {
    vi.useFakeTimers();
    const batcher = new Batcher<{ id: string }>(() => undefined, 30);
    for (let i = 0; i < 5000; i++) batcher.push({ id: "a" });
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(30);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("auto-scroll", () => {
  it("sticks to the bottom only when the user is at (or within 80 px of) the bottom", () => {
    expect(shouldStickToBottom(1000, 600, 400)).toBe(true); // exactly at the bottom
    expect(shouldStickToBottom(1000, 540, 400)).toBe(true); // 60 px above
    expect(shouldStickToBottom(1000, 500, 400)).toBe(false); // 100 px above: the user is reading
    expect(shouldStickToBottom(300, 0, 400)).toBe(true); // content shorter than the view
  });
});
