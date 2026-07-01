# Vamp Framework — Source Code Audit

**Date:** 2026-06-21
**Scope:** All hand-written TypeScript under `{examples,packages,tools}/src/**/*.ts`.
**Reviewer focus:** Correctness, bugs, performance (game-loop / real-time backend), and simplicity.
**Goal:** Assess readiness to productionize this framework for public use.

---

## 1. Executive Summary

**Verdict: NOT production-ready.** The architecture is sound and the happy paths work (the example app runs end-to-end and 111/112 ECS tests pass), but every core subsystem contains at least one correctness or resource-leak defect that will surface under real, sustained, multiplayer load — exactly the conditions this framework targets. There are **11 critical** issues that are release blockers, including a Durable Object that is permanently dead after hibernation eviction, two foundational async-iterator primitives with unbounded memory growth and a permanent-hang path, a turn-scheduler heap that silently mis-orders events, and a non-functional dungeon generator.

The defects cluster into four recurring themes (see §9): **(a)** resources that are created but never torn down (listeners, pending requests, stream generators, map entries, timers); **(b)** the Cloudflare Durable Object hibernation lifecycle not being honored; **(c)** three near-identical transport implementations (`ws-*`, `worker-*`, `extension-*`) that were copy-pasted and then diverged, so bug fixes landed in one variant but not the others; and **(d)** a regex-based code generator that silently emits wrong output on valid-but-unanticipated input.

### Production-readiness by package

| Package                                 | Verdict                       | Critical | High | Medium | Low |
| --------------------------------------- | ----------------------------- | :------: | :--: | :----: | :-: |
| `@vamp/ecs`                             | Blocked                       |    4     |  5   |   4    |  5  |
| `@vamp/worker`                          | Blocked                       |    3     |  5   |   4    |  3  |
| `@vamp/utils` (transports)              | Blocked                       |    3     |  4   |   5    |  3  |
| `@vamp/utils` (async primitives & misc) | Blocked                       |    3     |  3   |   4    |  3  |
| `tools/cli`                             | Blocked for untrusted schemas |    2     |  4   |   4    |  5  |
| `@vamp/rot`                             | 2 vamp-introduced regressions |    2     |  2   |   3    |  2  |

> Counts are indicative; the same root cause sometimes spans multiple files (e.g. the duplex `request.status` bug appears in all three routers).

### Excluded from audit (generated / vendored)

- `packages/utils/src/bebop.ts`, `examples/basic/src/bebop.ts`, `examples/basic/src/game.generated.ts` — bebopc/codegen output.
- `packages/rot/**` is a TypeScript port of the open-source **rot.js** library. It was audited for _real_ defects only; each rot finding is tagged **upstream** (inherited from rot.js) or **vamp-introduced** (a regression in this port).

---

## 2. Methodology & Independent Verification

Findings were produced by deep per-package review and then the headline items were **independently re-verified against the source and the test suite**:

| Claim                                                                  | How verified                             | Result                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ECS tag reconcile drops `add` when combined with `remove`              | Ran `vp test packages/ecs`               | **Confirmed** — `tests/index.test.ts:2237` fails: `put with object delta { add, remove } reconciles incrementally` (1 failed / 111 passed). Root cause read at `ECS.ts:486`.                                                                               |
| `create-event-iterator` unbounded queue + `shift()` + no error channel | Read full file                           | **Confirmed** (`create-event-iterator.ts:11,43,33-36`).                                                                                                                                                                                                    |
| `create-duplex-iterator` couples outgoing to incoming and can hang     | Read full file                           | **Confirmed** (`create-duplex-iterator.ts:40-54`).                                                                                                                                                                                                         |
| `MinHeap.remove` only sifts down                                       | Read full file                           | **Confirmed** (`MinHeap.ts:67-73`).                                                                                                                                                                                                                        |
| `emit-delta` maps `float64 → bigint`                                   | Read source                              | **Confirmed** (`emit-delta.ts:34`).                                                                                                                                                                                                                        |
| `Digger._digCallback` never registers walls                            | Read source                              | **Confirmed** (`digger.ts:134-139`, no `else` branch).                                                                                                                                                                                                     |
| Worker dead after hibernation eviction                                 | Read constructor + handlers + call sites | **Confirmed** — constructor (`ecs.ts:147-165`) restores `sessions` but never re-bootstraps `ecs`/`router`; `setup()` is only invoked from the HTTP upgrade (`examples/basic/src/index.ts:41`); `webSocketMessage` (`ecs.ts:643`) throws `"uninitialized"`. |
| Worker transport transfers a shared encode buffer                      | Read send paths                          | **Confirmed** — `worker-router.ts:337,346,366,407` and `worker-channel.ts:205,235,277,290` do `postMessage(encoded, [encoded.buffer])` where `encoded` is a view into bebop's process-wide singleton `writeBuffer`.                                        |

### Correction issued during verification

