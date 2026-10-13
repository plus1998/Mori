import { beforeEach, expect, test } from "bun:test";
import {
  configureCodexAsyncQuestionBridge,
  deliverAsyncClarificationAnswers,
  handleCodexAsyncQuestions,
  isTrackedCodexAsyncQuestion,
  markCodexAsyncQuestionDismissed,
  releasePendingClarification,
  resetCodexAsyncQuestionBridge,
} from "../src/main/codex-async-question-bridge";
import type {
  ClarificationAnswers,
  ClarificationRequest,
  ThreadFollowUpEnqueueRequest,
  ThreadPendingFollowUp,
  ThreadStatus,
} from "../src/shared/ipc";
import { terminalAcceptedMessageDelivery } from "../src/shared/conversation-message-delivery";

interface HarnessInput {
  status?: ThreadStatus;
  followUpQueuePaused?: boolean;
  /** Status the enqueue call settles the row into. */
  enqueueStatus?: ThreadPendingFollowUp["status"];
  enqueueError?: string;
  enqueueThrows?: string;
  threadMissing?: boolean;
  sendThrows?: string;
  scheduleThrows?: string;
  messageFailedAfterScheduling?: boolean;
}

function harness(input: HarnessInput = {}) {
  const events: Array<{ type: string; message: string; role: string }> = [];
  const pending = new Map<string, ClarificationRequest>();
  const released: ClarificationAnswers[] = [];
  const enqueued: ThreadFollowUpEnqueueRequest[] = [];
  let threadMissing = Boolean(input.threadMissing);
  const sent: Array<{ clientCommandId: string; text: string }> = [];
  const scheduled: Array<{ conversationId: string; messageId: string; turnId: string; text: string }> = [];
  const resolvers = new Map<string, (answers: ClarificationAnswers) => void>();
  let messageCounter = 0;
  let scheduleAttempts = 0;
  let messageFailed = false;

  configureCodexAsyncQuestionBridge({
    getThread: (threadId) =>
      threadMissing
        ? undefined
        : ({
            id: threadId,
            status: input.status ?? "running",
            ...(input.followUpQueuePaused === undefined
              ? {}
              : { followUpQueuePaused: input.followUpQueuePaused }),
          } as never),
    emitEvent: (threadId, type, message, role) => {
      void threadId;
      events.push({ type, message, role });
    },
    registerPending: async (threadId, toolUseId, parsed) => {
      const request: ClarificationRequest = {
        toolUseId,
        threadId,
        questions: parsed.questions,
        delivery: "async",
      };
      pending.set(toolUseId, request);
      return new Promise<ClarificationAnswers>((resolve) => {
        resolvers.set(toolUseId, resolve);
      });
    },
    getPending: (toolUseId) => pending.get(toolUseId),
    submitPending: (toolUseId, answers) => {
      if (!pending.has(toolUseId)) {
        return false;
      }
      pending.delete(toolUseId);
      released.push(answers);
      resolvers.get(toolUseId)?.(answers);
      resolvers.delete(toolUseId);
      return true;
    },
    headHistoryRevision: () => 7,
    enqueueFollowUp: async (request) => {
      enqueued.push(request);
      if (input.enqueueThrows) {
        throw new Error(input.enqueueThrows);
      }
      const status = input.enqueueStatus ?? "queued";
      const followUp: ThreadPendingFollowUp = {
        id: `follow-up-${enqueued.length}`,
        threadId: request.threadId,
        prompt: request.prompt,
        status,
        createdAt: "2026-10-06T00:00:00.000Z",
        conversationMessageId: `message-${enqueued.length}`,
        ...(input.enqueueError ? { error: input.enqueueError } : {}),
      } as ThreadPendingFollowUp;
      return { followUps: [followUp], followUp } as never;
    },
    sendMessage: (message) => {
      if (input.sendThrows) {
        throw new Error(input.sendThrows);
      }
      sent.push({ clientCommandId: message.clientCommandId, text: message.text });
      messageCounter += 1;
      return { messageId: `message-${messageCounter}`, turnId: `turn-${messageCounter}` };
    },
    scheduleAcceptedMessage: async (message) => {
      const terminal = terminalAcceptedMessageDelivery({
        status: messageFailed ? "failed" : "queued",
        isDeleted: false,
      });
      if (terminal) return terminal;
      scheduleAttempts += 1;
      if (input.messageFailedAfterScheduling) {
        messageFailed = true;
        throw new Error("continuation startup failed");
      }
      if (input.scheduleThrows) {
        throw new Error(input.scheduleThrows);
      }
      scheduled.push(message);
      return { state: "delivered" as const };
    },
    errorMessage: (error) => (error instanceof Error ? error.message : String(error)),
  });

  return {
    events,
    pending,
    released,
    enqueued,
    sent,
    scheduled,
    scheduleAttempts: () => scheduleAttempts,
    setThreadMissing: (value: boolean) => {
      threadMissing = value;
    },
  };
}

