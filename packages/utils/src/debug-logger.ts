import { type ConsoleLogger, type TempoLogger, TempoLogLevel } from "@tempojs/common";
import debug from "debug";
import { ContextLogger } from "./context-logger";

export class DebugLogger extends ContextLogger implements ConsoleLogger {
  bindings: Record<string, unknown> = {};
  private debuggers: Record<string, debug.Debugger>;
  sourceName: string;
  logLevel: TempoLogLevel;
  protected readonly children: Set<TempoLogger> = new Set();

  constructor(
    sourceName: string,
    logLevel: TempoLogLevel = TempoLogLevel.Info,
    parent?: TempoLogger,
    bindings: Record<string, unknown> = {},
  ) {
    super(sourceName, logLevel, parent, bindings);
    this.sourceName = sourceName;
    this.logLevel = logLevel;
    this.debuggers = {
      trace: debug(`${sourceName}:trace`),
      debug: debug(`${sourceName}:debug`),
      info: debug(`${sourceName}:info`),
      warn: debug(`${sourceName}:warn`),
      error: debug(`${sourceName}:error`),
      critical: debug(`${sourceName}:critical`),
    };
  }

  correlate<TLogger extends TempoLogger>(
    sourceName: string,
    correlationId: string,
    asOrphan?: boolean,
    bindings?: Record<string, unknown>,
  ): TLogger {
    return this.clone(sourceName, asOrphan, {
      ...bindings,
      correlationId,
    });
  }

  clone<TLogger extends TempoLogger>(
    sourceName: string,
    asOrphan?: boolean,
    bindings?: Record<string, unknown>,
  ): TLogger {
    const namespace = asOrphan ? sourceName : `${this.sourceName}:${sourceName}`;
    const logger = new DebugLogger(namespace, this.logLevel, asOrphan !== true ? this : void 0, {
      ...this.bindings,
      ...bindings,
    });
    if (asOrphan !== true) {
      this.children.add(logger);
    }
    //@ts-expect-error this is fine
    return logger;
  }

  write(
    level: TempoLogLevel,
    message: string,
    data: Record<string, unknown> = {},
    error?: Error,
  ): void {
    // Check if this log level should be written based on current log level
    if (level < this.logLevel) {
      return;
    }

    let logError = "";
    if (error) {
      const stack = this.formatErrorMessage(error);
      logError = `\n${stack}`;
      data.error = logError;
    }

    const debugData = ` ${JSON.stringify({ ...this.bindings, ...data }, null, 2)}`;
    const fullMessage = `${message}${debugData}`;

    switch (level) {
      case TempoLogLevel.Trace:
        this.debuggers.trace(fullMessage);
        break;
      case TempoLogLevel.Debug:
        this.debuggers.debug(fullMessage);
        break;
      case TempoLogLevel.Info:
        this.debuggers.info(fullMessage);
        break;
      case TempoLogLevel.Warn:
        this.debuggers.warn(fullMessage);
        break;
      case TempoLogLevel.Error:
        this.debuggers.error(fullMessage);
        break;
      case TempoLogLevel.Critical:
        this.debuggers.critical(fullMessage);
        break;
    }
  }

  /**
   * @inheritDoc
   */
  trace(message: string, data?: Record<string, unknown>, error?: Error) {
    this.write(TempoLogLevel.Trace, message, data, error);
  }

  /**
   * @inheritDoc
   */
  debug(message: string, data?: Record<string, unknown>, error?: Error) {
    this.write(TempoLogLevel.Debug, message, data, error);
  }

  /**
   * @inheritDoc
   */
  info(message: string, data?: Record<string, unknown>, error?: Error) {
    this.write(TempoLogLevel.Info, message, data, error);
  }

  /**
   * @inheritDoc
   */
  warn(message: string, data?: Record<string, unknown>, error?: Error) {
    this.write(TempoLogLevel.Warn, message, data, error);
  }

  /**
   * @inheritDoc
   */
  error(message: string, data?: Record<string, unknown>, error?: Error) {
    this.write(TempoLogLevel.Error, message, data, error);
  }

  /**
   * @inheritDoc
   */
  critical(message: string, data?: Record<string, unknown>, error?: Error) {
    this.write(TempoLogLevel.Critical, message, data, error);
  }

  setLogLevel(level: TempoLogLevel): void {
    this.logLevel = level;
    // Note: debug library uses DEBUG env var for filtering
    // Individual debugger enabling/disabling is controlled at creation time
  }

  formatErrorMessage(error: Error, indentLevel = 0) {
    const indent = "  ".repeat(indentLevel);
    const message = error.message || "Unknown error";
    const stack = error.stack || "Stack unavailable";
    const indentedStack = stack
      .split("\n")
      .map((line) => `${indent}${line}`)
      .join("\n");
    let cause = "";
    if ("cause" in error) {
      cause =
        error?.cause instanceof Error ? this.formatErrorMessage(error.cause, indentLevel + 1) : "";
    }
    return `
${indent}Error message: ${message}
${indentedStack}
${indent}${cause ? `Cause: ${cause}` : ""}`.trimEnd();
  }
}
