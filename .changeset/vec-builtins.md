---
"@vampgg/utils": minor
"@vampgg/cli": minor
---

Add vector built-ins. `@vampgg/utils/schema/vec.bop` defines `Vec2` and `Vec3` entity components with `Vec2Delta` and `Vec3Delta`. The deltas are `float32` counters, so fractional offsets survive the wire. A `Vec2Delta` that `vamp generate` synthesized from an app's own `Vec2` used `int32` fields and truncated them. `vamp init` imports `vec.bop` in the entity template.