beforeEach(() => {
  resetCodexAsyncQuestionBridge();
});

const ASYNC_INPUT = {
  ecoThreadId: "thread-1",
  codexThreadId: "codex-thread-1",
  turnId: "turn-1",
  itemId: "item-1",
  message: "要不要迁移？",
  questions: [{ title: "要不要迁移？", options: ["要", "不要"] }],
};

test("an async question message registers a non-blocking panel and emits one request", () => {
  const state = harness();
  handleCodexAsyncQuestions(ASYNC_INPUT);

  expect([...state.pending.keys()]).toEqual(["item-1"]);
  expect(state.pending.get("item-1")?.delivery).toBe("async");
  expect(state.events.map((event) => event.type)).toEqual(["clarification.requested"]);
  expect(state.events[0]?.role).toBe("planner");
  expect(state.events[0]?.message).toContain("本轮会继续执行");
});

test("the same question message only registers once across started and completed", () => {
  const state = harness();
  handleCodexAsyncQuestions(ASYNC_INPUT);
  handleCodexAsyncQuestions({ ...ASYNC_INPUT, message: "要不要迁移？(completed)" });
  // A resumed thread can replay the same item after a different turn id.
  handleCodexAsyncQuestions({ ...ASYNC_INPUT, turnId: "turn-2" });

  expect(state.events.filter((event) => event.type === "clarification.requested")).toHaveLength(1);
});

test("multiple questions in one session show in arrival order", () => {
  const state = harness();
  handleCodexAsyncQuestions({ ...ASYNC_INPUT, itemId: "item-a", questions: [{ title: "A", options: null }] });
  handleCodexAsyncQuestions({
    ...ASYNC_INPUT,
    itemId: "item-b",
    questions: [{ title: "B", options: ["x"] }],
  });

  expect([...state.pending.keys()]).toEqual(["item-a", "item-b"]);
  expect(state.events).toHaveLength(2);
});

test("a live turn delivers the answer as a mid-turn steer follow-up", async () => {
  const state = harness({ status: "running", enqueueStatus: "applied" });
  handleCodexAsyncQuestions(ASYNC_INPUT);

  const delivery = await deliverAsyncClarificationAnswers({
    threadId: "thread-1",
    toolUseId: "item-1",
    answers: { toolUseId: "item-1", selections: [["要"]] },
    commandIdempotencyKey: "command-1",
  });

  expect(delivery).toEqual({
    state: "delivered",
    followUpId: "follow-up-1",
    followUpMessageId: "message-1",
  });
  expect(state.enqueued).toHaveLength(1);
  expect(state.enqueued[0]?.followUpDeliveryMode).toBe("steer");
  expect(state.enqueued[0]?.clientCommandId).toBe("async-clarification:command-1");
  expect(state.enqueued[0]?.prompt).toBe(
    '<send_user_message_question_reply>[{"questionItemId":"[\\"request_user_input_async\\",\\"item-1\\",0]","question":"要不要迁移？","answer":"要"}]</send_user_message_question_reply>',
  );
  expect(state.sent).toEqual([]);
});

test("a finished turn delivers the answer as a plain continuation", async () => {
  const state = harness({ status: "idle" });
  handleCodexAsyncQuestions(ASYNC_INPUT);

  const delivery = await deliverAsyncClarificationAnswers({
    threadId: "thread-1",
    toolUseId: "item-1",
    answers: { toolUseId: "item-1", selections: [["要"]] },
    commandIdempotencyKey: "command-1",
  });

  expect(delivery).toEqual({ state: "delivered", followUpMessageId: "message-1" });
  expect(state.sent).toHaveLength(1);
  expect(state.scheduled).toEqual([
    { conversationId: "thread-1", messageId: "message-1", turnId: "turn-1", text: state.sent[0]?.text },
  ]);
  expect(state.enqueued).toEqual([]);
});

test("a paused ordinary queue does not change a live question answer's steer intent", async () => {
  const state = harness({ status: "running", followUpQueuePaused: true, enqueueStatus: "applied" });
  handleCodexAsyncQuestions(ASYNC_INPUT);
  const delivery = await deliverAsyncClarificationAnswers({
    threadId: "thread-1",
    toolUseId: "item-1",
    commandIdempotencyKey: "paused-answer",
    answers: { toolUseId: "item-1", selections: [["要"]] },
  });
  expect(delivery?.state).toBe("delivered");
  expect(state.enqueued[0]?.followUpDeliveryMode).toBe("steer");
  expect(state.enqueued[0]?.priority).toBeUndefined();
});

