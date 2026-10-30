import type { ThreadRuntimeConfig } from "../shared/thread-runtime-config";

/** The warning compares edits against the configuration accepted by the latest
 * execution, including retries, plan approval and messages sent by other clients.
 */
export class ComposerPromptCacheBaseline {
  private readonly byThread = new Map<string, { config: ThreadRuntimeConfig; attemptId?: string }>();

  observe(threadId: string, config: ThreadRuntimeConfig, attemptId: string | undefined): boolean {
    const previous = this.byThread.get(threadId);
    if (previous && (!attemptId || previous.attemptId === attemptId)) return false;
    this.byThread.set(threadId, { config, ...(attemptId ? { attemptId } : {}) });
    return true;
  }

  get(threadId: string): ThreadRuntimeConfig | undefined {
    return this.byThread.get(threadId)?.config;
  }
}
