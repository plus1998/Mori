import type { ConversationBootstrap } from "@eco/shared";
import { IPC_CHANNELS, type ThreadPendingFollowUp, type ThreadSummary } from "../shared/ipc";
import type { ProjectTodo } from "../shared/project-todos";
import { DEMO_THREAD_ID, DEMO_WORKSPACE_PATH } from "./constants";
import { demoThreadRuntimeConfig } from "./fixtures";

/** Offline data for recording the actual desktop queue UI. No model or database writes. */
export function createQueueDemoScene() {
  const now = new Date().toISOString();
  const thread: ThreadSummary = {
    id: DEMO_THREAD_ID,
    title: "Mori 官网设计",
    prompt: "设计一个简约、文雅的 Mori 官网。",
    workspacePath: DEMO_WORKSPACE_PATH,
    status: "completed",
    message: "首页第一版已完成。",
    createdAt: now,
    updatedAt: now,
    coreKind: "codex",
    runtimeConfig: demoThreadRuntimeConfig,
  };
  const followUps: ThreadPendingFollowUp[] = [
    "把首页的留白再增加一些。",
    "补一版移动端布局，晚一点再做。",
  ].map((prompt, index) => ({
    id: `queue_demo_${index}`,
    threadId: thread.id,
    prompt,
    priority: "normal",
    status: "queued",
    deliveryMode: "queued",
    createdAt: now,
    updatedAt: now,
    queuePosition: index,
  }));
  const todos: ProjectTodo[] = [];
  const stream = { protocolVersion: 2 as const, storeEpoch: "queue-demo", conversationId: thread.id };
  const bootstrap: ConversationBootstrap = {
    ...stream,
    snapshotSeq: 2,
    historyRevision: 0,
    messages: [
      {
        messageId: "queue_intro",
        conversationId: thread.id,
        turnId: "queue_turn",
        role: "user",
        channel: "answer",
        createdSeq: 1,
        versionSeq: 1,
        contentVersion: 0,
        body: thread.prompt,
        status: "final",
        isDeleted: false,
      },
      {
        messageId: "queue_answer",
        conversationId: thread.id,
        turnId: "queue_turn",
        role: "assistant",
        channel: "answer",
        createdSeq: 2,
        versionSeq: 2,
        contentVersion: 0,
        body: "首页的第一版已经完成。\n\n留白、字体和配色已经统一，接下来可以继续打磨细节。",
        status: "final",
        isDeleted: false,
      },
    ],
    turns: [],
    runs: [],
    tools: [],
    hasOlder: false,
  };
  const handlers: Record<string, (payload?: unknown) => unknown> = {
    [IPC_CHANNELS.conversationCapabilities]: () => ({
      protocolVersion: 2,
      eventSchemaVersion: 1,
      effectVersion: 1,
      storeEpoch: stream.storeEpoch,
      maxEvents: 100,
      maxBytes: 1048576,
    }),
    [IPC_CHANNELS.conversationBootstrap]: () => bootstrap,
    [IPC_CHANNELS.conversationHead]: () => ({ ...stream, lastSeq: 2, historyRevision: 0 }),
    [IPC_CHANNELS.conversationProjection]: () => ({ requestSpans: [] }),
    [IPC_CHANNELS.threadFollowUpList]: () => ({ followUps }),
    [IPC_CHANNELS.threadFollowUpQueuePaused]: (payload) => {
      thread.followUpQueuePaused =
        typeof payload === "object" && payload !== null && "paused" in payload && payload.paused === true;
      return { paused: thread.followUpQueuePaused, thread };
    },
    [IPC_CHANNELS.threadFollowUpToTodo]: (payload) => {
      const followUpId =
        typeof payload === "object" && payload !== null && "followUpId" in payload
          ? payload.followUpId
          : undefined;
      const followUp = followUps.find((row) => row.id === followUpId && row.status === "queued");
      if (!followUp) throw new Error("Queued demo message not found.");
      followUp.status = "cancelled";
      const todo: ProjectTodo = {
        id: `todo_${followUp.id}`,
        revision: 1,
        projectPath: DEMO_WORKSPACE_PATH,
        text: followUp.prompt,
        images: [],
        completed: false,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      };
      todos.push(todo);
      return { followUp, followUps, todo };
    },
    [IPC_CHANNELS.projectTodoList]: () => todos,
    [IPC_CHANNELS.projectTodoQuery]: () => ({
      items: todos,
      nextCursor: null,
      counts: { pending: todos.length, completed: 0 },
      projectPaths: [DEMO_WORKSPACE_PATH],
    }),
    [IPC_CHANNELS.projectTodoGet]: (payload) =>
      todos.find(
        (todo) =>
          todo.id ===
          (typeof payload === "string"
            ? payload
            : typeof payload === "object" && payload !== null && "id" in payload
              ? payload.id
              : undefined),
      ),
  };
  return { thread, followUps, handlers };
}
