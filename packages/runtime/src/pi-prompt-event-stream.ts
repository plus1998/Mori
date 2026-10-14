/** Bridge PI's callback events without making Stop wait for another SDK event. */
export async function* streamPiPromptEvents<T>(input: {
  signal?: AbortSignal | undefined;
  subscribe: (push: (events: readonly T[]) => void) => () => void;
  run: () => Promise<unknown>;
  abort: () => Promise<void>;
}): AsyncGenerator<T, { done: boolean; runError: unknown }> {
  const queue: T[] = [];
  let resolveWait: (() => void) | undefined;
  let done = false;
  let runError: unknown;
  const wake = () => {
    resolveWait?.();
    resolveWait = undefined;
  };
  const unsubscribe = input.subscribe((events) => {
    queue.push(...events);
    wake();
  });
  input.signal?.addEventListener("abort", wake, { once: true });
  const run = Promise.resolve()
    .then(() => (input.signal?.aborted ? undefined : input.run()))
    .then(
      () => {
        done = true;
        wake();
      },
      (error: unknown) => {
        runError = error;
        done = true;
        wake();
      },
    );
  try {
    while (!done || queue.length > 0) {
      if (input.signal?.aborted) {
        // Cancellation is only settled after PI and the actual prompt exit.
        await input.abort();
        break;
      }
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          resolveWait = resolve;
        });
      } else {
        const event = queue.shift();
        if (event !== undefined) yield event;
      }
    }
    await run;
    return { done, runError };
  } finally {
    input.signal?.removeEventListener("abort", wake);
    unsubscribe();
  }
}
