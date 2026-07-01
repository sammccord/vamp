---
"@vampgg/cli": minor
---

`vamp generate`: the generated `GameECS` durable object now exposes an overridable `Env` generic (previously the `ECSDurableObject` `Env` slot was hardcoded to `Cloudflare.Env`). The default is configurable via a new optional `env` field in `vamp.json` (defaults to `"Cloudflare.Env"`, preserving current behavior). Non-Worker packages that lack wrangler types can set `"env": "unknown"` (or a local bindings type) so the generated durable object type-checks without a `Cloudflare.Env` shim.
