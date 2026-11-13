import { createQueue } from "./support/stream-queue.ts";
import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import { GameProvider } from "../src/provider.ts";
import { createWorld } from "../src/world.ts";
import { frame, insert, options } from "./fixture.ts";
import type { TestDelta, TestEntity } from "./fixture.ts";
import type { WireBatch } from "../src/types.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("GameProvider reconnect", () => {
  it("drops entities missing from the snapshot that opens a new stream", async () => {
    const world = createWorld(options());
    const streams = [
      createQueue<WireBatch<TestEntity, TestDelta>>(),
      createQueue<WireBatch<TestEntity, TestDelta>>(),
    ];
    let opened = 0;

    const dispose = createRoot((dispose) => {
      GameProvider<TestEntity, TestDelta, null>({
        world,
        client: null,
        reconnectDelay: 0,
        open: async () => streams[opened++].iterator,
      });
      return dispose;
    });

    await sleep(10);
    streams[0].push(frame(["a", insert({ id: "a", hp: 1 })], ["b", insert({ id: "b", hp: 2 })]));
    await sleep(10);
    expect([...world.entities.keys()].sort((x, y) => x.localeCompare(y))).toEqual(["a", "b"]);

    // The connection drops; "b" is deleted while the client is offline.
    streams[0].fail(new Error("connection closed"));
    await sleep(10);
    expect(opened).toBe(2);
    streams[1].push(frame(["a", insert({ id: "a", hp: 1 })]));
    await sleep(10);
    expect([...world.entities.keys()]).toEqual(["a"]);

    dispose();
  });
});
