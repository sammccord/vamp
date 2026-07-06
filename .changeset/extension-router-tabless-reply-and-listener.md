---
"@vampgg/utils": minor
---

`TempoExtensionRouter` now replies to tabless senders, and a reusable inbound listener is exported.

- **Fix:** the router's reply path only used `tabs.sendMessage` and bailed when the sender had no `tab`, so a **popup / options / extension-page** caller never received its response and the call timed out. Replies to tabless senders now go over `runtime.sendMessage` (broadcast; each channel demultiplexes by `messageId`, so only the awaiting caller resolves). The tab check also uses `sender.tab?.id !== undefined` instead of a truthiness test, which previously dropped tab id `0`, and an undeliverable reply (popup closed, tab navigated) is now logged at `debug` rather than `error`.
- **Add:** `createExtensionListener(router, registry)` — the inbound `runtime.onMessage` guard the router never shipped. Only frames from this extension (`sender.id === runtime.id`) that decode to a `Message` with a registered `methodId` are dispatched; other extensions, reply frames, and malformed traffic are ignored. Replies travel back through the router's send path, so it never uses `sendResponse`. Exported alongside the `ExtensionSenderContext` type.
