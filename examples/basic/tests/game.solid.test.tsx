/** @jsxImportSource solid-js */
import type { ChildProcess } from "node:child_process";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { ConsoleLogger, TempoLogLevel } from "@tempojs/common";
import { createEntity, createQuery, createWorld, GameProvider, useConnection } from "@vampgg/solid";
import { TempoWSChannel } from "@vampgg/utils/ws-channel";
import { For } from "solid-js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Actions, Attack, Entity, MutationScope, RpcClient } from "../src/bebop";
import { components, createECSOptions } from "../src/game.generated";
import { startWranglerDev, waitFor } from "./support/server";

let port: number;
let proc: ChildProcess;
const openChannels: TempoWSChannel[] = [];

beforeAll(async () => {
  const dev = await startWranglerDev();
  proc = dev.proc;
  port = dev.port;
});

afterAll(async () => {
  proc?.kill("SIGINT");
  await new Promise((r) => setTimeout(r, 500));
  proc?.kill("SIGKILL");
});

afterEach(() => {
  cleanup();
  for (const channel of openChannels.splice(0)) channel.close();
});

/** A fresh read-replica world + websocket channel + client for one namespace. */
function connect(ns: string) {
  const world = createWorld(createECSOptions(() => crypto.randomUUID()));
  const channel = TempoWSChannel.forAddress(`ws://127.0.0.1:${port}/v1/game?ns=${ns}`, {
    logger: new ConsoleLogger(crypto.randomUUID().slice(0, 8), TempoLogLevel.None),
  });
  openChannels.push(channel);
  return { world, channel, client: channel.getClient(RpcClient) };
}

function makeEntity(points: number) {
  const id = crypto.randomUUID();
  return {
    id,
    entity: Entity({
      id,
      tags: [],
      children: [],
      health: { points, min: 0, max: points, rate: 0, interval: 0 },
    }),
  };
}

/** Open a global observe stream (no viewer → server delivers every mutation). */
const observeAll = (client: RpcClient) => client.observe(MutationScope({}));

/**
 * Renders every health-bearing entity. Propless on purpose: `createQuery` reads
 * the world via context, so the same component reflects whichever `<GameProvider>`
 * it is mounted under.
 */
function HealthList() {
  const entities = createQuery<Entity>((q) => q.every(components.health));
  return (
    <ul>
      <For each={entities()}>{(entity) => <li>{`${entity.id}:${entity.health?.points}`}</li>}</For>
    </ul>
  );
}

describe("@vampgg/solid against a live worker", () => {
  it("renders a spawned entity through createQuery", async () => {
    const { world, client } = connect(crypto.randomUUID());

    render(() => (
      <GameProvider world={world} client={client} open={observeAll}>
        <HealthList />
      </GameProvider>
    ));

    const { id, entity } = makeEntity(100);
    await client.spawn(entity);

    expect(await screen.findByText(`${id}:100`, undefined, { timeout: 10_000 })).toBeTruthy();
  });

  it("reflects a streamed health update fine-grained after act()", async () => {
    const { world, client } = connect(crypto.randomUUID());

    render(() => (
      <GameProvider world={world} client={client} open={observeAll}>
        <HealthList />
      </GameProvider>
    ));

    const { id, entity } = makeEntity(100);
    await client.spawn(entity);
    expect(await screen.findByText(`${id}:100`, undefined, { timeout: 10_000 })).toBeTruthy();

    await client.act(Actions.fromAttack(Attack({ source: id, target: id, damage: 30 })));
    expect(await screen.findByText(`${id}:70`, undefined, { timeout: 10_000 })).toBeTruthy();
  });

  it("exposes a single entity via createEntity and a live connection status", async () => {
    const { world, client } = connect(crypto.randomUUID());
    const { id, entity } = makeEntity(100);

    function Conn() {
      const status = useConnection();
      return <span>{status()}</span>;
    }
    function EntityView() {
      const e = createEntity<Entity>(() => id);
      return <span>{e()?.health?.points ?? "none"}</span>;
    }

    render(() => (
      <GameProvider world={world} client={client} open={observeAll}>
        <Conn />
        <EntityView />
      </GameProvider>
    ));

    expect(await screen.findByText("open", undefined, { timeout: 10_000 })).toBeTruthy();

    await client.spawn(entity);
    expect(await screen.findByText("100", undefined, { timeout: 10_000 })).toBeTruthy();
  });

  it("broadcasts a spawn to two providers sharing a namespace", async () => {
    const ns = crypto.randomUUID();
    const a = connect(ns);
    const b = connect(ns);

    render(() => (
      <>
        <GameProvider world={a.world} client={a.client} open={observeAll}>
          <HealthList />
        </GameProvider>
        <GameProvider world={b.world} client={b.client} open={observeAll}>
          <HealthList />
        </GameProvider>
      </>
    ));

    const { id, entity } = makeEntity(80);
    await a.client.spawn(entity);

    await waitFor(() => (screen.queryAllByText(`${id}:80`).length === 2 ? true : undefined), {
      label: "spawn rendered in both providers",
      timeout: 10_000,
    });
    expect(screen.queryAllByText(`${id}:80`).length).toBe(2);
  });
});
