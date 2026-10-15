import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ensurePiSessionsDir, resolvePiAgentDir } from "@eco/runtime";
import { CodexAppServerClient } from "@eco/runtime/codex-app-server-client";
import { encodeClaudeProjectDirName, resolveClaudeProjectsDir } from "./claude-session-paths";
import type { ConversationForkHistory } from "./conversation-fork-history";

export interface NativeConversationFork {
  coreKind: "claude" | "codex" | "pi";
  externalSessionId: string;
  cwd: string;
  empty?: boolean;
  metadata?: Record<string, unknown>;
  userIds: Record<string, string>;
}

export interface NativeConversationForkInput {
  history: ConversationForkHistory;
  childThreadId: string;
  coreKind: NativeConversationFork["coreKind"];
  sessionId: string;
  cwd: string;
  sessionFile?: string;
  ecoDataDir: string;
  recoveryTitle: string;
  codexExecutable?: string;
  codexHome?: string;
  resolveClaudeUserId?: (activityLineId: string) => Promise<string>;
  /** Called synchronously when the provider returns its new identity. */
  onCreated: (result: NativeConversationFork) => void;
}

export async function forkNativeConversation(
  input: NativeConversationForkInput,
): Promise<NativeConversationFork> {
  const afterAssistant = input.history.target.role === "assistant";
  const boundaryUser = afterAssistant ? input.history.boundaryUser : input.history.target;
  if (!boundaryUser || boundaryUser.role !== "user") throw new Error("分叉缺少已验证的用户轮次边界。");
  let nativeTarget = boundaryUser.historyTarget?.userMessageId;
  if (!nativeTarget) throw new Error("所选消息缺少原生节点 ID，无法安全分叉。");
  if (input.coreKind === "claude") {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const sourceFile = await claudeFile(input.sessionId, input.cwd);
    const sourceRows = await readJsonl(sourceFile);
    const userRows = uniqueUserRows(sourceRows);
    if (
      !userRows.some((row) => row.uuid === nativeTarget) &&
      input.resolveClaudeUserId &&
      boundaryUser.historyTarget?.activityLineId
    )
      nativeTarget = await input.resolveClaudeUserId(boundaryUser.historyTarget.activityLineId);
    const targetIndex = userRows.findIndex((row) => row.uuid === nativeTarget);
    if (targetIndex < 0) throw new Error("Claude 源会话中不存在所选消息。");
    const expected = input.history.messages.filter((message) => message.role === "user");
    const keptRows = userRows.slice(0, targetIndex + (afterAssistant ? 1 : 0));
    const keptPromptIds = new Map<string, string>();
    for (const message of expected) {
      let originalId = message.historyTarget?.userMessageId;
      if (
        !keptRows.some((row) => row.uuid === originalId) &&
        input.resolveClaudeUserId &&
        message.historyTarget?.activityLineId
      )
        originalId = await input.resolveClaudeUserId(message.historyTarget.activityLineId);
      if (!originalId || !keptRows.some((row) => row.uuid === originalId))
        throw new Error("Claude 原生历史与 Eco 分叉边界不一致。");
      keptPromptIds.set(message.messageId, originalId);
    }
    const tracked = new Set(keptPromptIds.values());
    if (
      keptRows.some(
        (row) => !tracked.has(row.uuid as string) && row.isMeta !== true && row.isSynthetic !== true,
      )
    )
      throw new Error("Claude 原生历史与 Eco 分叉边界不一致。");
    if (keptRows.length === 0) {
      const result: NativeConversationFork = {
        coreKind: "claude",
        externalSessionId: randomUUID(),
        cwd: input.cwd,
        empty: true,
        userIds: {},
      };
      input.onCreated(result);
      return result;
    }
    // A preserved assistant can precede compact_boundary physically, even when it is
    // the user's parent in the logical chain. Forking at that assistant would drop
    // the summary and resurrect pre-compaction context. Keep the last main-thread
    // message physically before this user, including the compact summary.
    const physicalTargetIndex = sourceRows.findLastIndex(
      (row) => row.uuid === nativeTarget && row.isSidechain !== true,
    );
    let anchor = sourceRows
      .slice(0, physicalTargetIndex)
      .findLast(
        (row) =>
          (row.type === "user" || row.type === "assistant") &&
          row.isSidechain !== true &&
          typeof row.uuid === "string",
      )?.uuid;
    if (afterAssistant) {
      const nextUserId = userRows[targetIndex + 1]?.uuid;
      const nextUserIndex = nextUserId
        ? sourceRows.findIndex((row) => row.uuid === nextUserId)
        : sourceRows.length;
      const reply = sourceRows
        .slice(physicalTargetIndex + 1, nextUserIndex)
        .findLast((row) => row.type === "assistant" && row.isSidechain !== true);
      if (!reply || nativeMessageText(reply.message) !== input.history.target.body.trim())
        throw new Error("Claude 所选回复不是该原生轮次的最后一条回答。");
      anchor = reply.uuid;
    }
    if (typeof anchor !== "string" || !anchor) throw new Error("Claude 所选消息之前缺少有效的历史链节点。");
    const effectiveSource = await sdk.getSessionMessages(input.sessionId, { dir: input.cwd });
    const effectiveTargetIndex = effectiveSource.findIndex(
      (message) => message.uuid === (afterAssistant ? anchor : nativeTarget),
    );
    const forked = await sdk.forkSession(input.sessionId, {
      dir: input.cwd,
      upToMessageId: anchor,
      title: input.recoveryTitle,
    });
    if (!forked.sessionId || forked.sessionId === input.sessionId)
      throw new Error("Claude 未返回独立的分支会话 ID。");
    // Record the identity before any further I/O, so an interrupted validation is recoverable.
    const result: NativeConversationFork = {
      coreKind: "claude",
      externalSessionId: forked.sessionId,
      cwd: input.cwd,
      metadata: { sessionFile: path.join(path.dirname(sourceFile), `${forked.sessionId}.jsonl`) },
      userIds: {},
    };
    input.onCreated(result);
    if (effectiveTargetIndex >= 0) {
      const effectiveChild = await sdk.getSessionMessages(forked.sessionId, { dir: input.cwd });
      const content = (messages: typeof effectiveSource) =>
        messages.map((message) => ({ type: message.type, message: message.message }));
      if (
        JSON.stringify(content(effectiveChild)) !==
        JSON.stringify(content(effectiveSource.slice(0, effectiveTargetIndex + (afterAssistant ? 1 : 0))))
      )
        throw new Error("Claude 分支的有效上下文与所选节点之前的历史不一致。");
    }
    const childRows = uniqueUserRows(await readJsonl(await claudeFile(forked.sessionId, input.cwd)));
    if (childRows.length !== keptRows.length)
      throw new Error("Claude 分支包含了边界之后的历史或缺失保留消息。");
    const remapped = new Map<string, string>();
    for (const [index, source] of keptRows.entries()) {
      const child = childRows[index];
      if (
        !source ||
        !child ||
        typeof child.uuid !== "string" ||
        JSON.stringify(source.message) !== JSON.stringify(child.message)
      )
        throw new Error("Claude 分支消息内容与源历史不一致。");
      remapped.set(source.uuid as string, child.uuid);
    }
    for (const message of expected) {
      const newId = remapped.get(keptPromptIds.get(message.messageId) ?? "");
      if (!newId) throw new Error("Claude 新会话的用户身份映射缺失。");
      result.userIds[message.messageId] = newId;
    }
    return result;
  }
  if (input.coreKind === "pi") {
    if (!input.sessionFile) throw new Error("Pi 会话缺少持久化 JSONL 路径。");
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const sessionsDir = await ensurePiSessionsDir(resolvePiAgentDir(input.ecoDataDir, input.childThreadId));
    const source = SessionManager.open(input.sessionFile, sessionsDir);
    if (source.getSessionId() !== input.sessionId) throw new Error("Pi 源会话文件与绑定 ID 不一致。");
    const target = source.getEntry(nativeTarget);
    if (target?.type !== "message" || target.message.role !== "user")
      throw new Error("Pi 源会话中不存在所选用户节点。");
    let anchor = target.parentId;
    if (afterAssistant) {
      const activeBranch = source.getBranch();
      const index = activeBranch.findIndex((entry) => entry.id === nativeTarget);
      if (index < 0) throw new Error("Pi 所选用户轮次不在当前历史路径上。");
      const nextUser = activeBranch.findIndex(
        (entry, i) => i > index && entry.type === "message" && entry.message.role === "user",
      );
      const reply = activeBranch
        .slice(index + 1, nextUser < 0 ? undefined : nextUser)
        .findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
      if (reply?.type !== "message" || nativeMessageText(reply.message) !== input.history.target.body.trim())
        throw new Error("Pi 所选回复不是该原生轮次的最后一条回答。");
      anchor = reply.id;
    }
    const branch = anchor ? source.getBranch(anchor) : [];
    const expected = input.history.messages.filter((message) => message.role === "user");
    const users = branch.filter((entry) => entry.type === "message" && entry.message.role === "user");
    if (users.length !== expected.length) throw new Error("Pi 原生历史与 Eco 分叉边界不一致。");
    const userIds: Record<string, string> = {};
    for (const [index, message] of expected.entries()) {
      const entry = users[index];
      if (!entry || message.historyTarget?.userMessageId !== entry.id)
        throw new Error("Pi 用户节点与 Eco 保存的身份不一致。");
      userIds[message.messageId] = entry.id;
    }
    let sessionFile: string | undefined;
    if (users.length === 0) {
      source.newSession({ parentSession: input.sessionFile });
    } else {
      if (!anchor) throw new Error("Pi 节点之前缺少历史链。");
      sessionFile = source.createBranchedSession(anchor);
      if (!sessionFile) throw new Error("Pi 未生成分支文件。");
    }
    const result: NativeConversationFork = {
      coreKind: "pi",
      externalSessionId: source.getSessionId(),
      cwd: input.cwd,
      userIds,
      ...(sessionFile ? { metadata: { sessionFile } } : { empty: true }),
    };
    input.onCreated(result);
    if (sessionFile) await fs.access(sessionFile);
    return result;
  }
  if (!input.codexExecutable || !input.codexHome) throw new Error("Codex 分叉运行环境不可用。");
  // A short-lived control plane leaves the child cold for its first thread-scoped MCP/config load.
  const child = spawn(input.codexExecutable, ["app-server", "--stdio"], {
    env: { ...process.env, CODEX_HOME: input.codexHome },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4096);
  });
  const client = CodexAppServerClient.attachToProcess(child, { timeoutMs: 30_000 });
  child.on("error", () => client.close());
  try {
    await client.initialize();
    type Turn = {
      id: string;
      status: string;
      items: Array<{ id: string; clientId?: string; type: string; text?: string }>;
    };
    type Thread = { id: string; path?: string; forkedFromId?: string; turns: Turn[] };
    const source = await client.request<{ thread: Thread }>("thread/read", {
      threadId: input.sessionId,
      includeTurns: true,
    });
    const mappedTurnId = input.history.codexTurnIds?.[boundaryUser.messageId];
    const targetIndex = source.thread.turns.findIndex((turn) =>
      mappedTurnId
        ? turn.id === mappedTurnId
        : turn.items.some(
            (item) =>
              item.type === "userMessage" && (item.id === nativeTarget || item.clientId === nativeTarget),
          ),
    );
    if (targetIndex < 0) throw new Error("Codex 源会话中不存在所选用户节点；请刷新消息身份后重试。");
    const target = source.thread.turns[targetIndex];
    if (!target || target.status === "inProgress") throw new Error("Codex 所选轮次尚未结束。");
    if (
      afterAssistant &&
      target.items.findLast((item) => item.type === "agentMessage")?.text?.trim() !==
        input.history.target.body.trim()
    )
      throw new Error("Codex 所选回复不是该原生轮次的最后一条回答。");
    const expected = input.history.messages.filter((message) => message.role === "user");
    const nativeUsers = source.thread.turns
      .slice(0, targetIndex + (afterAssistant ? 1 : 0))
      .flatMap((turn) => turn.items.filter((item) => item.type === "userMessage"));
    if (nativeUsers.length !== expected.length) throw new Error("Codex 原生历史与 Eco 分叉边界不一致。");
    const fork = await client.request<{ thread: Thread }>(
      "thread/fork",
      {
        threadId: input.sessionId,
        ...(afterAssistant ? { lastTurnId: target.id } : { beforeTurnId: target.id }),
        config: { mcp_servers: {} },
      },
      {
        onResult: (response) => {
          const id = response.thread?.id;
          if (!id || id === input.sessionId) throw new Error("Codex 未返回独立的分支 ID。");
          input.onCreated({
            coreKind: "codex",
            externalSessionId: id,
            cwd: input.cwd,
            metadata: { rolloutPath: response.thread.path },
            userIds: {},
          });
        },
      },
    );
    const forkUsers = fork.thread.turns.flatMap((turn) =>
      turn.items.filter((item) => item.type === "userMessage"),
    );
    if (forkUsers.length !== expected.length) throw new Error("Codex 分支历史未按指定轮次截断。");
    const userIds: Record<string, string> = {};
    for (const [index, message] of expected.entries()) {
      const item = forkUsers[index];
      const sourceItem = nativeUsers[index];
      const persistedTurnId = input.history.codexTurnIds?.[message.messageId];
      const turn = sourceItem
        ? source.thread.turns
            .slice(0, targetIndex + (afterAssistant ? 1 : 0))
            .find((turn) => turn.items.includes(sourceItem))
        : undefined;
      if (
        !item ||
        !sourceItem ||
        item.id !== sourceItem.id ||
        (persistedTurnId
          ? turn?.id !== persistedTurnId
          : message.historyTarget?.userMessageId !== sourceItem.id &&
            message.historyTarget?.userMessageId !== sourceItem.clientId)
      )
        throw new Error("Codex 分支消息身份验证失败。");
      userIds[message.messageId] = item.id;
    }
    return {
      coreKind: "codex",
      externalSessionId: fork.thread.id,
      cwd: input.cwd,
      metadata: { rolloutPath: fork.thread.path },
      userIds,
    };
  } catch (error) {
    throw new Error(`Codex 分叉失败：${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  } finally {
    client.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    }
    if (stderr && child.exitCode && child.exitCode !== 0)
      console.error(`[eco] fork control plane: ${stderr}`);
  }
}

export async function cleanupNativeConversationFork(result: NativeConversationFork): Promise<void> {
  if (result.coreKind === "claude" && !result.empty) {
    await (await import("@anthropic-ai/claude-agent-sdk")).deleteSession(result.externalSessionId, {
      dir: result.cwd,
    });
  } else if (result.coreKind === "pi" && typeof result.metadata?.sessionFile === "string") {
    await fs.unlink(result.metadata.sessionFile);
  }
  // Codex cleanup needs an app-server; the caller keeps its identity in a failed durable command.
}

async function claudeFile(sessionId: string, cwd: string): Promise<string> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error("Claude 会话 ID 无效。");
  const canonical = await fs.realpath(cwd);
  return path.join(resolveClaudeProjectsDir(), encodeClaudeProjectDirName(canonical), `${sessionId}.jsonl`);
}
async function readJsonl(file: string): Promise<Record<string, unknown>[]> {
  return (await fs.readFile(file, "utf8"))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
function uniqueUserRows(rows: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const result = new Map<string, Record<string, unknown>>();
  for (const row of rows)
    if (
      row.type === "user" &&
      row.isSidechain !== true &&
      row.isCompactSummary !== true &&
      typeof row.uuid === "string" &&
      (row.message as { role?: string; content?: unknown } | undefined)?.role === "user"
    ) {
      const content = (row.message as { content?: unknown }).content;
      if (
        Array.isArray(content) &&
        content.every((block) => block && typeof block === "object" && block.type === "tool_result")
      )
        continue;
      result.set(row.uuid, row);
    }
  return [...result.values()];
}

/** Content verification happens only inside a turn already located by its native user id. */
function nativeMessageText(value: unknown): string {
  const message = value as { content?: unknown } | undefined;
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) =>
      block && typeof block === "object" && block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("")
    .trim();
}