One initial finding — _"a single shared `response` Message is corrupted by concurrent requests in `ws-router`"_ — was **downgraded as largely incorrect**: `webSocketMessage` allocates a fresh `Message({})` per inbound message (`ecs.ts:645`), so concurrent calls do not share a `response` object, and `ws-router` already copies encoded bytes (`new Uint8Array(Message.encode(response))`) before `ws.send`. The _genuine_ aliasing defect is the **`postMessage` buffer-transfer in the worker transport** (verified above), which detaches bebop's singleton write buffer and breaks the next encode in the same isolate. The audit reflects the corrected version.

Severity legend: **CRITICAL** = data loss / crash / leak that breaks production; **HIGH** = wrong behavior or unbounded cost under load; **MEDIUM** = correctness gap or perf cost in plausible cases; **LOW** = simplicity / minor / defense-in-depth.

---

## 3. Consolidated Critical Blockers (must-fix before any public release)

1. **DO is permanently dead after hibernation eviction** — `worker/ecs.ts:147-165` (re-bootstrap missing).
2. **Server-stream / observer sinks leak on disconnect** — `worker/ecs.ts:648-661`, no stream teardown on close/error.
3. **`webSocketError` does no cleanup at all** — `worker/ecs.ts:659-661`.
4. **ECS tag reconcile drops added tags** (failing test) — `ecs/ECS.ts:486`.
5. **Unbounded memory growth in ECS** — `deletedEntities` and behavior/archetype caches never pruned — `ecs/ECS.ts:51,55-63,865`.
6. **Stale behavior cache after `registerBehavior`** silently ignores behaviors — `ecs/ECS.ts:565-582`.
7. **`createEventIterator` unbounded buffer + lost errors** — `utils/create-event-iterator.ts`.
8. **`createDuplexIterator` can permanently hang and drops messages** — `utils/create-duplex-iterator.ts:40-54`.
9. **Channels never tear down**: pending requests hang forever, listeners leak — `utils/ws-channel.ts`, `worker-channel.ts` (no `close()`).
10. **Worker transport transfers the shared bebop write buffer**, detaching it — `utils/worker-router.ts` / `worker-channel.ts`.
11. **`MinHeap.remove` corrupts the heap → scheduler mis-orders turns**, and **`Digger` produces a degenerate map** — `rot/MinHeap.ts:67-73`, `rot/map/digger.ts:134-139`.

---

## 4. `@vamp/ecs` — Entity-Component-System core

**Assessment:** The archetype-graph design is conceptually sound, but it ships with a failing test, several unbounded-memory leaks that degrade any long-running session, a stale-cache correctness bug, and a pooled-array scheme that hands live recycled arrays to callers. Multiple "optimizations" (whole-graph rescans, per-frame array spreads, the array pool) are net negatives.

### CRITICAL

