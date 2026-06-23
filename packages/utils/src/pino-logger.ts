import { type ConsoleLogger, type TempoLogger, TempoLogLevel } from "@tempojs/common";
import pino from "pino";
import { ContextLogger } from "./context-logger";

export class PinoLogger extends ContextLogger implements ConsoleLogger {
  logger: pino.Logger;
  sourceName: string;
  logLevel: TempoLogLevel;
  children: Set<TempoLogger> = new Set();

  constructor(
    sourceName: string,
    logLevel: TempoLogLevel = TempoLogLevel.Info,
    parent: pino.Logger = pino(),
    bindings?: Record<string, unknown>,
  ) {
    super(sourceName, logLevel, undefined, bindings);
    this.sourceName = sourceName;
    // Honor the constructor's logLevel argument instead of hardcoding Info, and
    // propagate it to the underlying pino child so filtering matches.
    this.logLevel = logLevel;
    this.logger = parent.child({ source: sourceName, ...bindings });
    this.logger.level = PinoLogger.getPinoLevel(String(logLevel));
  }

  static getPinoLevel(level: string): string {
    switch (level) {
      case "0":
        return "trace";
      case "1":
        return "debug";
      case "2":
        return "info";
      case "3":
        return "warn";
      case "4":
      case "5":
        return "error";
      default:
        return "info";
    }
  }

  clone<TLogger extends TempoLogger>(
    sourceName: string,
    asOrphan?: boolean,
    bindings?: Record<string, unknown>,
  ): TLogger {
    //@ts-expect-error this is fine
    return new PinoLogger(sourceName, this.logLevel, asOrphan ? undefined : this.logger, bindings);
  }

  write(
    level: TempoLogLevel,
    message: string,
    data: Record<string, unknown> = {},
    error?: Error,
  ): void {
    if (level < this.logLevel) {
      return;
    }
    let logError = "";

    if (error) {
      const stack = this.formatErrorMessage(error);
      logError = `\n${stack}`;
      data.error = logError;
    }
    switch (level) {
      case TempoLogLevel.Trace:
        this.logger.trace(data, message);
        break;
      case TempoLogLevel.Debug:
        this.logger.debug(data, message);
        break;
      case TempoLogLevel.Info:
        this.logger.info(data, message);
        break;
      case TempoLogLevel.Warn:
        this.logger.warn(data, message);
        break;
      case TempoLogLevel.Error:
        this.logger.error(data, message);
        break;
      case TempoLogLevel.Critical:
        this.logger.error(data, message);
        break;
    }
  }
  /**
   * @inheritDoc
   */
  trace(message: string, data?: Record<string, unknown>, error?: Error) {
    this.write(0 /* Trace */, message, data, error);
  }
  /**
   * @inheritDoc
   */
  debug(message: string, data?: Record<string, unknown>, error?: Error) {
    this.write(1 /* Debug */, message, data, error);
  }
  /**
   * @inheritDoc
   */
  info(message: string, data?: Record<string, unknown>, error?: Error) {
    this.write(2 /* Info */, message, data, error);
  }
  /**
   * @inheritDoc
   */
  warn(message: string, data?: Record<string, unknown>, error?: Error) {
    this.write(3 /* Warn */, message, data, error);
  }
  /**
   * @inheritDoc
   */
  error(message: string, data?: Record<string, unknown>, error?: Error) {
    this.write(4 /* Error */, message, data, error);
  }
  /**
   * @inheritDoc
   */
  critical(message: string, data?: Record<string, unknown>, error?: Error) {
    this.write(5 /* Critical */, message, data, error);
  }

  setLogLevel(level: TempoLogLevel): void {
    this.logLevel = level;
    const pinoLevel = this.tempoPinoLevelMap(level);
    this.logger.level = pinoLevel;
  }

  private tempoPinoLevelMap(level: TempoLogLevel): string {
    switch (level) {
      case TempoLogLevel.Trace:
        return "trace";
      case TempoLogLevel.Debug:
        return "debug";
      case TempoLogLevel.Info:
        return "info";
      case TempoLogLevel.Warn:
        return "warn";
      case TempoLogLevel.Error:
        return "error";
      case TempoLogLevel.Critical:
        return "fatal";
      default:
        return "info";
    }
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
