export class ThreadRunPreparationCancelled extends Error {
  constructor() {
    super("Run preparation cancelled by user.");
    this.name = "ThreadRunPreparationCancelled";
  }
}

/** Stop also revokes continuations that are still preparing their SDK/workspace. */
export class ThreadRunPreparationRegistry {
  private readonly pending = new Map<string, Set<AbortController>>();

  async prepare<T>(threadId: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const controllers = this.pending.get(threadId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.pending.set(threadId, controllers);
    try {
      return await run(controller.signal);
    } finally {
      controllers.delete(controller);
      if (controllers.size === 0 && this.pending.get(threadId) === controllers) {
        this.pending.delete(threadId);
      }
    }
  }

  cancel(threadId: string): boolean {
    const controllers = this.pending.get(threadId);
    if (!controllers?.size) return false;
    for (const controller of controllers) {
      controller.abort(new ThreadRunPreparationCancelled());
    }
    return true;
  }
}
