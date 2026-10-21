// Offline SDK contract probe. Creates and removes only its own temporary sessions.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../../packages/runtime/src/codex-app-server-client.ts";
import { forkNativeConversation } from "../../apps/desktop/src/main/conversation-native-fork.ts";
import type { ConversationForkHistory } from "../../apps/desktop/src/main/conversation-fork-history.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const executable = path.join(repo, "apps/desktop/node_modules/.bin/codex");
const codexVersion = execFileSync(executable, ["--version"], { encoding: "utf8" })
  .trim()
  .replace(/^codex-cli\s+/, "");
const pin = JSON.parse(fs.readFileSync(path.join(repo, "apps/desktop/package.json"), "utf8")).dependencies[
  "@openai/codex"
];
assert.equal(codexVersion, pin, "Probe must use the project-pinned Codex");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "eco-codex-fork-probe-"));
const workspace = path.join(root, "workspace");
fs.mkdirSync(workspace);
let apiCalls: unknown[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (!request.url.endsWith("/responses") || request.method !== "POST")
      return new Response("not found", { status: 404 });
    const body = (await request.json()) as { model: string };
    apiCalls.push(body);
    const responseId = `resp_${randomUUID()}`;
    const itemId = `msg_${randomUUID()}`;
    const message = {
      type: "message",
      id: itemId,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "ok", annotations: [] }],
    };
    const events = [
      {
        type: "response.created",
        response: {
          id: responseId,
          object: "response",
          model: body.model,
          status: "in_progress",
          output: [],
        },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...message, status: "in_progress", content: [] },
      },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: itemId, delta: "ok" },
      { type: "response.output_item.done", output_index: 0, item: message },
      {
        type: "response.completed",
        response: {
          id: responseId,
          object: "response",
          model: body.model,
          status: "completed",
          output: [message],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      },
    ];
    return new Response(
      events
        .map(
          (event, sequence_number) =>
            `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`,
        )
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});
const codexHome = path.join(root, "codex");
fs.mkdirSync(codexHome);
fs.writeFileSync(
  path.join(codexHome, "config.toml"),
  `model_provider = "stub"\n[model_providers.stub]\nname = "Local fork probe"\nbase_url = "http://127.0.0.1:${server.port}/v1"\nenv_key = "STUB_API_KEY"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_idle_timeout_ms = 5000\n`,
);
const child = spawn(executable, ["app-server", "--stdio"], {
  env: { ...process.env, CODEX_HOME: codexHome, STUB_API_KEY: "probe-local-only" },
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});
const client = CodexAppServerClient.attachToProcess(child, { timeoutMs: 15_000 });

interface ProbeItem {
  id: string;
  type: string;
  content: { type: string; text?: string }[];
}

interface ProbeTurn {
  id: string;
  status: string;
  error?: unknown;
  items: ProbeItem[];
}

interface ProbeThread {
  id: string;
  status?: { type: string };
  forkedFromId?: string;
  turns: ProbeTurn[];
}

async function send(threadId: string, text: string) {
  let remove = () => {};
  let timeout: ReturnType<typeof setTimeout>;
  const finished = new Promise<ProbeTurn>((resolve, reject) => {
    timeout = setTimeout(() => {
      remove();
      reject(new Error(`Turn timeout: ${stderr.slice(-1000)}`));
    }, 15_000);
    remove = client.addNotificationHandler((method, raw) => {
      const params = raw as { threadId?: string; turn: ProbeTurn } | null;
      if (method === "turn/completed" && params?.threadId === threadId) {
        clearTimeout(timeout);
        remove();
        resolve(params.turn);
      }
    });
  });
  try {
    await client.request("turn/start", {
      threadId,
      input: [{ type: "text", text }],
      model: "gpt-5.1-codex-mini",
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly" },
    });
    const turn = await finished;
    assert.equal(turn.status, "completed", JSON.stringify(turn.error));
    return turn;
  } finally {
    clearTimeout(timeout);
    remove();
  }
}
const read = async (threadId: string) =>
  (await client.request<{ thread: ProbeThread }>("thread/read", { threadId, includeTurns: true })).thread;
const texts = (thread: ProbeThread) =>
  thread.turns.flatMap((turn) =>
    turn.items
      .filter((item) => item.type === "userMessage")
      .flatMap((item) =>
        item.content.filter((content) => content.type === "text").map((content) => content.text),
      ),
  );

