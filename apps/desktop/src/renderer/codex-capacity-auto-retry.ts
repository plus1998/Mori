import type { CodexCapacityRetryNotice } from "../shared/codex-capacity-retry";

/** Deduplicate capacity notices before sending, including repeated React effects. */
export class CodexCapacityAutoRetry {
  private handledNoticeIdsByAttempt = new Map<string, Set<string>>();

  private handledNoticeIds(threadId: string, attemptId: string) {
    const identity = JSON.stringify([threadId, attemptId]);
    let noticeIds = this.handledNoticeIdsByAttempt.get(identity);
    if (!noticeIds) {
      noticeIds = new Set();
      this.handledNoticeIdsByAttempt.set(identity, noticeIds);
    }
    return noticeIds;
  }

  markHandled(threadId: string, notice: CodexCapacityRetryNotice) {
    this.handledNoticeIds(threadId, notice.runAttemptId).add(notice.id);
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

    const noticeIds = this.handledNoticeIds(input.threadId, input.attemptId);
    if (noticeIds.has(notice.id)) return;
    noticeIds.add(notice.id);
    // retryAt belongs to Codex's native backoff. Steer immediately instead.
    sendContinue();
  }
}
