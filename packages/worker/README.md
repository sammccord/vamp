# @vamp/worker

Cloudflare Workers Durable Object integration for @vamp. Hosts the ECS runtime
in a Durable Object, syncs state via yjs, and serves tempo RPC over hibernatable
WebSockets.

## Development

```bash
vp install   # install dependencies
vp test      # run the unit tests
vp build     # build the library
```