- **`ECS.ts:486` — Correctness — Combined `{add, remove}` tag delta drops the added tags.** The `remove` branch does `targetTags = currentTags.filter(...)`, rebuilding from `currentTags` and discarding the tags appended by the preceding `add` loop (481-485). This is the cause of the one failing test. **Fix:** filter the already-built array: `if (d.remove) targetTags = targetTags.filter((t) => !d.remove!.includes(t));`
- **`ECS.ts:51,865` — Bug — `deletedEntities` Set grows forever.** One entry is added per delete and never pruned. A game that spawns/despawns per frame (projectiles, particles) leaks indefinitely. **Fix:** drop the set entirely (use `entityArchetype.has` for liveness) or clear it at end of each update cycle.
- **`ECS.ts:55-63,625-629 — Bug — `archetypeBehaviorCache`/`entityBehaviorCache` never evicted.** Keyed by archetype / entity id, never deleted on `deleteEntity`. Both grow unbounded. **Fix:** delete `entityBehaviorCache`/`_deferredCacheRebuilds` entries in `deleteEntity`; invalidate `archetypeBehaviorCache` on behavior-set changes.
- **`ECS.ts:565-582` — Correctness — `registerBehavior` after init never invalidates caches.** New behaviors are silently ignored for already-cached archetypes; tests only pass because they manually call `rebuildBehaviorCache`. **Fix:** clear the behavior caches (or mark all entities for deferred rebuild) on `registerBehavior`.

### HIGH

- **`ECS.ts:291-302,374-386` — Bug — Pooled array handed to callers is also recycled for event systems.** `query()` returns a pooled array but never reclaims it, while `_executeEventSystem` returns its array to the pool right after `execute()`. A system that retains the `entities` reference sees it mutated next frame. **Fix:** make the contract explicit (always copy on escape, or never recycle escaping arrays); given games copy anyway, consider removing the pool.
- **`Archetype.ts:84-120` — Performance — Full archetype-graph rescan on every new transform.** Cache-miss transitions call `traverseArchetypeGraph` over the whole reachable graph (O(n) each → O(n²) discovery). **Fix:** keep a global `Map<string, Archetype>` (id → archetype) for O(1) lookup; the id string is already computed.
- **`ECS.ts:405-417` — Performance — `_tryAddArchetypeToQueries` rebuilds a flattened systems array every call.** Spreads `systems`, `subscriptions`, `handleCreate`, `handleDelete`, and `behaviors.values().flat()` whenever a novel archetype appears (hot path of component mutation). **Fix:** iterate each collection in place, or maintain one precomputed list updated on (un)register.
- **`ECS.ts:661-664` — Performance — `update()` spreads each archetype's entity Set into a fresh array every frame.** `system.execute([...arch.entities], ...)` allocates N×M arrays/frame. **Fix:** reuse a per-system scratch buffer, or iterate the Set directly.
- **`ECS.ts:856-868` — Bug — `deleteEntity` leaves the entity in `entityBehaviorCache`/`_deferredCacheRebuilds`.** Combined with id reuse (826), a recycled entity inherits a stale behavior cache. **Fix:** delete both entries in `deleteEntity`.

### MEDIUM

- **`ECS.ts:766-799` — Correctness — Nested `withScope` flushes inner mutations to the base store instead of merging up into the parent**, breaking transactional atomicity. **Fix:** nested scopes should merge coalesced mutations into the parent; only the outermost scope flushes.
- **`ECS.ts:181-197 / Query.ts:10-18,164-166` — Performance — `upsert` builds a fresh `Query` and full-graph traversal per call**, and matchers are nested closures (`.every`/`.some`) re-allocated per archetype test. **Fix:** cache queries by component-set key; flatten matchers into a monomorphic loop.
- **`ECS.ts:200-217` — Correctness — `insert()` mutates the caller's `entity.id` and fires event systems before recording the insert mutation**, so observers can see an entity whose archetype is set but whose data isn't committed. **Fix:** stage/record the insert before firing lifecycle/event systems; don't mutate the caller's object.
- **`Archetype.ts:79-99` — Correctness/robustness — `transformArchetype` mutates a shared mask in place (`flip`/`flip` back) during graph traversal**; not re-entrant, and `Object.freeze` is shallow so the mask isn't protected. **Fix:** compute the next id from a cloned mask without mutating the live one.

### LOW

- `ECS.ts:692,727` — `entityCache?.get(tag) || []` allocates a new empty array per entity per event; use a shared frozen `EMPTY`.
- `ECS.ts:711-713` — `actToSubtree` is a redundant alias of `act`; remove.
- `ECS.ts:884-895` — `transformEntity` doesn't schedule a behavior-cache rebuild; cache goes stale after a transform.
- `ECS.ts:99-114` — the `string[][]` array pool adds risk for marginal benefit (uses `Array.from({length})` holey arrays, silent <1000 cap, leaks via `query()`); prefer one or two long-lived scratch buffers.
- `ECS.ts:36` / `MutationScope.ts:37-55` — a top-level `TODO` on the core generic signature plus `structuredClone` on every scoped insert (expensive, throws on non-cloneable values); lock the public API and document cloneability.

---

## 5. `@vamp/worker` — Cloudflare Durable Object integration

**Assessment:** The most serious defects are lifecycle-related. The DO accepts hibernatable WebSockets but never re-initializes its runtime on wake, so it is dead after the first eviction; server-stream RPCs and observer sinks are never torn down on disconnect; and the yjs reconciliation has several gaps (no awareness, lost remote updates during the pre-seed window, component deletions not propagated into the archetype graph). There is also no `alarm()`/tick loop despite this being a game runtime.

### CRITICAL

- **`ecs.ts:147-165` — Correctness — DO is dead after hibernation eviction.** The constructor restores `sessions` from hibernating sockets but never re-runs `setup()`/`initialize()`; `ecs`, `router`, `doc`, `client`, `_seeded` all reset to field initializers. `setup()` is only called on the initial HTTP upgrade (`examples/basic/src/index.ts:41`). After eviction, the next message hits `webSocketMessage` → `throw new Error("uninitialized")` (`ecs.ts:643`) and all in-memory state is gone. **Fix:** persist the namespace to `ctx.storage` in `initialize()`; in the constructor, if `ctx.getWebSockets().length`, `ctx.blockConcurrencyWhile(() => this.setup(persistedNamespace))`.
- **`ecs.ts:648-657` — Bug — Server-stream RPCs and observer sinks leak on disconnect.** `webSocketClose` only does `sessions.delete` + `ws.close`; it never cancels in-flight streams, so the module-level `observers` set and the router's `clientStreams` map grow across reconnects and every broadcast calls `ws.send` on dead sockets. **Fix:** track per-socket stream generators/messageIds and drive them to `return()` (so the iterator `finally` unsubscribes) on close/error; delete `clientStreams` entries.
- **`ecs.ts:659-661` — Correctness — `webSocketError` does no cleanup.** Errored sockets stay in `sessions`/`observers` forever and keep receiving broadcasts. **Fix:** mirror `webSocketClose` cleanup (delete, cancel streams, close).

### HIGH

- **`ecs.ts:435-440` — Correctness — `onStatusChange` registered after `synced` already fired → seeding never runs.** `connect()` runs under `waitUntil` and can reach `synced` before the listener is attached; the listener doesn't replay current state, so `_seedFromDoc` is skipped and the 10s fallback force-inits an **empty** ECS, losing persisted entities. **Fix:** re-check `client.synced` immediately after subscribing and seed if already synced; ideally expose a `whenSynced()` promise.
- **`ecs.ts:464-489` — Correctness — Remote doc updates between seed and observer attachment are lost.** The array/entity observers attach only after `synced`, so updates applied during the initial sync burst are silently dropped from the ECS. **Fix:** attach observers before initial sync and seed by diffing once synced.
- **`ecs.ts:285-327,564-615` — Correctness — Remote "update" reconcile drops component _deletions_.** The delta is built as `delta: entity` (the whole object); a removed component is just an absent key, which `mergeDelta` treats as "no change", and the per-entity observer's `delete entity[key]` never calls `ecs.removeComponent`, so the entity stays in the wrong archetype. **Fix:** track removed keys and translate them into `removeComponent` / explicit delete markers. (Same class of bug for _added_ component keys at `ecs.ts:521-538` → no `addComponent`.)
- **`ecs.ts:383-402` — Bug — `ready()` leaks a 10s timer on every call and force-inits an empty ECS on timeout.** `Promise.race` never clears the `setTimeout`; the dangling timer keeps the isolate alive (defeating hibernation), and a slow seed publishes an empty world. **Fix:** `clearTimeout` in a `.finally`; reconsider the empty-init fallback.
- **`storage.ts:8-11` — Correctness — Compaction thresholds (`maxBytes: 20KB`, `maxUpdates: 1000`) are mismatched to a whole-world doc, and there's no periodic compaction.** A single >20KB transaction is stored as a row that never compacts; otherwise compaction thrashes. **Fix:** tune thresholds to world size and add an `alarm()`-driven periodic `commit`/compact.

### MEDIUM

- **`ecs.ts:285-327` — Performance — Per-scope `structuredClone` of every pending remote entity.** `onScopeOpen` runs on every `withScope` (i.e. every RPC mutation) and clones full entities, even untouched ones. **Fix:** clone lazily on first shadow access; clone at most once.
- **No `alarm()` / `ecs.update()` tick loop anywhere.** Time-based systems (physics, regen, AI, timeouts) never run, and there's no way to wake an evicted DO to advance simulation. `UpdateArguments` is plumbed but unused. **Fix:** add an `alarm()` that runs `ecs.update(...)` in a scope and reschedules, or document the purely-reactive design and drop the dead generic.
- **`ecs.ts:642-646` — Bug — `webSocketMessage` has no error boundary.** A throw before/inside `router.process` (e.g. the `"uninitialized"` throw, or `Message.decode`) becomes an unhandled rejection; the client gets no response. **Fix:** wrap in try/catch, log, and send a framed error.
- **`ecs.ts:579-610` — Bug — `_entityIdMirror` can double-write ids to the namespace `Y.Array`** under a local-insert/remote-array race, and delete removes only the first occurrence, re-seeding a ghost entity. **Fix:** check `arr.toArray().includes(id)` before push, or make the mirror the single transactional source of truth.

### LOW

- `ecs.ts:417` — `waitUntil(client.connect())` pins the isolate for the stream's lifetime, fighting the hibernation model the code claims to want (and masking the eviction bug in dev).
- `ecs.ts:233-239` — `saveSession` uses `this.sessions` but is handed to systems and may be invoked unbound (`this` undefined → throw after a partial `serializeAttachment`); bind via a captured `const sessions`.
- `cloudflare-shims.d.ts:148-153` — `DurableObjectNamespace.get` is untyped, forcing `as unknown as YStreamProviderStub` and erasing stub type safety; parameterize the binding type.

---

## 6. `@vamp/utils` — Transport channels & routers (`ws-*`, `worker-*`)

**Assessment:** Request/response correlation works on the happy path, but there is **no teardown anywhere**: on socket/worker death, pending unary promises hang forever and their listeners leak; on timeout/abort, unary listeners are never removed; and the worker transport transfers bebop's shared singleton write buffer. The `ws-*` and `worker-*` files are ~80% copy-paste with divergent, divergently-buggy cleanup.

### CRITICAL

- **`ws-channel.ts:273-289` / `worker-channel.ts:189-207` — Bug — Unary pending-request listener leaks on timeout/deadline/abort.** The listener is removed only on the success path; a rejected/timed-out call leaves `events.on(messageId, listener)` (and the `resolve` closure) attached forever. **Fix:** route every exit (resolve/reject/abort) through one `cleanup()`, e.g. `.finally(cleanup)` plus `{ once: true }` abort listener.
- **`worker-channel.ts:33-97` / `ws-channel.ts:132-148` — Bug — No teardown; in-flight requests hang forever.** No `close()`/`dispose()`, no `worker.terminate()`, and `close`/`error` events only log — they never reject outstanding requests or clear `events`. **Fix:** add `close()` that rejects all pending correlations (`UNAVAILABLE`/`CANCELLED`), `removeAllListeners()`, and terminates/closes the transport; wire socket/worker `close`+`error` to it.
- **`worker-router.ts:337,346,366,407` / `worker-channel.ts:205,235,277,290` — Correctness — `postMessage(encoded, [encoded.buffer])` transfers bebop's process-wide singleton write buffer.** `Message.encode(...)` returns a view into the static `writeBuffer`; transferring its `ArrayBuffer` detaches the global buffer and breaks the next encode in the same isolate (and corrupts in-flight bytes). **Fix:** copy before transfer — `const frame = Message.encode(msg).slice(); postMessage(frame, [frame.buffer])`. (`ws-router`/`ws-channel` already copy via `new Uint8Array(Message.encode(...))` and are safe.)

### HIGH

- **`worker-router.ts:183` / `ws-router.ts:182` — Correctness — Duplex cancellation checks the wrong message's status.** The handler tests `request.status` (the original captured request) instead of `message.status` (the current frame), so a later `CANCELLED` frame never cancels the server stream. **Fix:** use `message.status`, matching the client-stream handler.
- **`ws-channel.ts:326-359` — Bug — Server-stream abort handler `throw`s inside an event listener and never tells the server to stop.** The `throw` is swallowed by the event dispatcher, and (unlike `worker-channel`) the WS path never sends a `CANCELLED` frame, so the server generator streams forever. **Fix:** remove the `throw`; send a `CANCELLED` frame on unsubscribe.
- **`ws-router.ts:36-40,365` / `worker-router.ts:399` — Bug — `clientStreams`/`serverStreams` map entries are reaped only on iterator-cleanup or in `catch`.** If the method resolves without the generator being fully drained (e.g. server returns early), the entry and its listener leak per stream. **Fix:** delete in a `finally` around the invocation, plus a connection-close sweep.
- **`ws-channel.ts:489-498` — Bug — `waitForOpen` leaks `open`/`error` listeners and waits 5s for an `open` that never fires when the socket is already `CLOSING`/`CLOSED`.** **Fix:** short-circuit on `readyState`, register all listeners `{ once: true }`, remove them in a `finally`, and reject on `close`.

### MEDIUM

- **`worker-router.ts:238` — Correctness — Reads `previousAttempts` from `metadata`, but `worker-channel` writes it as a top-level `Message` field (`createRequest`, ~`:432`)**, so the retry-exhaustion guard never fires over workers. (`ws-router.ts:220` correctly reads `request.previousAttempts`.) **Fix:** read `request.previousAttempts` consistently.
- **`ws-router.ts:69` / `worker-router.ts:69` — Performance — Request data copied twice and response serialized-then-copied again.** `new Uint8Array(request.data!)` re-copies an already-isolated subarray; every response frame does `new Uint8Array(serializeResponse(...))` then `Message.encode` copies again. For multi-MB messages this is several large copies per call. **Fix:** pass `request.data` directly to `deserializeRequest`; avoid the intermediate response copy.
- **`ws-channel.ts:78-79` — Bug — `maxReceive`/`maxSend` constants are declared but never enforced.** A peer can push arbitrarily large frames. **Fix:** validate frame size on send/receive and reject with `RESOURCE_EXHAUSTED`/`INVALID_ARGUMENT`.
- **`worker-channel.ts:78-89` — Correctness — Readiness inferred from "first message seen" rather than an explicit handshake**, racing real responses and silently dropping control frames without a `methodId`. **Fix:** use an explicit ready message type.
- **`ws-channel.ts:84` / `*-router.ts:35` — Performance — Per-`messageId` EventEmitter dispatch creates/removes an object property per RPC** (hidden-class churn) and, combined with the leaks above, grows unbounded. **Fix:** replace with a single `Map<string, {resolve,reject}>` correlation table.

### LOW

- `ws-channel.ts:362-404` / `worker-channel.ts:296-338` — duplex frames mutate a single shared `init` Message across sends; a terminal `CANCELLED` leaves stale `init.status`. Build a fresh per-frame message.
- `ws-channel.ts:118` — duplicate `this.credential = ...` assignment (also at 110); the second is dead.
- `worker-channel.ts:229` — client-stream generator errors swallowed by `.catch(() => {})`, hanging the call; use `.catch(reject)`.
- `ws-router.ts:297-301` / `worker-router.ts:316-320` — metadata `freeze()`/spread on every response even when empty; skip when no metadata set.

---

## 7. `@vamp/utils` — Async primitives, extension transport, logging

**Assessment:** The two async iterators are the highest-leverage code in the repo (every stream flows through them) and both are defective: unbounded buffering, O(n) `shift()`, no `return`/`throw`/error propagation, and — for the duplex variant — a loop that can drop messages and hang permanently. The extension transport layers additional listener leaks and shared-`init` races on top. The three transport variants are ~90% duplicated.

### CRITICAL

- **`create-event-iterator.ts:11,21-31 — Bug — Unbounded buffer; no backpressure.** `emit()` does `events.push()` with no bound; a consumer slower than the producer (network/CPU) grows the array without limit → OOM on a busy server stream. Each `emit` also allocates a new `Promise` + closure (27-29). **Fix:** bounded ring buffer with a high-water mark and backpressure or explicit overflow error; allocate the wakeup promise lazily on empty-await.
- **`create-event-iterator.ts:33-36,53-55` — Correctness — Errors cannot propagate to the consumer.** `cancel()` only sets `cancelled = true`, ending the stream as a clean completion; a transport error swallowed by the EventEmitter looks like a successful empty stream. **Fix:** add an `error(e)` channel; after waking, `throw` any pending error so it surfaces at the `for await`.
- **`create-duplex-iterator.ts:40-54` — Bug — Main loop drops messages and can hang forever.** It couples `outgoing.next()` to `await nextPromise` and drains only one incoming event per outgoing send; if the server pushes without a matching outgoing, frames sit unconsumed, and if no incoming arrives for an outgoing, `await nextPromise` (44) never resolves → permanent hang. **Fix:** decouple — pump the outgoing generator in its own task (with error capture) and drive the consumer loop purely off the incoming buffer, like `createEventIterator`.

