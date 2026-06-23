import { ConsoleLogger, TempoLogger, TempoLogLevel } from "@tempojs/common";

export class ContextLogger extends ConsoleLogger {
  bindings: Record<string, unknown> = {};

  constructor(
    sourceName: string,
    logLevel: TempoLogLevel = TempoLogLevel.Info,
    parent?: TempoLogger,
    bindings: Record<string, unknown> = {},
  ) {
    super(sourceName, logLevel, parent);
    this.bindings = bindings || {};
    // Allow re-creating a logger with the same source name without the
    // TempoLogger constructor throwing on a duplicate. Only drop THIS logger's
    // own registration (the normalized sourceName key) instead of clearing the
    // entire global registry, which would wipe every other component's logger.
    TempoLogger.instances.delete(sourceName.replace(/\s+/g, "_"));
  }

  correlate<TLogger extends TempoLogger>(
    sourceName: string,
    correlationId?: string,
    asOrphan?: boolean,
    bindings?: Record<string, unknown>,
  ): TLogger {
    return this.clone(sourceName, asOrphan, {
      ...(correlationId ? { correlationId } : {}),
      ...bindings,
    });
  }

  clone<TLogger extends TempoLogger>(
    sourceName: string,
    asOrphan?: boolean,
    bindings?: Record<string, unknown>,
  ): TLogger {
    const logger = Reflect.construct(this.constructor, [
      sourceName,
      this.logLevel,
      asOrphan !== true ? this : void 0,
    ]);
    logger.bindings = {
      ...this.bindings,
      ...bindings,
    };
    if (asOrphan !== true) {
      this.children.add(logger);
    }
    return logger;
  }
}
