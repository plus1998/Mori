/**
 * Storyboard demo scene (ECO_DEMO_SCENE=storyboard).
 *
 * Offline Conversation V2 fixtures + ChatGPT Login accounts / quotas / wake
 * batches / image quota / scheduled messages / display controls, so promo
 * footage can be recorded from the real renderer without agents or SQLite.
 */
import type {
  ConversationBootstrap,
  ConversationCapabilities,
  ConversationDetailsPage,
  ConversationEffect,
  ConversationHead,
  ConversationMessage,
  ConversationMessagesPage,
  ConversationRun,
  ConversationSendMessageResult,
  ConversationSyncPage,
  ConversationToolCall,
  ConversationTurnSummary,
} from "@eco/shared";
import {
  CONVERSATION_V2_EFFECT_VERSION,
  CONVERSATION_V2_PROTOCOL_VERSION,
  limitConversationToolSummaryPayload,
  stableHash,
} from "@eco/shared";
import { IPC_CHANNELS, type ThreadSummary } from "../shared/ipc";
import type { ThreadRuntimeConfig } from "../shared/thread-runtime-config";
import { buildThreadRuntimeConfigFromDefaults } from "../shared/thread-runtime-config";
import type {
  OpenAIAccount,
  OpenAIAccountDetails,
  OpenAIAccountImageQuota,
  OpenAIAccountQuota,
} from "../shared/openai-account";
import type { AccountWakeBatch, AccountWakeBatchState } from "../shared/account-wake-batch";
import type { DisplayControlChange, DisplayControlState } from "../shared/display-control";
import type { ScheduleCreateInput, ScheduleDefinition, ScheduleOccurrence } from "../shared/scheduling";
import { buildResourcesFromRouteProfile } from "../shared/agent-orchestration";
import { demoModelSettings, demoProvider, demoWorkflowSettings } from "./fixtures";
import { DEMO_WORKSPACE_PATH } from "./constants";

const NOW_MS = Date.now();
const iso = (offsetSeconds = 0) => new Date(NOW_MS + offsetSeconds * 1000).toISOString();
const atClock = (hour: number, minute: number) => {
  const d = new Date(NOW_MS);
  d.setHours(hour, minute, 30, 0);
  if (d.getTime() <= NOW_MS) d.setDate(d.getDate() + 1);
  return d;
};

const STORE_EPOCH = "storyboard-demo";

function convIdOf(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object") {
    const value = (payload as { conversationId?: unknown }).conversationId;
    if (typeof value === "string") return value;
  }
  return "";
}
function idOf(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of ["accountId", "id", "scheduleId", "runId"]) {
      if (typeof record[key] === "string") return record[key] as string;
    }
  }
  return "";
}

/** Minimal Conversation V2 store: effects + projected rows, hashes match the main store. */
class DemoConversation {
  readonly conversationId: string;
  readonly messages = new Map<string, ConversationMessage>();
  readonly runs = new Map<string, ConversationRun>();
  readonly tools = new Map<string, ConversationToolCall>();
  readonly turns = new Map<string, ConversationTurnSummary>();
  private effects: ConversationEffect[] = [];
  private seq = 0;
  historyRevision = 0;

  constructor(conversationId: string) {
    this.conversationId = conversationId;
  }

  push(effect: ConversationEffect): void {
    this.seq += 1;
    this.effects.push(effect);
    this.project(effect);
  }

  private project(effect: ConversationEffect): void {
    const seq = this.seq;
    switch (effect.type) {
      case "message.create":
        this.messages.set(effect.message.messageId, { ...effect.message });
        break;
      case "message.append": {
        const message = this.messages.get(effect.messageId);
        if (message) {
          this.messages.set(message.messageId, {
            ...message,
            body: message.body + effect.delta,
            contentVersion: effect.nextContentVersion,
            versionSeq: effect.versionSeq,
          });
        }
        break;
      }
      case "message.finalize": {
        const message = this.messages.get(effect.messageId);
        if (message) {
          this.messages.set(message.messageId, {
            ...message,
            status: effect.status,
            contentVersion: effect.contentVersion,
            versionSeq: effect.versionSeq,
          });
        }
        break;
      }
      case "run.upsert": {
        this.runs.set(effect.run.runId, { ...effect.run });
        const turn = this.turns.get(effect.run.turnId) ?? {
          turnId: effect.run.turnId,
          conversationId: this.conversationId,
          createdSeq: seq,
          versionSeq: seq,
        };
        const nextTurn = { ...turn, versionSeq: seq };
        if (effect.run.status === "completed") delete nextTurn.activeRunId;
        else nextTurn.activeRunId = effect.run.runId;
        this.turns.set(effect.run.turnId, nextTurn);
        break;
      }
      case "tool.summary.upsert":
        this.tools.set(effect.toolCall.toolCallId, { ...effect.toolCall });
        break;
      case "history.invalidation":
        this.historyRevision = effect.historyRevision;
        break;
      default:
        break;
    }
  }