### HIGH

- **`create-event-iterator.ts:43,50` / `create-duplex-iterator.ts:46,51,58` — Performance — `Array.shift()` is O(n).** Draining a stream becomes O(n²) plus GC churn from array compaction. **Fix:** head-index ring buffer or linked-list queue; never `shift()` in a hot path.
- **`extension-channel.ts:59-64` — Bug — `runtime.onMessage` listener added in the constructor is never removed.** No `dispose()`; every channel permanently retains a global listener that decodes every inbound message. **Fix:** store the listener and add `close()` that `removeListener`s and clears `events`.
- **`extension-channel.ts:178-208` — Bug — `fetchClientStream` mutates a shared `init` Message while un-awaited sends are in flight**, so concurrent sends can serialize an overwritten payload. **Fix:** build a fresh per-frame message and `await` each send sequentially; stop the generator on send failure.

### MEDIUM

- **`extension-router.ts:371` — Correctness — Duplex handler checks `request.status` instead of `message.status`** (same bug as the ws/worker routers); cancellation never detected. **Fix:** use `message.status`.
- **`extension-channel.ts:233-238,276-281` — Bug — Abort handler `throw`s inside an `abort` listener and the listener is never removed** (mirrors `ws-channel`). **Fix:** remove the `throw`, route through the iterator error channel, register `{ once: true }`.
- **`extension-router.ts:282-383` — Bug — `clientStreams` map entry reaped only on cancel/error**, leaks on normal completion. **Fix:** `invocation.finally(() => clientStreams.delete(messageId))`.
- **`extension-channel.ts:60` — Bug/Performance — The global listener fully decodes _every_ inbound runtime message (including foreign extension traffic) and throws synchronously on a malformed one.** **Fix:** guard decode in try/catch and early-return on failure.

