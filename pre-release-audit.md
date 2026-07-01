# Vamp — Final Pre-Release Audit

**Date:** 2026-06-28
**Reviewer focus:** test coverage, DevX clarity, documentation (JSDoc + prose), CI / release flows, code quality, memory leaks.
**Relationship to `audit.md`:** That audit (2026-06-21) covered correctness/perf/leaks. This one re-verifies its leak findings and adds the release-readiness dimensions above.

---

## 0. Remediation Status (applied 2026-06-28)

Fixes landed on branch `chore/pre-release-hardening`. After them: `vp run -r test`
is green across all packages (ecs 152, config 69, worker 23, rot 23, utils 17,
basic 7, solid 3) and `vp check` is clean (192 files formatted, 0 lint warnings,
0 type errors).

**Fixed**

- **B1 — CI ran zero tests / Ready gate failed.** `ci.yml` test step → `pnpm vp run -r test`; root `ready` script → `vp run -r test`. README + the recursive-flag footgun documented.
- **B2 — packages couldn't be published.** Added `publishConfig.access: "public"` to all six packages, bumped them to `0.1.0`, and added a tag-triggered `release.yml` (build → `pnpm -r publish` with provenance, gated on check+test) to pair with `bumpp`.
- **B3 — broken README commands.** Root README commands fixed (`vp run -r test/build`, `vp run dev` repointed; root `dev` script `website#dev` → `basic#dev`); `@vamp/solid` + `@vamp/cli` + the `worker/interest` API now listed.
- **Docs.** Fleshed out the stub `@vamp/ecs` and `@vamp/worker` READMEs (install + accurate usage from the example); fixed every `@vamp/rot` import example (`rot/…` → `@vamp/rot/…`) + title; removed phantom `@vamp/solid` exports; added the `@vamp/utils/async-queue` section; corrected `vp build` → `vp run build` everywhere; wrote `examples/basic/README.md` (run/test steps + wiring map).
- **JSDoc.** Documented the core `@vamp/ecs` consumer API (`entity`/`entities`/`upsert`/`insert`/`put`/`delete`/`query`/`subscribe`/`onCreate`/`onDelete`/`registerBehavior`/`act`), the `query` builder factory, the system factories (and fixed `createEventSystem`'s copy-pasted doc), and the error classes.
- **Code quality.** Removed shipped `console.log` from `@vamp/rot` (`MinHeap`/`features`/`rogue`); deleted the two no-op filler tests; made the env-fragile `tools/cli` scaffolding test deterministic (injectable resolver); lint is now 0/0 (the two unicorn warnings were false positives on deliberate buffer-preallocation / iterate-then-delete snapshots — disabled with justification in `vite.config.ts`).

**Test coverage added (2026-06-28, follow-up)**

- **Worker + extension transports** — `packages/utils/tests/worker-transport.test.ts` (3) and `extension-transport.test.ts` (2): in-process loopback (fake `Worker`/global `postMessage`; mocked `webextension-polyfill`) driving a hand-rolled echo service through a real channel↔router. Covers unary round-trip, `close()` rejecting in-flight calls, transport-death teardown, and (extension) global-listener removal.
- **Durable Object lifecycle** — `packages/worker/tests/ecs-do-lifecycle.do.test.ts` (9): the DO runs in plain Node behind a fake `DurableObjectState`/`env` (the `cloudflare:workers` virtual module is aliased to a stub base in `packages/worker/vite.config.ts`); only the external Yjs sync client (`y-durablestream`) is mocked. Covers: `setup()` persisting namespace/document/context to storage; **seeding the world from the persisted Yjs doc** (current shared layout + legacy-layout migration); local inserts writing through to the doc; **hibernation wake** (constructor restores sessions from socket attachments, re-bootstraps from persisted state, calls `rehydrateConnection` per live socket); cold-start does NOT re-bootstrap; `webSocketClose`/`webSocketError` teardown (session drop + app close hook); and the `alarm()` tick loop running `ecs.update` and rescheduling.
- These run under the normal task graph, so `vp run -r test` (and CI) pick them up — no extra CI step.

**Toolchain finding:** `@cloudflare/vitest-pool-workers` (the ideal real-workerd harness) is currently **incompatible with the vite-plus test runner** — the pool boots miniflare/workerd but the fork's test bundle performs disallowed I/O (`setTimeout`/random) in workerd's global scope (`Disallowed operation called within global scope`). The DO tests therefore run in Node behind fakes. Revisit pool-workers if the runner gains compatibility (it would let the real storage DO + sync protocol be exercised end-to-end).

**Deliberately deferred** (substantial features, not quick fixes — tracked in §9 P1/P2)

- ~~DO-lifecycle tests and worker/extension transport tests~~ — **done** (see "Test coverage added" above). Remaining gap: end-to-end coverage of the real storage DO + Yjs sync protocol, which needs the (currently incompatible) workers pool.
- Coverage tooling in CI — needs a `@vitest/coverage-*` build compatible with the `@voidzero-dev/vite-plus-test` fork; not a drop-in.
- Transport-base extraction and reducing the `@vamp/rot` `@ts-nocheck` surface — structural refactors (the transports are already bug-converged by hand; see §7).
- **Codegen determinism:** running `vamp generate` locally (bebopc 3.2.3) reorders `examples/basic/src/bebop.ts`, which would fail CI's `git diff --exit-code` round-trip. Confirm the locked bebopc matches what generated the committed file (regenerate + commit) or pin bebopc. Pre-existing; left untouched here.

---

## 1. Verdict

**Closer than `audit.md` implied, but NOT releasable yet — for new reasons.**

The bug/leak debt from 2026-06-21 has largely been paid down (11/12 leak blockers fixed, all 7 dead-code items fixed, metadata/types cleaned, lint/fmt/canonical-typecheck green, test count grew from ~112 to ~390). The blockers now are **packaging and process**, not core correctness:

- **CI runs zero tests** and the "Ready gate" step fails — the test commands are wrong.
- **The README's first commands fail** on copy-paste.
- **No publish pipeline**, and scoped packages can't `npm publish` as configured.
- **The two highest-LOC public surfaces (worker DO lifecycle, the worker + extension transports) have ~no tests.**

None of these are deep — most are 1-line fixes — but every one is on the critical path to a first release that real consumers touch.

### Readiness by dimension

| Dimension             | State                                                      | Blockers |
| --------------------- | ---------------------------------------------------------- | :------: |
| Memory leaks          | Good — 11/12 fixed, 1 bounded-partial                      |    0     |
| Code quality          | Good — all 2026-06-21 items fixed; structural debt remains |    0     |
| CI / release flows    | **Broken** — CI tests no-op; no publish path               |    3     |
| Documentation / JSDoc | Gaps — stub READMEs, wrong commands, undoc core API        |    2     |
| Test coverage         | Skewed — core ECS strong, DO + transports untested         |    2     |
| DevX clarity          | Rough on-ramp — broken commands, no example README         |    1     |

---

## 2. Release Blockers (must-fix before publish)

### B1 — CI does not run the test suite (and Ready gate fails)

- `.github/workflows/ci.yml:31` runs `pnpm vp test -r`. Verified locally: this runs vitest **at the repo root**, finds no test files, and **exits 1** (`No test files found`). `vp test` does not recurse; `-r` is not its recursive flag.
- The root `package.json:7` `ready` script (run by CI step "Ready gate", `ci.yml:43`) chains `vp run test -r`, which **fails with `Task "test" not found`** — the flag is in the wrong position.
- **Working form is `vp run -r test`** (flag _before_ the task), which runs all suites. Confirmed: ecs 152, config 69, worker 23, rot ~24, utils ~18, basic 7, solid 3.
- Net effect: CI as written either runs **zero tests** or fails outright. The whole suite is effectively unguarded.
- **Fix:** `ci.yml:31` → `pnpm vp run -r test`; `package.json:7` `ready` → `vp fmt && vp lint && vp run -r test && vp run -r build`.

### B2 — Packages cannot be published as configured

- All six packages are `@vamp/*` (scoped) with **no `publishConfig.access: "public"`**. `npm publish` on a scoped package defaults to a restricted (paid/private) registry entry and **fails for a public release** unless `--access public` is passed or `publishConfig.access` is set.
- All six are stuck at `version: 0.0.0`.
- There is **no publish/release workflow** (`.github/workflows/` has only `ci.yml`), **no changesets**, and `bumpp` is wired per-package with no coordinated bump. There is no story for "how does a tagged release reach npm."
- **Fix:** add `"publishConfig": { "access": "public" }` to each package; choose a release strategy (changesets recommended for a multi-package monorepo) and add a release workflow (tag → build → `npm publish` with provenance). Set a real `0.1.0` starting version.

### B3 — README's first commands fail on copy-paste

- `README.md:29` `vp run test -r` and `:32` `vp run build -r` both fail (same flag-position bug as B1). Correct: `vp run -r test` / `vp run -r build`.
- `README.md:35` `vp run dev` maps to the root `dev` script `vp run website#dev` — **there is no `website` package** in the workspace. Dead command.
- A newcomer following the README hits an error on the first three commands.
- **Fix:** correct the flag position; remove or repoint `dev`.

---

## 3. CI / Release Flows (detail)

What CI does today (`ci.yml`): checkout → pnpm → `vp check` (fmt+lint+typecheck) → `vp test -r` (**no-op, B1**) → codegen round-trip (`generate` + `tsc --noEmit` + `git diff --exit-code`) → `pnpm run ready` (**fails, B1**) → `npm pack --dry-run`.

- `vp check` and `npm pack --dry-run` are good gates. The codegen round-trip is a genuinely strong gate (catches generator drift).
- **No coverage measurement anywhere** — no `@vitest/coverage-*` dep, no `coverage` config, no threshold, no `--coverage` in CI.
- **The example e2e (`examples/basic/tests/rpc.test.ts`) boots real `wrangler dev`** (45s ready timeout). Once B1 is fixed and `vp run -r test` runs everything, this will run in CI and needs the workerd runtime available + is a flake risk. Decide: gate it, or split it into a separate non-blocking job.
- `@vamp/solid`'s actual integration tests (`game.solid.test.tsx`, jsdom + wrangler) use a `test:e2e` script and a `.tsx` extension excluded by the default include — so they **never run in CI** even after B1.
- No Node-version matrix (CI pins Node 22 only; `engines` says `>=22.12.0`).

---

## 4. Test Coverage

Suite is healthy where it's strong and absent where the risk is highest.

**Strong:** `@vamp/ecs` (152) — archetypes, queries, mutations, tags. `tools/cli` (69) — parsers, emitters, codegen round-trip. These are well covered.

**Gaps (ranked by release risk):**

1. **Durable Object lifecycle is untested.** No test imports `ECSDurableObject` (`packages/worker/src/ecs.ts`, ~1194 LOC). The hibernation re-bootstrap (the headline fix from `audit.md`), `webSocketClose`/`webSocketError` → `_teardownConnection`, and the `alarm()` tick loop are exercised by **nobody**. `@cloudflare/vitest-pool-workers` is a devDep but **unused** — `packages/worker` has no `test` block / workers-pool config, so its tests run in plain Node and never instantiate the DO in workerd. The only real DO coverage is the example e2e happy path (no eviction, no teardown assertions, alarm never configured).
2. **Worker + extension transports are 100% untested.** `worker-channel.ts` (712) + `worker-router.ts` (436) and `extension-channel.ts` (658) + `extension-router.ts` (593) have **zero test references**. `transport-wire.test.ts` tests only the bebop `Message` slice/spread invariant, not any channel or router. The ws transport is covered only indirectly via the example e2e; `close()`/teardown and unary timeout/abort paths are asserted by nothing.
3. **`@vamp/solid` ships on 3 headless tests** (registry/store/world). The consumer-facing surface (hooks, `GameProvider`, `useGame`, reactive queries) is covered only by `game.solid.test.tsx`, which CI does not run.
4. **`@vamp/rot`: 7 of 36 exported subpaths tested.** All FOV variants, all map generators, noise, lighting, dijkstra, path are untested (vendored rot.js ports — medium risk, but `audit.md` found vamp-introduced regressions in exactly this package).
5. **Two filler tests** assert nothing: `packages/rot/tests/index.test.ts:3` and `packages/utils/tests/index.test.ts:3` are both `expect(true).toBe(true)`.

**Flaky / environment-dependent:** `tools/cli/tests/scaffolding.test.ts:176` asserts `resolvePoolImport` returns the literal fallback `../node_modules/@vamp/utils/schema/pool.bop`, which only holds when `@vamp/utils` is unresolvable from the OS temp dir. When the temp dir sits under (or shares a `node_modules` ancestor with) the repo, real Node resolution finds the workspace symlink and returns a deep machine-specific relative path — the test fails (reproduced locally). The product behavior is fine for real consumers; the **test** is env-fragile. No `.skip`/`.only`/`.todo` anywhere.

---

## 5. Documentation / JSDoc

**JSDoc coverage is inverted from where consumers need it.**

- Best: `@vamp/worker` `interest.ts` (every export documented), `@vamp/solid` hooks (100%).
- **Flagship `@vamp/ecs` has the weakest doc on the most-used methods.** Class-level docs are excellent, but the daily-driver API is undocumented in source: `entity/entities/upsert/insert/put/delete/query/subscribe/onCreate/onDelete/act/actWithBubbling/parent/unparent` (`ECS.ts`), the entire query builder (`Query.ts`), the behavior factories (`System.ts: createBehavior/createLifecycleSystem`), the error classes (`Errors.ts`), and `MutationRecord`/mutation types (`types.ts`).
- `@vamp/utils` transports and `@vamp/rot` top-level exports are thinly doc'd in source (README compensates partially).

**READMEs:**

- **Root `README.md`:** lists only 4 of 6 packages (omits `@vamp/solid` and `tools/cli`/`@vamp/cli`); never mentions the `@vamp/worker` `./interest` API; broken commands (B3).
- **`packages/ecs/README.md`:** stub (title + 1 line + dev). No install-as-dependency, no usage, no API — for the flagship package.
- **`packages/worker/README.md`:** stub. Omits `ECSDurableObject`, `defineECSRuntime`, and `./interest` — the exact things consumers extend/call.
- **`packages/rot/README.md`:** best prose in the repo, but **every import example is wrong** — uses bare `rot/...` (e.g. `import { RNG } from "rot/rng"`) when the package is `@vamp/rot` (must be `@vamp/rot/rng`). All 32 specifiers unusable. Title `# rot`.
- **`packages/utils/README.md`:** good/thorough, but no section for the `./async-queue` export.
- **`packages/solid/README.md`:** good, but documents **phantom exports** that don't exist: `createQueryObservable`, `createEntityObservable`, `defaultApply`.
- **`examples/basic/`:** **no README** — only a generic `AGENTS.md`. The root README points newcomers here as "a complete working example," but there are zero run steps (`vp install` → `vamp generate` → `wrangler dev`).
- Several READMEs say `vp build` where the build script is `vp pack` / `vp run build` (`vp build` runs Vite build, not the package script).
- Working docs `audit.md` and `TODO.md` sit in the repo root and probably shouldn't ship in the first public release.

No leftover template text (`tsdown-starter`/`Author Name`) — that 2026-06-21 finding is fixed.

---

## 6. DevX Clarity

- **The on-ramp is broken end-to-end:** README first commands fail (B3), the example it points to has no README, and the documented test/build commands are wrong everywhere they appear (flag position + `vp build` vs `vp run build`).
- The `vp run <task> -r` vs `vp run -r <task>` distinction is a real footgun — it bit the README, the `ready` script, and CI simultaneously. Worth a one-line note in CLAUDE.md/README ("recursive flag goes before the task").
- Once running, the ECS API is discoverable by types but not by docs (§5).
- `examples/basic` is the strongest DevX asset (real e2e, interest API, multi-client) — it just needs a README to be usable.

---

## 7. Code Quality

**All 2026-06-21 code-quality findings are fixed.** Verified removed/corrected: `actToSubtree` alias, duplicate `credential`/`maxRetryAttempts` assignments, `.catch(()=>{})` swallow → `.catch(reject)`, `context-logger` global-registry clobber → scoped delete, `pino-logger` now honors `logLevel`, `error.ts` copies input before mutating, `cloudflare-shims.d.ts` now generic/typed.

**Lint/fmt/typecheck:** `vp check` exits 0. `vp lint`: 0 errors, 11 cosmetic `unicorn` warnings (`no-useless-spread` ×6, `no-new-array` ×5). `vp fmt --check`: clean (191 files). Per-package `tsc --noEmit` clean **except** the generated `packages/utils/src/bebop.ts` (TS6133 unused `BebopRuntimeError`, TS1484 type-only import) — generated by bebopc; tolerated by `vp check` but the committed generated source doesn't pass strict standalone `tsc`.

**Remaining structural debt (not blockers, but a public framework should plan these):**

1. **Transport triplication unresolved.** ws/worker/extension channels+routers = ~3825 LOC across 6 files, ~55%+ identical, **no shared base** extracted. The divergent-bug theme from `audit.md` was fixed by **hand-syncing** all three (duplex now consistently checks `message.status`; `previousAttempts` consistent) — so they're correct _today_, but every future transport fix must still land 3×.
2. **`@vamp/rot` ships fully untyped:** all 23 `@ts-nocheck` files live in `packages/rot/src` — the entire public pathfinding/FOV/mapgen surface has typechecking disabled.
3. **Codegen emits `as any`** into generated delta/merge code (`emit-helpers.ts:26,75,99`), and generated `bebop.ts` fails strict `tsc`.
4. **Debug `console.log` shipping in the `@vamp/rot` library:** `MinHeap.ts:127`, `map/features.ts:200,301`, `map/rogue.ts:232`.
5. **God-files:** `ECS.ts` (1339), `worker/ecs.ts` (1194) — large single-class files; `ws-channel.ts:34-68` carries a brittle 12× `@ts-expect-error` monkeypatch into `websocket-ts` internals.
6. Type-safety markers overall: 23 `@ts-nocheck`, 23 `@ts-expect-error`, 20 `@ts-ignore`, 15 `as unknown as`, 7 `as any`.

---

## 8. Memory Leaks (re-verification of `audit.md`)

11 of 12 leak/teardown blockers from 2026-06-21 are **fixed**; 1 is a **bounded partial** (not a blocker):

| #   | Leak                                                 | Status      | Evidence                                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | DO dead after hibernation                            | FIXED       | `worker/ecs.ts:333,339,354` re-bootstrap via `blockConcurrencyWhile` + persisted `__vamp:namespace`                                                                                                                                                                            |
| 2   | Stream/observer leak on disconnect                   | FIXED       | `webSocketClose`+`webSocketError` → `_teardownConnection` (`ecs.ts:1069,1092-1107`)                                                                                                                                                                                            |
| 3   | `deletedEntities` grows forever                      | FIXED       | ring cap 1024 (`ECS.ts:298,1165-1168`)                                                                                                                                                                                                                                         |
| 4   | behavior caches not evicted                          | FIXED       | `deleteEntity` deletes cache entries (`ECS.ts:1162-1163`)                                                                                                                                                                                                                      |
| 5   | `registerBehavior` stale cache                       | FIXED       | clears + rebuilds (`ECS.ts:841-842`)                                                                                                                                                                                                                                           |
| 6   | `createEventIterator` unbounded/lost-errors/`shift`  | FIXED       | rebuilt on `AsyncQueue` (ring buffer, bounded, error channel)                                                                                                                                                                                                                  |
| 7   | `createDuplexIterator` hang/drops                    | FIXED       | decoupled pump (`create-duplex-iterator.ts:47-55`)                                                                                                                                                                                                                             |
| 8   | Channels never tear down                             | FIXED       | `close()` rejects pending + removes listeners (all 3 channels); socket close/error wired                                                                                                                                                                                       |
| 9   | Worker transport transfers shared buffer             | FIXED       | `Message.encode(...).slice()` before transfer (all send sites)                                                                                                                                                                                                                 |
| 10  | `ready()` 10s timer leak                             | FIXED       | `raceWithBoundedTimer` clears in `.finally`                                                                                                                                                                                                                                    |
| 11  | `clientStreams`/`serverStreams` reaped only in catch | **PARTIAL** | client streams now `.finally` + `closeConnection()` sweep; `ws-router.ts:448` server-stream `delete` still not in a strict `finally`, so a generator that throws mid-stream leaks its entry until socket close. Bounded to one connection's lifetime — cleanup, not a blocker. |
| 12  | extension `onMessage` listener never removed         | FIXED       | removed in `close()` (`extension-channel.ts:92`)                                                                                                                                                                                                                               |

---

## 9. Prioritized Punch List

**P0 — release blockers (mostly 1-line):**

1. Fix CI test command `ci.yml:31` and the `ready` script → `vp run -r test` (B1).
2. Add `publishConfig.access:"public"` to all 6 packages; pick a release strategy + workflow; set real versions (B2).
3. Fix README commands: flag position, `vp build`→`vp run build`, dead `vp run dev` (B3); fix `@vamp/rot` README imports (`rot/`→`@vamp/rot/`).

**P1 — should-fix before consumers arrive:** 4. Add a workers-pool test config to `@vamp/worker` and test the DO lifecycle (hibernation re-bootstrap, close/error teardown, alarm tick). 5. Add basic tests for worker + extension transports (close/teardown, timeout/abort, duplex cancel). 6. Write `examples/basic/README.md` (run steps); flesh out `@vamp/ecs` and `@vamp/worker` READMEs with install + minimal usage. 7. Document the core `@vamp/ecs` API with JSDoc (the query/mutation/behavior methods). 8. Fix the env-fragile `scaffolding.test.ts` assertion; delete the two filler `index.test.ts` files. 9. Run `@vamp/solid`'s real integration tests in CI.

**P2 — structural debt / quality:** 10. Add coverage measurement (+ a soft threshold) to CI. 11. Extract a shared transport base (or accept the 3× cost and document it). 12. Remove `console.log` from `@vamp/rot`; reduce `@ts-nocheck` surface; fix generated-code strict-`tsc` issues. 13. Remove `audit.md`/`TODO.md` from the published tree; add a Node-version matrix to CI.

---

_Bottom line: the engine is sound and the 2026-06-21 correctness/leak debt is paid. What stands between this and a usable first release is the packaging-and-process layer — CI that actually tests, a publish path, working docs, and tests for the DO + transports that real multiplayer load will hit first._
