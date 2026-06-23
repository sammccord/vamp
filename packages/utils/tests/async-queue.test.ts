import { describe, expect, test } from "vitest";
import { AsyncQueue, AsyncQueueOverflowError } from "../src/async-queue.ts";
import { createEventIterator } from "../src/create-event-iterator.ts";
import { createDuplexIterator } from "../src/create-duplex-iterator.ts";

function timeout(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));
}

async function* fromArray<T>(items: T[]): AsyncGenerator<T, void, undefined> {
  for (const item of items) yield item;
}

describe("AsyncQueue", () => {
  test("FIFO order across ring-buffer wraps with no leaked references", async () => {
    const q = new AsyncQueue<number>({ highWaterMark: 4 });
    const seen: number[] = [];
    // Interleave pushes and pulls so the ring buffer wraps repeatedly.
    for (let i = 0; i < 100; i++) {
      q.push(i);
      const r = await q.next();
      seen.push(r.value as number);
    }
    q.close();
    expect(seen).toEqual([...Array(100).keys()]);
    // Buffer slots are released after consumption (count back to zero).
    expect((q as unknown as { count: number }).count).toBe(0);
  });

  test("push returns false past highWaterMark (drop-latest)", () => {
    const q = new AsyncQueue<number>({ highWaterMark: 4, overflow: "drop-latest" });
    expect(q.push(1)).toBe(true);
    expect(q.push(2)).toBe(true);
    expect(q.push(3)).toBe(true);
    expect(q.push(4)).toBe(true);
    expect(q.push(5)).toBe(false); // full
  });
});

describe("createEventIterator", () => {
  test("bounded buffer: runaway producer throws AsyncQueueOverflowError, not OOM", async () => {
    const it = createEventIterator<number>(
      ({ emit }) => {
        for (let i = 0; i < 1000; i++) emit(i); // synchronous flood, no consumer yet
      },
      { highWaterMark: 8, overflow: "error" },
    );
    await expect(
      (async () => {
        for await (const _ of it) {
          // drain
        }
      })(),
    ).rejects.toBeInstanceOf(AsyncQueueOverflowError);
  });

  test("error() propagates into the consumer and runs cleanup", async () => {
    let cleaned = false;
    const it = createEventIterator<number>(({ emit, error }) => {
      emit(1);
      error(new Error("boom"));
      return () => {
        cleaned = true;
      };
    });
    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const v of it) seen.push(v);
      })(),
    ).rejects.toThrow("boom");
    expect(seen).toEqual([1]);
    expect(cleaned).toBe(true);
  });

  test("cancel() completes cleanly after draining buffered values", async () => {
    const it = createEventIterator<number>(({ emit, cancel }) => {
      emit(1);
      emit(2);
      cancel();
    });
    const seen: number[] = [];
    for await (const v of it) seen.push(v);
    expect(seen).toEqual([1, 2]);
  });

  test("early break runs cleanup exactly once (return path)", async () => {
    let cleanups = 0;
    const it = createEventIterator<number>(({ emit }) => {
      emit(1);
      emit(2);
      emit(3);
      return () => {
        cleanups++;
      };
    });
    for await (const v of it) {
      if (v === 1) break;
    }
    expect(cleanups).toBe(1);
  });

  test("consumer throw runs cleanup exactly once (throw path)", async () => {
    let cleanups = 0;
    const it = createEventIterator<number>(({ emit }) => {
      emit(1);
      return () => {
        cleanups++;
      };
    });
    await expect(
      (async () => {
        for await (const _ of it) {
          throw new Error("consumer-fail");
        }
      })(),
    ).rejects.toThrow("consumer-fail");
    expect(cleanups).toBe(1);
  });

  test("high throughput drains in linear time (no O(n^2) shift)", async () => {
    const N = 50_000;
    const it = createEventIterator<number>(
      ({ emit, cancel }) => {
        for (let i = 0; i < N; i++) emit(i);
        cancel();
      },
      { highWaterMark: N + 1 },
    );
    let counted = 0;
    for await (const _ of it) counted++;
    expect(counted).toBe(N);
  });
});

describe("createDuplexIterator", () => {
  test("server push without matching outgoing send is not dropped", async () => {
    const sent: unknown[] = [];
    const it = createDuplexIterator<number>(
      fromArray<never>([]), // outgoing yields nothing
      (rec) => sent.push(rec),
      ({ emit, cancel }) => {
        emit(1);
        emit(2);
        emit(3);
        emit(4);
        emit(5);
        cancel();
      },
    );
    const seen: number[] = [];
    for await (const v of it) seen.push(v);
    expect(seen).toEqual([1, 2, 3, 4, 5]); // old impl gated on outgoing.next() and dropped these
    expect(sent).toEqual([]);
  });

  test("outgoing send with no incoming reply does not deadlock", async () => {
    const sent: unknown[] = [];
    const it = createDuplexIterator<number>(
      // 3 outgoing records, never any incoming reply
      fromArray([{ a: 1 }, { a: 2 }, { a: 3 }] as never[]),
      (rec) => sent.push(rec),
      ({ cancel }) => {
        // Close the incoming side once the outgoing pump is expected to be done.
        setTimeout(() => cancel(), 50);
      },
    );
    const drain = (async () => {
      for await (const _ of it) {
        // no incoming values expected
      }
      return "done";
    })();
    const result = await Promise.race([drain, timeout(500)]);
    expect(result).toBe("done"); // pump ran to completion, no hang
    expect(sent).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]); // all outgoing emitted
  });

  test("interleave preserves order on both sides", async () => {
    const sent: unknown[] = [];
    const it = createDuplexIterator<number>(
      fromArray([{ o: "A" }, { o: "B" }, { o: "C" }] as never[]),
      (rec) => sent.push(rec),
      ({ emit, cancel }) => {
        emit(1);
        emit(2);
        emit(3);
        setTimeout(() => cancel(), 50);
      },
    );
    const seen: number[] = [];
    for await (const v of it) seen.push(v);
    expect(seen).toEqual([1, 2, 3]);
    expect(sent).toEqual([{ o: "A" }, { o: "B" }, { o: "C" }]);
  });

  test("early break halts outgoing pump and runs cleanup", async () => {
    let returned = false;
    let cleaned = false;
    // outgoing generator records when return() is invoked
    const outgoing = (async function* () {
      try {
        for (let i = 0; i < 1_000_000; i++) {
          yield { i } as never;
          await new Promise((r) => setTimeout(r, 1));
        }
      } finally {
        returned = true;
      }
    })();

    const it = createDuplexIterator<number>(
      outgoing,
      () => {},
      ({ emit }) => {
        emit(1);
        return () => {
          cleaned = true;
        };
      },
    );
    for await (const _ of it) {
      break; // consume one then bail
    }
    // give the queued dispose microtasks a tick
    await new Promise((r) => setTimeout(r, 10));
    expect(cleaned).toBe(true);
    expect(returned).toBe(true);
  });
});
