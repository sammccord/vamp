---
"@vampgg/ecs": minor
"@vampgg/utils": minor
"@vampgg/cli": minor
---

Add behavior trees. `@vampgg/utils/schema/behavior.bop` defines `BehaviorTree` and `Brain` entity components. `@vampgg/ecs` adds a pure `evaluate`, a tree builder, and `createBehaviorTreeSystem`, which runs each agent's tree per update and dispatches the chosen actions through `act`. `ECS.waitUntil` keeps a `withScope` open until those dispatches settle, so their mutations commit in the tick's batch. Codegen now chooses a component's delta merge from a per-type table: `BehaviorTree` and `Brain` replace fields instead of summing them, via the new `applyReplaceDelta`/`accumulateReplaceDelta`. When `Entity` has both fields, codegen emits `createGameBehaviorTreeSystem`, which requires a leaf for every `Condition` and `Task` enum member. `vamp init` imports `behavior.bop` in the entity template.
