# Interest routing

Interest routing decides what each connected player is told. An observer with an empty scope sees everything in its lobby. An observer scoped to a viewer entity sees only what that viewer's area of interest covers, and mutations outside it never reach that socket.

## Sub-features

- `observe-see-all` delivers every lobby mutation to an observer with an empty scope.
- `observe-multi-client` delivers the same mutation to every observer in one lobby.
- `observe-viewer-scope` filters a stream to one viewer entity's area of interest.
- `observe-no-leak` withholds out-of-range mutations from a scoped viewer.

## How to get to it (user POV)

- Call `observe(MutationScope({}))` on a lobby socket for a see-all stream.
- Call `observe(MutationScope({ mutations: new Map([[viewerId, …]]) }))` for an interest-filtered stream keyed by the viewer entity.

## Driving it with control-vamp

Preconditions:

- `control-vamp doctor` is green.
- Both observers connect to the same namespace, and viewer entities exist before their streams open.

- **Two players, one lobby.** `connect(ns)` twice against the same `ns`, then open a see-all `observe` on each.
- **Confirm the fan-out.** Spawn one entity through the first client. `waitFor` its id in both observers' mutation keys.
- **Place two viewers apart.** Spawn `makeEntity({ position: { x: 0, y: 0 } })` and `makeEntity({ position: { x: 1000, y: 1000 } })` from a third connection.
- **Scope each stream.** Open `observe` with a one-entry `mutations` map keyed by each viewer id, as `interest-routing.scenario.mts` does. Settle 200 ms so the initial filtered snapshots land.
- **Spawn one entity near each viewer.** `{ x: 10, y: 10 }` and `{ x: 1010, y: 1010 }`, after both observers are attached, so they arrive as live routed mutations.
- **Confirm delivery.** `waitFor` each near entity in its own viewer's keys.
- **Confirm isolation.** Settle 300 ms, then assert each viewer's key set does not contain the other's near entity.
- **Proof.** `control-vamp drive interest-routing` writes `interest-shared-lobby.json` (the fan-out) and `interest-aoi.json` (both viewers' full delivered key sets alongside the two near entity ids).

## Gotchas

- The viewer is resolved from the **first key** of the request scope's `mutations` map. The map's value is ignored, but the key must be a real entity id that already exists.
- An empty scope is not a filtered stream with everything allowed; it is a different code path. A see-all pass proves nothing about area-of-interest filtering.
- Absence is only meaningful after a positive delivery plus a settle. Asserting a missing key immediately passes for the wrong reason.
- Entities spawned before an observer attaches arrive in the snapshot, not through live routing. Spawn after attaching when the routing path is what you are testing.
- Both viewers must have positions. An entity without one is not placeable in any zone.
