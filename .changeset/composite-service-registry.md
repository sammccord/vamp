---
"@vampgg/utils": minor
---

Add `CompositeServiceRegistry` as the `@vampgg/utils/service-registry` subpath: one `ServiceRegistry` that fronts several generated registries behind a single router. `getMethod` resolves first-hit-wins — method ids are service+method hashes and collision-free across services — and `init()` forwards to every child exactly once even when re-entered, because generated `init()` is destructive (it drains tempo's decorator-registration static map).
