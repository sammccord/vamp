---
name: verify-vamp
description: Drive the vamp framework the way a user does. Boots the examples/basic game worker under wrangler dev and plays it over the real WebSocket RPC surface (spawn, act, tick, observe), and runs the vamp codegen CLI in isolated scratch dirs. Use when proving a change to packages/ecs, packages/worker, packages/utils, packages/solid, tools/cli, or examples/basic actually works at runtime, and when reproducing a reported defect in any of them.
---

# Verify vamp

Vamp has two surfaces a person touches. A **player** connects to a game worker over a WebSocket and issues RPC (`spawn`, `act`, `tick`, `observe`); `examples/basic` is the app that surface belongs to. A **game developer** runs the `vamp` CLI to scaffold schemas and generate ECS code. This skill drives both. The library packages have their own unit suites (`vp run -r test`); a green suite is not a substitute for driving the worker.

Every command below runs from the repo root.

## Launch

One-time, and after any change under `packages/` or `tools/`:

```
vp install
vp run -r build
```

`@vampgg/*` resolve through each package's `dist/`, so an unbuilt source change is invisible to the running worker. Rebuild or you will verify stale code.

Start an instance:

```
node .opencode/skills/verify-vamp/scripts/control-vamp.mjs up
```

`up` spawns `wrangler dev` in `examples/basic` on an ephemeral port with its own `--persist-to` state directory, waits for wrangler's `Ready on http://…` line, and prints an instance record plus the `VAMP_RUN_ID` to export. Concurrent runs are safe: each gets its own port, inspector port, durable-object state, and artifacts directory. Every later command finds the instance from `--run <id>`, `VAMP_RUN_ID`, or the sole live run.

`up` fails loudly on a wrangler build error, an early exit, or a 120 s timeout, and prints the tail of `wrangler.log`.

## Doctor

```
node .opencode/skills/verify-vamp/scripts/control-vamp.mjs doctor
```

Read-only. Exits non-zero if any check fails. It asserts the recorded pid is alive, that `GET /v1/game` without an upgrade header answers `426 Expected Upgrade: websocket` (proof the port is our worker and not a leftover process), that `wrangler.log` holds no `[ERROR]`, that HEAD still matches the sha the worker was launched from, that `examples/basic` and `packages` are unchanged since launch, and that every workspace `dist/` exists.

Run it first whenever a result looks wrong. A stale-sha or dirty-sources failure means the running worker predates your edit; take the instance down and bring up a new one.

## Drive

### The game surface

Scenarios live in `.opencode/skills/verify-vamp/scenarios/` as vitest files ending in `.scenario.mts`. Run one:

```
node .opencode/skills/verify-vamp/scripts/control-vamp.mjs drive join-lobby
```

The argument is a scenario name, a path relative to the cwd, or an absolute path. `drive` runs it through `scenario.config.mts` with `VAMP_PORT`, `VAMP_URL`, `VAMP_RUN_ID`, and `VAMP_ARTIFACTS` set, and tees the transcript into the run's artifacts directory.

Write new scenarios against `scenarios/harness.mts`, which owns the connection details:

- `connect(ns, extraQuery?)` opens `ws://127.0.0.1:$VAMP_PORT/v1/game?ns=<ns>` and returns `{ channel, client }`. Everything in `extraQuery` besides `ns` and `character` seeds the lobby's world context on first connect.
- `newNs(label)` mints a fresh namespace. Use it for every scenario. A namespace is one durable object and it persists inside the run's state directory, so reusing a name leaks state between scenarios.
- `makeEntity(overrides?)` builds an entity with a health pool, which every behavior in the example requires.
- `collect(stream)` drains an `observe` stream into a live array and gives you `stop()`.
- `waitFor(poll, { label, timeout })` polls a sync or async predicate. Use it instead of a fixed sleep.
- `artifact(name, data)` writes proof into `$VAMP_ARTIFACTS`.
- `BASE_URL` is the instance's HTTP origin, for the `GET /v1/characters/:id` route.

Read `features/README.md` before driving, then the matching feature file for the recipe.

### The CLI surface

```
node .opencode/skills/verify-vamp/scripts/control-vamp.mjs cli --scratch <name> -- init
node .opencode/skills/verify-vamp/scripts/control-vamp.mjs cli --scratch <name> -- generate
```

`cli` runs the built `tools/cli/dist/vamp.mjs` inside `<run>/scratch/<name>`, with `examples/basic/node_modules/.bin` prepended to `PATH` so the CLI's `npx --no-install bebopc build` step resolves. Rebuild the CLI (`vp run -r build`) after editing `tools/cli/src`; `cli` runs the built entry, not the source. Each invocation records argv, cwd, exit code, stdout, stderr, and the resulting file tree as JSON in the artifacts directory.

## Evidence

Proof lands in `<repo>/.opencode/skills/verify-vamp/.verify/<run-id>/artifacts/`. `control-vamp down` leaves it there.

Standards for a proof that counts:

- Drive the real user path. Connect a socket and call the RPC; do not reach into the ECS through a test-only import.
- Capture the action and the resulting state. A spawn echo is the action; the streamed mutation is the state. Record both.
- Assert the observable side effect, not the RPC return value alone. Health and position arrive on the `observe` stream as **signed deltas**, not absolute values: a 30-damage attack streams `health.points === -30`.
- `observe(MutationScope({}))` is a see-all stream. A one-entry scope keyed by a viewer entity id selects the interest-filtered stream instead; the two prove different things, so name which one you used.
- Never assert an absence without first waiting for a positive event and then settling. `interest-routing.scenario.mts` shows the shape.
- Mock nothing. The worker, the durable objects, and the serialization are all real under `wrangler dev`.

## Cleanup

```
node .opencode/skills/verify-vamp/scripts/control-vamp.mjs down            # the current run
node .opencode/skills/verify-vamp/scripts/control-vamp.mjs down --all      # every recorded run
node .opencode/skills/verify-vamp/scripts/control-vamp.mjs runs            # list, with liveness
```

`down` signals the recorded process group (SIGINT, then SIGKILL) and deletes that run's `wrangler-state/`, `scratch/`, and `instance.json`. It keeps `artifacts/` and `wrangler.log`. Never `pkill wrangler`: it would take out instances this run did not start.

Run `down` after a failed attempt too, so a broken try does not strand a wrangler process on a port.

## Helpers

| Path                       | What it is                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `scripts/control-vamp.mjs` | The executable harness. `up`, `doctor`, `drive`, `cli`, `down`, `runs`.                                  |
| `scenario.config.mts`      | The vitest config `drive` uses. Roots at the repo, includes only `$VAMP_SCENARIO`, inlines `@tempojs/*`. |
| `scenarios/harness.mts`    | Connection, entity, streaming, and artifact helpers for scenarios.                                       |
| `scenarios/*.scenario.mts` | The shipped recipes, one per mapped feature.                                                             |
| `features/`                | The maintained feature map. Start here.                                                                  |
| `.verify/<run-id>/`        | Per-run state and evidence. Gitignored.                                                                  |

`up` and `drive` create `.opencode/skills/verify-vamp/node_modules` as a symlink to `examples/basic/node_modules`. Scenarios sit outside every workspace package, so that link is what lets their bare imports resolve. Delete it and `drive` fails on `Cannot find package '@tempojs/common'`.
