/** User queue intent must survive asynchronous Stop/preparation cleanup. */
export class ThreadFollowUpQueueControl {
  private readonly revisions = new Map<string, number>();
  private readonly stops = new Map<string, number>();

  revision(threadId: string): number {
    return this.revisions.get(threadId) ?? 0;
  }

  changed(threadId: string): void {
    this.revisions.set(threadId, this.revision(threadId) + 1);
  }

  stopped(threadId: string): void {
    this.changed(threadId);
    this.stops.set(threadId, this.revision(threadId));
  }

  shouldPauseCancelledRun(threadId: string): boolean {
    const stoppedAt = this.stops.get(threadId);
    return stoppedAt === undefined || stoppedAt === this.revision(threadId);
  }

  finished(threadId: string): void {
    this.stops.delete(threadId);
  }

  clear(threadId: string): void {
    this.stops.delete(threadId);
    this.revisions.delete(threadId);
  }
}
