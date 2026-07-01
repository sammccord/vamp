---
"@vampgg/cli": patch
---

`vamp init`: scaffold the `@vampgg/utils/schema/pool.bop` import as the stable, symlinked `node_modules/@vampgg/utils/…` path instead of the realpath. `require.resolve` previously resolved through pnpm's symlinks and baked a version-pinned `.pnpm/@vampgg+utils@<version>/…` path into `schema/entity.bop`, which broke on any dependency version bump.
