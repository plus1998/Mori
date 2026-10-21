import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { encodeClaudeProjectDirName } from "../src/main/claude-session-paths";
import type { ConversationForkHistory } from "../src/main/conversation-fork-history";
import {
  cleanupNativeConversationFork,
  forkNativeConversation,
  type NativeConversationFork,
} from "../src/main/conversation-native-fork";

let root: string;
let cwd: string;
let config: string;
const previousConfig = process.env.CLAUDE_CONFIG_DIR;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "eco-native-fork-"));
  cwd = await fs.realpath(root);
  config = path.join(cwd, "claude");
  process.env.CLAUDE_CONFIG_DIR = config;
});
afterAll(async () => {
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousConfig;
  await fs.rm(root, { recursive: true, force: true });
});

function history(user1: string, user2: string): ConversationForkHistory {
  const target = {
    conversationId: "source",
    messageId: "u2",
    turnId: "turn2",
    createdSeq: 4,
    versionSeq: 4,
    contentVersion: 0,
    role: "user" as const,
    channel: "answer" as const,
    status: "final" as const,
    isDeleted: false,
    body: "U2",
    historyTarget: { activityLineId: "u2", userMessageId: user2 },
  };
  return {
    sourceThreadId: "source",
    sourceHeadSeq: 10,
    target,
    messages: [
      {
        ...target,
        messageId: "u1",
        body: "U1",
        historyTarget: { activityLineId: "u1", userMessageId: user1 },
      },
    ],
    runs: [],
    runPayloads: {},
    agents: [],
    tools: [],
    details: [],
    sources: [],
  };
}

async function claudeFixture() {
  const sessionId = randomUUID();
  const ids = Array.from({ length: 4 }, () => randomUUID());
  const dir = path.join(config, "projects", encodeClaudeProjectDirName(cwd));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const rows = ids.map((uuid, index) => ({
    uuid,
    parentUuid: ids[index - 1] ?? null,
    type: index % 2 ? "assistant" : "user",
    sessionId,
    cwd,
    isSidechain: false,
    timestamp: new Date().toISOString(),
    message: {
      role: index % 2 ? "assistant" : "user",
      content: index === 0 ? "U1" : index === 1 ? "A1" : index === 2 ? "U2" : "A2",
    },
  }));
  const bytes = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  await fs.writeFile(file, bytes);
  return { sessionId, ids, file, bytes };
}

