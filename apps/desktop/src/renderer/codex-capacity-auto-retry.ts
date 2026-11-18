import { CODEX_CAPACITY_RETRY_LIMIT, type CodexCapacityRetryNotice } from "../shared/codex-capacity-retry";

/** Deduplicate capacity notices before sending, including repeated React effects. */
export class CodexCapacityAutoRetry {
  private attempts = new Map<string, { handledNoticeIds: Set<string>; retriesStarted: number }>();

  private selectAttempt(threadId: string, attemptId: string) {
    const identity = JSON.stringify([threadId, attemptId]);
    let attempt = this.attempts.get(identity);
    if (!attempt) {
      attempt = { handledNoticeIds: new Set(), retriesStarted: 0 };
      this.attempts.set(identity, attempt);
    }
    return attempt;
  }

  markHandled(threadId: string, notice: CodexCapacityRetryNotice) {
    this.selectAttempt(threadId, notice.runAttemptId).handledNoticeIds.add(notice.id);
  }

  observe(
    input: {
      threadId: string;
      attemptId: string;
      threadStatus: string;
      enabled: boolean;
      isCodexLogin: boolean;
      notice: CodexCapacityRetryNotice | undefined;
    },
    sendContinue: () => void,
  ) {
    const notice = input.notice;
    if (
      !input.enabled ||
      !input.isCodexLogin ||
      input.threadStatus !== "running" ||
      !input.threadId ||
      !input.attemptId ||
      !notice ||
      notice.runAttemptId !== input.attemptId
    ) return;

    const attempt = this.selectAttempt(input.threadId, input.attemptId);
    if (attempt.handledNoticeIds.has(notice.id) || attempt.retriesStarted >= CODEX_CAPACITY_RETRY_LIMIT) return;
    attempt.handledNoticeIds.add(notice.id);
    attempt.retriesStarted += 1;
    // retryAt belongs to Codex's native backoff. Steer immediately instead.
    sendContinue();
  }
}
