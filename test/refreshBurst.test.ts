import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshUnlessAsked } from "../src/review/refreshBurst";

describe("refreshUnlessAsked", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does nothing when VS Code already asked for the lenses (the normal path is not disturbed)", () => {
    const fire = vi.fn();
    refreshUnlessAsked(fire, () => true, () => true);
    vi.advanceTimersByTime(60_000);
    expect(fire).not.toHaveBeenCalled();
  });

  it("fires at +600 ms and +1.5 s while nobody asked, and never more", () => {
    const fire = vi.fn();
    refreshUnlessAsked(fire, () => false, () => true);
    vi.advanceTimersByTime(599);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fire).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(900);
    expect(fire).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60_000);
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("stops once the request arrives (the second check sees it)", () => {
    const fire = vi.fn();
    let asked = false;
    refreshUnlessAsked(fire, () => asked, () => true);
    vi.advanceTimersByTime(600);
    expect(fire).toHaveBeenCalledTimes(1);
    asked = true; // VS Code answered the nudge
    vi.advanceTimersByTime(5000);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("does not fire for a review that is already gone, and can be cancelled", () => {
    const fire = vi.fn();
    refreshUnlessAsked(fire, () => false, () => false);
    vi.advanceTimersByTime(5000);
    expect(fire).not.toHaveBeenCalled();
    const cancel = refreshUnlessAsked(fire, () => false, () => true);
    cancel();
    vi.advanceTimersByTime(5000);
    expect(fire).not.toHaveBeenCalled();
  });
});
