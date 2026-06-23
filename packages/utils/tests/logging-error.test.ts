import { TempoLogLevel } from "@tempojs/common";
import { describe, expect, test } from "vitest";
import { ContextLogger } from "../src/context-logger.ts";
import { ErrorTags, SystemError } from "../src/error.ts";
import { PinoLogger } from "../src/pino-logger.ts";

describe("logging & error footguns (plan 20)", () => {
  test("two same-named ContextLoggers can be constructed without throwing", () => {
    // The TempoLogger base throws on a duplicate sourceName; the scoped
    // self-delete must allow re-creation without wiping the global registry.
    const a = new ContextLogger("dup-name");
    const b = new ContextLogger("dup-name");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
  });

  test("PinoLogger honors the constructor logLevel instead of hardcoding Info", () => {
    const debug = new PinoLogger("pino-debug", TempoLogLevel.Debug);
    expect(debug.logLevel).toBe(TempoLogLevel.Debug);
    expect(debug.logger.level).toBe("debug");

    const error = new PinoLogger("pino-error", TempoLogLevel.Error);
    expect(error.logLevel).toBe(TempoLogLevel.Error);
    expect(error.logger.level).toBe("error");
  });

  test("SystemError does not mutate the caller's error object and carries the tag", () => {
    const input = { msg: "boom", code: 7 };
    const e = new SystemError(ErrorTags.Validation, input);
    expect(e._tag).toBe(ErrorTags.Validation);
    expect(e.cause.tag).toBe(ErrorTags.Validation);
    expect(e.cause.msg).toBe("boom");
    // The caller's partial must be untouched (no `tag` injected by side effect).
    expect((input as Record<string, unknown>).tag).toBeUndefined();
  });
});
