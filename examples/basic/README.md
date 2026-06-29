# Basic example

A complete, runnable @vamp game: a Cloudflare Workers Durable Object hosting the
ECS, tempo RPC over hibernatable WebSockets, area-of-interest broadcast, and a
Solid read-replica client. Use it as the reference wiring for the whole stack.

## Run it

From the repo root, install once, then work inside this directory:

```bash
vp install                      # install workspace deps (from repo root)

cd examples/basic
pnpm run generate               # parse schema/*.bop -> src/game.generated.ts
pnpm run dev                    # wrangler dev (serves ws://localhost:8787/v1/game?ns=room1)
```

Connect a client to `ws://localhost:8787/v1/game?ns=<room>`. Everything in the
query string except `ns` is forwarded to the DO as the runtime context seed (see
`resolveContext` in `src/index.ts`).

## Tests & benchmark

```bash
pnpm test          # rpc.test.ts — boots real `wrangler dev` and drives RPC e2e
pnpm run test:e2e  # game.solid.test.tsx — Solid client against the live worker (jsdom)
pnpm run bench     # stress.bench.ts — fixed-timestep ECS throughput benchmark
```

> `pnpm test` and `test:e2e` spawn `wrangler dev` (workerd), so they need the
> Cloudflare runtime available and take longer than a unit test.

## How it's wired

```
schema/*.bop ──(config generate)──▶ src/game.generated.ts + src/bebop.ts
                                          │
   src/systems.ts        registerGameSystems(world)   ← ECS systems + behaviors
   src/rpc.service.ts    @TempoService RPC impl + interest broadcast hooks
   src/observe-routing.ts  per-connection mutation routing
   src/index.ts          worker entry: defineGameECSRuntime(...) + Hono upgrade
                          handler; exports the GameECS + GameStorage DO classes
```

- **`schema/`** — the bebop source of truth. `entity.bop`, `actions.bop`,
  `state.bop`, `tags.bop` are listed in `vamp.json`; `mutation.bop` + `rpc.bop`
  feed the RPC/mutation wire types. Editing these and re-running `pnpm run
generate` regenerates `src/game.generated.ts` (and `bebopc` regenerates
  `src/bebop.ts`). Both generated files are committed and checked in CI.
- **`wrangler.jsonc`** — binds two Durable Objects: `GameECS` (the runtime) and
  `GameStorage` (yjs `y-durablestream` persistence), with the `nodejs_compat`
  flag.
- **Config:** `vamp.json` (schemas → `outFile`) drives `@vamp/config`;
  `bebop.json` drives `bebopc`.

See the package READMEs for the building blocks: [`@vamp/ecs`](../../packages/ecs),
[`@vamp/worker`](../../packages/worker), [`@vamp/solid`](../../packages/solid),
[`@vamp/utils`](../../packages/utils), [`@vamp/config`](../../tools/config).
