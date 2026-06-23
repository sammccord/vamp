import { AsyncQueue, type AsyncQueueOptions } from "./async-queue";

export type Context<T> = {
  emit: (value: T) => void;
  /** Terminate the stream as a clean completion. */
  cancel: () => void;
  /** Terminate the stream with an error thrown into the consumer's `for await`. */
  error: (e: unknown) => void;
};

export type CleanupFn = () => void | Promise<void>;

export type Subscriber<T> = (context: Context<T>) => void | CleanupFn | Promise<CleanupFn | void>;

/**
 * Wrap an {@link AsyncQueue} in a hand-rolled async iterator that delegates
 * `next`/`return`/`throw` directly to the queue.
 *
 * This deliberately does NOT use an `async function*` wrapper. An async
 * generator serializes `next`/`return`/`throw` through an internal request
 * queue, so a `return()` issued while a `next()` is still parked (the common
 * "consume in the background, then call `return()` to stop" pattern) is queued
 * *behind* that pending `next()`. The pending `next()` only settles once the
 * queue is closed — which is exactly what the queued `return()` would do — so
 * the two deadlock and the stream hangs forever. A plain object iterator has no
 * such serialization: `return()` runs immediately, `queue.return()` resolves the
 * parked `next()`, and the consumer's `for await` ends cleanly.
 *
 * `start` is invoked lazily on the first pull (matching the lazy semantics of
 * the previous `async function*` body, whose code did not run until the first
 * `next()`), and is awaited by `return()`/`throw()` so a subscription that has
 * begun establishing always has its cleanup captured before dispose runs.
 */
export function queueIterator<T>(
  queue: AsyncQueue<T>,
  start: () => Promise<void>,
): AsyncGenerator<T> {
  let started: Promise<void> | undefined;
  const ensureStarted = () => {
    started ??= start();
    return started;
  };
  const iterator = {
    async next(): Promise<IteratorResult<T>> {
      await ensureStarted();
      return queue.next();
    },
    async return(value?: unknown): Promise<IteratorResult<T>> {
      // If iteration began, let a pending subscription settle first so its
      // cleanup is captured before dispose runs (tolerate a failed start).
      if (started !== undefined) await started.catch(() => {});
      return queue.return(value);
    },
    async throw(e?: unknown): Promise<IteratorResult<T>> {
      if (started !== undefined) await started.catch(() => {});
      return queue.throw(e);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return iterator as unknown as AsyncGenerator<T>;
}

/**
 * Bridge a callback-style event source into an async iterator backed by a
 * bounded {@link AsyncQueue}. The subscriber receives `{ emit, cancel, error }`
 * and may return a cleanup function, which runs exactly once when the stream
 * terminates (close / error / consumer `break` / consumer `return()` / throw).
 */
export function createEventIterator<T>(
  subscriber: Subscriber<T>,
  options?: AsyncQueueOptions,
): AsyncGenerator<T> {
  let unsubscribe: CleanupFn | void;
  const queue = new AsyncQueue<T>(options, () => unsubscribe?.());

  const context: Context<T> = {
    emit: (value) => {
      queue.push(value);
    },
    cancel: () => queue.close(),
    error: (e) => queue.fail(e),
  };

  // Subscribe on the first pull; capture the cleanup so the queue's dispose can
  // run it exactly once.
  return queueIterator(queue, async () => {
    unsubscribe = await subscriber(context);
  });
}