test("real Claude SDK forks before a user node, remaps UUIDs and preserves the source file", async () => {
  const source = await claudeFixture();
  let created: NativeConversationFork | undefined;
  const result = await forkNativeConversation({
    history: history(source.ids[0]!, source.ids[2]!),
    childThreadId: "claude-child",
    coreKind: "claude",
    sessionId: source.sessionId,
    cwd,
    ecoDataDir: cwd,
    recoveryTitle: "real-fork-test",
    onCreated: (value) => {
      created = value;
    },
  });
  expect(created?.externalSessionId).toBe(result.externalSessionId);
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const messages = await sdk.getSessionMessages(result.externalSessionId, { dir: cwd });
  expect(messages.map((message) => (message.message as { content: string }).content)).toEqual(["U1", "A1"]);
  expect(result.userIds.u1).toBe(messages[0]?.uuid);
  expect(result.userIds.u1).not.toBe(source.ids[0]);
  expect(await fs.readFile(source.file, "utf8")).toBe(source.bytes);
  // Independent later input and second generation use the child's actual UUIDs.
  const childFile = result.metadata?.sessionFile as string;
  const childRows = (await fs.readFile(childFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const nextId = randomUUID();
  await fs.appendFile(
    childFile,
    `${JSON.stringify({ ...childRows[0], uuid: nextId, parentUuid: messages.at(-1)?.uuid, message: { role: "user", content: "child-only" } })}\n`,
  );
  const again = await forkNativeConversation({
    history: history(result.userIds.u1!, nextId),
    childThreadId: "claude-grandchild",
    coreKind: "claude",
    sessionId: result.externalSessionId,
    cwd,
    ecoDataDir: cwd,
    recoveryTitle: "second-generation",
    onCreated: () => {},
  });
  expect(
    (await sdk.getSessionMessages(again.externalSessionId, { dir: cwd })).map(
      (message) => (message.message as { content: string }).content,
    ),
  ).toEqual(["U1", "A1"]);
  expect(await fs.readFile(source.file, "utf8")).toBe(source.bytes);
  await cleanupNativeConversationFork(again);
  await cleanupNativeConversationFork(result);
});

test("first-node Claude fork allocates an explicit empty session instead of copying the full transcript", async () => {
  const source = await claudeFixture();
  const snapshot = history(source.ids[0]!, source.ids[0]!);
  snapshot.messages = [];
  const result = await forkNativeConversation({
    history: snapshot,
    childThreadId: "empty-claude",
    coreKind: "claude",
    sessionId: source.sessionId,
    cwd,
    ecoDataDir: cwd,
    recoveryTitle: "empty",
    onCreated: () => {},
  });
  expect(result.empty).toBe(true);
  expect(result.externalSessionId).not.toBe(source.sessionId);
  expect(result.userIds).toEqual({});
});

test("real Claude SDK rejects unknown anchors and mismatched local boundaries", async () => {
  const source = await claudeFixture();
  const input = {
    history: history(source.ids[0]!, randomUUID()),
    childThreadId: "invalid-claude",
    coreKind: "claude" as const,
    sessionId: source.sessionId,
    cwd,
    ecoDataDir: cwd,
    recoveryTitle: "invalid",
    onCreated: () => {
      throw new Error("must not create");
    },
  };
  await expect(forkNativeConversation(input)).rejects.toThrow("不存在");
  input.history = history(source.ids[0]!, source.ids[2]!);
  input.history.messages = [];
  await expect(forkNativeConversation(input)).rejects.toThrow("边界不一致");
  expect(await fs.readFile(source.file, "utf8")).toBe(source.bytes);
});

test("real Pi SDK creates a child-owned persisted file and retains exact entry IDs", async () => {
  const source = SessionManager.create(cwd, path.join(cwd, "pi-source"));
  const user1 = source.appendMessage({ role: "user", content: "U1", timestamp: Date.now() });
  source.appendLabelChange(user1, "label");
  const user2 = source.appendMessage({ role: "user", content: "U2", timestamp: Date.now() });
  const sourceFile = source.getSessionFile()!;
  const bytes = await fs.readFile(sourceFile, "utf8");
  const sourceId = source.getSessionId();
  const result = await forkNativeConversation({
    history: history(user1, user2),
    childThreadId: "pi-child",
    coreKind: "pi",
    sessionId: sourceId,
    sessionFile: sourceFile,
    cwd,
    ecoDataDir: cwd,
    recoveryTitle: "pi-fork",
    onCreated: () => {},
  });
  expect(result.externalSessionId).not.toBe(sourceId);
  expect(result.userIds.u1).toBe(user1);
  const file = result.metadata?.sessionFile as string;
  expect(file).toContain("pi-agent/pi-child/sessions");
  const child = SessionManager.open(file);
  expect(child.getEntries().filter((entry) => entry.type === "message")).toHaveLength(1);
  expect(await fs.readFile(sourceFile, "utf8")).toBe(bytes);
  expect(source.getSessionId()).toBe(sourceId);
  expect(source.getLeafId()).toBe(user2);
  await fs.unlink(sourceFile);
  const childUser = child.appendMessage({ role: "user", content: "child-only", timestamp: Date.now() });
  const grandchild = await forkNativeConversation({
    history: history(user1, childUser),
    childThreadId: "pi-grandchild",
    coreKind: "pi",
    sessionId: result.externalSessionId,
    sessionFile: file,
    cwd,
    ecoDataDir: cwd,
    recoveryTitle: "pi-again",
    onCreated: () => {},
  });
  expect(SessionManager.open(grandchild.metadata?.sessionFile as string).getEntry(user1)).toBeDefined();
  await cleanupNativeConversationFork(grandchild);
  await cleanupNativeConversationFork(result);
});

test("Pi first-node fork keeps an empty binding without a nonexistent resume path", async () => {
  const source = SessionManager.create(cwd, path.join(cwd, "pi-empty-source"));
  const user = source.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
  const snapshot = history(user, user);
  snapshot.messages = [];
  const result = await forkNativeConversation({
    history: snapshot,
    childThreadId: "pi-empty-child",
    coreKind: "pi",
    sessionId: source.getSessionId(),
    sessionFile: source.getSessionFile()!,
    cwd,
    ecoDataDir: cwd,
    recoveryTitle: "pi-empty",
    onCreated: () => {},
  });
  expect(result.empty).toBe(true);
  expect(result.metadata?.sessionFile).toBeUndefined();
});

test("real Pi child continuation sends retained history and excludes the source's later answer", async () => {
  const { runScriptedPiSession } = await import("../../../packages/runtime/test/pi-session-events-probe");
  const source = await runScriptedPiSession({
    workspace: cwd,
    agentDir: path.join(cwd, "pi-wire-source"),
    threadId: "pi-wire-source",
    promptActivityLineId: "u1",
    turns: [{ text: "pi-keep-answer" }, { text: "pi-future-answer" }],
  });
  let child: Awaited<ReturnType<typeof runScriptedPiSession>> | undefined;
  try {
    const secondEvents = await source.runAgain(undefined, "u2");
    const first = source.events.find((event) => event.type === "file.checkpoint")?.payload as {
      userMessageId: string;
    };
    const second = secondEvents.find((event) => event.type === "file.checkpoint")?.payload as {
      userMessageId: string;
    };
    const captured = source.events.find((event) => event.type === "session.captured")?.payload as {
      sessionId: string;
      sessionFile: string;
    };
    const bytes = await fs.readFile(captured.sessionFile, "utf8");
    const snapshot = history(first.userMessageId, second.userMessageId);
    snapshot.messages[0]!.body = "probe";
    snapshot.target.body = "probe";
    const fork = await forkNativeConversation({
      history: snapshot,
      childThreadId: "pi-wire-child",
      coreKind: "pi",
      sessionId: captured.sessionId,
      sessionFile: captured.sessionFile,
      cwd,
      ecoDataDir: cwd,
      recoveryTitle: "wire-child",
      onCreated: () => {},
    });
    child = await runScriptedPiSession({
      workspace: cwd,
      agentDir: path.join(cwd, "pi-agent", "pi-wire-child"),
      threadId: "pi-wire-child",
      sessionFile: fork.metadata?.sessionFile as string,
      promptActivityLineId: "child-user",
      turns: [{ text: "pi-child-answer" }],
    });
    const modelInput = JSON.stringify(child.requests);
    expect(modelInput).toContain("pi-keep-answer");
    expect(modelInput).not.toContain("pi-future-answer");
    expect(child.events.find((event) => event.type === "session.captured")?.payload).toMatchObject({
      sessionId: fork.externalSessionId,
    });
    expect(await fs.readFile(captured.sessionFile, "utf8")).toBe(bytes);
  } finally {
    await child?.dispose();
    await source.dispose();
  }
}, 30_000);

test("production Claude fork preserves compacted context and verifies the remapped user identities", async () => {
  const source = await claudeFixture();
  const [user1, assistant1, user2, assistant2] = source.ids;
  if (!user1 || !assistant1 || !user2 || !assistant2) throw new Error("fixture missing identity");
  const row = (uuid: string, parentUuid: string | null, type: string, content: string) => ({
    uuid,
    parentUuid,
    type,
    sessionId: source.sessionId,
    cwd,
    isSidechain: false,
    timestamp: new Date().toISOString(),
    message: { role: type, content },
  });
  const retained = randomUUID(),
    boundary = randomUUID(),
    summary = randomUUID();
  const rows = [
    row(user1, null, "user", "U1"),
    row(assistant1, user1, "assistant", "A1"),
    row(retained, assistant1, "assistant", "retained output"),
    {
      uuid: boundary,
      parentUuid: null,
      type: "system",
      subtype: "compact_boundary",
      sessionId: source.sessionId,
      timestamp: new Date().toISOString(),
      compactMetadata: {
        trigger: "manual",
        preTokens: 8000,
        postTokens: 1000,
        preservedSegment: { headUuid: retained, tailUuid: retained, anchorUuid: summary },
        preservedMessages: { anchorUuid: summary, uuids: [retained], allUuids: [retained] },
      },
    },
    { ...row(summary, boundary, "user", "summary of earlier context"), isCompactSummary: true },
    row(user2, retained, "user", "U2"),
    row(assistant2, user2, "assistant", "A2"),
  ];
  const bytes = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  await fs.writeFile(source.file, bytes);
  const fork = await forkNativeConversation({
    history: history(user1, user2),
    childThreadId: "claude-compact-child",
    coreKind: "claude",
    sessionId: source.sessionId,
    cwd,
    ecoDataDir: cwd,
    recoveryTitle: "compact-fork",
    onCreated: () => {},
  });
  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const messages = await sdk.getSessionMessages(fork.externalSessionId, { dir: cwd });
    const contents = messages.map((message) => (message.message as { content: string }).content);
    expect(contents).toContain("summary of earlier context");
    expect(contents).toContain("retained output");
    expect(contents).not.toContain("U2");
    expect(contents).not.toContain("A2");
    expect(fork.userIds.u1).not.toBe(user1);
    expect(await fs.readFile(source.file, "utf8")).toBe(bytes);
  } finally {
    await cleanupNativeConversationFork(fork);
  }
});

test("real Claude SDK forks inclusively after the selected assistant turn and remaps the retained user", async () => {
  const source = await claudeFixture();
  const snapshot = history(source.ids[0]!, source.ids[2]!);
  const user = snapshot.messages[0]!;
  snapshot.boundaryUser = user;
  snapshot.target = {
    conversationId: "source",
    messageId: "a1",
    turnId: "turn1",
    runId: "run1",
    createdSeq: 2,
    versionSeq: 2,
    contentVersion: 0,
    role: "assistant",
    channel: "answer",
    body: "A1",
    status: "final",
    isDeleted: false,
  };
  snapshot.messages.push(snapshot.target);
  const result = await forkNativeConversation({
    history: snapshot,
    childThreadId: "claude-after-answer",
    coreKind: "claude",
    sessionId: source.sessionId,
    cwd,
    ecoDataDir: cwd,
    recoveryTitle: "after-reply",
    onCreated: () => {},
  });
  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const rows = await sdk.getSessionMessages(result.externalSessionId, { dir: cwd });
    expect(rows.map((row) => (row.message as { content: string }).content)).toEqual(["U1", "A1"]);
    expect(result.userIds.u1).toBe(rows[0]?.uuid);
    expect(result.userIds.u1).not.toBe(source.ids[0]);
    expect(await fs.readFile(source.file, "utf8")).toBe(source.bytes);
  } finally {
    await cleanupNativeConversationFork(result);
  }
  snapshot.target.body = "wrong selected answer";
  await expect(
    forkNativeConversation({
      history: snapshot,
      childThreadId: "claude-wrong-answer",
      coreKind: "claude",
      sessionId: source.sessionId,
      cwd,
      ecoDataDir: cwd,
      recoveryTitle: "invalid-reply",
      onCreated: () => {
        throw new Error("must not create");
      },
    }),
  ).rejects.toThrow("最后一条回答");
});

