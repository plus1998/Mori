// Real SDK/CLI and production fork adapter, with a loopback-only scripted model.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ConversationForkHistory } from "../../apps/desktop/src/main/conversation-fork-history";
import { forkNativeConversation } from "../../apps/desktop/src/main/conversation-native-fork";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "eco-claude-fork-model-"));
const cwd = await fs.realpath(root);
const previous = process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CONFIG_DIR = path.join(cwd, "config");
const sdk = await import("../../packages/runtime/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs");
const requests: unknown[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("count_tokens")) return Response.json({ input_tokens: 10 });
    if (!url.pathname.endsWith("/messages")) return Response.json({ ok: true });
    const body = (await request.json()) as { model: string; messages: unknown[]; stream?: boolean };
    requests.push(body.messages);
    const text = `local-answer-${requests.length}`;
    const message = {
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 2 },
    };
    if (!body.stream) return Response.json(message);
    const events = [
      {
        type: "message_start",
        message: {
          ...message,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 2 },
      },
      { type: "message_stop" },
    ];
    return new Response(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});
async function run(prompt: string, resume?: string) {
  const query = sdk.query({
    prompt,
    options: {
      cwd,
      model: "claude-sonnet-4-20250514",
      tools: [],
      settingSources: [],
      maxTurns: 1,
      ...(resume ? { resume } : {}),
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: server.url.origin,
        ANTHROPIC_API_KEY: "local-test",
        ANTHROPIC_AUTH_TOKEN: "",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
    },
  });
  let sessionId = "";
  try {
    for await (const event of query) {
      if (event.type === "result") {
        assert.equal(event.subtype, "success", JSON.stringify(event));
        sessionId = event.session_id;
      }
    }
  } finally {
    query.close();
  }
  assert(sessionId);
  return sessionId;
}
try {
  const source = await run("source-keep-user");
  await run("source-future-user", source);
  const messages = await sdk.getSessionMessages(source, { dir: cwd });
  const users = messages.filter((message) => message.type === "user");
  assert.equal(users.length, 2);
  const sourceDir = path.join(process.env.CLAUDE_CONFIG_DIR!, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  const sourceFile = path.join(sourceDir, `${source}.jsonl`);
  const bytes = await fs.readFile(sourceFile, "utf8");
  const local = (index: number) => ({
    messageId: `u${index}`,
    conversationId: "source",
    turnId: `turn${index}`,
    createdSeq: index + 1,
    versionSeq: index + 1,
    contentVersion: 0,
    role: "user" as const,
    channel: "answer" as const,
    body: index ? "source-future-user" : "source-keep-user",
    status: "final" as const,
    isDeleted: false,
    historyTarget: { activityLineId: `u${index}`, userMessageId: users[index]!.uuid },
  });
  const history: ConversationForkHistory = {
    sourceThreadId: "source",
    sourceHeadSeq: 10,
    target: local(1),
    messages: [local(0)],
    runs: [],
    runPayloads: {},
    tools: [],
    details: [],
    agents: [],
    sources: [],
  };
  const fork = await forkNativeConversation({
    history,
    childThreadId: "model-child",
    coreKind: "claude",
    sessionId: source,
    cwd,
    ecoDataDir: cwd,
    recoveryTitle: "offline model fork",
    onCreated: () => {},
  });
  assert.notEqual(fork.externalSessionId, source);
  const requestStart = requests.length;
  await run("child-only-user", fork.externalSessionId);
  const modelInput = JSON.stringify(requests.slice(requestStart));
  assert(modelInput.includes("source-keep-user"));
  assert(modelInput.includes("local-answer-1"));
  assert(modelInput.includes("child-only-user"));
  assert(!modelInput.includes("source-future-user"));
  assert(!modelInput.includes("local-answer-2"));
  assert.equal(await fs.readFile(sourceFile, "utf8"), bytes);
  const selectedReply = {conversationId: "source", messageId: "reply-first", turnId: "first-turn", runId: "run-first", createdSeq: 2, versionSeq: 2, contentVersion: 0, role: "assistant" as const, channel: "answer" as const, status: "final" as const, isDeleted: false, body: "local-answer-1"};
  const afterHistory: ConversationForkHistory = {...history, target: selectedReply, boundaryUser: local(0), messages: [local(0), selectedReply]};
  const afterFork = await forkNativeConversation({history: afterHistory, childThreadId: "after-reply-child", coreKind: "claude", sessionId: source, cwd, ecoDataDir: cwd, recoveryTitle: "after reply", onCreated: () => {}});
  const afterStart = requests.length;
  await run("after-reply-child-only", afterFork.externalSessionId);
  const afterModelInput = JSON.stringify(requests.slice(afterStart));
  assert(afterModelInput.includes("source-keep-user"));
  assert(afterModelInput.includes("local-answer-1"));
  assert(afterModelInput.includes("after-reply-child-only"));
  assert(!afterModelInput.includes("source-future-user"));
  assert(!afterModelInput.includes("local-answer-2"));
  assert.equal(await fs.readFile(sourceFile, "utf8"), bytes);
  console.log(
    JSON.stringify({
      core: "claude",
      productionAdapter: true,
      assistantReplyFork: true,
      realSdkCli: true,
      loopbackModel: true,
      futureHistoryExcludedFromModelInput: true,
      sourceFileUnchanged: true,
    }),
  );
} finally {
  server.stop(true);
  if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previous;
  await fs.rm(root, { recursive: true, force: true });
}
