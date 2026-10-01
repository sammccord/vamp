# Hostile behavior

A hostile mob decides what to do each frame with a behavior tree. While a player is within aggro range, it usually lands a regular hit and sometimes a heavy one, and the heavy hit then cools down. The hit reaches the player as an ordinary `Attack` action, so it cascades to the player's children like a hit a player sent. A lobby seeded with the same `rng` value replays the same sequence of hits.

## Sub-features

- `bt-pick` makes each frame's hit either `-1` (regular) or `-3` (heavy).
- `bt-cooldown` keeps two heavy hits at least 10 frames apart.
- `bt-dispatch` sends the hit through the `Attack` behavior, so a child of the player takes the same damage.
- `bt-replay` streams an identical hit sequence in two lobbies seeded with the same `rng`.
- `bt-out-of-range` makes a hostile with no player within 256 units do nothing.

## How to get to it (user POV)

- Connect with `rng=<n>` in the query string to seed the lobby's AI. Without it the seed is `1`.
- Spawn an entity with `brain: { tree: HOSTILE_TREE_ID }` and a position. `HOSTILE_TREE_ID` is exported from `examples/basic/src/systems.ts`.
- Call `tick(TickRequest({ steps, dtMs }))` to advance frames.

## Driving it with control-vamp

Preconditions:

- `control-vamp doctor` is green.
- Each lobby is a fresh `newNs(...)` namespace.

- **Seed a lobby.** `connect(newNs("bt"), "&rng=42")`, then `collect(await client.observe(MutationScope({})))`.
- **Spawn a family and a hostile.** Spawn a pet with `makeEntity({ health: { points: 1000, min: 0, max: 1000, rate: 0, interval: 0 } })`, a player with `tags: [Tags.PlayerControlled]`, `position: { x: 0, y: 0 }`, `children: [pet.id]` and the same pool, and a hostile with `position: { x: 10, y: 10 }` and `brain: { tree: HOSTILE_TREE_ID }`.
- **Run 20 frames.** `await client.tick(TickRequest({ steps: 20, dtMs: 16 }))`. The result's `frames` is `20`.
- **Read the hits.** `waitFor` 20 health updates on the pet. The player's `delta.health.points` values are each `-1` or `-3`, and the pet's list equals the player's.
- **Replay.** Repeat in a second fresh namespace with `&rng=42`. The player's hit list is identical.
- **Out of range.** In a fresh namespace place the player at `{ x: 1000, y: 1000 }`, tick 5 frames, and settle. No health update arrives for the player.
- **Proof.** `control-vamp drive hostile-behavior` writes `hostile-behavior.json` (both runs' hit lists and the pet's list) and `hostile-out-of-range.json` (the frames ticked and the player's empty delta list).

## Gotchas

- The `Hostile` tag does nothing on its own. Only an entity with a `brain` attacks.
- Health streams as signed deltas per frame. One frame is one update, so count updates, not totals.
- A regular hit and regen can cancel out. Give the player `rate: 0` or a frame's delta can read `0` and vanish.
- The seed and frame clock live in memory. A lobby that hibernates restarts both, so replay only holds within one lobby lifetime.
- Two hostiles near one player both hit it in the same frame, and the frame's delta is their sum.