  userMessage(messageId: string, body: string, opts?: { origin?: ConversationMessage["origin"]; occurredAt?: string }): void {
    this.push({
      type: "message.create",
      message: {
        messageId,
        conversationId: this.conversationId,
        turnId: `turn_${messageId}`,
        role: "user",
        channel: "answer",
        createdSeq: 0,
        versionSeq: 0,
        contentVersion: 0,
        body,
        status: "final",
        isDeleted: false,
        occurredAt: opts?.occurredAt ?? new Date().toISOString(),
        ...(opts?.origin ? { origin: opts.origin } : {}),
      },
    });
    // project() stamps createdSeq/versionSeq with the effect seq at create time? No:
    // the message literal above carries zeros; patch projection rows with real seq.
    const row = this.messages.get(messageId);
    if (row) {
      row.createdSeq = this.seq;
      row.versionSeq = this.seq;
    }
    this.turns.set(`turn_${messageId}`, {
      turnId: `turn_${messageId}`,
      conversationId: this.conversationId,
      createdSeq: this.seq,
      versionSeq: this.seq,
    });
  }

  answer(turnId: string, messageId: string, body: string, occurredAt?: string): void {
    this.push({
      type: "message.create",
      message: {
        messageId,
        conversationId: this.conversationId,
        turnId,
        role: "assistant",
        channel: "answer",
        createdSeq: this.seq + 1,
        versionSeq: this.seq + 1,
        contentVersion: 0,
        body,
        status: "final",
        isDeleted: false,
        occurredAt: occurredAt ?? new Date().toISOString(),
        providerRole: "main",
      },
    });
  }

  startRun(turnId: string, runId: string, startedAt?: string): void {
    this.push({
      type: "run.upsert",
      run: {
        runId,
        conversationId: this.conversationId,
        turnId,
        status: "running",
        startedAt: startedAt ?? new Date().toISOString(),
        versionSeq: this.seq + 1,
        timingQuality: "recorded",
      },
    });
  }

  finishRun(turnId: string, runId: string, window?: { startedAt?: string; endedAt?: string }): void {
    this.push({
      type: "run.upsert",
      run: {
        runId,
        conversationId: this.conversationId,
        turnId,
        status: "completed",
        startedAt: window?.startedAt ?? this.runs.get(runId)?.startedAt ?? iso(-600),
        endedAt: window?.endedAt ?? new Date().toISOString(),
        versionSeq: this.seq + 1,
        timingQuality: "recorded",
      },
    });
  }

  tool(runId: string, toolCallId: string, name: string, input: string, output: string, occurredAt?: string): void {
    this.push({
      type: "tool.summary.upsert",
      toolCall: {
        toolCallId,
        conversationId: this.conversationId,
        runId,
        name,
        status: "completed",
        createdSeq: this.seq + 1,
        versionSeq: this.seq + 1,
        occurredAt: occurredAt ?? new Date().toISOString(),
        providerRole: "main",
        input,
        output,
      },
    });
  }

  capabilities(): ConversationCapabilities {
    return {
      protocolVersion: CONVERSATION_V2_PROTOCOL_VERSION,
      eventSchemaVersion: 1,
      effectVersion: CONVERSATION_V2_EFFECT_VERSION,
      storeEpoch: STORE_EPOCH,
      maxEvents: 200,
      maxBytes: 4 * 1024 * 1024,
    };
  }

  bootstrap(): ConversationBootstrap {
    return {
      protocolVersion: CONVERSATION_V2_PROTOCOL_VERSION,
      conversationId: this.conversationId,
      storeEpoch: STORE_EPOCH,
      snapshotSeq: this.seq,
      historyRevision: this.historyRevision,
      messages: [...this.messages.values()],
      turns: [...this.turns.values()],
      runs: [...this.runs.values()],
      tools: [...this.tools.values()].map(limitConversationToolSummaryPayload),
      details: [],
      hasOlder: false,
    };
  }

  head(): ConversationHead {
    return {
      protocolVersion: CONVERSATION_V2_PROTOCOL_VERSION,
      conversationId: this.conversationId,
      storeEpoch: STORE_EPOCH,
      lastSeq: this.seq,
      historyRevision: this.historyRevision,
    };
  }

