---
"@vampgg/ecs": minor
"@vampgg/cli": minor
---

Behavior handlers are now typed for the action tag they handle. `createBehavior` takes `tag` as a literal `Tag` type parameter (constrained to `Actions["tag"]` instead of `number`) and types the handler's `event.detail` as `Extract<Actions, { tag: Tag }>`, so handlers no longer cast the payload. The new `BehaviorHandler` type is exported from `@vampgg/ecs`. Codegen emits an `ActionTag` const map from each `Actions` branch name to its discriminator, and `createGameBehavior(ActionTag.Heal, handler, ...)` infers `Tag` and narrows the handler the same way.
