import type { BebopRecord } from "bebop";
import { AsyncQueue, type AsyncQueueOptions } from "./async-queue";
import { type CleanupFn, type Context, queueIterator } from "./create-event-iterator";

export type Writer<T> = (context: Context<T>) => void | CleanupFn | Promise<CleanupFn | void>;

/**
 * Duplex stream iterator. The outgoing generator is pumped in its own task and
 * the incoming stream is drained independently off a bounded {@link AsyncQueue}
 * — the two are never coupled, so an outgoing send with no incoming reply (or a
 * server push with no matching outgoing send) neither deadlocks nor drops
 * frames. Consumer teardown halts the outgoing pump and unsubscribes incoming.
 */
export function createDuplexIterator<T>(
  outgoing: AsyncGenerator<BebopRecord, void, undefined>,
  emitter: (record: BebopRecord) => void,
  incoming: Writer<T>,
  options?: AsyncQueueOptions,
): AsyncGenerator<T> {
  let unsubscribe: CleanupFn | void;
  // When the consumer goes away, dispose() must both unsubscribe AND stop the
  // outgoing pump so it cannot send on a torn-down transport.
  const queue = new AsyncQueue<T>(options, async () => {
    await outgoing.return?.(undefined); // halt the outgoing pump
    await unsubscribe?.();
  });

  const context: Context<T> = {
    emit: (value) => {
      queue.push(value);
    },
    cancel: () => queue.close(),
    error: (e) => queue.fail(e),
  };

  // Plain async iterator (not an `async function*`) so a consumer `return()`
  // issued while a `next()` is parked does not deadlock — see `queueIterator`.
  // Subscribing + starting the outgoing pump runs lazily on the first pull,
  // matching the previous async-generator body's lazy execution.
  return queueIterator(queue, async () => {
    unsubscribe = await incoming(context);

    // Outgoing runs as an independent task. Normal completion does NOT close the
    // incoming stream (the server may keep pushing after the client stops
    // sending); an outgoing-side failure surfaces to the consumer via the error
    // channel.
    const pump = (async () => {
      try {
        for await (const record of outgoing) {
          emitter(record);
        }
      } catch (e) {
        queue.fail(e);
      }
    })();
    // Avoid an unhandled rejection if the pump rejects after the consumer parks.
    void pump.catch(() => {});
  });
}
