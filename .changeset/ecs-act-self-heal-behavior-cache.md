---
"@vampgg/ecs": patch
---

`act`/`actWithBubbling` now self-heal an entity's behavior cache on read. Entity mutators (`insert`, `addComponent`, `removeComponent`, `addTag`, `removeTag`, `transformEntity`) only enqueue a deferred cache rebuild that is otherwise flushed by `update()`. Dispatching outside an update tick previously read a stale or absent cache and silently ran zero behaviors. Both dispatch paths now rebuild a pending entity before reading it, so reactive callers no longer need a manual `rebuildBehaviorCache(target)` before `act`, and an entity whose archetype changed after its cache was built no longer runs the stale behavior set. The pending flag is cleared on the on-read rebuild, so the next `update()` does not redo the work.
