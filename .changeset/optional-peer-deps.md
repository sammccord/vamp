---
"@vampgg/utils": major
"@vampgg/worker": minor
---

Make transport- and logger-specific packages optional, and drop pino from game Workers.

**`@vampgg/utils` (breaking).** `pino`, `websocket-ts`, and `webextension-polyfill` are optional peer dependencies. Install the one matching the entry point you import: `pino` for `pino-logger`, `websocket-ts` for `ws-channel`, `webextension-polyfill` for `extension-channel` and `extension-router`.

**`@vampgg/worker`.** The default logger is a console `ContextLogger`, so a game Worker no longer bundles pino. Pass `logger` to keep structured pino output.
