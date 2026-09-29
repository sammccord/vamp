import { ConsoleLogger, TempoLogger, TempoLogLevel } from "@tempojs/common";

/** Structured log fields, as TempoLogger's own `write` contract defines them. */
export type LogData = NonNullable<Parameters<TempoLogger["write"]>[2]>;

export class ContextLogger extends ConsoleLogger {
  bindings: LogData = {};

  constructor(
    sourceName: string,
    logLevel: TempoLogLevel = TempoLogLevel.Info,
    parent?: TempoLogger,
    bindings: LogData = {},
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
    bindings?: LogData,
  ): TLogger {
    const merged = correlationId ? { correlationId } : {};
    Object.assign(merged, bindings);
    return this.clone(sourceName, asOrphan, merged);
  }

  clone<TLogger extends TempoLogger>(
    sourceName: string,
    asOrphan?: boolean,
    bindings?: LogData,
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
