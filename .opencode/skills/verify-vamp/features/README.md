# Vamp verification map

This directory is the maintained source for verifying the user-facing behavior of vamp. Read this index before driving anything, then use the matching feature file as the recipe.

## Baseline preconditions

- Run `vp install` and `vp run -r build` from the repo root. `@vampgg/*` resolve through `dist/`, and the `vamp` CLI runs from `tools/cli/dist/vamp.mjs`.
- Bring up an instance with `control-vamp up` and export the `VAMP_RUN_ID` it prints.
- Run `control-vamp doctor` and require every check green before driving.
- Never drive an instance this run did not start. `control-vamp runs` shows what is live.

## Driving conventions

- `control-vamp` means `node .opencode/skills/verify-vamp/scripts/control-vamp.mjs`, run from the repo root.
- Mint a fresh namespace per scenario with `newNs(label)`. A namespace is one durable object and its state persists for the life of the run.
- Wait on an observable event with `waitFor`, never a fixed sleep, except when settling before asserting an absence.
- Prefer the harness helpers in `scenarios/harness.mts` over hand-rolled channels; they encode the connect URL and the entity shape the behaviors require.
- Treat every quoted route, method name, and flag as literal.
- Write proof through `artifact(name, data)` so it survives `control-vamp down`.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final value.
- Game proof includes the RPC response and the streamed mutation that followed it.
- CLI proof includes argv, exit code, stdout, stderr, and the resulting file tree. `control-vamp cli` records all five.
- Pool changes stream as signed deltas. Assert the delta, not an absolute total.
- Record the feature ID and the entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition. Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with control-vamp` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Join a lobby](./join-lobby.md) covers the websocket upgrade, spawning a player, insert streaming, and per-lobby world context.
- [Combat actions](./combat-actions.md) covers `act` behaviors: attack, heal, and the area-attack cascade to children.
- [World tick](./world-tick.md) covers `tick` driving the regen, movement, and hostile-aggro systems.
- [Interest routing](./interest-routing.md) covers see-all versus interest-filtered observers and area-of-interest isolation.
- [Character shards](./character-shards.md) covers cross-lobby shard propagation and the `GET /v1/characters/:id` snapshot.
- [Codegen CLI](./codegen-cli.md) covers `vamp init` and `vamp generate` in a scratch project.
