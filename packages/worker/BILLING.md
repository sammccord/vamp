# Cloudflare cost model — `@vampgg/worker` + `y-durablestream`

A code-grounded model of what it costs to run a vamp game on Cloudflare Durable
Objects: **compute** (requests + wall-clock duration), **SQLite storage** (rows
read/written + stored bytes), and the **front Worker** (requests + CPU-time). Every
per-operation claim cites the source line so it is auditable, and the compute
formulas are validated against Cloudflare's own published pricing examples (see
[Appendix A](#appendix-a--model-validation)).

> **The one thing to remember.** Ticking is **request-scoped, not alarm-driven**
> (`ecs.ts` `_maybeTick`): a lobby advances its simulation only while awake handling a
> player message, so it **hibernates whenever idle** — no continuous duration, no
> per-tick `setAlarm` write. A reactive world (`tickIntervalMs = 0`) and a request-tick
> world (`tickIntervalMs > 0`) therefore cost the same order of magnitude; enabling a
> tick only adds the flushes it produces while players are active. A small game runs on
> the **free tier** either way.

---

## 1. What gets billed

Three billed components (verified in `src/ecs.ts`, `src/storage.ts`, `src/entity-doc.ts`,
`src/shard-manager.ts`, `y-durablestream/src/provider.ts`, `.../storage/sql.ts`, and
`examples/basic/{wrangler.jsonc,src/index.ts}`):

| #   | Component                                      | Count                                                                | Backend          | What it bills                                                     |
| --- | ---------------------------------------------- | -------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------- |
| 1   | **Front Worker** (Hono entry)                  | 1 script                                                             | —                | 1 request + a little CPU **per WS connection upgrade**            |
| 2   | **`GameECS` lobby DO** (`GAME_ECS`)            | 1 per namespace/room (`L`)                                           | KV metadata only | requests + compute duration; holds hibernatable player WebSockets |
| 3   | **`GameStorage` provider DO** (`GAME_STORAGE`) | 1 per **root/shard** (`L` × `game/${ns}` + `P` shared `character/*`) | **SQLite**       | requests + duration + SQLite rows/stored bytes                    |

Provider DOs are addressed by `idFromName(root)` (`ecs.ts:952`), so **the same root
name is one shared DO across all lobbies** — never duplicated per lobby.

**Post-upgrade WebSocket messages go straight to the lobby DO** (`ctx.acceptWebSocket`,
`ecs.ts:1391`) and never re-invoke the front Worker — so the Worker is billed per
connection, not per message.

### Two runtime regimes (both hibernate)

| Regime           | Trigger                                | Behaviour                                                                                                                                                                                                                                                                                   |
| ---------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Reactive**     | `tickIntervalMs = 0` (example default) | No ticking; the world changes only on player RPCs. Idle lobbies **hibernate**; duration billed only while running JS.                                                                                                                                                                       |
| **Request-tick** | `tickIntervalMs > 0`                   | `_maybeTick` advances `floor(elapsed / tickIntervalMs)` frames (capped at 8) on each inbound message while a socket is connected. Still **no alarm**, so idle lobbies **hibernate** — duration is JS-only, and each active message coalesces its catch-up frames + action into one forward. |

---

## 2. Pricing constants

**Durable Objects** (from Cloudflare's DO pricing page — authoritative):

| Metric              | Free/day  | Paid included/mo | Overage          |
| ------------------- | --------- | ---------------- | ---------------- |
| Requests            | 100,000   | 1,000,000        | $0.15 / million  |
| Duration (GB-s)     | 13,000    | 400,000          | $12.50 / million |
| SQLite rows read    | 5,000,000 | 25,000,000,000   | $0.001 / million |
| SQLite rows written | 100,000   | 50,000,000       | $1.00 / million  |
| SQLite stored       | 5 GB      | 5 GB-month       | $0.20 / GB-month |

- Duration bills **128 MB flat** per DO regardless of actual memory: `GB-s = 0.128 × active-seconds`.
- Incoming WebSocket **messages are billed 20:1** (20 msgs = 1 request); a WS connection and an RPC session are 1 request each; outgoing messages and ping/pong auto-responses are free. (Alarms would also be 1 request + 1 `setAlarm` row-write each — but **vamp uses no alarms**; ticking is request-scoped.)
- **Deletes count as rows written.** KV `put/get/list` on a SQLite DO are billed as rows.
- SQLite storage billing began **2026-01-07**.

**Workers Paid** (Standard usage model — from Cloudflare's Workers pricing page):

| Metric   | Free/day             | Paid included/mo    | Overage                |
| -------- | -------------------- | ------------------- | ---------------------- |
| Requests | 100,000              | 10,000,000          | $0.30 / million        |
| CPU time | 10 ms/invocation cap | 30,000,000 CPU-ms   | $0.02 / million CPU-ms |
| Duration | —                    | no charge, no limit | —                      |

- **$5/mo base** covers the account and is **also the DO plan minimum** — one $5, not two.
- Workers bill **CPU-time, not wall-clock duration** (unlike DOs). The front Worker's few
  ms of CPU per connection is the only Workers-compute cost.
- A **WebSocket connection to a Worker is 1 request; WS messages routed through a Worker
  are _not_ requests** — and here they don't even reach the Worker (they go straight to
  the lobby DO). **Subrequests a Worker makes are not billed** on the Worker side, so the
  front Worker's `stub.setup()`/`stub.fetch()` calls cost nothing as Worker requests
  (they are billed as _DO_ requests on the lobby, counted in §3).

---

## 3. Per-operation cost table

### Requests (each = 1 billed request on the named component)

| Event                                                                 | Front Worker |   Lobby (`GameECS`)   |                Provider (`GameStorage`)                | Source                                    |
| --------------------------------------------------------------------- | :----------: | :-------------------: | :----------------------------------------------------: | ----------------------------------------- |
| Client WS connect                                                     |      1       | 1 `fetch` + 1 `setup` |                           —                            | `index.ts:83-107`, `ecs.ts:749,1375`      |
| Client WS message                                                     |      —       |        ×(1/20)        |                           —                            | `ecs.ts:1404`                             |
| Lobby write burst _(per shard, ≤1 / 16 ms)_                           |      —       |           —           |             1 `update` (`pushLocalUpdate`)             | `ecs.ts:972-986`                          |
| Shard open / hibernation wake _(per persisted shard)_                 |      —       |           —           | ~3 (`subscribe`+`update`+`unsubscribe` via `syncOnce`) | `ecs.ts:990`, `client.ts` `syncOnce`      |
| Cross-lobby propagation _(write to shard with `S` other subscribers)_ |      —       | `S` × `onShardUpdate` |                           —                            | `provider.ts:494-504`, `storage.ts:64-71` |
| Notify-push register / deregister                                     |      —       |           —           |                         1 each                         | `ecs.ts:1074-1092`                        |
| Compaction backstop _(if `compactEveryNTicks` set)_                   |      —       |           —           |             1 `compact()` per active shard             | `ecs.ts:1591-1603`                        |

There is **no alarm request** — ticking is request-scoped (`_maybeTick`), so a tick
produces no request of its own; its catch-up flushes ride the message that triggered
them. The **16 ms forward-coalesce** (`_forwardDebounceMs`, `ecs.ts:277`) merges a
message's catch-up frames + action into a single `pushLocalUpdate` RPC — so a ticking
message still costs **one** provider `update`, not one per frame. This caps provider
write-RPCs at ~62 / s / shard and bounds lobby→provider request volume.

### SQLite / storage rows (`N` = current uncompacted `yjs_updates` rows)

All the meaningful rows are on the **provider** (`GameStorage`, SQLite). The lobby
(`GameECS`) writes only a little metadata (`__vamp:shards`/`__vamp:context`/`__vamp:tick`
puts, a few per session) — and, crucially, **no `setAlarm` rows**, because there is no
alarm.

| Op                                                                                                                                               | On       |                       Rows read                        |              Rows written              | Source                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | :----------------------------------------------------: | :------------------------------------: | ------------------------------------------ |
| Persist 1 Yjs update _(1 flush → 1 `doc.transact` → 1 update)_                                                                                   | provider |            0 (in-memory threshold counters)            |               1 (INSERT)               | `sql.ts` `storeUpdate`                     |
| Auto-compaction _(trips at 10 KB **or** 500 updates, defaults)_                                                                                  | provider |                        `1 + N`                         |    `1 + N` (snapshot + delete log)     | `sql.ts` `compactSync`                     |
| `compact()` RPC / last-subscriber `commit()` _(skipped when nothing was written since the last commit — a read-only `syncOnce` costs no commit)_ | provider |                           0                            |                `1 + N`                 | `sql.ts` `commit`, `provider.ts` `onEmpty` |
| Cold-start hydration _(per isolate revive)_                                                                                                      | provider | `1 + N` (+1 counter seed aggregate, +registry KV list) |                   0                    | `sql.ts` `getYDoc`/ctor                    |
| `register` / `deregister`                                                                                                                        | provider |                           0                            | 1 (per-subscriber KV `__yds:sub:<id>`) | `provider.ts` `register`                   |
| Session metadata put                                                                                                                             | lobby    |                           0                            |        ~2 per session (KV puts)        | `ecs.ts:1019-1021`                         |

Three facts that drive the SQLite bill:

1. **One flush = one row, not one row per mutation.** A whole ECS scope batches into one
   `doc.transact` per touched root → one Yjs update → one `INSERT` (`ecs.ts:604-615`,
   `entity-doc.ts:86-163`). Under request-scoped ticking a message's catch-up frames +
   action coalesce into **one** forward → one row. Entity field count sets the row's
   _blob size_, not the row count. So **row-writes scale with active-message frequency,
   never with entity count or catch-up depth.**
2. **Rows-written ≈ 2 × flushes.** Every inserted update row is eventually `DELETE`d by a
   compaction, and deletes bill as writes — so `W` flushes cost ≈ `2W` rows written,
   independent of the compaction threshold. This provider write bill is the dominant
   cost at scale in both regimes.
3. **Rows-read are no longer per-write.** Since y-durablestream 0.9 the compaction
   thresholds are tracked with in-memory counters (seeded by one aggregate per DO
   construction), so a `storeUpdate` reads **zero** rows; reads happen only on
   cold-start hydration and inside a compaction rebuild (`1 + N` each). Reads are
   also ~1000× cheaper than writes ($0.001 vs $1.00 / M), so the read line is noise —
   tune `maxUpdates`/`maxBytes` for world size and compaction latency, not cost.

### Duration

```
GB-s = 0.128 × active-seconds
```

- **Both regimes:** active-seconds ≈ Σ JS execution time only — the DO hibernates
  between messages either way (there is no alarm). Request-ticking adds the catch-up
  frames' compute to each active message (`catchup × update()` per message), but that is
  still bounded JS, not continuous wall-clock. In practice duration stays **under the
  free tier** even at thousands of concurrent players (see §5).
- No component holds a persistent **outbound** connection; cross-DO comms are
  request/response RPC (`syncOnce` + `pushLocalUpdate`, `ecs.ts:955-990`), so nothing is
  pinned resident for the 15-minute outbound-connection window.

---

## 4. Workload parameters & formulas

| Symbol    | Meaning                                                                    |
| --------- | -------------------------------------------------------------------------- |
| `L`       | lobbies (namespaces)                                                       |
| `U`       | players per lobby                                                          |
| `m`       | client WS messages per player per minute                                   |
| `f`       | fraction of messages that mutate (→ a flush)                               |
| `h`       | active hours per day · `d` = 30 days                                       |
| `T`       | tick interval ms (`0` = reactive)                                          |
| `S`       | avg _other_ subscribers per shared shard · `P` shared `character/*` shards |
| `E`, `bₑ` | entities per world, bytes per entity (stored snapshot size)                |

```
connections/mo     = L·U·d
messages/mo        = L·U·m·60·h·d
flushes/mo (W)     = messages · f          # reactive   (only mutating msgs forward)
                   = messages              # request-tick (every active msg forwards a
                                           #   coalesced catch-up + action = 1 forward)
catchup/msg        = min(8, (1000/T) / (U·m/60))   # frames advanced per message (tick)
onShardUpdate/mo   = W · shareFrac · S

Front Worker $     = over(connections, 10M, $0.30/M) + over(connections·CPUms, 30M, $0.02/M)
Lobby req $        = over(2·connections + messages/20 + onShardUpdate, 1M, $0.15/M)   # no alarms
Lobby duration $   = over(0.128 · (messages·msPerMsg·(1+catchup) + …)/1000, 400k, $12.50/M)  # JS-only
Provider req $     = over(W + shardOpens·(subscribe+update+register+dereg), 1M, $0.15/M)
SQLite write $     = over(≈2·W, 50M, $1.00/M)
SQLite read $      = over(≈wakes·(1+N) + compactions·(1+N), 25B, $0.001/M)   # no per-write reads
SQLite stored $    = over((L+P)·(E·bₑ + logBytes) / 1e9, 5, $0.20/GB-mo)
Total $            = $5 base + all of the above
```

---

## 5. Worked scenarios

Three tiers × two regimes. Tiers: **Hobby** (`L=1, U=4, h=3`), **Indie**
(`L=50, U=8, h=6`), **Scaled** (`L=500, U=20, h=10`, plus shared `character/*` shards
with `S=2`, 20 % of writes shared). `m` ranges 10–20 msg/min, `f=0.5`. Tick tiers use
`T=50 ms` (20 Hz). Numbers are monthly, computed with the formulas above (calculator in
Appendix B).

### Reactive (`tickIntervalMs = 0`)

| Tier   | Connections | Messages | Flushes `W` | Rows written | Duration GB-s |                 **Total / mo** | Dominant line                                                       |
| ------ | ----------: | -------: | ----------: | -----------: | ------------: | -----------------------------: | ------------------------------------------------------------------- |
| Hobby  |         120 |   0.22 M |      0.11 M |       0.22 M |           ~14 | **≈ $0 (free tier) / $5 Paid** | —                                                                   |
| Indie  |        12 k |   51.8 M |      25.9 M |       52.2 M |        ~3.3 k |                     **$11.23** | provider req $3.75 + SQLite write $2.25                             |
| Scaled |       300 k |    3.6 B |       1.8 B |       3.64 B |        ~277 k |                     **$4,019** | **SQLite writes $3,586** + provider req $270 + cross-lobby req $135 |

Reactive duration stays **under the 400 k GB-s free tier at every tier** — hibernation is
doing its job. Cost is driven by requests and SQLite writes, both proportional to flush
volume `W`.

### Request-tick (`T = 50 ms`)

Same tiers, now with `tickIntervalMs = 50`. Because catch-up frames coalesce into one
forward per active message and the DO still hibernates, the cost is ≈ the reactive tier
plus the extra forwards from non-mutating messages (reactive forwards only mutating
messages; request-tick forwards every active one):

| Tier   | Flushes `W` | Rows written | Duration GB-s |     **Total / mo** | Dominant line                                                            |
| ------ | ----------: | -----------: | ------------: | -----------------: | ------------------------------------------------------------------------ |
| Hobby  |      0.22 M |       0.44 M |          ~124 | **≈ $0 / $5 Paid** | — (free tier)                                                            |
| Indie  |      51.8 M |        104 M |         ~30 k |            **$67** | provider SQLite writes $54 + provider req $8                             |
| Scaled |       3.6 B |        7.3 B |        ~1.0 M |         **$8,087** | **provider SQLite writes $7,221** + prov req $540 + cross-lobby req $243 |

Compared to the old alarm-driven tick loop this is a **~5–30× reduction** (the Indie
tier fell from ~$2,156 to $67; Scaled from ~$41,615 to $8,087): the continuous-duration
charge and the per-tick `setAlarm` row-writes are **gone**. What remains is just the
provider write bill (≈ `2 × W`), and `W` is now bounded by active-message rate, not by
`frame-rate × active-time`. A ticking world costs roughly **2× its reactive equivalent**
(it forwards every active message, not only mutating ones) — and stays on the free tier
at hobby scale.

### Dominant cost & cheapest lever, per scenario

- **Small game (either regime)** → fits the free tier.
- **At scale (either regime)** → **provider SQLite writes** dominate (≈ `2 × W`, where
  `W` = forwarded flushes). Levers: reduce flush count — batch client actions into fewer
  scopes; and keep AOI (`canSee`) tight so cross-lobby `onShardUpdate` fan-out (`S`)
  stays small (it multiplies both requests and shared-shard writes).
- **Request-tick vs reactive** → ticking roughly **doubles** the provider write bill (it
  forwards every active message, not only mutating ones). If cost matters and the tick is
  not essential, stay reactive; the tick no longer carries the old alarm/duration
  penalty, so the choice is now just this ~2× write factor, not a regime change.

---

## 6. Cost levers (summary)

| Lever                                    | Effect                                                                                     | Where                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------- |
| **Batch mutations per scope**            | Fewer flushes `W` → fewer rows written (≈2×`W`) and fewer provider RPCs. Biggest lever.    | one flush per `withScope`, `ecs.ts:566` |
| **Stay reactive** (`tickIntervalMs = 0`) | ~Halves the provider write bill (only mutating messages forward, not every active one).    | `ecs.ts:718`                            |
| **Tight AOI (`canSee`)**                 | Cuts cross-lobby `onShardUpdate` fan-out `S` and per-client WS egress.                     | `@vampgg/worker/interest`               |
| **Fewer, bigger lobbies vs many tiny**   | Fewer `GameECS` + `game/${ns}` provider DOs; better hibernation amortization.              | topology                                |
| **Shared `character/*` shards**          | Dedupe cross-lobby entities into one provider DO — but raises `S` fan-out; keep AOI tight. | `entity.sk` routing                     |

Note: raising `maxBytes`/`maxUpdates` reduces compaction _CPU/latency_, **not** the
row-write bill (which is ≈2×`W` regardless) — and it _increases_ rows read. Tune it for
world size, not for cost.

---

## 7. Free-tier fit & caveats

- **Free plan requires SQLite-backed DOs only.** `GameStorage` is SQLite
  (`wrangler.jsonc:10`). Ensure `GameECS` is also declared under `new_sqlite_classes`
  for a free-plan deployment (the example wrangler declares only `GameStorage`; the lobby
  uses `ctx.storage` for a few `__vamp:*` metadata keys, so it needs a storage backend).
- A **small reactive game fits the free tier entirely** (Hobby reactive: ~370 billed
  lobby requests/day, ~7 k rows written/day, ~14 GB-s/mo — all under the daily free
  limits). It runs at **$0** on Free, or the **$5 base** on Paid.
- **The front Worker is effectively free in every scenario.** Connections stay far under
  the Workers included allotment (10 M requests + 30 M CPU-ms / mo) — even the Scaled tier
  is ~300 k connections / mo (~$0 requests) and ~0.6 M CPU-ms (~$0). WS messages bypass the
  Worker entirely, so it never scales with traffic. Its cost is $0 above the shared $5 base.
- **Modelling assumptions** (change them in Appendix B for your game): 1 connection per
  player per day; 0.5 ms lobby JS per message; 2 ms front-Worker CPU per connection.
  Absolute dollars are illustrative — the _shape_ (which line dominates, and the levers)
  is the durable takeaway.
- **Shard `release()` is wired via entity-emptiness**: when the last local entity of a
  root disappears, the lobby releases its pin (`_untrackEntityRoot` →
  `_maybeReleaseShard`), deregisters notify-push, and the reap cycle tears the shard
  down after the grace period. `S` (subscribers per shared shard) therefore tracks
  active interest, not isolate lifetime. D2/D3 may add player-interest release drivers
  on top.

---

## Appendix A — model validation

The compute formulas reproduce Cloudflare's own published examples exactly — both the
Durable Objects examples (requests + duration) and the Workers example (requests +
CPU-time):

| CF example                                      | Their total | Model output                                                    |
| ----------------------------------------------- | ----------- | --------------------------------------------------------------- |
| DO Example 2 (100 DOs × 50 WS, non-hibernating) | $138.65     | **$138.65** (req 3.75 M → $0.41; 11.06 M GB-s → $133.24; +$5)   |
| DO Example 4 (100 DOs × 100 hibernatable WS)    | $10.00      | **$10.00** (req 21.61 M → $3.09; 552,960 GB-s → $1.91; +$5)     |
| Workers Example 1 (15 M req, 7 ms CPU/req)      | $8.00       | **$8.00** (req 5 M over → $1.50; 75 M CPU-ms over → $1.50; +$5) |

## Appendix B — calculator

The scenario numbers were generated by a standalone calculator (parameters at the top).
Adjust `L`, `U`, `m`, `f`, `T`, `S`, `P`, entity sizes, and the per-message CPU
assumptions to model your own game. The formulas are exactly those in §4; the CF-example
checks in Appendix A guard the arithmetic.
