import { afterEach, describe, expect, it, vi } from "vitest";
import { raceWithBoundedTimer } from "../src/reconcile-helpers.ts";

/**
 * Unit tests for the `ready()` timer lifecycle (proposal 05 step 3), exercised
 * through the extracted `raceWithBoundedTimer` helper that `ready()` delegates
 * to. The load-bearing guarantee: the fallback `setTimeout` is cleared on BOTH
 * the fast path (the pending promise wins) and the slow path, so no live timer
 * outlives the call (a pending timer keeps the isolate resident and fights
 * hibernation), and `onTimeout` fires only when the timer genuinely elapses.
 */

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("raceWithBoundedTimer (ready() timer lifecycle)", () => {
  it("clears the timer and does NOT run onTimeout when pending wins (fast path)", async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const onTimeout = vi.fn();

    let resolvePending!: () => void;
    const pending = new Promise<void>((r) => {
      resolvePending = r;
    });

    const race = raceWithBoundedTimer(pending, 10_000, onTimeout);
    // Seeding completes well before the timeout.
    resolvePending();
    await race;

    expect(clearSpy).toHaveBeenCalledTimes(1); // fallback timer cleared on exit
    // Advancing past the timeout must NOT fire onTimeout (timer was cleared).
    vi.advanceTimersByTime(20_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("runs onTimeout exactly once and clears the timer on a stalled completion", async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const onTimeout = vi.fn();

    // A pending promise that never resolves on its own.
    const pending = new Promise<void>(() => {});

    const race = raceWithBoundedTimer(pending, 10_000, onTimeout);
    await vi.advanceTimersByTimeAsync(10_000);
    await race;

    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(clearSpy).toHaveBeenCalledTimes(1);
    // Further time does not re-fire it (single-shot).
    vi.advanceTimersByTime(20_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("does not leak a pending timer after resolving (no timer outlives the call)", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    let resolvePending!: () => void;
    const pending = new Promise<void>((r) => {
      resolvePending = r;
    });

    const race = raceWithBoundedTimer(pending, 5_000, onTimeout);
    resolvePending();
    await race;

    // vitest tracks pending fake timers; after the race settles there must be
    // none left armed.
    expect(vi.getTimerCount()).toBe(0);
  });
});
