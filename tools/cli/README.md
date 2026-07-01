# @vampgg/cli

ECS code generator CLI for @vampgg. Parses Bebop (`.bop`) schemas and emits the
TypeScript ECS components, factories, deltas, and mutation schemas used by a
`@vampgg` game. The binary is `vamp`.

```bash
pnpm add -D @vampgg/cli bebop-tools
```

> **Prerequisite:** `generate` shells out to `bebopc` (from `bebop-tools`). It must
> be resolvable via `npx bebopc`, or `vamp generate` exits with a clear error. Use
> `--skip-bebopc` if you regenerate `src/bebop.ts` separately.

## Commands

### `vamp init [--cwd <dir>]`

Scaffolds a new game's schema: creates `schema/` with template `.bop` files
(`entity.bop`, `actions.bop`, `state.bop`, `tags.bop`) plus `bebop.json` (the
`bebopc` config) and `vamp.json` (the codegen config). Existing files are left
untouched, so it's safe to re-run.

### `vamp generate [--cwd <dir>] [--skip-bebopc] [--watch]`

The codegen pipeline: emit `mutation.bop` (the `EntityDelta` / `MutationScope` wire
types) from your `Entity` message → run `bebopc build` (→ `src/bebop.ts`, skip with
`--skip-bebopc`) → emit the generated TypeScript.

```bash
vamp generate            # one-shot regenerate
vamp generate --watch    # re-run on schema changes (debounced; never drops a change)
```

## Generated output

`vamp generate` runs `bebopc` (which writes `src/bebop.ts`) and then emits **three**
TypeScript files from a single `vamp.json` `outFile` (default `./src/game.generated.ts`):

| File                       | Depends on                                      | Import it from              |
| -------------------------- | ----------------------------------------------- | --------------------------- |
| `game.core.generated.ts`   | `@vampgg/ecs` only                              | anywhere (node, web, tests) |
| `game.worker.generated.ts` | `@vampgg/worker` (imports `cloudflare:workers`) | a Cloudflare Worker only    |
| `game.generated.ts`        | re-exports both (barrel)                        | Worker code / convenience   |

The `game.core.generated.ts` file (component map, `EntityDelta`, `materialize/merge/accumulateDelta`,
`createECSOptions`, the `createGame*` system factories) carries **no** Worker
dependency — import it directly from non-Worker packages to keep `cloudflare:workers`
out of your dependency graph. `game.worker.generated.ts` holds the `GameECS` durable
object, runtime, and interest broadcast. The barrel keeps existing `./game.generated`
imports working. Override the two part-file paths with `coreOutFile` / `workerOutFile`
in `vamp.json`.

### `env` (durable-object bindings type)

The generated `GameECS` exposes an overridable `Env` generic that defaults to
`Cloudflare.Env` (the `wrangler types` bindings interface). For a non-Worker package
that has no wrangler types, set `env` in `vamp.json`:

```jsonc
{
  "outFile": "./src/game.generated.ts",
  "env": "unknown", // or "{}", or a locally-declared bindings type
}
```

### tsconfig / tooling

- **`moduleResolution`**: `nodenext` **or** `bundler` both work — the generated
  relative imports carry explicit `.js` extensions.
- **`verbatimModuleSyntax`**: leave it **off**. The `bebopc`-generated `src/bebop.ts`
  emits a value-style import of the `BebopRecord` type, which `verbatimModuleSyntax`
  rejects. (The `@vampgg/cli`-generated files are themselves compatible; the constraint
  is bebopc's output.)
- **Formatter / linter**: the generated files are overwritten on every run, so add them
  to your ignore globs, e.g. `src/bebop.ts` and `src/*.generated.ts`.

## Configuration

`vamp.json` (`FrameworkConfig`) points the generator at your schema files and output:

```jsonc
{
  "schemas": {
    "entity": "schema/entity.bop",
    "actions": "schema/actions.bop",
    "state": "schema/state.bop",
    "tags": "schema/tags.bop",
    // "mutation": "schema/mutation.bop"   // optional; auto-emitted otherwise
  },
  "outFile": "./src/game.generated.ts",
  // optional: "coreOutFile", "workerOutFile", "bebopConfig", "env"
}
```

`bebop.json` — the `bebopc` config `init` writes alongside it:

```jsonc
{
  "include": ["schema/**/*.bop"],
  "generators": { "ts": { "outFile": "./src/bebop.ts" } },
}
```

See `examples/basic/vamp.json` for a complete config.

## End-to-end workflow

```bash
vamp init                 # scaffold schema/ + configs
# edit schema/*.bop to define your entity, actions, state, tags
vamp generate             # emit src/bebop.ts + the generated TypeScript
```

Then import the generated symbols to wire the world — see
[`@vampgg/worker`](../../packages/worker) for the Durable Object entry and
[`examples/basic/`](../../examples/basic) for the full stack (schema → generated
options → systems → worker → Solid client).

## Programmatic API

The generator is usable as a library (`@vampgg/cli`):

```ts
import { loadVampConfig, loadBebopConfig, generate, generateMutationSchema } from "@vampgg/cli";

const vampConfig = loadVampConfig(cwd);
const bebopConfig = loadBebopConfig(cwd, vampConfig.bebopConfig);
generateMutationSchema(cwd, vampConfig); // emit mutation.bop
const { core, worker, barrel } = generate(cwd, bebopConfig, vampConfig); // emit the TS files
```

Also exported: `parseSchema` / `loadSchemaFromFile` / `loadAndParseSchema`,
`emitMutationSchema`, `resolveMutationPath`, and the `FrameworkConfig` /
`BebopConfig` / `ParsedSchema` types.

## Performance

`vamp generate` emits the framework's fast path — the archetype-graph ECS, additive
CRDT deltas, and interest-routed broadcast that the full-stack benchmark measures
(server frames over 1,024 entities, ~100 µs single-`act` round-trips, 0%-loss
fan-out to dozens of observers, ~18k entities per Durable Object). See
[`@vampgg/worker`](../../packages/worker#performance) for the numbers and how to
reproduce them (`cd examples/basic && pnpm bench`).

## Development

```bash
vp install     # install dependencies
vp test        # run the unit tests
vp run build   # build the CLI
```
