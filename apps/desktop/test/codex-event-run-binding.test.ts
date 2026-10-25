import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { CodexEventAdapter } from "@eco/runtime";
import { bindCodexThreadRunEventAttempt } from "../src/main/codex-runtime-run";
import { normalizeCodexThreadRunEventForProjection } from "../src/main/codex-thread-run-event-normalizer";
import { ConversationV2RuntimeWriter } from "../src/main/conversation-v2-runtime-writer";
import { ConversationV2Store } from "../src/main/conversation-v2-store";
import type { ThreadRunEvent, ThreadRunEventInput } from "../src/shared/thread-run-events";

for (const status of ["failed", "completed"] as const) {
  test(`a background terminal ${status} event stays in its original run after the next run starts`, () => {
    const db = new DatabaseSync(":memory:");
    const store = new ConversationV2Store(db);
    store.initialize();
    store.ensureConversation("thread");
    const writer = new ConversationV2RuntimeWriter(db, store);
    let currentRun: string | undefined = "run-1";
    const recorded: ThreadRunEvent[] = [];
    const adapter = new CodexEventAdapter({
      resolveEcoThreadId: () => "thread",
      recordThreadRunEvent(event) {
        const normalized = normalizeCodexThreadRunEventForProjection(event as ThreadRunEventInput);
        recorded.push(
          writer.append(
            bindCodexThreadRunEventAttempt(normalized, currentRun, (threadId, requestId) =>
              store.resolveRuntimeRunAttemptId(threadId, requestId),
            ),
          ).event,
        );
      },
    });
    const command = {
      type: "commandExecution",
      id: "exec-background",
      processId: "73286",
      command: "bun run dev",
      status: "inProgress",
      commandActions: [],
    };
    const envelope = { threadId: "codex-thread", turnId: "turn-1" };
    const startRun = (runId: string) =>
      store.append({
        conversationId: "thread",
        eventId: `start-${runId}`,
        runId,
        turnId: runId,
        type: "run.started",
        occurredAt: "2026-10-25T00:00:00Z",
        payload: { status: "running" },
      });
    try {
      startRun("run-1");
      adapter.dispatch("item/started", { ...envelope, item: command });
      store.append({
        conversationId: "thread",
        eventId: "complete-run-1",
        runId: "run-1",
        type: "run.completed",
        occurredAt: "2026-10-25T00:00:01Z",
        payload: { status: "completed" },
      });
      startRun("run-2");
      currentRun = "run-2";
      // An unseen turn must still bind to the new active run.
      adapter.dispatch("item/started", {
        ...envelope,
        turnId: "turn-2",
        item: { ...command, id: "exec-current", processId: "current" },
      });
      adapter.dispatch("item/completed", {
        ...envelope,
        item: { ...command, status, exitCode: status === "failed" ? 143 : 0, aggregatedOutput: "exit" },
      });
      expect(recorded.at(-1)).toMatchObject({
        runAttemptId: "run-1",
        requestId: "turn-1",
        eventType: status === "failed" ? "tool.failed" : "tool.completed",
      });
      expect(store.findTool("thread", command.id)).toMatchObject({ runId: "run-1", status });
      expect(store.findTool("thread", "exec-current")).toMatchObject({
        runId: "run-2",
        status: "running",
      });
      expect(store.getRun("thread", "run-1")?.status).toBe("completed");
      expect(store.getRun("thread", "run-2")?.status).toBe("running");
      const terminal = recorded.at(-1);
      if (!terminal) throw new Error("Missing terminal event");
      const head = store.head("thread").lastSeq;
      expect(writer.append(terminal).duplicate).toBe(true);
      expect(store.head("thread").lastSeq).toBe(head);
      expect(() => writer.append({ ...terminal, id: "invalid-owner", runAttemptId: "run-2" })).toThrow(
        /belongs to another run/,
      );
      expect(store.head("thread").lastSeq).toBe(head);
      store.rebuildReadModels("thread");
      expect(store.findTool("thread", command.id)).toMatchObject({ runId: "run-1", status });
      // No active run is needed to recover an already recorded turn after completion/restart.
      currentRun = undefined;
      adapter.dispatch("item/completed", {
        ...envelope,
        turnId: "turn-2",
        item: { ...command, id: "exec-current", processId: "current", status: "completed", exitCode: 0 },
      });
      expect(store.findTool("thread", "exec-current")).toMatchObject({
        runId: "run-2",
        status: "completed",
      });
    } finally {
      db.close();
    }
  });
}

test("a late terminal event can resolve ownership from turn metadata without a request id", () => {
  const event: ThreadRunEventInput = {
    id: "late-terminal",
    threadId: "thread",
    eventType: "tool.failed",
    scope: "main",
    streamState: "finalized",
    message: "Bash",
    observedAt: "2026-10-25T00:00:00Z",
    metadata: { turnId: "original-turn" },
  };
  const bound = bindCodexThreadRunEventAttempt(event, "current-run", (threadId, requestId) => {
    expect(threadId).toBe("thread");
    expect(requestId).toBe("original-turn");
    return "original-run";
  });
  expect(bound.runAttemptId).toBe("original-run");
});

test("streaming events and agent lifecycles keep their existing binding without querying history", () => {
  for (const eventType of ["message.delta", "tool.writing", "tool.started", "agent.stopped"] as const) {
    const event: ThreadRunEventInput = {
      id: eventType,
      threadId: "thread",
      eventType,
      scope: "main",
      streamState: "streaming",
      message: "activity",
      observedAt: "2026-10-25T00:00:00Z",
      requestId: "turn-1",
    };
    const bound = bindCodexThreadRunEventAttempt(event, "current-run", () => {
      throw new Error("This event must not query history");
    });
    expect(bound.runAttemptId).toBe("current-run");
  }
});
