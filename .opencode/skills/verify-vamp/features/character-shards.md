# Character shards

A character is a set of entities that live outside any single lobby, keyed by a shard like `character/<id>`. Two lobbies subscribed to the same shard see each other's live edits to it, while each lobby's own private entities stay in that lobby. A character's entities are also readable over plain HTTP without starting a lobby at all.

## Sub-features

- `shard-author` spawns an entity into a named shard from a lobby.
- `shard-live-propagate` pushes one lobby's shard edit to another subscribed lobby with no action by that lobby.
- `shard-private-isolation` keeps a lobby's own `game/<ns>` entities out of every other lobby.
- `shard-http-snapshot` returns a character's entities over `GET /v1/characters/:id`.
- `shard-connect-load` loads a character into a lobby via the `character` connect param.

## How to get to it (user POV)

- Spawn an entity whose `sk` is `character/<id>` from any lobby socket.
- Connect with `ws://<host>:<port>/v1/game?ns=<lobby>&character=<id>` to load that character into the lobby.
- Issue `GET /v1/characters/<id>` for a snapshot with no lobby involved.

## Driving it with control-vamp

Preconditions:

- `control-vamp doctor` is green.
- Both lobbies hold a connected observer, which is what gates live notify-push on.

- **Two lobbies, one shard.** `connect(suffix + "-a")` and `connect(suffix + "-b")`, open a see-all `observe` on each, then spawn `makeEntity({ sk: "character/" + suffix })` from both. Settle 800 ms so both shard registrations land.
- **Author a private entity.** Spawn `makeEntity()` with no `sk` from lobby A. It belongs to A's own `game/<ns>` shard.
- **Live A to B.** Spawn a new shard entity from A after B is connected. `waitFor` its id in B's keys, with an 8 s timeout.
- **Live B to A.** Spawn a new shard entity from B. `waitFor` its id in A's keys.
- **Confirm isolation.** Settle 400 ms, then assert A's private entity id is absent from B's keys.
- **Read over HTTP.** Spawn `makeEntity({ sk: "character/" + id })` from any lobby, then `waitFor` a `fetch(BASE_URL + "/v1/characters/" + id)` whose JSON array contains that entity id. `curl -s $VAMP_URL/v1/characters/<id>` is the same call by hand.
- **Proof.** `control-vamp drive character-shards` writes `character-shards-live.json` (both live ids, the private id, and B's full delivered key set) and `character-shards-http.json` (the HTTP snapshot body).

## Gotchas

- Propagation is push-on-notify and needs a connected observer in the receiving lobby. A lobby with no observer syncs on connect only, and a scenario without one times out for the wrong reason.
- Shard registration is not instant. Settle after the first spawn into a shard before treating a later spawn as a live edit.
- An entity with no `sk` defaults server-side to the lobby's own `game/<ns>` shard. That default is what makes the isolation assertion meaningful, so do not set `sk` on the private entity.
- The HTTP snapshot is eventually consistent, read straight from the storage durable object. Poll it with `waitFor`; a single immediate `fetch` can return an empty array.
- `GET /v1/characters/:id` never starts a lobby, so it cannot confirm anything about lobby state. Use it only as a second, independent view of persisted entities.
