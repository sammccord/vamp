# Codegen CLI

The `vamp` CLI is what a game developer touches. `vamp init` scaffolds a schema directory, four template `.bop` files, and the two config files. `vamp generate` derives the mutation schema, runs `bebopc`, and emits the generated ECS, worker, and barrel modules the game imports.

## Sub-features

- `cli-init-scaffold` creates `schema/`, the four templates, `bebop.json`, and `vamp.json`.
- `cli-init-idempotent` skips every file that already exists and never overwrites.
- `cli-generate-mutation` derives `schema/mutation.bop` from the entity schema.
- `cli-generate-emit` emits the core, worker, and barrel `.generated.ts` modules.
- `cli-generate-skip-bebopc` reuses an existing `src/bebop.ts` instead of rebuilding it.
- `cli-generate-errors` fails with exit code 1 on a missing or invalid `vamp.json`.

## How to get to it (user POV)

- Run `vamp init` in an empty project directory.
- Run `vamp generate` in a project that has `vamp.json` and `bebop.json`.
- Add `--cwd <dir>` to operate on another directory, `--skip-bebopc` to skip the bebop build, `--watch` to regenerate on schema changes.

## Driving it with control-vamp

Preconditions:

- `vp run -r build` has been run, so `tools/cli/dist/vamp.mjs` reflects current source.
- An instance is up, because `control-vamp cli` puts its scratch dirs under that run.

- **Scaffold.** `control-vamp cli --scratch fresh -- init`. Exit code `0`. stdout lists `Created schema/`, the four `.bop` files, `bebop.json`, and `vamp.json`.
- **Prove idempotence.** Run the same command again. Exit code `0`, and every file line now reads `Skipping … (already exists)`. Only the `Created schema/` directory line repeats. The recorded file tree is unchanged.
- **Generate.** `control-vamp cli --scratch fresh -- generate`. Exit code `0`. stdout reports the generated `schema/mutation.bop`, then `src/game.core.generated.ts`, `src/game.worker.generated.ts`, and `src/game.generated.ts`.
- **Confirm the emit.** The recorded `files` array in the artifact holds `bebop.json`, `vamp.json`, the five `schema/*.bop` files including the derived `mutation.bop`, `src/bebop.ts` from `bebopc`, and the three `src/game*.generated.ts` modules.
- **Re-generate without bebopc.** `control-vamp cli --scratch fresh -- generate --skip-bebopc`. Exit code `0`, no `Running bebopc build...` line, and the same emitted files.
- **Fail on a missing config.** `control-vamp cli --scratch bare -- generate`. Exit code `1` and stderr names `vamp.json not found`.
- **Proof.** Each invocation writes `cli-<scratch>-<stamp>.json` into the run's artifacts with argv, cwd, exit code, stdout, stderr, and the resulting file tree.

## Gotchas

- `control-vamp cli` runs the built entry. An edit under `tools/cli/src` is invisible until `vp run -r build`.
- `generate` shells out to `npx --no-install bebopc build`. `control-vamp cli` prepends `examples/basic/node_modules/.bin` to `PATH` so it resolves; running the CLI by hand from an unrelated directory fails with `bebopc not found`.
- `init` never overwrites. To re-test the scaffold path, use a new `--scratch` name rather than editing files in place.
- `generate` always overwrites its three outputs and has no dry-run. Point it at a scratch dir, never at `examples/basic`.
- Scratch dirs are deleted by `control-vamp down`. The JSON records that prove what happened survive.
- Exit code alone is weak proof for `generate`. Assert the emitted file list, which the artifact records.