  messagesPage(): ConversationMessagesPage {
    return {
      protocolVersion: CONVERSATION_V2_PROTOCOL_VERSION,
      conversationId: this.conversationId,
      storeEpoch: STORE_EPOCH,
      readSeq: this.seq,
      historyRevision: this.historyRevision,
      messages: [...this.messages.values()],
      runs: [...this.runs.values()],
      tools: [...this.tools.values()].map(limitConversationToolSummaryPayload),
      agents: [],
      details: [],
      hasMore: false,
    };
  }

  toolsPage(runId: string): {
    protocolVersion: 2;
    conversationId: string;
    storeEpoch: string;
    runId: string;
    readSeq: number;
    historyRevision: number;
    tools: ConversationToolCall[];
    totalCount: number;
    hasMore: false;
  } {
    const tools = [...this.tools.values()].filter((tool) => tool.runId === runId);
    return {
      protocolVersion: CONVERSATION_V2_PROTOCOL_VERSION,
      conversationId: this.conversationId,
      storeEpoch: STORE_EPOCH,
      runId,
      readSeq: this.seq,
      historyRevision: this.historyRevision,
      tools,
      totalCount: tools.length,
      hasMore: false,
    };
  }

  detailsPage(): ConversationDetailsPage {
    return {
      protocolVersion: CONVERSATION_V2_PROTOCOL_VERSION,
      conversationId: this.conversationId,
      storeEpoch: STORE_EPOCH,
      readSeq: this.seq,
      historyRevision: this.historyRevision,
      items: [],
      hasMore: false,
    };
  }

  syncPage(afterSeq: number, throughSeq: number): ConversationSyncPage {
    const fromSeq = afterSeq + 1;
    const end = Math.min(throughSeq, this.seq);
    const slice: ConversationSyncPage["effects"] = [];
    for (let index = fromSeq - 1; index < end; index += 1) {
      const effect = this.effects[index];
      if (!effect) throw new Error(`Missing storyboard effect at sequence ${index + 1}`);
      slice.push({
        seq: index + 1,
        effectVersion: CONVERSATION_V2_EFFECT_VERSION,
        effectHash: stableHash(effect),
        effect,
      });
    }
    return {
      protocolVersion: CONVERSATION_V2_PROTOCOL_VERSION,
      conversationId: this.conversationId,
      storeEpoch: STORE_EPOCH,
      fromSeq,
      throughSeq: end,
      headSeq: this.seq,
      hasMore: end < throughSeq,
      effects: slice,
    };
  }

  sendMessage(payload: unknown): ConversationSendMessageResult {
    const record = (payload ?? {}) as Record<string, unknown>;
    const body = typeof record.body === "string" ? record.body : typeof record.prompt === "string" ? record.prompt : "";
    const clientCommandId = typeof record.clientCommandId === "string" ? record.clientCommandId : `cmd_${Date.now()}`;
    const messageId = `msg_${clientCommandId}`;
    this.userMessage(messageId, body);
    return {
      protocolVersion: CONVERSATION_V2_PROTOCOL_VERSION,
      conversationId: this.conversationId,
      clientCommandId,
      messageId,
      turnId: `turn_${messageId}`,
      acceptedSeq: this.seq,
      status: "queued",
    };
  }
}

function emptyConversation(conversationId: string): DemoConversation {
  const conv = new DemoConversation(conversationId);
  return conv;
}

// ---------------------------------------------------------------------------
// ChatGPT Login accounts + quota
// ---------------------------------------------------------------------------

const QUOTA_WINDOW_SECONDS = 5 * 3600;

function quota(email: string, planType: string, usedPercent: number, resetAt: Date, limitReached = false): OpenAIAccountQuota {
  const resetMs = resetAt.getTime();
  return {
    planType,
    email,
    rateLimit: {
      allowed: !limitReached,
      limitReached,
      primaryWindow: {
        usedPercent,
        limitWindowSeconds: QUOTA_WINDOW_SECONDS,
        resetAfterSeconds: Math.max(0, Math.round((resetMs - NOW_MS) / 1000)),
        // 渲染层把 OpenAIAccountQuotaWindow.resetAt 当 Unix 秒处理（OpenAIAccountsPanel.tsx 里 *1000）
        resetAt: Math.round(resetMs / 1000),
      },
      secondaryWindow: null,
    },
    resetCreditsAvailable: 1,
    fetchedAt: NOW_MS,
  };
}

