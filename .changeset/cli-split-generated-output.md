---
"@vampgg/cli": minor
---

`vamp generate`: split the generated output into a pure ECS file and a Worker-runtime file, plus a backward-compatible barrel.

- `game.core.generated.ts` — component map, `EntityDelta`, delta algebra, `createECSOptions`, and the `createGame*` system factories. Depends only on `@vampgg/ecs`, so it can be imported from non-Worker code (node, web, tests) without pulling `@vampgg/worker` and its `cloudflare:workers` import into the dependency graph.
- `game.worker.generated.ts` — the `GameECS` durable object, runtime, and interest broadcast. Depends on `@vampgg/worker`.
- `game.generated.ts` — a barrel re-exporting both, so existing `./game.generated` imports keep working.

Override the two part-file paths with `coreOutFile` / `workerOutFile` in `vamp.json`. The docs cover the recommended tsconfig (`moduleResolution: nodenext` or `bundler`, and why `verbatimModuleSyntax` must stay off with bebopc output) and formatter-ignore guidance.

Note (beta): the exported `generate()` now returns `{ barrel, core, worker }` paths instead of a single path string — a breaking change for programmatic API consumers.
