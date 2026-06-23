/**
 * Single-consumer, multi-producer bounded async queue.
 *
 * Replaces the ad-hoc "array + single wakeup promise" queues that previously
 * backed `createEventIterator` / `createDuplexIterator`. Properties:
 *  - Ring buffer: O(1) enqueue/dequeue, never `Array.shift()`.
 *  - Bounded: `highWaterMark` caps buffered values; `push` returns `false` so
 *    producers can apply backpressure, and `overflow: "error"` turns a runaway
 *    producer into a thrown error instead of silent unbounded growth (OOM).
 *  - Error channel: `fail(e)` makes the consumer's `next()` throw `e`.
 *  - Lifecycle: a single `onDispose` runs exactly once on the first terminal
 *    transition (close / error / return / throw).
 *
 * Single-consumer contract: at most one `next()` may be outstanding at a time.
 * Every current use is a single `for await` / `yield*`, which satisfies this.
 */

export interface AsyncQueueOptions {
  /**
   * Maximum number of buffered, not-yet-consumed values. When the buffer is
   * full, `push` returns `false` (overflow). Defaults to 1024.
   */
  highWaterMark?: number;
  /**
   * Behavior when `push` is called on a full buffer:
   *  - "error" (default): the queue fails with an overflow error that is thrown
   *    into the consumer at the next `next()`.
   *  - "drop-latest": the pushed value is dropped, `push` returns false.
   * Producers should honor the boolean return value to apply backpressure.
   */
  overflow?: "error" | "drop-latest";
}

export class AsyncQueueOverflowError extends Error {
  constructor(highWaterMark: number) {
    super(`async queue overflowed (highWaterMark=${highWaterMark})`);
    this.name = "AsyncQueueOverflowError";
  }
}

type Resolver<T> = (r: IteratorResult<T>) => void;
type Rejecter = (e: unknown) => void;

export class AsyncQueue<T> implements AsyncIterableIterator<T> {
  // Ring buffer: head index + length, never `shift()`.
  private buffer: (T | undefined)[];
  private head = 0;
  private count = 0;

  private readonly highWaterMark: number;
  private readonly overflow: "error" | "drop-latest";

  // At most one pending consumer (single-consumer contract).
  private pendingResolve: Resolver<T> | null = null;
  private pendingReject: Rejecter | null = null;

  private closed = false; // producer signalled end-of-stream
  private error: unknown; // terminal error, thrown into consumer
  private hasError = false;
  // Invoked exactly once on the first terminal transition.
  private onDispose?: () => void | Promise<void>;
  private disposed = false;

  constructor(opts: AsyncQueueOptions = {}, onDispose?: () => void | Promise<void>) {
    this.highWaterMark = opts.highWaterMark ?? 1024;
    this.overflow = opts.overflow ?? "error";
    this.buffer = new Array(Math.min(this.highWaterMark, 32));
    this.onDispose = onDispose;
  }

  /** Producer: enqueue a value. Returns false if the buffer is full (backpressure signal). */
  push(value: T): boolean {
    if (this.closed || this.hasError) return false;
    // Fast path: a consumer is parked — hand the value over directly.
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      this.pendingReject = null;
      resolve({ value, done: false });
      return true;
    }
    if (this.count >= this.highWaterMark) {
      if (this.overflow === "error") {
        this.fail(new AsyncQueueOverflowError(this.highWaterMark));
        return false;
      }
      return false; // drop-latest
    }
    this.enqueue(value);
    return true;
  }

  /** Producer: terminate the stream as a clean completion. Idempotent. */
  close(): void {
    if (this.closed || this.hasError) return;
    this.closed = true;
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      this.pendingReject = null;
      resolve({ value: undefined as never, done: true });
    }
  }

  /** Producer: terminate the stream with an error thrown into the consumer. Idempotent. */
  fail(error: unknown): void {
    if (this.closed || this.hasError) return;
    this.hasError = true;
    this.error = error;
    if (this.pendingReject) {
      const reject = this.pendingReject;
      this.pendingResolve = null;
      this.pendingReject = null;
      reject(error);
    }
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.count > 0) {
      return { value: this.dequeue(), done: false };
    }
    if (this.hasError) {
      await this.dispose();
      throw this.error;
    }
    if (this.closed) {
      await this.dispose();
      return { value: undefined as never, done: true };
    }
    // Park the single consumer.
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;
    });
  }

  /** Consumer aborted early (break / return). Runs dispose and ends the stream. */
  async return(value?: unknown): Promise<IteratorResult<T>> {
    this.closed = true;
    // Resolve any parked consumer so its awaited next() does not dangle.
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      this.pendingReject = null;
      resolve({ value: undefined as never, done: true });
    }
    await this.dispose();
    return { value: value as never, done: true };
  }

  /** Consumer threw. Propagate after dispose. */
  async throw(e?: unknown): Promise<IteratorResult<T>> {
    this.closed = true;
    if (this.pendingReject) {
      const reject = this.pendingReject;
      this.pendingResolve = null;
      this.pendingReject = null;
      reject(e);
    }
    await this.dispose();
    throw e;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }

  private enqueue(value: T): void {
    if (this.count === this.buffer.length) this.grow();
    const tail = (this.head + this.count) % this.buffer.length;
    this.buffer[tail] = value;
    this.count++;
  }

  private dequeue(): T {
    const value = this.buffer[this.head]!;
    this.buffer[this.head] = undefined; // release reference
    this.head = (this.head + 1) % this.buffer.length;
    this.count--;
    return value;
  }

  private grow(): void {
    const next = new Array<T | undefined>(this.buffer.length * 2);
    for (let i = 0; i < this.count; i++) {
      next[i] = this.buffer[(this.head + i) % this.buffer.length];
    }
    this.buffer = next;
    this.head = 0;
  }

  private async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.onDispose?.();
  }
}
