import { createSignal, DEV, flush } from "solid-js";
import { describe, expect, it } from "vitest";

/**
 * Guards `vite.config.ts`'s `ssr.resolve.conditions` override. Without it the
 * suite loads Solid's SSR build, where writes commit synchronously and the
 * dev-only owned-write diagnostics are absent — every other test here would
 * then pass without exercising the semantics the client binding actually runs
 * under.
 */
describe("test build conditions", () => {
  it("loads the development client build, not the SSR build", () => {
    expect(DEV).toBeDefined();
  });

  it("stages writes until flush, as the client build does", () => {
    const [value, setValue] = createSignal(0);
    setValue(1);
    expect(value()).toBe(0);
    flush();
    expect(value()).toBe(1);
  });
});
