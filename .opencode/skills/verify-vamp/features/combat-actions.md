# Combat actions

Combat is what a player does to another entity. They send an action, the matching behavior runs on the server, and the resulting pool change streams back to every interested observer as a signed delta. An area attack cascades from a parent entity through its children.

## Sub-features

- `act-attack` subtracts damage from the targeted entity's health.
- `act-take-damage` applies the same subtraction without naming an attacker.
- `act-heal` adds to the targeted entity's health.
- `act-area-cascade` damages the target and every child, and drains child stamina.
- `act-echo` returns the dispatched action to the caller.

## How to get to it (user POV)

- Call `act(Actions.fromAttack(Attack({ source, target, damage })))` on a lobby socket.
- Call `act(Actions.fromTakeDamage(TakeDamage({ source, target, damage })))`.
- Call `act(Actions.fromHeal(Heal({ source, target, amount })))`.
- Call `act(Actions.fromAreaAttack(AreaAttack({ source, target, damage, radius })))`.

## Driving it with control-vamp

Preconditions:

- `control-vamp doctor` is green.
- The target entity exists in the lobby and carries a health pool.

- **Attack.** Spawn a target, then `await client.act(Actions.fromAttack(Attack({ source: id, target: id, damage: 30 })))`. The echoed action's `tag` is `1`.
- **Confirm the damage.** `waitFor` an update mutation keyed by the target id with `tag` `2`. Its `value.delta.health.points` is `-30`.
- **Heal.** `await client.act(Actions.fromHeal(Heal({ source: id, target: id, amount: 12 })))`. A second update arrives with `value.delta.health.points` of `12`.
- **Build a family.** Spawn a child with a stamina pool, then spawn a parent whose `children` contains the child id.
- **Area attack.** `await client.act(Actions.fromAreaAttack(AreaAttack({ source: parentId, target: parentId, damage: 5, radius: 1 })))`. Updates arrive for both the parent and the child, each with `value.delta.health.points` of `-5`.
- **Proof.** `control-vamp drive combat-actions` writes `combat-actions.json` (the ordered health deltas for one target) and `combat-area-attack.json` (parent and child deltas from one cascade).

## Gotchas

- The server routes an action by `record.value.target`, not by the socket that sent it. A wrong `target` silently no-ops.
- Deltas are signed and relative. `-30` is the change, not the remaining health. Summing deltas is the only way to reach a total.
- A behavior with `damage` or `amount` of `0` returns early and streams nothing. A scenario that uses `0` proves nothing.
- Child propagation follows the parent's `children` array, which is set at spawn. Spawn the child first so its id exists.
- Stamina drains only on entities that already have a stamina pool. `makeEntity` does not add one; pass it as an override.
