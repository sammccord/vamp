# World tick

A tick advances the server simulation. Every registered system runs once per frame: wounded entities regenerate, moving entities integrate their velocity, and hostiles chip the nearest player in range. Each frame commits one mutation scope, so a tick is visible to observers as streamed deltas.

## Sub-features

- `tick-frames` advances N frames and reports how many ran.
- `tick-regen` restores one health point per frame to an entity below max with a non-zero rate.
- `tick-movement` adds the entity's velocity to its position each frame.
- `tick-aggro` makes a hostile deal one damage to the nearest player-controlled entity in range.

## How to get to it (user POV)

- Call `tick(TickRequest({ steps, dtMs }))` on a lobby socket.

## Driving it with control-vamp

Preconditions:

- `control-vamp doctor` is green.
- The lobby holds entities the systems can act on, spawned before the tick.

- **Watch first.** `collect(await client.observe(MutationScope({})))` before spawning, so frame commits arrive as live mutations.
- **Spawn a wounded entity.** `makeEntity({ health: { points: 50, min: 0, max: 100, rate: 1, interval: 0 } })`.
- **Spawn a mover.** `makeEntity({ position: { x: 0, y: 0 }, velocity: { x: 3, y: -2 } })`.
- **Advance one frame.** `await client.tick(TickRequest({ steps: 1, dtMs: 16 }))`. The result's `frames` is `1`.
- **Confirm regen.** `waitFor` an update on the wounded entity whose `delta.health.points` is `1`.
- **Confirm movement.** `waitFor` an update on the mover whose `delta.position` equals `{ x: 3, y: -2 }`.
- **Set up aggro.** In a fresh namespace spawn `makeEntity({ tags: [Tags.PlayerControlled], position: { x: 0, y: 0 } })` and `makeEntity({ tags: [Tags.Hostile], position: { x: 10, y: 10 } })`, then tick one frame.
- **Confirm the chip.** `waitFor` an update on the player whose `delta.health.points` is `-1`.
- **Proof.** `control-vamp drive tick-systems` writes `tick-systems.json` (frame count, regen delta, movement delta) and `tick-aggro.json` (the hostile, the player, and the damage delta).

## Gotchas

- Regen needs `rate` above `0` and `points` below `max`. An entity at full health streams nothing, and neither does one with `rate: 0`, which is what `makeEntity` defaults to.
- Position arrives as a delta, so the streamed value equals the velocity, not the new absolute position.
- Velocity is rounded to an integer per frame. A fractional velocity below `0.5` rounds to zero and never moves.
- Aggro needs the `PlayerControlled` tag on the victim and the `Hostile` tag on the attacker, both with positions. Aggro range is 256 units; place them closer.
- Every tick runs every system. Reuse of a namespace across scenarios makes stray entities move and regenerate inside your assertions. Mint a fresh one.