test("real Pi assistant fork continues with that answer and excludes later turns", async () => {
  const { runScriptedPiSession } = await import("../../../packages/runtime/test/pi-session-events-probe");
  const source = await runScriptedPiSession({
    workspace: cwd,
    agentDir: path.join(cwd, "pi-after-source"),
    threadId: "pi-after-source",
    promptActivityLineId: "u1",
    turns: [{ text: "keep-selected-reply" }, { text: "exclude-later-reply" }],
  });
  let child: Awaited<ReturnType<typeof runScriptedPiSession>> | undefined;
  try {
    const secondEvents = await source.runAgain(undefined, "u2");
    const one = source.events.find((event) => event.type === "file.checkpoint")?.payload as {
      userMessageId: string;
    };
    const two = secondEvents.find((event) => event.type === "file.checkpoint")?.payload as {
      userMessageId: string;
    };
    const binding = source.events.find((event) => event.type === "session.captured")?.payload as {
      sessionId: string;
      sessionFile: string;
    };
    const before = await fs.readFile(binding.sessionFile, "utf8");
    const snapshot = history(one.userMessageId, two.userMessageId);
    snapshot.boundaryUser = snapshot.messages[0];
    snapshot.target = {
      conversationId: "source",
      messageId: "a1",
      turnId: "turn1",
      runId: "run1",
      createdSeq: 2,
      versionSeq: 2,
      contentVersion: 0,
      role: "assistant",
      channel: "answer",
      body: "keep-selected-reply",
      status: "final",
      isDeleted: false,
    };
    snapshot.messages.push(snapshot.target);
    const result = await forkNativeConversation({
      history: snapshot,
      childThreadId: "pi-after-child",
      coreKind: "pi",
      sessionId: binding.sessionId,
      sessionFile: binding.sessionFile,
      cwd,
      ecoDataDir: cwd,
      recoveryTitle: "pi-after",
      onCreated: () => {},
    });
    child = await runScriptedPiSession({
      workspace: cwd,
      agentDir: path.join(cwd, "pi-agent", "pi-after-child"),
      threadId: "pi-after-child",
      sessionFile: result.metadata?.sessionFile as string,
      promptActivityLineId: "child-user",
      turns: [{ text: "child-answer" }],
    });
    const modelInput = JSON.stringify(child.requests);
    expect(modelInput).toContain("keep-selected-reply");
    expect(modelInput).not.toContain("exclude-later-reply");
    expect(await fs.readFile(binding.sessionFile, "utf8")).toBe(before);
    snapshot.target.body = "unknown reply";
    await expect(
      forkNativeConversation({
        history: snapshot,
        childThreadId: "pi-wrong-answer",
        coreKind: "pi",
        sessionId: binding.sessionId,
        sessionFile: binding.sessionFile,
        cwd,
        ecoDataDir: cwd,
        recoveryTitle: "invalid-reply",
        onCreated: () => {
          throw new Error("must not create");
        },
      }),
    ).rejects.toThrow("最后一条回答");
  } finally {
    await child?.dispose();
    await source.dispose();
  }
}, 30_000);