### LOW

- `context-logger.ts:15` — every `ContextLogger`/`DebugLogger`/`PinoLogger` constructor calls `TempoLogger.instances.clear()`, wiping the global logger registry for all components. Scope the dedup instead.
- `pino-logger.ts:13-19` — constructor hardcodes `TempoLogLevel.Info`, ignoring the `logLevel` argument and never setting the pino child's level. Honor the argument.
- `error.ts:16` — `this._tag = (err as any).tag = tag` mutates the (lodash `defaults`-mutated) input object and assigns to a readonly field via side effect; build a fresh object instead.
- `extension-router.ts:72-73` — duplicated `maxRetryAttempts` assignment.

---

## 8. `tools/cli` — Bebop → TypeScript code generator

**Assessment:** Works for the narrow hand-shaped example schemas but is **not safe for public/untrusted schemas**. The parser is a regex/brace-walker that silently mis-parses legitimate bebop syntax (inline messages, regex-special names, nested maps), several emitters have latent type bugs, and there is no validation, escaping, or end-to-end "generate → typecheck" gate.

### CRITICAL

- **`generate-mutation-schema.ts:38` / `emit-mutation-bop.ts:38` — Correctness — Custom-field delta references a `<Type>Delta` that may not exist.** `deltaTypeForField` blindly emits `${typeName}Delta` (e.g. `Position pos` → `PositionDelta pos`); it only works because `PoolDelta` is hand-defined with matching tags. Any other custom field makes the emitted `mutation.bop` reference an undefined type and bebopc fails. **Fix:** auto-emit a matching `<Type>Delta`, or detect the missing delta and fail with a clear message.
- **`emit-delta.ts:34` — Bug — `float64` mapped to `bigint`.** bebop emits `float64` as `number` (only `int64`/`uint64` are `bigint`), so any `float64` field makes the generated `EntityDelta` fail to typecheck against `Entity`. **Fix:** move `float64` into the `number` group.

