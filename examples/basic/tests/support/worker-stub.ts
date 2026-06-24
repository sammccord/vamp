// Stub for `@vamp/worker` in the e2e module graph. `game.generated` imports it
// only to define the Durable Object classes (GameECS/GameStorage) and
// `defineGameECSRuntime` — none of which run in these tests, which use only the
// pure `createECSOptions`/`components`/delta functions from the same generated
// module. Stubbing `@vamp/worker` keeps its CF-runtime-only `cloudflare:workers`
// import out of the vite/jsdom graph entirely; the real worker runs in the
// separate `wrangler dev` process.
export class ECSDurableObject {}
export class ECSStorage {}
export function defineECSRuntime(): void {}