function account(input: {
  id: string;
  name: string;
  email: string;
  planType: string;
  usedPercent: number;
  resetAt: Date;
  limitReached?: boolean;
  imageQuota?: OpenAIAccountImageQuota;
  imageGenerationEnabled?: boolean;
}): OpenAIAccount {
  return {
    id: input.id,
    name: input.name,
    email: input.email,
    proxyMode: "system",
    isLoggedIn: true,
    authState: "configured",
    lastLogin: iso(-3600),
    createdAt: iso(-40 * 24 * 3600),
    hasProfileData: true,
    profileFields: { email: true, password: true, pickupUrl: false, twoFactorSecret: false },
    quota: quota(input.email, input.planType, input.usedPercent, input.resetAt, input.limitReached),
    ...(input.imageQuota ? { imageQuota: input.imageQuota } : {}),
    ...(input.imageGenerationEnabled !== undefined ? { imageGenerationEnabled: input.imageGenerationEnabled } : {}),
  };
}

const accounts: OpenAIAccount[] = [
  account({
    id: "acct_plus_outlook",
    name: "plus-dev",
    email: "dev.plus@outlook.com",
    planType: "plus",
    usedPercent: 100,
    resetAt: atClock(3, 0),
    limitReached: true,
  }),
  account({ id: "acct_plus_icloud", name: "plus-2025", email: "plus2025@icloud.com", planType: "plus", usedPercent: 28, resetAt: atClock(17, 2) }),
  account({ id: "acct_gmail", name: "happy-plus", email: "happy.plus@gmail.com", planType: "plus", usedPercent: 42, resetAt: atClock(19, 40) }),
  account({ id: "acct_eco_outlook", name: "eco-dev", email: "eco.dev@outlook.com", planType: "plus", usedPercent: 59, resetAt: atClock(21, 15) }),
  account({
    id: "acct_free1",
    name: "free-day01",
    email: "free.day01@outlook.com",
    planType: "free",
    usedPercent: 10,
    resetAt: atClock(8, 0),
    imageGenerationEnabled: true,
    imageQuota: { source: "chatgpt_image_gen", status: "available", fetchedAt: NOW_MS, remaining: 4, resetAt: atClock(8, 0).toISOString() },
  }),
  account({
    id: "acct_free2",
    name: "free-day02",
    email: "free.day02@outlook.com",
    planType: "free",
    usedPercent: 6,
    resetAt: atClock(8, 0),
    imageGenerationEnabled: true,
    imageQuota: { source: "chatgpt_image_gen", status: "available", fetchedAt: NOW_MS, remaining: 5, resetAt: atClock(8, 0).toISOString() },
  }),
];

// ---------------------------------------------------------------------------
// Wake batches (镜头8)
// ---------------------------------------------------------------------------

const wakeBatches: AccountWakeBatchState = {
  version: 1,
  batches: [
    {
      id: "wake_0500",
      revision: 1,
      name: "账号 1 · 凌晨唤醒",
      time: "05:00",
      timezone: "Asia/Shanghai",
      repeat: "daily",
      accountIds: ["acct_plus_outlook"],
      enabled: true,
      nextRunAt: atClock(5, 0).toISOString(),
      lastRun: {
        id: "wake_0500_run",
        source: "scheduled",
        scheduledAt: atClock(5, 0).toISOString(),
        status: "completed",
        startedAt: atClock(5, 0).toISOString(),
        finishedAt: atClock(5, 0, ).toISOString(),
        items: [{ accountId: "acct_plus_outlook", name: "plus-dev", status: "succeeded" }],
      },
    } as AccountWakeBatch,
    {
      id: "wake_0700",
      revision: 1,
      name: "账号 2 · 清晨唤醒",
      time: "07:00",
      timezone: "Asia/Shanghai",
      repeat: "daily",
      accountIds: ["acct_plus_icloud"],
      enabled: true,
      nextRunAt: atClock(7, 0).toISOString(),
    },
    {
      id: "wake_0900",
      revision: 1,
      name: "账号 3 · 上午唤醒",
      time: "09:00",
      timezone: "Asia/Shanghai",
      repeat: "daily",
      accountIds: ["acct_gmail"],
      enabled: true,
      nextRunAt: atClock(9, 0).toISOString(),
    },
  ],
};

// ---------------------------------------------------------------------------
// Display controls (镜头4)
// ---------------------------------------------------------------------------

const displayState: DisplayControlState = {
  preventAutoLock: false,
  dimmed: false,
  brightnessAvailable: true,
  displays: [
    { id: 1, key: "internal-1", name: "内建显示器 1", internal: true, method: "backlight", status: "ready" },
    { id: 2, key: "external-1", name: "外接显示器 1", internal: false, method: "software", status: "ready" },
  ],
  pendingRestores: 0,
};

// ---------------------------------------------------------------------------
// Conversations + threads
// ---------------------------------------------------------------------------

