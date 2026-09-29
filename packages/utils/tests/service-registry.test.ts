import { ConsoleLogger, MethodType, type TempoLogger } from "@tempojs/common";
import { type BebopMethodAny, ServiceRegistry } from "@tempojs/server";
import { describe, expect, it } from "vitest";
import { CompositeServiceRegistry } from "../src/service-registry.ts";

class FakeRegistry extends ServiceRegistry {
  initCalls = 0;

  constructor(
    logger: TempoLogger,
    private readonly methodIds: number[],
  ) {
    super(logger);
  }

  init(): void {
    this.initCalls++;
  }

  getMethod(methodId: number): BebopMethodAny | undefined {
    return this.methodIds.includes(methodId) ? fakeMethod(`m${methodId}`) : undefined;
  }
}

function fakeMethod(name: string): BebopMethodAny {
  const unused = () => {
    throw new Error(`${name} is a lookup-only fake`);
  };
  return {
    name,
    service: "Fake",
    invoke: unused,
    serialize: unused,
    deserialize: unused,
    stringify: unused,
    fromJSON: unused,
    type: MethodType.Unary,
  };
}

// TempoLogger keeps a process-global registry keyed by name, so a second
// `new ConsoleLogger(...)` with the same name throws. One shared instance.
const logger = new ConsoleLogger("service-registry-test");

describe("CompositeServiceRegistry", () => {
  it("inits each child exactly once, even when init is re-entered", () => {
    const a = new FakeRegistry(logger, [1]);
    const b = new FakeRegistry(logger, [2]);
    const composite = new CompositeServiceRegistry(logger, [a, b]);
    composite.init();
    composite.init();
    expect(a.initCalls).toBe(1);
    expect(b.initCalls).toBe(1);
  });

  it("resolves methods across children, first hit wins", () => {
    const composite = new CompositeServiceRegistry(logger, [
      new FakeRegistry(logger, [1]),
      new FakeRegistry(logger, [2]),
    ]);
    expect(composite.getMethod(1)?.name).toBe("m1");
    expect(composite.getMethod(2)?.name).toBe("m2");
    expect(composite.getMethod(3)).toBeUndefined();
  });
});
