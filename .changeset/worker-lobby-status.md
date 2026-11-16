---
"@vampgg/worker": minor
---

Report a lobby's state, and let runtime controls act on an evicted lobby.

**`status()`.** `ECSDurableObject.status()` returns a `LobbyStatus` without waking the lobby. It reports `unset` before `setup`, `dormant` when no world is in memory (namespace, sockets, sessions, and the persisted tick override), and `loaded` (adding entity count, open shard roots, and `loadShard` subscriptions). `TickConfig` and `LobbyStatus` are exported.

**Controls restore first.** `setTickInterval`, `pauseTick`, `resumeTick`, `loadShard`, and `unloadShard` now restore an evicted world before acting, as `stepTick` already did. Before, `loadShard` threw on an evicted lobby, and `pauseTick`, `resumeTick`, and `unloadShard` silently did nothing because a fresh isolate's fields were still defaults. Each now throws when the durable object was never set up.

**Subscriptions survive a cold start.** `setup()` on an evicted lobby now wakes it the way a hibernation wake does, from its persisted seed, shard set, and `loadShard` subscriptions. Before, a player joining an evicted lobby re-bootstrapped it from scratch, which re-persisted the shard set as the lobby's own root and dropped every subscription; a later wake then saw the root as subscribed but never re-opened it, and `loadShard` skipped it. `loadShard` now re-opens a subscribed root whose shard is closed, which repairs state persisted by earlier versions. As documented for `setup`, the first connection's seed keeps configuring the context across eviction, not only across hibernation.