### HIGH

- **`parse-bop-source.ts:113` — Bug — The field regex scrapes nested/inline message fields.** `extractMessageBody` returns the full body including nested `message X { ... }` blocks, and the global field regex emits their fields as top-level Entity fields with duplicated indices. **Fix:** strip nested brace blocks (reuse the depth walker) before field extraction.
- **`parse-bop-source.ts:39` — Bug — Unescaped message name interpolated into `new RegExp`.** A schema/type name with a regex metacharacter mis-matches or throws — injection via schema name. **Fix:** escape the name and add word boundaries.
- **`parse-bop.ts:137` — Correctness — `BEBOP_SCHEMA` is extracted by regex-scraping `new Uint8Array([...])` and `parseInt`-ing tokens**; a trailing comma or format drift yields `NaN` → silent `0` bytes, corrupting the parsed schema with no error. **Fix:** validate every token is a finite 0–255 integer; better, dynamically import the exported value.
- **`generate.ts:46` — Bug — `execSync("npx bebopc build")` swallows stderr** (generic "bebopc build failed"), doesn't verify the toolchain exists, and parses `bebop.ts` even if partially written. **Fix:** capture/print stderr, check exit status, validate output before parsing.

### MEDIUM

- **`emit-helpers.ts:42` — Bug — `materializeDelta` silently drops array `add`/`remove` deltas** (uses `?.set ?? base ?? []`), disagreeing with `mergeDelta` which handles them. **Fix:** apply `add`/`remove` against base in materialize too.
- **`emit-components.ts:7` — Correctness — Component IDs are array positions (with a gap where `tags` is skipped), unrelated to bebop field tags.** Reordering/removing a field silently shifts every later component ID, invalidating persisted/serialized data. **Fix:** derive IDs from the field tag, or compact and document the ordering contract.
- **`codegen.ts:66` — Bug — `collectBebopImportTypes` skips array/map element types** (`!isArray && !isMap`), so a custom type used only inside an array/map is never imported → TS error. **Fix:** inspect element/value types too.
- **`loader.ts:14,29` — Bug — jsonc parse errors are swallowed** (no errors array; partial parse passes the `!config` guard), producing wrong codegen from a typo'd `vamp.json`. **Fix:** pass an errors array and throw on any.