// Feed 时间线按 occurredAt 排序、同刻按 messageId 字典序 tie-break（_a1 会排到 _u1 前）。
// 预烘焙必须给出阶梯时间戳：提问 → 处理 → 工具 → 答案，顺次早于现在。
function buildConversation(threadId: string, steps: { user: string; tools: [string, string, string][]; answer: string }): DemoConversation {
  const conv = new DemoConversation(threadId);
  const turnId = `turn_msg_${threadId}_u1`;
  const runId = `run_${threadId}_1`;
  conv.userMessage(`msg_${threadId}_u1`, steps.user, { occurredAt: iso(-620) });
  conv.startRun(turnId, runId, iso(-600));
  const toolStep = Math.floor(540 / (steps.tools.length + 1));
  steps.tools.forEach(([name, input, output], index) =>
    conv.tool(runId, `tool_${threadId}_${index}`, name, input, output, iso(-600 + (index + 1) * toolStep)),
  );
  conv.finishRun(turnId, runId, { startedAt: iso(-600), endedAt: iso(-60) });
  conv.answer(turnId, `msg_${threadId}_a1`, steps.answer, iso(-60));
  return conv;
}

const conversations = new Map<string, DemoConversation>();
conversations.set(
  "thr_demo_release_verify",
  buildConversation("thr_demo_release_verify", {
    user: "为 Mori 的 Supabase Center 补全设备配对 UI，并加上基础测试。",
    tools: [
      ["read", "src/renderer/SupabaseCenter.tsx", "412 lines"],
      ["apply_patch", "新增 PairingFlow 组件", "+168 −12"],
      ["shell", "bun run test supabase-center", "12 passed"],
    ],
    answer: "配对 UI 已完成：新增 PairingFlow 流程与 12 项测试全部通过。可以进入真机核验。",
  }),
);
conversations.set(
  "thr_perf_diagnosis",
  buildConversation("thr_perf_diagnosis", {
    user: "分析 Feed 滚动的火焰图，找出掉帧原因。",
    tools: [
      ["read", "FeedList.tsx", "890 lines"],
      ["shell", "node scripts/feed-scroll-prof.mjs", "Layout 42% · Recalc 31%"],
    ],
    answer: "瓶颈在 Layout/Recalc：长列表未做窗口化。建议虚拟滚动 + 底部锚定，预计 P95 帧时间从 38ms 降到 12ms。",
  }),
);
conversations.set(
  "thr_ui_prototype",
  buildConversation("thr_ui_prototype", {
    user: "生成产品 UI 原型图，浅色主题。",
    tools: [["image_gen", "product UI prototype, light, minimal", "剩余 4 张"]],
    answer: "已生成产品 UI 原型图：左导航 + 右表单，额度卡置顶。本次使用 Free Account · 图片额度剩余 4/5。",
  }),
);
// 镜头11/12：微信线程用时间线驱动——首次 bootstrap 时按脚本推 user 消息/工具/完成，
// 渲染端轮询 head 追赶，录出来就是"自动新建会话并开始运行"的实况。
const wechatConversation = new DemoConversation("thr_wechat_refactor");
conversations.set("thr_wechat_refactor", wechatConversation);
let wechatTimelineStarted = false;
function startWechatTimeline(): void {
  if (wechatTimelineStarted) return;
  wechatTimelineStarted = true;
  console.log("[demo-storyboard] wechat timeline start");
  const messageId = "msg_thr_wechat_refactor_u1";
  const turnId = `turn_${messageId}`;
  const runId = "run_thr_wechat_refactor_1";
  const at = (ms: number, fn: () => void) => setTimeout(fn, ms);
  at(800, () => wechatConversation.userMessage(messageId, "帮我重构 user-service"));
  at(2200, () => wechatConversation.startRun(turnId, runId));
  at(3600, () => wechatConversation.tool(runId, "tool_thr_wechat_refactor_0", "read", "services/user-service/**", "3 files · 1180 lines"));
  at(5600, () => wechatConversation.tool(runId, "tool_thr_wechat_refactor_1", "apply_patch", "拆分 domain / infra 层", "+240 −186"));
  at(7800, () => wechatConversation.tool(runId, "tool_thr_wechat_refactor_2", "shell", "cargo test -p user-service", "test result: ok. 8 passed"));
  at(9600, () => wechatConversation.finishRun(turnId, runId));
  at(10100, () => wechatConversation.answer(turnId, "msg_thr_wechat_refactor_a1", "✅ 重构完成：已通过 8 项测试，修改 3 个文件。\ncommit: refactor/user-service"));
}