test("answering after the turn ends schedules the durable reply even while the ordinary queue is paused", async () => {
  const state = harness({ status: "completed", followUpQueuePaused: true });
  const acceptedMessage = {
    conversationId: "thread-1",
    messageId: "durable-answer",
    turnId: "answer-turn",
    text: "durable reply",
  };
  const delivery = await deliverAsyncClarificationAnswers({
    threadId: "thread-1",
    toolUseId: "item-1",
    commandIdempotencyKey: "paused-idle-answer",
    answers: { toolUseId: "item-1", selections: [["要"]] },
    acceptedMessage,
  });
  expect(delivery?.state).toBe("delivered");
  expect(state.scheduled).toEqual([acceptedMessage]);
  expect(state.enqueued).toEqual([]);
  expect(state.sent).toEqual([]);
});

test("a queued follow-up row is reported as queued, not delivered", async () => {
  const state = harness({ status: "running", enqueueStatus: "queued" });
  handleCodexAsyncQuestions(ASYNC_INPUT);

  const delivery = await deliverAsyncClarificationAnswers({
    threadId: "thread-1",
    toolUseId: "item-1",
    answers: { toolUseId: "item-1", selections: [["要"]] },
    commandIdempotencyKey: "command-1",
  });

  expect(delivery?.state).toBe("queued");
  expect(delivery?.followUpId).toBe("follow-up-1");
  expect(delivery?.message).toContain("排队");
});

test("an enqueue failure is reported as unknown and never as delivered", async () => {
  const state = harness({ status: "running", enqueueThrows: "thread is not accepting follow-ups" });
  handleCodexAsyncQuestions(ASYNC_INPUT);

  const delivery = await deliverAsyncClarificationAnswers({
    threadId: "thread-1",
    toolUseId: "item-1",
    answers: { toolUseId: "item-1", selections: [["要"]] },
    commandIdempotencyKey: "command-1",
  });

  expect(delivery).toEqual({ state: "unknown", message: "thread is not accepting follow-ups" });
  // Nothing may claim the run got the answer, so the question stays pending and releasable.
  expect(state.released).toEqual([]);
});

test("a continuation that never starts is unknown, and a resend is still possible", async () => {
  const state = harness({ status: "idle", scheduleThrows: "thread requires resume" });
  handleCodexAsyncQuestions(ASYNC_INPUT);

  const first = await deliverAsyncClarificationAnswers({
    threadId: "thread-1",
    toolUseId: "item-1",
    answers: { toolUseId: "item-1", selections: [["要"]] },
    commandIdempotencyKey: "command-1",
  });
  expect(first).toEqual({ state: "unknown", message: "thread requires resume" });

  // The same command id is replayed after the failure: an unknown outcome is never cached,
  // so the retry reaches the bridge again instead of returning the stale failure.
  const replay = await deliverAsyncClarificationAnswers({
    threadId: "thread-1",
    toolUseId: "item-1",
    answers: { toolUseId: "item-1", selections: [["要"]] },
    commandIdempotencyKey: "command-1",
  });
  expect(replay).toEqual(first);
  expect(state.sent).toHaveLength(2);
});

test("a replayed submit of a confirmed delivery does not send the answer twice", async () => {
  const state = harness({ status: "running", enqueueStatus: "applied" });
  handleCodexAsyncQuestions(ASYNC_INPUT);
  const input = {
    threadId: "thread-1",
    toolUseId: "item-1",
    answers: { toolUseId: "item-1", selections: [["要"]] },
    commandIdempotencyKey: "command-1",
  };

  const first = await deliverAsyncClarificationAnswers(input);
  const replay = await deliverAsyncClarificationAnswers(input);

  expect(replay).toEqual(first);
  expect(state.enqueued).toHaveLength(1);
});

test("retrying a failed continuation never reports delivery or starts it again", async () => {
  const state = harness({ status: "idle", messageFailedAfterScheduling: true });
  handleCodexAsyncQuestions(ASYNC_INPUT);
  const input = {
    threadId: "thread-1",
    toolUseId: "item-1",
    answers: { toolUseId: "item-1", selections: [["要"]] },
    commandIdempotencyKey: "command-1",
    acceptedMessage: {
      conversationId: "thread-1",
      messageId: "durable-message",
      turnId: "turn-1",
      text: "durable reply",
    },
  };
  expect((await deliverAsyncClarificationAnswers(input))?.state).toBe("unknown");
  const retry = await deliverAsyncClarificationAnswers(input);
  expect(retry?.state).toBe("unknown");
  expect(retry?.message).toContain("failed");
  expect(state.scheduleAttempts()).toBe(1);
  expect(state.sent).toHaveLength(0);
});