### LOW

- `cli.ts:17` — `.catch(console.error)` logs but exits 0, reporting success to CI on failure; `process.exit(1)`.
- `emit-helpers.ts:46` — pool default `{ field: 0 }` ignores field types (string/bool/nested defaulted to `0`).
- `emit-delta.ts:3-18` vs `parse-bop.ts` — two independent scalar vocabularies (`byte` vs `uint8`) that can disagree and fall through to an invalid emitted type; single source of truth.
- `parse-bop-source.ts:68` — nested map/array value types captured as raw strings, never recursively classified.
- `init.ts` / `templates/entity.bop.ts` — scaffolded `import "../node_modules/@vamp/utils/schema/pool.bop"` is fragile across pnpm/workspace layouts; resolve at generate time.

> Hand-written example files `examples/basic/src/rpc.service.ts` and `index.ts` are sound for their stated assumptions; the only fragile spots are the documented `delete (entity).encode` and `as unknown as Map` casts that rely on ECS mutation records being wire-compatible with the bebop `MutationRecord` — an intentional, documented coupling.

---

## 9. `@vamp/rot` — Roguelike toolkit (vendored rot.js port)

**Assessment:** RNG, FOV (precise/recursive/discrete), color, and noise are faithful, correct ports. Two **vamp-introduced** regressions are serious: `MinHeap.remove` corrupts the heap (mis-ordering the turn scheduler), and `Digger` is functionally broken. The A\* open-set and `EventQueue.shift` are the perf hot-spots that will choke a server tick with many entities.

### CRITICAL (vamp-introduced)

- **`MinHeap.ts:67-73` — Bug — `remove()` only sifts down.** It moves the last element into the removed slot and calls `updateDown(index)` only; if the moved element is smaller than its new parent the heap invariant is violated, and a later `pop()` returns events out of time order — corrupting the scheduler (`Scheduler.remove → EventQueue.remove → MinHeap.remove`). **Fix:** call both `updateUp(index)` and `updateDown(index)` after the replacement; also fix the duplicate-value index scan (`MinHeap.ts:56-65`).
- **`map/digger.ts:134-139` — Bug — `_digCallback` never registers walls.** Missing the upstream `else { this._walls[x+","+y] = 1; }` branch, so `_findWall()` runs dry almost immediately; output is ~1 room / 0 corridors / ~1% dug versus the 20% target. **Fix:** restore wall registration adapted to this port's map convention (`else { this._walls[x+","+y] = 1; }`).

### HIGH

- **`path/astar.ts:96-106` — Performance — A\* open-set insertion is O(n) per node** (sorted-array `splice` + `shift`), so pathfinding is O(n²) per query (**upstream** rot.js design, but a real server hot-spot). **Fix:** use the existing `MinHeap` keyed by `f = g + h`; replace string keys (`x+","+y`) with numeric `y*width+x`.
- **`MinHeap.ts:19-25` / `eventqueue.ts:52` — Performance — `shift()` reallocates the whole heap every `EventQueue.get()`** (`heap.map(...)` → new array + N new wrappers per scheduler tick) (**vamp-introduced** design). **Fix:** track a running time offset and store absolute times, or at least mutate keys in place instead of reallocating.

### MEDIUM

- `MinHeap.ts:98-107` — `minNode` allocates a filtered array + `bind` per sift-down step, and reads `heap[undefined]` if ever called with all-invalid indices; inline the 3-way comparison (**vamp**).
- `scheduler/action.ts:24` — `time || this._defaultDuration` treats a legitimate `0`-cost action as falsy; use `time !== undefined ? time : ...` (**upstream**, `Speed.add` already does it right).
- `path/astar.ts:108-121` — `_distance()` has no `default` case; an out-of-range topology yields `undefined` → `NaN` heuristic that silently breaks ordering (file is `//@ts-nocheck`); add a throwing default (**upstream**).

