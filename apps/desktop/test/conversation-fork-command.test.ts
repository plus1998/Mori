import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type ConversationForkCommandDeps,
  ConversationForkCommands,
} from "../src/main/conversation-fork-command";
import { buildForkHistoryEvents, forkHistoryId } from "../src/main/conversation-fork-history";
import type { NativeConversationFork } from "../src/main/conversation-native-fork";
import { ConversationStore } from "../src/main/conversation-store";
import type { ThreadForkFromMessageRequest, ThreadSummary } from "../src/shared/ipc";

const databases: DatabaseSync[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(coreKind: "claude" | "codex" | "pi" = "claude", filename = ":memory:") {
  const db = new DatabaseSync(filename);
  databases.push(db);
  const store = new ConversationStore(db, { freshStorageMode: "v2_only" });
  store.initialize();
  const source: ThreadSummary = {
    id: "source",
    coreKind,
    title: "Source",
    prompt: "U1",
    workspacePath: "/tmp",
    status: "completed",
    message: "",
    createdAt: "2026-10-15T00:00:00Z",
    updatedAt: "2026-10-15T00:00:00Z",
  };
  store.saveThread(source);
  store.saveThreadCoreSession({
    threadId: source.id,
    coreKind,
    externalSessionId: "native-source",
    cwd: "/tmp",
  });
  const v2 = store.conversationV2();
  function user(threadId: string, n: number, nativeId = `native-${n}`) {
    const id = `${threadId}-u${n}`;
    v2.appendRuntime({
      conversationId: threadId,
      eventId: `user-create-${id}`,
      type: "message.created",
      occurredAt: `2026-10-15T00:0${n}:00Z`,
      messageId: id,
      turnId: `user-turn-${id}`,
      payload: {
        role: "user",
        body: `U${n}`,
        status: "final",
        historyTarget: { activityLineId: id, userMessageId: nativeId },
      },
    });
    store.appendConversationRuntimeEvent({
      threadId,
      id: `input-${id}`,
      role: "user",
      scope: "main",
      eventType: "thread.status",
      streamState: "final",
      message: `U${n}`,
      observedAt: `2026-10-15T00:0${n}:00Z`,
      metadata: {
        liveType: "thread.user_prompt",
        conversationV2MessageId: id,
        rewindTarget: { activityLineId: id, userMessageId: nativeId },
      },
    });
    return id;
  }
  function answer(threadId: string, n: number) {
    const runId = `${threadId}-r${n}`;
    store.upsertRunAttempt({
      threadId,
      attemptId: runId,
      phase: "execution",
      retryIndex: 0,
      status: "running",
      startedAt: `2026-10-15T00:0${n}:01Z`,
    });
    store.appendConversationRuntimeEvent({
      threadId,
      id: `${threadId}-a${n}`,
      runAttemptId: runId,
      role: "main",
      scope: "main",
      eventType: "message.final",
      streamState: "final",
      streamKey: `answer-${threadId}-${n}`,
      message: `A${n}`,
      observedAt: `2026-10-15T00:0${n}:02Z`,
    });
    store.upsertRunAttempt({
      threadId,
      attemptId: runId,
      phase: "execution",
      retryIndex: 0,
      status: "completed",
      startedAt: `2026-10-15T00:0${n}:01Z`,
      endedAt: `2026-10-15T00:0${n}:03Z`,
    });
  }
  user(source.id, 1);
  answer(source.id, 1);
  user(source.id, 2);
  answer(source.id, 2);
  user(source.id, 3);
  answer(source.id, 3);
  let forks = 0;
  const cleaned: NativeConversationFork[] = [];
  const deps: ConversationForkCommandDeps = {
    store,
    ensureThreadRuntimeConfig: (thread) => thread,
    forkNative: async (thread, history, childId, onCreated) => {
      forks++;
      const native: NativeConversationFork = {
        coreKind: thread.coreKind as "claude",
        externalSessionId: `native-${childId}`,
        cwd: "/tmp",
        userIds: Object.fromEntries(
          history.messages
            .filter((message) => message.role === "user")
            .map((message) => [message.messageId, `new-${message.messageId}`]),
        ),
      };
      onCreated(native);
      return native;
    },
    cleanupNative: async (native) => {
      cleaned.push(native);
    },
  };
  const commands = new ConversationForkCommands(deps);
  const request: ThreadForkFromMessageRequest = {
    principalId: "desktop-local",
    threadId: source.id,
    clientCommandId: "fork-u2",
    activityLineId: "source-u2",
    expectedHistoryRevision: 0,
  };
  return { db, store, v2, source, deps, commands, request, user, answer, cleaned, forks: () => forks };
}

async function stageCrash(h: ReturnType<typeof harness>, verified: boolean) {
  h.v2.acceptCommand({
    principalId: "desktop-local",
    conversationId: "source",
    clientCommandId: "fork-u2",
    commandType: "history.branch",
    expectedHistoryRevision: 0,
    request: { activityLineId: "source-u2" },
  });
  h.v2.beginCommandExecution("desktop-local", "source", "fork-u2");
  const history = h.v2.snapshotForkHistory(
    "source",
    "source-u2",
    h.store.listConversationRuntimeSources("source", { historyOrder: true }),
  );
  const childThreadId = "crash-child";
  h.v2.recordCommandCheckpoint("desktop-local", "source", "fork-u2", "fork.prepared", {
    history,
    thread: h.source,
    childThreadId,
  });
  h.v2.recordCommandCheckpoint("desktop-local", "source", "fork-u2", "fork.requested", { childThreadId });
  const native = await h.deps.forkNative(h.source, history, childThreadId, (native) =>
    h.v2.recordCommandCheckpoint("desktop-local", "source", "fork-u2", "fork.created", { native }),
  );
  if (verified)
    h.v2.appendRuntime({
      conversationId: "source",
      eventId: "verified-crash-child",
      sourceEventKey: `fork:verified:${childThreadId}`,
      type: "noop",
      occurredAt: "2026-10-15T00:10:00Z",
      payload: { reason: "history.fork_verified", native, childThreadId },
    });
}

describe("independent conversation fork", () => {
  for (const core of ["claude", "codex", "pi"] as const)
    test(`${core}: copies only history before the selected node and leaves the parent unchanged`, async () => {
      const h = harness(core);
      const before = h.v2.bootstrap("source");
      const result = await h.commands.execute(h.request);
      const child = h.v2.bootstrap(result.thread.id);
      expect(child.messages.map((message) => message.body)).toEqual(["U1", "A1"]);
      expect(result.draft.prompt).toBe("U2");
      expect(result.thread.status).toBe("idle");
      expect(h.v2.bootstrap("source").messages).toEqual(before.messages);
      expect(h.store.getThreadCoreSession("source")?.externalSessionId).toBe("native-source");
      expect(h.store.getThreadCoreSession(result.thread.id)?.externalSessionId).toBe(
        `native-${result.thread.id}`,
      );
      expect(h.store.getComposerDraft(`thread:${result.thread.id}`)?.prompt).toBe("U2");
      expect(child.messages[0]?.historyTarget?.userMessageId).toBe("new-source-u1");
      expect(h.store.listRunAttempts(result.thread.id)).toHaveLength(1);
      expect(h.v2.validateIntegrity(result.thread.id).eventCount).toBeGreaterThan(0);
      h.v2.rebuildReadModels(result.thread.id);
      expect(h.v2.bootstrap(result.thread.id).messages.map((message) => message.body)).toEqual(["U1", "A1"]);
      h.user("source", 4);
      h.answer("source", 4);
      h.user(result.thread.id, 2);
      h.answer(result.thread.id, 2);
      expect(h.v2.bootstrap(result.thread.id).messages.map((message) => message.body)).toEqual([
        "U1",
        "A1",
        "U2",
        "A2",
      ]);
      expect(h.v2.bootstrap("source").messages.map((message) => message.body)).toEqual([
        "U1",
        "A1",
        "U2",
        "A2",
        "U3",
        "A3",
        "U4",
        "A4",
      ]);
    });

  test("concurrent duplicate and lost-response retry create exactly one child", async () => {
    const h = harness();
    const [first, duplicate] = await Promise.all([
      h.commands.execute(h.request),
      h.commands.execute(h.request),
    ]);
    expect(duplicate).toEqual(first);
    expect(h.forks()).toBe(1);
    expect(await new ConversationForkCommands(h.deps).execute(h.request)).toEqual(first);
    expect(h.forks()).toBe(1);
    await expect(h.commands.execute({ ...h.request, activityLineId: "source-u3" })).rejects.toThrow();
  });

  test("the first user message creates an empty child and the selected text stays in the draft", async () => {
    const h = harness();
    const result = await h.commands.execute({ ...h.request, activityLineId: "source-u1" });
    expect(h.v2.bootstrap(result.thread.id).messages).toEqual([]);
    expect(result.draft.prompt).toBe("U1");
  });

  test("second-generation fork uses the child's persisted identities", async () => {
    const h = harness();
    const first = await h.commands.execute(h.request);
    h.user(first.thread.id, 2);
    h.answer(first.thread.id, 2);
    const second = await h.commands.execute({
      ...h.request,
      threadId: first.thread.id,
      clientCommandId: "fork-again",
      activityLineId: `${first.thread.id}-u2`,
    });
    expect(h.v2.bootstrap(second.thread.id).messages.map((message) => message.body)).toEqual(["U1", "A1"]);
    expect(h.v2.bootstrap(second.thread.id).messages[0]?.messageId).toBe(
      forkHistoryId(second.thread.id, forkHistoryId(first.thread.id, "source-u1")),
    );
  });

  test("native failure produces no local child and does not erase the parent", async () => {
    const h = harness();
    h.deps.forkNative = async () => {
      throw new Error("native refused");
    };
    await expect(h.commands.execute(h.request)).rejects.toThrow("native refused");
    expect(h.store.listThreads()).toHaveLength(1);
    expect(h.v2.bootstrap("source").messages).toHaveLength(6);
    expect(h.v2.getCommandJob("desktop-local", "source", "fork-u2")?.status).toBe("failed");
  });

  test("history changes during the native call abort commit and clean the new identity", async () => {
    const h = harness();
    const original = h.deps.forkNative;
    h.deps.forkNative = async (...args) => {
      const native = await original(...args);
      h.user("source", 4);
      return native;
    };
    await expect(h.commands.execute(h.request)).rejects.toThrow("源会话在分叉期间已变化");
    expect(h.store.listThreads()).toHaveLength(1);
    expect(h.cleaned).toHaveLength(1);
  });

  test("busy, missing and stale nodes fail before native fork", async () => {
    const h = harness();
    h.store.updateThread("source", { status: "running", message: "" });
    await expect(h.commands.execute(h.request)).rejects.toThrow("执行结束");
    expect(h.forks()).toBe(0);
    h.store.updateThread("source", { status: "completed", message: "" });
    await expect(
      h.commands.execute({ ...h.request, clientCommandId: "missing", activityLineId: "absent" }),
    ).rejects.toThrow("已被移除");
    await expect(
      h.commands.execute({ ...h.request, clientCommandId: "stale", expectedHistoryRevision: 1 }),
    ).rejects.toThrow();
    expect(h.forks()).toBe(0);
  });

  test("recovering a crash after validated native creation commits the same child without another SDK call", async () => {
    const h = harness();
    await stageCrash(h, true);
    new ConversationForkCommands(h.deps).recover();
    const job = h.v2.getCommandJob("desktop-local", "source", "fork-u2");
    expect(job?.status).toBe("completed");
    expect(h.forks()).toBe(1);
    expect(h.store.listThreads()).toHaveLength(2);
  });

  test("legacy continuation carrying the prior run id still forks at a completed boundary", async () => {
    const h = harness();
    const source = h.store
      .listConversationRuntimeSources("source")
      .find((source) => source.metadata?.conversationV2MessageId === "source-u2")!;
    h.store.appendConversationRuntimeEvent({ ...source, runAttemptId: "source-r1" });
    const child = await h.commands.execute(h.request);
    expect(h.v2.bootstrap(child.thread.id).messages.map((message) => message.body)).toEqual(["U1", "A1"]);
  });

  test("actual provider work spanning a selected node is rejected before creating a native branch", async () => {
    const h = harness();
    h.store.appendConversationRuntimeEvent({
      threadId: "source",
      id: "late-r1",
      runAttemptId: "source-r1",
      role: "main",
      scope: "main",
      eventType: "message.final",
      streamState: "final",
      message: "late work",
      observedAt: "2026-10-15T00:04:00Z",
    });
    await expect(h.commands.execute(h.request)).rejects.toThrow("同一执行轮");
    expect(h.forks()).toBe(0);
  });

  test("unverified native outcomes fail on restart instead of creating another branch", async () => {
    const h = harness();
    await stageCrash(h, false);
    new ConversationForkCommands(h.deps).recover();
    expect(h.v2.getCommandJob("desktop-local", "source", "fork-u2")?.error).toMatchObject({
      code: "fork_recovery_failed",
      message: expect.stringContaining("无法确认"),
    });
    expect(h.store.listThreads()).toHaveLength(1);
    expect(h.forks()).toBe(1);
    await expect(h.commands.execute(h.request)).rejects.toThrow("无法确认");
    expect(h.forks()).toBe(1);
  });

  test("recovery refuses a verified identity whose native history file was removed", async () => {
    const h = harness();
    await stageCrash(h, true);
    h.deps.validateRecoveredNative = () => {
      throw new Error("原生历史文件缺失");
    };
    new ConversationForkCommands(h.deps).recover();
    expect(h.v2.getCommandJob("desktop-local", "source", "fork-u2")?.error).toMatchObject({
      message: "原生历史文件缺失",
    });
    expect(h.store.listThreads()).toHaveLength(1);
    expect(h.forks()).toBe(1);
  });

  test("native cleanup failures remain visible in the durable error receipt", async () => {
    const h = harness();
    const original = h.deps.forkNative;
    h.deps.forkNative = async (...args) => {
      const native = await original(...args);
      h.user("source", 4);
      return native;
    };
    h.deps.cleanupNative = async () => {
      throw new Error("cleanup refused");
    };
    await expect(h.commands.execute(h.request)).rejects.toThrow("原生分支清理失败：cleanup refused");
    expect(h.v2.getCommandJob("desktop-local", "source", "fork-u2")?.error).toMatchObject({
      cleanupError: "cleanup refused",
      orphan: { coreKind: "claude" },
    });
    expect(h.store.listThreads()).toHaveLength(1);
  });

  test("first-node draft images keep a child-owned content reference after deleting the parent", async () => {
    const h = harness();
    const attachment = { mediaType: "image/png", contentRef: `sha256:${"a".repeat(64)}`, byteLength: 1 };
    h.v2.appendRuntime({
      conversationId: "source",
      eventId: "attach-first",
      type: "message.finalized",
      messageId: "source-u1",
      occurredAt: "2026-10-15T00:05:00Z",
      payload: {
        authority: "maintenance",
        baseContentVersion: 0,
        nextContentVersion: 1,
        body: "U1",
        attachments: [attachment],
      },
    });
    const result = await h.commands.execute({ ...h.request, activityLineId: "source-u1" });
    expect(result.draft.attachments).toEqual([attachment]);
    expect(h.store.hasForkImageDependents("source")).toBe(true);
    expect(h.v2.hasPromptImageContentRef(result.thread.id, attachment.contentRef)).toBe(true);
    h.store.deleteThread("source");
    expect(h.v2.hasPromptImageContentRef(result.thread.id, attachment.contentRef)).toBe(true);
    expect((await h.v2.collectReferencedPromptImageContentRefs()).has(attachment.contentRef)).toBe(true);
  });

  test("tombstoned messages are never resurrected in the child's canonical history", async () => {
    const h = harness();
    const assistant = h.v2.bootstrap("source").messages.find((message) => message.body === "A1")!;
    h.v2.appendRuntime({
      conversationId: "source",
      eventId: "delete-a1",
      type: "message.tombstoned",
      messageId: assistant.messageId,
      occurredAt: "2026-10-15T00:05:00Z",
      payload: {},
    });
    const result = await h.commands.execute(h.request);
    expect(h.v2.bootstrap(result.thread.id).messages.map((message) => message.body)).toEqual(["U1"]);
    h.v2.rebuildReadModels(result.thread.id);
    expect(h.v2.bootstrap(result.thread.id).messages.map((message) => message.body)).toEqual(["U1"]);
  });

  test("reopening SQLite recovers a validated branch and duplicate receipt without another native call", async () => {
    const directory = mkdtempSync(join(tmpdir(), "eco-fork-recovery-"));
    directories.push(directory);
    const filename = join(directory, "state.sqlite");
    const h = harness("claude", filename);
    await stageCrash(h, true);
    databases.splice(databases.indexOf(h.db), 1);
    h.db.close();
    const db = new DatabaseSync(filename);
    databases.push(db);
    const store = new ConversationStore(db, { freshStorageMode: "v2_only" });
    store.initialize();
    const restarted = new ConversationForkCommands({ ...h.deps, store });
    restarted.recover();
    const result = await restarted.execute(h.request);
    expect(result.thread.id).toBe("crash-child");
    expect(
      store
        .conversationV2()
        .bootstrap(result.thread.id)
        .messages.map((message) => message.body),
    ).toEqual(["U1", "A1"]);
    expect(h.forks()).toBe(1);
    expect(store.getThreadCoreSession("source")?.externalSessionId).toBe("native-source");
  });
  test("cloned tools, failed agents and structured details use child identities and survive projection rebuild", () => {
    const h = harness();
    const history = h.v2.snapshotForkHistory(
      "source",
      "source-u2",
      h.store.listConversationRuntimeSources("source", { historyOrder: true }),
    );
    history.tools.push({
      conversationId: "source",
      toolCallId: "tool-parent",
      runId: "source-r1",
      agentId: "agent-child",
      agentInstanceId: "agent-child",
      name: "Bash",
      status: "completed",
      createdSeq: 1,
      versionSeq: 1,
      input: { command: "printf retained" },
      output: "retained",
    });
    history.agents.push({
      conversationId: "source",
      agentId: "agent-child",
      role: "coder",
      kind: "subagent",
      status: "failed",
      runId: "source-r1",
      parentToolCallId: "tool-parent",
      todoId: "source-only-todo",
      versionSeq: 1,
      mission: "historical mission",
    });
    history.details.push({
      conversationId: "source",
      itemId: "detail-retained",
      runId: "source-r1",
      toolCallId: "tool-parent",
      agentInstanceId: "agent-child",
      type: "tool.detail",
      content: JSON.stringify({
        toolCallId: "tool-parent",
        agentInstanceId: "agent-child",
        threadId: "source",
        text: "source-r1",
      }),
      createdSeq: 1,
      versionSeq: 1,
    });
    history.details.push({ ...history.details[0]!, itemId: "approval-source", type: "approval.requested" });
    const childId = "rich-child";
    h.store.saveThread({ ...h.source, id: childId });
    const events = buildForkHistoryEvents(history, childId, { "source-u1": "new-user" });
    for (const event of events) h.v2.appendRuntime(event);
    const toolId = forkHistoryId(childId, "tool-parent");
    expect(h.v2.getTool(childId, toolId)).toMatchObject({
      conversationId: childId,
      runId: forkHistoryId(childId, "source-r1"),
      agentInstanceId: forkHistoryId(childId, "agent-child"),
      output: "retained",
    });
    expect(h.v2.bootstrap(childId).agents?.[0]).toMatchObject({ status: "failed", parentToolCallId: toolId });
    expect(h.v2.bootstrap(childId).agents?.[0]?.todoId).toBeUndefined();
    const detail = events.find((event) => event.type === "detail.upserted");
    expect(JSON.parse(detail?.payload.content as string)).toEqual({
      toolCallId: toolId,
      agentInstanceId: forkHistoryId(childId, "agent-child"),
      threadId: childId,
      text: "source-r1",
    });
    expect(events.filter((event) => event.type === "detail.upserted")).toHaveLength(1);
    h.v2.rebuildReadModels(childId);
    expect(h.v2.getTool(childId, toolId).output).toBe("retained");
    expect(h.v2.validateIntegrity(childId).eventCount).toBeGreaterThan(0);
    expect(h.v2.bootstrap("source").messages).toHaveLength(6);
  });
  for (const coreKind of ["claude", "codex", "pi"] as const)
    test(`${coreKind}: agent reply fork retains that reply and starts with an empty draft`, async () => {
      const h = harness(coreKind);
      const before = h.v2.bootstrap("source");
      const answer = before.messages.find((message) => message.body === "A2");
      if (!answer) throw new Error("missing reply");
      const result = await h.commands.execute({ ...h.request, activityLineId: answer.messageId });
      expect(result.draft).toEqual({ prompt: "", attachments: [] });
      expect(h.v2.bootstrap(result.thread.id).messages.map((message) => message.body)).toEqual([
        "U1",
        "A1",
        "U2",
        "A2",
      ]);
      expect(h.v2.bootstrap("source").messages).toEqual(before.messages);
      expect(h.store.listRunAttempts(result.thread.id)).toHaveLength(2);
      h.v2.rebuildReadModels(result.thread.id);
      expect(h.v2.bootstrap(result.thread.id).messages.at(-1)?.body).toBe("A2");
    });

  test("an intermediate agent answer is rejected when the same run has a later answer", async () => {
    const h = harness();
    const first = h.v2.bootstrap("source").messages.find((message) => message.body === "A1");
    if (!first) throw new Error("missing reply");
    h.store.appendConversationRuntimeEvent({
      threadId: "source",
      id: "later-answer",
      runAttemptId: "source-r1",
      role: "main",
      scope: "main",
      eventType: "message.final",
      streamState: "final",
      message: "later final answer",
      observedAt: "2026-10-15T00:01:04Z",
    });
    await expect(h.commands.execute({ ...h.request, activityLineId: first.messageId })).rejects.toThrow(
      "最后一条 Agent 回复",
    );
    expect(h.forks()).toBe(0);
  });
});