try {
  await client.initialize();
  const { thread } = await client.request<{ thread: ProbeThread }>("thread/start", {
    cwd: workspace,
    modelProvider: "stub",
    model: "gpt-5.1-codex-mini",
  });
  const first = await send(thread.id, "KEEP_FIRST_TURN");
  await send(thread.id, "EXCLUDE_LATER_TURN");
  const before = await read(thread.id);
  assert.deepEqual(texts(before), ["KEEP_FIRST_TURN", "EXCLUDE_LATER_TURN"]);
  const { thread: fork } = await client.request<{ thread: ProbeThread }>("thread/fork", {
    threadId: thread.id,
    lastTurnId: first.id,
  });
  assert.notEqual(fork.id, thread.id);
  assert.equal(fork.forkedFromId, thread.id);
  const childRead = await read(fork.id);
  assert.deepEqual(texts(childRead), ["KEEP_FIRST_TURN"]);
  assert.deepEqual(texts(await read(thread.id)), texts(before));
  const parentFirst = before.turns[0];
  const childFirst = childRead.turns[0];
  const identity = {
    parentTurnId: parentFirst.id,
    childTurnId: childFirst.id,
    sameTurnId: parentFirst.id === childFirst.id,
    sameItemIds:
      JSON.stringify(parentFirst.items.map((i) => i.id)) ===
      JSON.stringify(childFirst.items.map((i) => i.id)),
  };
  apiCalls = [];
  await send(fork.id, "CHILD_ONLY");
  const sent = JSON.stringify(apiCalls);
  assert(sent.includes("KEEP_FIRST_TURN"));
  assert(!sent.includes("EXCLUDE_LATER_TURN"));
  assert(sent.includes("CHILD_ONLY"));
  assert.deepEqual(texts(await read(thread.id)), texts(before));
  await send(thread.id, "PARENT_ONLY");
  assert.deepEqual(texts(await read(fork.id)), ["KEEP_FIRST_TURN", "CHILD_ONLY"]);
  await assert.rejects(client.request("thread/fork", { threadId: thread.id, lastTurnId: randomUUID() }));
  const targetTurn = before.turns[1];
  assert(targetTurn);
  const targetMessage = { conversationId: "probe-source", messageId: "target-user", turnId: "local-target-turn", createdSeq: 3, versionSeq: 3, contentVersion: 0, role: "user" as const, channel: "answer" as const, status: "final" as const, isDeleted: false, body: "EXCLUDE_LATER_TURN", historyTarget: { activityLineId: "target-user", userMessageId: "rebuilt-target-item" } };
  const nativeHistory: ConversationForkHistory = { sourceThreadId: "probe-source", sourceHeadSeq: 10, target: targetMessage,
    messages: [{ ...targetMessage, messageId: "kept-user", body: "KEEP_FIRST_TURN", historyTarget: { activityLineId: "kept-user", userMessageId: "rebuilt-kept-item" } }],
    codexTurnIds: { "kept-user": first.id, "target-user": targetTurn.id }, runs: [], runPayloads: {}, tools: [], details: [], agents: [], sources: [] };
  let createdId: string | undefined;
  // The production native-fork adapter runs a separate control plane and returns a cold child.
  process.env.STUB_API_KEY = "probe-local-only";
  const independent = await forkNativeConversation({ history: nativeHistory, childThreadId: "probe-child", coreKind: "codex", sessionId: thread.id, cwd: workspace, ecoDataDir: root, recoveryTitle: "probe-native", codexExecutable: executable, codexHome, onCreated: result => { createdId = result.externalSessionId; } });
  assert.equal(createdId, independent.externalSessionId);
  const independentRead = await read(independent.externalSessionId);
  assert.deepEqual(texts(independentRead), ["KEEP_FIRST_TURN"]);
  assert.equal(independentRead.status?.type, "notLoaded");
  await client.request("thread/resume", { threadId: independent.externalSessionId, config: { mcp_servers: {} } });
  apiCalls = [];
  await send(independent.externalSessionId, "PRODUCTION_CHILD_ONLY");
  assert(!JSON.stringify(apiCalls).includes("EXCLUDE_LATER_TURN"));
  assert(!JSON.stringify(apiCalls).includes("PARENT_ONLY"));
  assert.deepEqual(texts(await read(thread.id)), ["KEEP_FIRST_TURN", "EXCLUDE_LATER_TURN", "PARENT_ONLY"]);
  const boundaryUser = nativeHistory.messages[0];
  assert(boundaryUser);
  const replyTarget = {conversationId: "probe-source", messageId: "reply-first", turnId: "local-first-turn", runId: "first-run", createdSeq: 2, versionSeq: 2, contentVersion: 0, role: "assistant" as const, channel: "answer" as const, status: "final" as const, isDeleted: false, body: "ok"};
  const afterHistory: ConversationForkHistory = {...nativeHistory, target: replyTarget, boundaryUser, messages: [boundaryUser, replyTarget]};
  const afterReply = await forkNativeConversation({history: afterHistory, childThreadId: "probe-after-reply", coreKind: "codex", sessionId: thread.id, cwd: workspace, ecoDataDir: root, recoveryTitle: "after-reply", codexExecutable: executable, codexHome, onCreated: () => {}});
  assert.deepEqual(texts(await read(afterReply.externalSessionId)), ["KEEP_FIRST_TURN"]);
  await client.request("thread/resume", {threadId: afterReply.externalSessionId, config: {mcp_servers: {}}});
  apiCalls = [];
  await send(afterReply.externalSessionId, "AFTER_REPLY_CHILD_ONLY");
  const afterInput = JSON.stringify(apiCalls);
  assert(afterInput.includes("KEEP_FIRST_TURN"));
  assert(afterInput.includes("AFTER_REPLY_CHILD_ONLY"));
  assert(!afterInput.includes("EXCLUDE_LATER_TURN"));
  assert(!afterInput.includes("PARENT_ONLY"));
  let beforeTurnId: { supported: boolean; turns: number };
  {
    const beforeFork = await client.request<{ thread: ProbeThread }>("thread/fork", {
      threadId: thread.id,
      beforeTurnId: first.id,
    });
    const result = await read(beforeFork.thread.id);
    assert.deepEqual(texts(result), []);
    beforeTurnId = { supported: true, turns: result.turns.length };
  }
  console.log(
    JSON.stringify({
      core: "codex",
      version: codexVersion,
      inclusiveCompletedTurn: true,
      freshThreadId: true,
      parentUnchanged: true,
      childModelInputExcludesFuture: true,
      independentContinuations: true,
      unknownAnchorRejected: true,
      identity,
      beforeTurnId,
      productionAdapter: { coldChild: true, stableTurnMapping: true, modelInputExcludesFuture: true, assistantReplyFork: true },
    }),
  );
} finally {
  client.close();
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), Bun.sleep(2000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  server.stop(true);
  fs.rmSync(root, { recursive: true, force: true });
}
