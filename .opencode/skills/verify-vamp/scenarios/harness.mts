import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConsoleLogger, TempoLogLevel } from "@tempojs/common";
import { TempoWSChannel } from "@vampgg/utils/ws-channel";
import { Entity, RpcClient } from "../../../../examples/basic/src/bebop";

export const PORT = Number(process.env.VAMP_PORT);
export const BASE_URL = process.env.VAMP_URL ?? `http://127.0.0.1:${process.env.VAMP_PORT}`;
export const ARTIFACTS = process.env.VAMP_ARTIFACTS ?? "";

if (!PORT) throw new Error("VAMP_PORT is unset; drive this scenario with `control-vamp drive`");

/** A fresh namespace, so each scenario gets its own GameECS durable object. */
export function newNs(label: string): string {
  return `${label}-${crypto.randomUUID().slice(0, 8)}`;
}

export function connect(
  ns: string,
  extraQuery = "",
): { channel: TempoWSChannel; client: RpcClient } {
  const channel = TempoWSChannel.forAddress(
    `ws://127.0.0.1:${PORT}/v1/game?ns=${ns}${extraQuery}`,
    { logger: new ConsoleLogger(crypto.randomUUID().slice(0, 8), TempoLogLevel.None) },
  );
  return { channel, client: channel.getClient(RpcClient) };
}

export function makeEntity(overrides: Partial<Entity> = {}): Entity {
  return Entity({
    id: crypto.randomUUID(),
    tags: [],
    children: [],
    health: { points: 100, min: 0, max: 100, rate: 0, interval: 0 },
    ...overrides,
  });
}

export async function waitFor<T>(
  poll: () => T | undefined | Promise<T | undefined>,
  { timeout = 10_000, label = "condition" }: { timeout?: number; label?: string } = {},
): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await poll();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

export function collect<T>(stream: AsyncGenerator<T>): { seen: T[]; stop: () => Promise<void> } {
  const seen: T[] = [];
  const pump = (async () => {
    for await (const item of stream) seen.push(item);
  })();
  return {
    seen,
    stop: async () => {
      await stream.return(undefined as never);
      await pump.catch(() => {});
    },
  };
}

/** Survives `control-vamp down`, which deletes run state but keeps artifacts. */
export function artifact(name: string, data: unknown): string {
  if (!ARTIFACTS) throw new Error("VAMP_ARTIFACTS is unset");
  mkdirSync(ARTIFACTS, { recursive: true });
  const path = join(ARTIFACTS, name);
  const body =
    typeof data === "string"
      ? data
      : JSON.stringify(data, (_k, v) => (v instanceof Map ? Object.fromEntries(v) : v), 2);
  writeFileSync(path, `${body}\n`);
  return path;
}
