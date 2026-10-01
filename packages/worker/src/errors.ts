/** Normalize a caught value into the `Error` the tempo loggers expect. */
export function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
