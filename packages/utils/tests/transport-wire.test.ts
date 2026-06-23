import { describe, expect, test } from "vitest";
import { Message } from "../src/bebop.ts";

/**
 * Plan 04 (a): the worker transport must `.slice()` an encoded frame before
 * transferring its ArrayBuffer, because `Message.encode(...)` returns a view
 * into bebop's process-wide singleton write buffer. Transferring that view's
 * buffer detaches the singleton and breaks the next encode in the same isolate.
 */
describe("transport wire correctness (plan 04)", () => {
  test("slice() before transfer keeps the bebop singleton write buffer intact", () => {
    const a = Message({
      messageId: "11111111-1111-1111-1111-111111111111",
      data: new Uint8Array([1, 2, 3]),
    });
    const b = Message({
      messageId: "22222222-2222-2222-2222-222222222222",
      data: new Uint8Array([4, 5, 6]),
    });

    const frameA = Message.encode(a).slice(); // owns a fresh ArrayBuffer
    // Simulate the postMessage transfer of frameA's buffer.
    structuredClone(frameA, { transfer: [frameA.buffer] });
    expect(frameA.byteLength).toBe(0); // the SLICE's buffer was detached, as expected

    // The singleton write buffer is untouched, so the next encode still works.
    const frameB = Message.encode(b).slice();
    const decodedB = Message.decode(frameB);
    expect(decodedB.messageId).toBe("22222222-2222-2222-2222-222222222222");
    expect([...decodedB.data!]).toEqual([4, 5, 6]);

    // And frameA's bytes (captured before transfer via a copy) round-trip too.
    const frameA2 = Message.encode(a).slice();
    expect([...Message.decode(frameA2).data!]).toEqual([1, 2, 3]);
  });

  test("a fresh Message per frame does not carry a stale CANCELLED status", () => {
    const init = Message({ messageId: "33333333-3333-3333-3333-333333333333", methodId: 7 });
    // Data frames are built by spreading init WITHOUT mutating it.
    const dataFrame = Message({ ...init, data: new Uint8Array([9]) });
    const terminal = Message({ ...init, status: 1 /* CANCELLED */, data: new Uint8Array() });

    expect(dataFrame.status).toBeUndefined(); // no leaked terminal status
    expect(dataFrame.methodId).toBe(7); // fields preserved via spread
    expect(terminal.status).toBe(1);
    expect(init.status).toBeUndefined(); // shared init never mutated
  });
});
