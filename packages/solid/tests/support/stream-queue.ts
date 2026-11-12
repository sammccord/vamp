/** A hand-driven async stream: push frames into it, or fail it like a dropped connection. */
export function createQueue<T>() {
  const buffered: T[] = [];
  let failure: { cause: unknown } | undefined;
  let wake: (() => void) | undefined;
  const signal = () => {
    wake?.();
    wake = undefined;
  };
  async function* stream(): AsyncGenerator<T, void, unknown> {
    while (true) {
      const next = buffered.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (failure) throw failure.cause;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  }
  return {
    iterator: stream(),
    push: (value: T) => {
      buffered.push(value);
      signal();
    },
    fail: (cause: unknown) => {
      failure = { cause };
      signal();
    },
  };
}
