import { TempoError, TempoStatusCode } from "@tempojs/common";
import type { Error as BebopError } from "./bebop";
import defaults from "lodash-es/defaults";

export class SystemError<Tag extends string> extends TempoError {
  readonly _tag: Tag;
  readonly cause: BebopError;
  constructor(tag: Tag, error?: Partial<Omit<BebopError, "tag">>) {
    // Copy the caller-provided partial first so lodash `defaults` (which mutates
    // its first argument) cannot mutate the caller's object.
    const err = defaults(
      { ...error },
      {
        code: TempoStatusCode.UNKNOWN,
        stack: "",
        msg: "Unknown error occured",
        details: new Map(),
      },
    );
    const cause = { ...err, tag } as BebopError;
    super(err.code, err.msg, cause);
    this._tag = tag;
    this.cause = cause;
  }

  static generic(err: unknown, tag?: ErrorTags, opts?: Partial<Omit<BebopError, "tag">>) {
    return new SystemError(tag || ErrorTags.Unknown, {
      msg: err instanceof Error ? err.message : "Unknown error occured",
      code: err instanceof TempoError ? err.status : TempoStatusCode.INTERNAL,
      details:
        err instanceof Error
          ? err.cause instanceof Map
            ? err.cause
            : new Map()
          : // biome-ignore lint/suspicious/noExplicitAny: error handling
            new Map([["cause", JSON.stringify((err as any)?.cause || "")]]),
      stack: (err as Error)?.stack || "",
      ...opts,
    });
  }
}

export enum ErrorTags {
  PgOutage = "PgOutage",
  RedisOutage = "RedisOutage",
  Unknown = "Unknown",
  NeedPermissions = "NeedPermissions",
  Validation = "Validation",
  Authorization = "Authorization",
  GameStateGeneration = "GameStateGeneration",
  InvalidPrompt = "InvalidPrompt",
  UnknownAIProvider = "UnknownAIProvider",
  FailedToStart = "FailedToStart",
  Unimplemented = "Unimplemented",
  IncompatibleVersion = "IncompatibleVersion",
  PingUnacceptable = "PingUnacceptable",
}
