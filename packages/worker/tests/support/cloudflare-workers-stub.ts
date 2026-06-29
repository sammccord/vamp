// Stand-in for the `cloudflare:workers` virtual module so the Durable Object can
// be imported and instantiated under plain Node (the real module only exists in
// workerd). Aliased in `vitest.do.config.mts`. Only the `DurableObject` base is
// needed: it stores `ctx`/`env` exactly like the runtime's does, which is all the
// ECS DO relies on from the base class.
export class DurableObject<Env = unknown> {
  protected ctx: DurableObjectState;
  protected env: Env;
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export type Env = Record<string, unknown>;
