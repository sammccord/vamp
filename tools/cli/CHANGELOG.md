# @vampgg/cli

## 1.0.0-beta.3

### Minor Changes

- 87153a6: `vamp generate`: the generated `GameECS` durable object now exposes an overridable `Env` generic (previously the `ECSDurableObject` `Env` slot was hardcoded to `Cloudflare.Env`). The default is configurable via a new optional `env` field in `vamp.json` (defaults to `"Cloudflare.Env"`, preserving current behavior). Non-Worker packages that lack wrangler types can set `"env": "unknown"` (or a local bindings type) so the generated durable object type-checks without a `Cloudflare.Env` shim.
- 87153a6: `vamp generate`: split the generated output into a pure ECS file and a Worker-runtime file, plus a backward-compatible barrel.

  - `game.core.generated.ts` — component map, `EntityDelta`, delta algebra, `createECSOptions`, and the `createGame*` system factories. Depends only on `@vampgg/ecs`, so it can be imported from non-Worker code (node, web, tests) without pulling `@vampgg/worker` and its `cloudflare:workers` import into the dependency graph.
  - `game.worker.generated.ts` — the `GameECS` durable object, runtime, and interest broadcast. Depends on `@vampgg/worker`.
  - `game.generated.ts` — a barrel re-exporting both, so existing `./game.generated` imports keep working.

  Override the two part-file paths with `coreOutFile` / `workerOutFile` in `vamp.json`. The docs cover the recommended tsconfig (`moduleResolution: nodenext` or `bundler`, and why `verbatimModuleSyntax` must stay off with bebopc output) and formatter-ignore guidance.

  Note (beta): the exported `generate()` now returns `{ barrel, core, worker }` paths instead of a single path string — a breaking change for programmatic API consumers.

### Patch Changes

- 87153a6: `vamp generate`: emit explicit `.js` extensions on the generated relative imports (e.g. `./bebop.js`). The extensionless specifier only resolved under `moduleResolution: bundler`; the `.js` form resolves under `nodenext` too (it maps back to the `.ts` source), so the generated output now type-checks in both module-resolution modes.
- 87153a6: `vamp init`: scaffold the `@vampgg/utils/schema/pool.bop` import as the stable, symlinked `node_modules/@vampgg/utils/…` path instead of the realpath. `require.resolve` previously resolved through pnpm's symlinks and baked a version-pinned `.pnpm/@vampgg+utils@<version>/…` path into `schema/entity.bop`, which broke on any dependency version bump.

## 1.0.0-beta.2

### Patch Changes

- bacbe16: Publish 1.0.0-beta.2 with npm provenance re-enabled now that the source repository is public. No runtime source changes.

## 1.0.0-beta.1

### Patch Changes

- 046a351: Publish 1.0.0-beta.1: exercise the fixed CI/release pipeline (build-before-check, workspace bin linking, changeset-file fmt ignores, unit-only test gate, platform-stable codegen determinism, no-op-safe release commit). No runtime source changes.

## 1.0.0-beta.0

### Major Changes

- 3961d4d: initial release
