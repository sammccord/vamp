import type { BebopRecord } from "bebop";
import type { CleanupFn, Context } from "./create-event-iterator";

export type Writer<T> = (context: Context<T>) => void | CleanupFn | Promise<CleanupFn | void>;

export async function* createDuplexIterator<T>(
  outgoing: AsyncGenerator<BebopRecord, void, undefined>,
  emitter: (record: BebopRecord) => void,
  incoming: Writer<T>,
): AsyncGenerator<T> {
  const events: T[] = [];
  let cancelled = false;

  // Prime the promise BEFORE incoming() runs to prevent race condition
  // This ensures resolveNext is never null when events arrive
  let resolveNext: (() => void) | null = null;
  let nextPromise = new Promise<void>((resolve) => {
    resolveNext = resolve;
  });

  const emit = (event: T) => {
    events.push(event);
    // If we are awaiting for a new event, resolve the promise
    if (resolveNext) {
      resolveNext();
      // Create next promise immediately after resolving
      nextPromise = new Promise<void>((resolve) => {
        resolveNext = resolve;
      });
    }
  };

  const cancel = () => {
    cancelled = true;
    if (resolveNext) resolveNext();
  };

  const unsubscribe = await incoming({ emit, cancel });
  try {
    while (!cancelled) {
      const { value, done } = await outgoing.next();
      if (value && !done) {
        emitter(value);
        await nextPromise;
        if (events.length > 0) {
          yield events.shift()!;
        }
      } else if (done) {
        await nextPromise;
        if (events.length > 0) {
          yield events.shift()!;
        }
        break;
      }
    }
    // Process any remaining events that were emitted before cancellation.
    while (events.length > 0) {
      yield events.shift()!;
    }
  } finally {
    await unsubscribe?.();
  }
}
