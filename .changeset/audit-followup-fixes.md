---
"@vampgg/ecs": major
"@vampgg/worker": minor
"@vampgg/utils": minor
"@vampgg/solid": minor
"@vampgg/cli": minor
---

Second round of fixes from the source audit: scope atomicity, query semantics, RPC error handling, reconnects, interest transitions, and hot-path cost.

**`@vampgg/ecs`**

- An aborted scope restores archetype membership for every entity it touched.
- Reads inside a scope see staged updates to pre-existing entities, including a parent scope's.
- `act()` runs behaviors for an entity inserted earlier in the same scope.
- `insert()` with an existing id replaces the entity. `put(id, { x: undefined })` without `mutating` no longer adds component `x`.
- Unsubscribe functions are idempotent. Registering a query that is already registered with another world throws.
- `or()` ORs the whole sub-query. `none()`/`noneTag()` exclude only archetypes holding every listed id, as documented.
- An entity system runs once per update over a snapshot of its matches. A throwing deferred action runs once.
- Breaking: an `EventSystem` receives only the ids that changed, not every match. `subscribe(system, true)` still emits every match once.
- `registerBehavior` returns an unsubscribe function. The error classes are exported.

**`@vampgg/utils`**

- Error frames always carry the request's `messageId`. Over WebSocket, failed calls previously hung.
- Non-Tempo error messages are masked unless `transmitInternalErrors` is set.
- Client- and duplex-stream continuation frames no longer each send a reply or start a second pump.
- `TempoWSChannel` survives a dropped connection: in-flight calls and streams fail, and the next call reconnects. Oversized frames fail in-flight work instead of being dropped silently.

**`@vampgg/worker`**

- `saveSession` keeps framework-owned `__vamp:` attachment keys.
- Reserved close codes are never echoed. An oversized frame closes the socket with 1009. Framed errors echo the request's `messageId`.
- Interest observers with a `canSee` policy send an Insert when an entity enters view and a Delete when it leaves, including when the viewer moves. The `observe` stream always opens with a snapshot frame.
- A commit broadcast to many sockets is encoded once.
- The `logger` option is honored. `document` is deprecated.

**`@vampgg/solid`**

- `GameProvider` treats the first frame of each stream as an authoritative snapshot (`snapshotOnConnect`, default `true`), removing entities deleted while disconnected.
- Components sharing a hoisted query builder share one tracked query.

**`@vampgg/cli`**

- An unlisted custom component is an additive counter only when every field is numeric; otherwise it replaces.
