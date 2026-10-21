import type { AgentResourceAgentFormState } from "../src/renderer/agent-resource-form";
import { CODING_AGENT_TEMPLATE_IDS, resolveAgentTemplateCatalog } from "../src/shared/agent-orchestration";
import type {
  ProviderConfigView,
  ThreadBillingSnapshot,
  ThreadRunProjectionAgent,
  ThreadRunProjectionSnapshot,
  ThreadRunProjectionTimelineItem,
} from "../src/shared/ipc";

export const demoProvider: ProviderConfigView = {
  id: "provider_mycodex",
  name: "MyCodex",
  baseUrl: "https://api.example.com",
  requestPath: "",
  version: "v1",
  apiCompat: "openai_responses",
  defaultModel: "gpt-5.6-luna",
  enabled: true,
  hasApiKey: true,
  apiKeyPreview: "sk-demo••••",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

export const demoTemplates = resolveAgentTemplateCatalog();

function agentForm(
  input: Partial<AgentResourceAgentFormState> & Pick<AgentResourceAgentFormState, "agentKey" | "templateId">,
): AgentResourceAgentFormState {
  return {
    agentKey: input.agentKey,
    templateId: input.templateId,
    displayName: input.displayName ?? "",
    themeColor: input.themeColor ?? "#6366f1",
    providerId: input.providerId ?? demoProvider.id,
    modelId: input.modelId ?? "gpt-5.6-luna",
    thinkingEffort: input.thinkingEffort ?? "max",
    apiCompat: input.apiCompat ?? "openai_responses",
    enabled: input.enabled ?? true,
    candidateModelId: input.candidateModelId ?? "luna-max",
    v4aTeachingEnabled: false,
    readCodebase: true,
    readScope: "workspace",
    writeCodebase: true,
    bash: true,
    network: false,
    skill: true,
    askUser: false,
    taskProgress: true,
  };
}

export const demoRosterAgents: AgentResourceAgentFormState[] = [
  agentForm({
    agentKey: "eco_explore",
    templateId: CODING_AGENT_TEMPLATE_IDS.explore,
    displayName: "Explore",
    themeColor: "#22c55e",
  }),
  agentForm({
    agentKey: "coder_a",
    templateId: CODING_AGENT_TEMPLATE_IDS.coder,
    displayName: "Coder",
    themeColor: "#3b82f6",
  }),
  agentForm({
    agentKey: "tester_a",
    templateId: CODING_AGENT_TEMPLATE_IDS.tester,
    displayName: "Tester",
    themeColor: "#f59e0b",
  }),
];

function timelineItem(
  input: Partial<ThreadRunProjectionTimelineItem> & Pick<ThreadRunProjectionTimelineItem, "id">,
): ThreadRunProjectionTimelineItem {
  return {
    id: input.id,
    sequence: input.sequence ?? 1,
    eventType: input.eventType ?? "tool.started",
    scope: input.scope ?? "main",
    role: input.role ?? "main",
    text: input.text ?? "",
    at: input.at ?? "2026-08-10T10:00:00.000Z",
    ...(input.runAttemptId && { runAttemptId: input.runAttemptId }),
    ...(input.requestId && { requestId: input.requestId }),
    ...(input.metadata && { metadata: input.metadata }),
  };
}

function subagent(
  input: Partial<ThreadRunProjectionAgent> & Pick<ThreadRunProjectionAgent, "agentId">,
): ThreadRunProjectionAgent {
  return {
    agentId: input.agentId,
    role: input.role ?? "coder",
    kind: "subagent",
    status: input.status ?? "completed",
    startedAt: input.startedAt ?? "2026-08-10T10:01:00.000Z",
    endedAt: input.endedAt ?? "2026-08-10T10:04:30.000Z",
    durationMs: input.durationMs ?? 210_000,
    timeline: input.timeline ?? [],
    ...(input.taskName && { taskName: input.taskName }),
    ...(input.delegationPrompt && { delegationPrompt: input.delegationPrompt }),
    ...(input.nickname && { nickname: input.nickname }),
  };
}

export const demoProductOverviewProjection: ThreadRunProjectionSnapshot = {
  thread: {
    threadId: "thr_readme_demo",
    status: "completed",
    generatedAt: "2026-08-10T10:05:00.000Z",
  },
  attempts: [
    {
      attemptId: "attempt_demo_1",
      phase: "execution",
      retryIndex: 0,
      status: "completed",
      startedAt: "2026-08-10T10:00:00.000Z",
      endedAt: "2026-08-10T10:05:00.000Z",
    },
  ],
  requestSpans: [],
  agents: [
    subagent({
      agentId: "agent_explore",
      role: "explore",
      status: "completed",
      nickname: "Scout",
      taskName: "scan_auth_flow",
      runAttemptId: "attempt_demo_1",
      parentToolUseId: "toolu_explore",
      delegationPrompt: "梳理登录与 Supabase Center 配对相关代码路径，列出关键文件。",
      durationMs: 72_000,
      timeline: [],
    }),
    subagent({
      agentId: "agent_coder",
      role: "coder",
      status: "completed",
      nickname: "Builder",
      taskName: "implement_pairing_ui",
      runAttemptId: "attempt_demo_1",
      parentToolUseId: "toolu_coder",
      delegationPrompt: "根据 Explore 结果，补全 Center 设置页的设备列表与授权码展示。",
      durationMs: 118_000,
      timeline: [],
    }),
    subagent({
      agentId: "agent_tester",
      role: "tester",
      status: "completed",
      nickname: "Verifier",
      taskName: "verify_pairing_flow",
      runAttemptId: "attempt_demo_1",
      parentToolUseId: "toolu_tester",
      delegationPrompt: "为配对创建/加入流程补 smoke 测试，覆盖错误提示与成功路径。",
      durationMs: 95_000,
      timeline: [],
    }),
  ],
  timeline: [
    timelineItem({
      id: "user-prompt",
      sequence: 1,
      eventType: "thread.status",
      role: "user",
      runAttemptId: "attempt_demo_1",
      text: "为 Eco Coding 的 Supabase Center 补全设备配对 UI，并加上基础测试。主代理用 Sol 规划，Explore/Coder/Tester 用 Luna max。",
      metadata: { liveType: "thread.user_prompt" },
    }),
    timelineItem({
      id: "planner-summary",
      sequence: 2,
      eventType: "message.final",
      role: "main",
      runAttemptId: "attempt_demo_1",
      text: "我会先让 Explore 梳理认证与配对链路，再并行委派 Coder 实现 UI、Tester 补 smoke。完成后统一验收 diff 与测试结果。",
    }),
    timelineItem({
      id: "planner-final",
      sequence: 3,
      eventType: "message.final",
      role: "main",
      runAttemptId: "attempt_demo_1",
      text: "三个子代理已完成：Explore 列出配对链路，Coder 更新 Center 设置页，Tester 补 smoke。可以开始验收。",
    }),
  ],
  diagnostics: [],
  sourceEventCount: 6,
};

export const demoBillingSnapshot: ThreadBillingSnapshot = {
  plannerModelLabel: "gpt-5.6-sol · MyCodex",
  totalTokens: {
    input: 42_000,
    output: 8_400,
    cacheRead: 186_000,
    cacheCreation: 12_000,
  },
  sourceReportedCostUsd: 0.52,
  plannerTokenCostUsd: 0.31,
  ecoCostUsd: 0.4875,
  savedUsd: 1.5989,
  savedPct: 76.6,
  pricingResolved: true,
  primarySource: "proxy",
  displaySource: "proxy",
  byRole: {
    main: {
      inputTokens: 18_000,
      outputTokens: 2_200,
      cacheReadTokens: 48_000,
      cacheCreationTokens: 4_000,
      ecoCostUsd: 0.31,
      modelId: "gpt-5.6-sol",
    },
    explore: {
      inputTokens: 8_000,
      outputTokens: 1_800,
      cacheReadTokens: 46_000,
      cacheCreationTokens: 2_800,
      ecoCostUsd: 0.0625,
      modelId: "gpt-5.6-luna",
    },
    coder: {
      inputTokens: 10_000,
      outputTokens: 2_600,
      cacheReadTokens: 52_000,
      cacheCreationTokens: 3_200,
      ecoCostUsd: 0.075,
      modelId: "gpt-5.6-luna",
    },
    tester: {
      inputTokens: 6_000,
      outputTokens: 1_800,
      cacheReadTokens: 40_000,
      cacheCreationTokens: 2_000,
      ecoCostUsd: 0.04,
      modelId: "gpt-5.6-luna",
    },
  },
  subagents: [
    {
      agentId: "agent_explore",
      role: "explore",
      status: "completed",
      inputTokens: 8_000,
      outputTokens: 1_800,
      cacheReadTokens: 46_000,
      cacheCreationTokens: 2_800,
      ecoCostUsd: 0.0625,
      modelId: "gpt-5.6-luna",
    },
    {
      agentId: "agent_coder",
      role: "coder",
      status: "completed",
      inputTokens: 10_000,
      outputTokens: 2_600,
      cacheReadTokens: 52_000,
      cacheCreationTokens: 3_200,
      ecoCostUsd: 0.075,
      modelId: "gpt-5.6-luna",
    },
    {
      agentId: "agent_tester",
      role: "tester",
      status: "completed",
      inputTokens: 6_000,
      outputTokens: 1_800,
      cacheReadTokens: 40_000,
      cacheCreationTokens: 2_000,
      ecoCostUsd: 0.04,
      modelId: "gpt-5.6-luna",
    },
  ],
};

export const demoAgentDisplayNames = {
  main: "Main agent",
  explore: "Explore",
  coder: "Coder",
  tester: "Tester",
};