test("a durable accepted answer can be scheduled after async addressing was lost on restart", async () => {
  const state = harness({ status: "idle" });
  const delivery = await deliverAsyncClarificationAnswers({
    threadId: "thread-1",
    toolUseId: "old-question",
    answers: { toolUseId: "old-question", selections: [["要"]] },
    commandIdempotencyKey: "old-command",
    acceptedMessage: {
      conversationId: "thread-1",
      messageId: "durable-message",
      turnId: "turn-1",
      text: "durable reply",
    },
  });
  expect(delivery).toEqual({ state: "delivered", followUpMessageId: "durable-message" });
  expect(state.sent).toHaveLength(0);
  expect(state.scheduled).toHaveLength(1);
});

test("free-text and multi-question answers become one reply envelope", async () => {
  const state = harness({ status: "running", enqueueStatus: "applied" });
  handleCodexAsyncQuestions({
    ...ASYNC_INPUT,
    questions: [
      { title: "用哪个库？", options: null },
      { title: "什么时候上线？", options: ["今天", "下周"] },
    ],
  });

  await deliverAsyncClarificationAnswers({
    threadId: "thread-1",
    toolUseId: "item-1",
    answers: { toolUseId: "item-1", selections: [["用 bun"], ["下周"]] },
    commandIdempotencyKey: "command-1",
  });

  const prompt = state.enqueued[0]?.prompt ?? "";
  const replies = JSON.parse(
    prompt
      .replace("<send_user_message_question_reply>", "")
      .replace("</send_user_message_question_reply>", ""),
  ) as Array<{ questionItemId: string; question: string; answer: string }>;
  expect(replies).toEqual([
    {
      questionItemId: '["request_user_input_async","item-1",0]',
      question: "用哪个库？",
      answer: "用 bun",
    },
    {
      questionItemId: '["request_user_input_async","item-1",1]',
      question: "什么时候上线？",
      answer: "下周",
    },
  ]);
});

test("a thread that vanished before the answer reports unknown, not delivered", async () => {
  const state = harness();
  handleCodexAsyncQuestions(ASYNC_INPUT);
  state.setThreadMissing(true);

  const delivery = await deliverAsyncClarificationAnswers({
    threadId: "thread-1",
    toolUseId: "item-1",
    answers: { toolUseId: "item-1", selections: [["要"]] },
    commandIdempotencyKey: "command-1",
  });

  expect(delivery).toEqual({ state: "unknown", message: "对话不存在，回答未投递。" });
  expect(state.enqueued).toEqual([]);
  expect(state.sent).toEqual([]);
});

test("a question is not registered for a thread this process does not know", () => {
  const state = harness({ threadMissing: true });
  handleCodexAsyncQuestions(ASYNC_INPUT);
  expect(state.events).toEqual([]);
  expect([...state.pending.keys()]).toEqual([]);
});

test("delivery is skipped for toolUseIds that are not async questions", async () => {
  const state = harness();
  expect(
    await deliverAsyncClarificationAnswers({
      threadId: "thread-1",
      toolUseId: "sync-question",
      answers: { toolUseId: "sync-question", selections: [["x"]] },
      commandIdempotencyKey: "command-1",
    }),
  ).toBeUndefined();
  expect(state.enqueued).toEqual([]);
  expect(state.sent).toEqual([]);
});

test("answering closes the question; dismissing says so without claiming an answer", async () => {
  const state = harness();
  handleCodexAsyncQuestions({ ...ASYNC_INPUT, itemId: "item-answered" });
  handleCodexAsyncQuestions({ ...ASYNC_INPUT, itemId: "item-dismissed" });

  releasePendingClarification("item-answered", { toolUseId: "item-answered", selections: [["要"]] });
  markCodexAsyncQuestionDismissed("item-dismissed");
  expect(isTrackedCodexAsyncQuestion("item-dismissed")).toBe(true);
  releasePendingClarification("item-dismissed", { toolUseId: "item-dismissed", selections: [[]] });

  await Bun.sleep(0);
  const answered = state.events.filter((event) => event.type === "clarification.answered");
  const dismissed = state.events.filter((event) => event.type === "clarification.dismissed");
  expect(answered).toHaveLength(1);
  expect(answered[0]?.message).toContain("要不要迁移？ → 要");
  expect(dismissed).toHaveLength(1);
  expect(dismissed[0]?.message).toContain("不会收到回答");
  // A dismissed question cannot be answered later — its reply addressing is gone.
  expect(isTrackedCodexAsyncQuestion("item-dismissed")).toBe(false);
});