function storyboardThread(input: {
  id: string;
  title: string;
  prompt: string;
  message: string;
  runtimeConfig: ThreadRuntimeConfig;
  status?: ThreadSummary["status"];
}): ThreadSummary {
  return {
    id: input.id,
    title: input.title,
    prompt: input.prompt,
    workspacePath: DEMO_WORKSPACE_PATH,
    status: input.status ?? "completed",
    message: input.message,
    createdAt: iso(-2 * 3600),
    updatedAt: iso(-40 * 60),
    coreKind: "codex",
    runtimeConfig: input.runtimeConfig,
  };
}

// ---------------------------------------------------------------------------
// Model settings with a real OpenAI account binding (composer quota chip)
// ---------------------------------------------------------------------------

const openaiProvider = {
  ...demoProvider,
  id: "openai",
  name: "OpenAI",
  baseUrl: "",
  requestPath: "",
  defaultModel: "gpt-5-codex",
  apiKeyPreview: "ChatGPT Login",
};

const storyboardRouteProfile = {
  id: "storyboard_codex",
  name: "Storyboard · Codex",
  routes: [
    { role: "main" as const, providerId: "openai", modelId: "gpt-5-codex", thinkingEffort: "medium" as const, accountId: "acct_plus_outlook" },
    { role: "explore" as const, providerId: demoProvider.id, modelId: "gpt-5.6-luna", thinkingEffort: "max" as const },
    { role: "architect" as const, providerId: demoProvider.id, modelId: "gpt-5.6-luna", thinkingEffort: "max" as const },
    { role: "coder" as const, providerId: demoProvider.id, modelId: "gpt-5.6-luna", thinkingEffort: "max" as const },
    { role: "reviewer" as const, providerId: demoProvider.id, modelId: "gpt-5.6-luna", thinkingEffort: "max" as const },
    { role: "tester" as const, providerId: demoProvider.id, modelId: "gpt-5.6-luna", thinkingEffort: "max" as const },
  ],
  createdAt: iso(-40 * 24 * 3600),
  updatedAt: iso(),
};

const storyboardBundle = buildResourcesFromRouteProfile(storyboardRouteProfile, {
  mainAgentConfigId: "storyboard.main.config",
  subagentOrchestrationId: "storyboard.subagents",
});

export const storyboardModelSettings = {
  ...demoModelSettings,
  providers: [openaiProvider, ...demoModelSettings.providers],
  routeProfiles: [storyboardRouteProfile, ...demoModelSettings.routeProfiles],
  mainAgentConfigs: [storyboardBundle.mainAgentConfig, ...demoModelSettings.mainAgentConfigs],
  mainAgentPrompts: storyboardBundle.mainAgentPrompt
    ? [storyboardBundle.mainAgentPrompt, ...demoModelSettings.mainAgentPrompts]
    : demoModelSettings.mainAgentPrompts,
  subagentOrchestrations: [storyboardBundle.subagentOrchestration, ...demoModelSettings.subagentOrchestrations],
};

// composer 的额度芯片/账号绑定读的是 selection.mainModel.accountId
// （orchestration-readiness.ts diagnoseOrchestrationSnapshotReadiness → account_missing），
// 光靠 mainAgentConfig.modelRef 不够，必须显式带上。
const storyboardSelection = {
  ...storyboardBundle.selection,
  mainModel: {
    providerId: "openai",
    modelId: "gpt-5-codex",
    accountId: "acct_plus_outlook",
    thinkingEffort: "medium" as const,
  },
};

export const storyboardWorkflowSettings = {
  ...demoWorkflowSettings,
  defaultOrchestrationSelection: storyboardSelection,
};

export const storyboardThreadRuntimeConfig = buildThreadRuntimeConfigFromDefaults({
  settings: storyboardModelSettings,
  workflowDefaults: storyboardWorkflowSettings,
});

/** 镜头6：不同会话绑不同账号/模型，composer 角落显示各自的账号额度。 */
function storyboardThreadRuntimeWith(mainModel: Partial<NonNullable<typeof storyboardSelection.mainModel>>): ThreadRuntimeConfig {
  return buildThreadRuntimeConfigFromDefaults({
    settings: storyboardModelSettings,
    workflowDefaults: {
      ...storyboardWorkflowSettings,
      defaultOrchestrationSelection: {
        ...storyboardSelection,
        mainModel: { ...storyboardSelection.mainModel, ...mainModel },
      },
    },
  });
}

// 镜头6要并行 spinner；镜头9/10 要干净完成态（否则 feed 顶栏显示思考中占位）
const parallelDemo = process.env.ECO_STORYBOARD_IDLE !== "1";