### LOW

- `path/path.ts:67-81` and the pathfinder inner loops allocate a result array + `[x,y]` tuple per neighbor and build `x+","+y` strings per node; iterate `_dirs` inline with integer keys (**upstream design**).
- `rng.ts:24-26` — `setSeed(0)` maps to `Infinity` and negative/NaN seeds are unguarded; matches upstream (intentional, to allow `Math.random()` in `[0,1)` as a seed) — documentation note only, **not a bug**.

---

## 10. Cross-Cutting Themes

1. **No teardown discipline.** Listeners (`events.on`, `runtime.onMessage`, `abort`, `open`/`error`), pending request closures, stream generators, `clientStreams`/`serverStreams`/`observers`/`sessions` entries, `setTimeout`s, and ECS caches are created on every connection/request/entity but reclaimed on at most the happy path. Under reconnect storms and per-frame spawn/despawn this is unbounded growth. **A single audited `dispose()`/`close()` contract per long-lived object** (channel, router, DO, iterator) would close most CRITICAL/HIGH leaks at once.

2. **Hibernation lifecycle not honored.** The DO opts into hibernatable WebSockets but treats in-memory state as permanent (no re-bootstrap on wake, `waitUntil` pinning, 10s timers keeping the isolate alive). Either commit to hibernation (persist what's needed, rebuild on construct, no eternal `waitUntil`) or don't accept hibernatable sockets.

3. **Three copy-pasted transports that diverged.** `ws-*`, `worker-*`, and `extension-*` channels/routers are 80–90% identical, and bug fixes landed unevenly (worker has server-stream cancel, ws/extension don't; ws copies before send, worker transfers the shared buffer; the duplex `request.status` bug is in all three; `previousAttempts` is read inconsistently). **Extract one `AbstractTempoChannel`/`AbstractTempoRouter` parameterized by a `send(bytes)` sink** — this both removes the duplication and makes every transport-level fix land everywhere.

4. **Two async iterators underpin everything and are both broken.** `createEventIterator` and `createDuplexIterator` should be replaced by a **single bounded, error-propagating async-queue primitive** (ring buffer + error channel + proper `return`/`throw`). That one change fixes the OOM, lost-error, duplex-hang, and O(n) `shift` findings simultaneously, and the transports above should sit on top of it.

5. **Silent failure in the codegen path.** The generator prefers "emit something" over "fail loudly": swallowed bebopc stderr, `parseInt → NaN → 0` schema corruption, unescaped regex names, dropped array deltas, positional component IDs. A public framework needs an **end-to-end `generate → tsc --noEmit` test** in CI and hard failures on unrecognized input.

---

## 11. Prioritized Remediation Roadmap

**P0 — Release blockers (correctness/data-loss/crash).**

1. Fix `_reconcileTags` (`ECS.ts:486`) → green test suite.
2. DO hibernation re-bootstrap + stream/observer teardown on close/error (`worker/ecs.ts`).
3. Rewrite the two async iterators as one bounded, error-propagating queue; fix the duplex hang.
4. Add channel/router `close()` that rejects pending requests and removes listeners; copy-before-transfer in the worker transport.
5. Fix `MinHeap.remove` (sift both directions) and `Digger` wall registration.
6. Fix duplex `message.status` cancellation in all three routers; fix `emit-delta` `float64`.

**P1 — Unbounded growth / load correctness.** 7. Prune ECS `deletedEntities` + behavior/archetype caches on delete; invalidate caches on `registerBehavior`. 8. Reap `clientStreams`/`serverStreams` map entries in `finally`; fix unary listener leak on timeout/abort; `waitForOpen` cleanup. 9. yjs reconcile: attach observers before sync, propagate component add/remove into the archetype graph, fix the seed-race; tune storage compaction + add `alarm()`. 10. Codegen hardening: escape regex names, strip nested blocks before field parse, validate schema bytes, surface bebopc stderr, add the `generate → tsc` CI gate.

**P2 — Performance hot-paths.** 11. ECS: global id→archetype map (kill graph rescans), per-system scratch buffer (kill per-frame spreads), cache `upsert` queries. 12. rot: A\* on a heap with numeric keys; stop reallocating the EventQueue heap each tick. 13. Transports: single `Map` correlation table instead of per-`messageId` EventEmitter; eliminate redundant multi-MB copies.

**P3 — Simplicity / DX.** 14. Collapse the three transports onto one abstract base; collapse the iterators. 15. Remove dead code and duplicate assignments (`actToSubtree`, duplicate credential/`maxRetryAttempts` assignments, the array pool); fix logger registry clobbering and `pino` level; package `README`/metadata still say "tsdown-starter" / "Author Name".

---

_End of audit. The single failing test (`packages/ecs/tests/index.test.ts:2237`) is the canary: fixing `ECS.ts:486` turns the suite green, but the leaks and lifecycle bugs above are silent in a short test run and surface only under sustained multiplayer load — which is precisely the production target._
