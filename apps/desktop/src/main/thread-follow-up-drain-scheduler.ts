/** Coalesce drains without losing a Resume/edit-release arriving during a drain. */
export class ThreadFollowUpDrainScheduler {
  private readonly running = new Map<string, { pending: boolean; promise: Promise<void> }>();

  isDraining(threadId: string): boolean { return this.running.has(threadId); }

  drain(threadId: string, run: () => Promise<void>): Promise<void> {
    const existing = this.running.get(threadId);
    if (existing) {
      existing.pending = true;
      return existing.promise;
    }
    const state = { pending: true, promise: Promise.resolve() };
    state.promise = Promise.resolve().then(async () => {
      try {
        while (state.pending) {
          state.pending = false;
          await run();
        }
      } finally {
        this.running.delete(threadId);
      }
    });
    this.running.set(threadId, state);
    return state.promise;
  }
}