const threads: ThreadSummary[] = [
  storyboardThread({
    id: "thr_demo_release_verify",
    title: "Supabase Center 配对 UI",
    prompt: "为 Mori 的 Supabase Center 补全设备配对 UI，并加上基础测试。",
    message: "配对 UI 已完成，12 项测试通过。",
    runtimeConfig: storyboardThreadRuntimeConfig,
  }),
  storyboardThread({
    id: "thr_perf_diagnosis",
    title: "Feed 滚动性能诊断",
    prompt: "分析 Feed 滚动的火焰图，找出掉帧原因。",
    message: "瓶颈定位在 Layout/Recalc，建议虚拟滚动。",
    runtimeConfig: storyboardThreadRuntimeWith({ accountId: "acct_plus_icloud" }),
    // 镜头6：三个会话并行进行
    status: parallelDemo ? "running" : "completed",
  }),
  storyboardThread({
    id: "thr_ui_prototype",
    title: "生成产品 UI 原型图",
    prompt: "生成产品 UI 原型图，浅色主题。",
    message: "已生成原型图，图片额度剩余 4/5。",
    runtimeConfig: storyboardThreadRuntimeWith({ accountId: "acct_free1", modelId: "gpt-5.6-luna" }),
    status: parallelDemo ? "queued" : "completed",
  }),
  storyboardThread({
    id: "thr_wechat_refactor",
    title: "重构 user-service",
    prompt: "帮我重构 user-service",
    message: "已通过 8 项测试，修改 3 个文件。",
    runtimeConfig: storyboardThreadRuntimeConfig,
  }),
];

// ---------------------------------------------------------------------------
// Scheduled messages (镜头3)
// ---------------------------------------------------------------------------

