import { startCodexThreadSerially } from "@eco/runtime/codex-app-server-driver";
import type { CodexQuotaClient } from "./codex-account-quota";
import { latestLunaModelId } from "../shared/codex-wake-model";

interface WakeTurn {
  id: string;
  status: string;
  error?: { message?: string } | null;
  items?: Array<{ type: string; text?: string }>;
}

/** One ephemeral greeting on the official subscription provider; never resumes a user thread. */
export async function wakeCodexAccount(
  client: CodexQuotaClient,
  selectedModelId: string | null = null,
  timeoutMs = 90_000,
): Promise<string> {
  if (!client.addNotificationHandler) throw new Error("Codex 客户端不支持接收唤醒回复。");
  let model = selectedModelId?.trim();
  if (selectedModelId !== null && !model) throw new Error("唤醒模型不能为空。");
  if (!model) {
    const modelIds: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: Array<{ model: string }>; nextCursor?: string | null } = await client.request(
        "model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }, { timeoutMs: 30_000 },
      );
      modelIds.push(...page.data.map((entry) => entry.model));
      cursor = page.nextCursor ?? null;
    } while (cursor);
    model = latestLunaModelId(modelIds);
    if (!model) throw new Error("Codex 模型目录中没有 Luna 模型，请在账号页设置唤醒模型。");
  }
  const started = await startCodexThreadSerially(client, () =>
    client.request<{ thread: { id: string } }>(
      "thread/start",
      {
        model,
        modelProvider: "openai",
        ephemeral: true,
        approvalPolicy: "never",
        sandbox: "read-only",
        baseInstructions: "Reply with a brief greeting. Do not use tools or inspect files.",
        developerInstructions: "This is an account wake-up greeting. Reply briefly to hi.",
        config: { web_search: "disabled", "features.shell_tool": false },
      },
      { timeoutMs: 30_000 },
    ),
  );
  const threadId = started.thread.id;
  if (!threadId) throw new Error("Codex 未返回唤醒会话 ID。");
  const completion = Promise.withResolvers<WakeTurn>();
  // A completion can arrive before turn/start's response, including an immediate failure.
  void completion.promise.catch(() => {});
  const messages = new Map<string, string>();
  let completed = false;
  let turnId: string | undefined;
  const unsubscribe = client.addNotificationHandler((method, params) => {
    if (!isRecord(params) || params.threadId !== threadId) return;
    if (method === "item/completed" && isRecord(params.item)) {
      const item = params.item;
      if (item.type === "agentMessage" && typeof item.id === "string" && typeof item.text === "string") {
        messages.set(item.id, item.text);
      }
    }
    if (method === "turn/completed" && isRecord(params.turn)) {
      completed = true;
      completion.resolve(params.turn as unknown as WakeTurn);
    }
  });
  const timer = setTimeout(
    () => completion.reject(new Error("唤醒超时，尚未收到完整回复，请刷新额度确认状态。")),
    timeoutMs,
  );
  try {
    const result = await client.request<{ turn: WakeTurn }>(
      "turn/start",
      {
        threadId,
        model,
        input: [{ type: "text", text: "hi" }],
      },
      { timeoutMs: Math.min(timeoutMs, 30_000) },
    );
    turnId = result.turn.id;
    const turn = await completion.promise;
    if (turn.id !== turnId) throw new Error("Codex 唤醒回复的回合 ID 不匹配。");
    if (turn.status !== "completed")
      throw new Error(turn.error?.message || `Codex 唤醒未完成：${turn.status}`);
    const reply = (
      turn.items
        ?.filter((item) => item.type === "agentMessage")
        .map((item) => item.text ?? "")
        .join("\n") || [...messages.values()].join("\n")
    ).trim();
    if (!reply) throw new Error("Codex 已结束唤醒请求，但未返回文本回复。");
    return reply;
  } finally {
    clearTimeout(timer);
    unsubscribe();
    if (!completed && turnId) {
      await client
        .request("turn/interrupt", { threadId, turnId }, { timeoutMs: 5_000 })
        .catch((error) => console.error("[codex-wake] Interrupt failed:", error));
    }
    await client
      .request("thread/unsubscribe", { threadId }, { timeoutMs: 5_000 })
      .catch((error) => console.error("[codex-wake] Unsubscribe failed:", error));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
