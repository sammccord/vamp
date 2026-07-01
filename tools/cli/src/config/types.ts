export interface FrameworkConfig {
  /** Path to the bebop.json config file (default: "./bebop.json") */
  bebopConfig?: string;
  schemas: {
    entity: string;
    actions: string;
    state: string;
    tags: string;
    /**
     * Path for the generated bebop mutation schema (EntityDelta, MutationScope).
     * Defaults to a `mutation.bop` sibling of the entity schema.
     */
    mutation?: string;
  };
  outFile: string;
  /**
   * Override path for the generated **pure** ECS file (components, deltas, helpers,
   * factory, systems — depends only on `@vampgg/ecs`). Defaults to a sibling of
   * `outFile` with `.core.generated.ts` in place of `.generated.ts`.
   */
  coreOutFile?: string;
  /**
   * Override path for the generated **worker** file (the `GameECS` durable object,
   * runtime, and interest broadcast — depends on `@vampgg/worker`). Defaults to a
   * sibling of `outFile` with `.worker.generated.ts` in place of `.generated.ts`.
   */
  workerOutFile?: string;
  /**
   * TypeScript type used as the default `Env` generic of the generated `GameECS`
   * durable object. Defaults to `"Cloudflare.Env"` (the wrangler-generated bindings
   * type). Set to `"unknown"`, `"{}"`, or a locally-declared type for non-Worker
   * packages that lack wrangler types.
   */
  env?: string;
}

export interface BebopConfig {
  include?: string[];
  exclude?: string[];
  generators?: {
    ts?: {
      outFile?: string;
    };
  };
  watchOptions?: {
    excludeDirectories?: string[];
  };
}