let scheduleSeq = 0;
const schedules: ScheduleDefinition[] = [];
const occurrences: ScheduleOccurrence[] = [];

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function createStoryboardDemoScene() {
  const handlers: Record<string, (payload?: unknown) => unknown> = {
    [IPC_CHANNELS.modelSettingsGet]: () => storyboardModelSettings,
    [IPC_CHANNELS.workflowSettingsGet]: () => storyboardWorkflowSettings,

    [IPC_CHANNELS.openAIAccountsList]: () => accounts,
    [IPC_CHANNELS.openAIAccountsGetDetails]: (payload): OpenAIAccountDetails | undefined => {
      const account = accounts.find((row) => row.id === idOf(payload));
      if (!account) return undefined;
      return {
        id: account.id,
        name: account.name,
        ...(account.email === undefined ? {} : { email: account.email }),
        proxyMode: account.proxyMode,
        createdAt: account.createdAt,
        updatedAt: iso(),
        authJson: null,
        ...(account.quota === undefined ? {} : { quota: account.quota }),
        ...(account.imageQuota === undefined ? {} : { imageQuota: account.imageQuota }),
        ...(account.imageGenerationEnabled === undefined ? {} : { imageGenerationEnabled: account.imageGenerationEnabled }),
      };
    },
    [IPC_CHANNELS.openAIAccountsQueryQuota]: (payload) => {
      const account = accounts.find((row) => row.id === idOf(payload));
      return account?.quota ?? undefined;
    },
    [IPC_CHANNELS.openAIAccountsImageQuota]: (payload) => {
      const account = accounts.find((row) => row.id === idOf(payload));
      return account?.imageQuota ?? { source: "chatgpt_image_gen", status: "error", fetchedAt: Date.now(), error: "额度未查询" };
    },
    [IPC_CHANNELS.openAIAccountsImageEnabled]: (payload) => {
      const record = (payload ?? {}) as Record<string, unknown>;
      const account = accounts.find((row) => row.id === idOf(payload));
      if (account && typeof record.enabled === "boolean") account.imageGenerationEnabled = record.enabled;
      return accounts;
    },
    [IPC_CHANNELS.openAIAccountsWake]: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1400));
      return { reply: "你好！我是 ChatGPT，很高兴继续为你服务。" };
    },
    [IPC_CHANNELS.openAIAccountsGetWakeModel]: () => null,
    [IPC_CHANNELS.openAIAccountsSetWakeModel]: () => null,
    [IPC_CHANNELS.openAIAccountsWakeBatchesList]: () => wakeBatches,
    [IPC_CHANNELS.openAIAccountsWakeBatchesSave]: (payload) => {
      const record = (payload ?? {}) as Record<string, unknown>;
      const batch = record.batch as AccountWakeBatch | undefined;
      if (batch && !wakeBatches.batches.some((row) => row.id === batch.id)) wakeBatches.batches.push(batch);
      return wakeBatches;
    },
    [IPC_CHANNELS.openAIAccountsWakeBatchesRun]: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1400));
      return { ok: true, runs: [] };
    },

    [IPC_CHANNELS.displayControlGet]: () => displayState,
    [IPC_CHANNELS.displayControlSet]: (payload) => {
      const change = (payload ?? {}) as DisplayControlChange;
      if (change.control === "preventAutoLock") displayState.preventAutoLock = change.enabled;
      if (change.control === "dimmed") {
        displayState.dimmed = change.enabled;
        displayState.displays = displayState.displays.map((monitor) =>
          monitor.method ? { ...monitor, status: change.enabled ? "dimmed" : "ready" } : monitor,
        );
      }
      return displayState;
    },

    [IPC_CHANNELS.schedulingList]: () => ({ schedules, occurrences }),
    [IPC_CHANNELS.schedulingCreate]: (payload) => {
      const input = payload as ScheduleCreateInput;
      scheduleSeq += 1;
      const nextRunAt =
        input?.trigger?.type === "at" ? input.trigger.at : new Date(Date.now() + 3.5 * 3600 * 1000).toISOString();
      const definition: ScheduleDefinition = {
        id: `sch_storyboard_${scheduleSeq}`,
        kind: input?.kind ?? "session_message",
        name: input?.name?.trim() || (input && "prompt" in input ? String(input.prompt).split("\n", 1).join("") : "定时消息"),
        prompt: input && "prompt" in input ? String(input.prompt) : "",
        trigger: input?.trigger ?? { type: "at", at: nextRunAt },
        enabled: true,
        maxLatenessSeconds: input?.maxLatenessSeconds ?? 0,
        source: "user",
        ...("threadId" in input ? { originThreadId: input.threadId, threadId: input.threadId } : {}),
        ...(input.kind === "scheduled_task"
          ? { workspacePath: input.workspacePath, executionProfile: input.executionProfile }
          : {}),
        revision: 1,
        nextRunAt,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        creationSignature: input?.requestId,
      };
      schedules.push(definition);
      return { definition, schedules };
    },
    [IPC_CHANNELS.schedulingUpdate]: (payload) => {
      const record = (payload ?? {}) as Record<string, unknown>;
      const schedule = schedules.find((row) => row.id === record.id);
      if (schedule && typeof record.enabled === "boolean") schedule.enabled = record.enabled;
      return { definition: schedule, schedules };
    },
    [IPC_CHANNELS.schedulingDelete]: (payload) => {
      const id = idOf(payload);
      const index = schedules.findIndex((row) => row.id === id);
      if (index >= 0) schedules.splice(index, 1);
      return { ok: true, schedules };
    },

    [IPC_CHANNELS.conversationCapabilities]: () => emptyConversation("").capabilities(),
    [IPC_CHANNELS.conversationBootstrap]: (payload) => {
      const id = convIdOf(payload);
      if (id === "thr_wechat_refactor") startWechatTimeline();
      return (conversations.get(id) ?? emptyConversation(id)).bootstrap();
    },
    [IPC_CHANNELS.conversationHead]: (payload) => {
      const id = convIdOf(payload);
      return (conversations.get(id) ?? emptyConversation(id)).head();
    },
    [IPC_CHANNELS.conversationMessagesPage]: (payload) => {
      const id = convIdOf(payload);
      return (conversations.get(id) ?? emptyConversation(id)).messagesPage();
    },
    [IPC_CHANNELS.conversationToolsPage]: (payload) => {
      const id = convIdOf(payload);
      const record = (payload ?? {}) as Record<string, unknown>;
      return (conversations.get(id) ?? emptyConversation(id)).toolsPage(
        typeof record.runId === "string" ? record.runId : "",
      );
    },
    [IPC_CHANNELS.conversationDetailsPage]: (payload) => {
      const id = convIdOf(payload);
      return (conversations.get(id) ?? emptyConversation(id)).detailsPage();
    },
    [IPC_CHANNELS.conversationSync]: (payload) => {
      const id = convIdOf(payload);
      const record = (payload ?? {}) as Record<string, unknown>;
      return (conversations.get(id) ?? emptyConversation(id)).syncPage(
        typeof record.afterSeq === "number" ? record.afterSeq : 0,
        typeof record.throughSeq === "number" ? record.throughSeq : Number.MAX_SAFE_INTEGER,
      );
    },
    [IPC_CHANNELS.conversationProjection]: () => ({ requestSpans: [] }),
    [IPC_CHANNELS.conversationSendMessage]: (payload) => {
      const id = convIdOf(payload);
      const conv = conversations.get(id);
      if (!conv) {
        return {
          error: "conversation_not_found",
          protocolVersion: CONVERSATION_V2_PROTOCOL_VERSION,
          conversationId: id,
        };
      }
      return conv.sendMessage(payload);
    },
  };

  return { threads, handlers };
}
