---
"@vampgg/cli": patch
---

`vamp generate`: emit explicit `.js` extensions on the generated relative imports (e.g. `./bebop.js`). The extensionless specifier only resolved under `moduleResolution: bundler`; the `.js` form resolves under `nodenext` too (it maps back to the `.ts` source), so the generated output now type-checks in both module-resolution modes.
