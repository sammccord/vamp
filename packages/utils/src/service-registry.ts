import type { TempoLogger } from "@tempojs/common";
import { type BebopMethodAny, ServiceRegistry } from "@tempojs/server";

/**
 * One router takes one registry, but a host can generate services across
 * several packages (each with its own registry class). Method ids are
 * service+method hashes (collision-free across services), so first-hit-wins
 * lookup is safe. Generated `init()` is destructive (moves the
 * decorator-registered singleton out of a static map), so it must run exactly
 * once — the router constructor also calls `init()`.
 */
export class CompositeServiceRegistry extends ServiceRegistry {
  #initialized = false;

  constructor(
    logger: TempoLogger,
    private readonly registries: readonly ServiceRegistry[],
  ) {
    super(logger);
  }

  init(): void {
    if (this.#initialized) return;
    this.#initialized = true;
    for (const registry of this.registries) registry.init();
  }

  getMethod(methodId: number): BebopMethodAny | undefined {
    for (const registry of this.registries) {
      const method = registry.getMethod(methodId);
      if (method) return method;
    }
    return undefined;
  }
}
