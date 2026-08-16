# Join a lobby

Joining a lobby is what a player does first. They open a websocket to a named game, their entity is inserted into that lobby's world, and every observer in the lobby sees the insert. The connect query string seeds that lobby's world context on the first connection.

## Sub-features

- `join-upgrade` upgrades the websocket for a named lobby.
- `join-spawn` inserts a player entity and echoes it back.
- `join-insert-stream` delivers the new entity to observers as an insert mutation.
- `join-context-seed` derives the lobby's world context from the connect query.
- `join-reject-plain` refuses a plain HTTP request on the game route.

## How to get to it (user POV)

- Open `ws://<host>:<port>/v1/game?ns=<lobby>` and call `spawn`.
- Add query params, for example `&faction=7`, to seed the lobby's world context.
- Add `&character=<id>` to load that player's character shard into the lobby.
- Issue a plain `GET /v1/game` with no upgrade header to see the rejection.

## Driving it with control-vamp

Preconditions:

- `control-vamp doctor` is green.
- The scenario mints its lobby with `newNs`, so no prior state is required.

- **Open the socket.** Connect as a player. `connect(newNs("join"))` then `await channel.waitForOpen()`. `channel.ws.readyState` is `WebSocket.OPEN`.
- **Watch the lobby.** Subscribe before acting. `collect(await client.observe(MutationScope({})))`. The stream is see-all for this lobby.
- **Spawn a player.** `await client.spawn(makeEntity())`. The response echoes the same `id` and `health.points` of `100`.
- **Confirm the insert reached observers.** `waitFor` a mutation keyed by the entity id. Its `tag` is `1` and its `value.entity.sk` is `game/<ns>`, the lobby's own shard.
- **Seed two lobbies differently.** `connect(ns + "-a", "&faction=7")` and `connect(ns + "-b", "&faction=9")`, then spawn an entity with no faction in each. The spawn responses come back with `faction` `7` and `9`.
- **Reject a plain request.** `curl -s -o /dev/null -w '%{http_code}' $VAMP_URL/v1/game` returns `426`. The body is `Expected Upgrade: websocket`. `control-vamp doctor` already asserts this.
- **Proof.** `control-vamp drive join-lobby` writes `join-lobby.json` (the spawn response and every streamed mutation) and `join-lobby-context.json` (both lobbies' resolved factions) into the run's artifacts.

## Gotchas

- The world context is first-connection-wins per lobby. A second connection with a different `faction` does not change it, so seed a fresh namespace to test a different value.
- `character` is deliberately not part of the context seed. Passing it changes which shard loads, not the world context.
- An entity with no `health` pool matches none of the example's behaviors. `makeEntity` supplies one; a hand-built entity must too.
- Subscribe before you spawn. `observe` yields an initial filtered snapshot, but a scenario that spawns first and subscribes second proves the snapshot path, not the live routing path.
- The response to `spawn` is an echo. It is not evidence that anything reached another client. Assert the streamed mutation.
