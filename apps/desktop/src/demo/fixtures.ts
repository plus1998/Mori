import { buildResourcesFromRouteProfile, resolveAgentTemplateCatalog } from "../shared/agent-orchestration";
import type {
  CandidateModelView,
  CenterServerSettingsSnapshot,
  CoreAvailabilitySnapshot,
  GitSettingsSnapshot,
  GitWorkingTreeStatus,
  IntegratedWebSearchSettingsSnapshot,
  McpSettingsSnapshot,
  ModelSettingsSnapshot,
  PersonalizationSettingsSnapshot,
  ProviderConfigView,
  ProxyBridgeSettingsSnapshot,
  RouteProfileView,
  ThreadBillingSnapshot,
  ThreadContextSnapshot,
  ThreadRunProjectionAgent,
  ThreadRunProjectionSnapshot,
  ThreadRunProjectionTimelineItem,
  ThreadSessionBootstrapResult,
  ThreadSubagentMetricsSummary,
  ThreadSubagentSessionTiming,
  ThreadSummary,
  WorkflowSettingsSnapshot,
  WorkspaceInfo,
} from "../shared/ipc";
import { buildThreadRuntimeConfigFromDefaults } from "../shared/thread-runtime-config";
import {
  DEMO_HOME_PROJECT_PATH,
  DEMO_THREAD_ID,
  DEMO_WORKSPACE_NAME,
  DEMO_WORKSPACE_PATH,
} from "./constants";

const NOW = new Date(Date.now() - 5 * 60_000).toISOString();
const T_PLAN = new Date(Date.now() - 4 * 60_000).toISOString();
const T_EXPLORE = new Date(Date.now() - 3.5 * 60_000).toISOString();
const T_CODER = new Date(Date.now() - 3 * 60_000).toISOString();
const T_TESTER = new Date(Date.now() - 2 * 60_000).toISOString();
const T_FINAL = new Date(Date.now() - 1 * 60_000).toISOString();

export const demoProvider: ProviderConfigView = {
  id: "demo_mycodex",
  name: "MyCodex",
  baseUrl: "https://api.example.com",
  requestPath: "",
  version: "v1",
  apiCompat: "openai_responses",
  defaultModel: "gpt-5.6-luna",
  enabled: true,
  hasApiKey: true,
  apiKeyPreview: "sk-demo••••",
  createdAt: NOW,
  updatedAt: NOW,
};

export const demoRouteProfile: RouteProfileView = {
  id: "demo_release_team",
  name: "发布核验 · Demo Team",
  routes: [
    { role: "planner", providerId: demoProvider.id, modelId: "gpt-5.6-sol", thinkingEffort: "high" },
    { role: "explore", providerId: demoProvider.id, modelId: "gpt-5.6-luna", thinkingEffort: "max" },
    { role: "architect", providerId: demoProvider.id, modelId: "gpt-5.6-luna", thinkingEffort: "max" },
    { role: "coder", providerId: demoProvider.id, modelId: "gpt-5.6-luna", thinkingEffort: "max" },
    { role: "reviewer", providerId: demoProvider.id, modelId: "gpt-5.6-luna", thinkingEffort: "max" },
    { role: "tester", providerId: demoProvider.id, modelId: "gpt-5.6-luna", thinkingEffort: "max" },
  ],
  createdAt: NOW,
  updatedAt: NOW,
};

const demoBundle = buildResourcesFromRouteProfile(demoRouteProfile, {
  mainAgentConfigId: "demo.main.config",
  subagentOrchestrationId: "demo.subagents",
});

export const demoModelSettings: ModelSettingsSnapshot = {
  providers: [demoProvider],
  routeProfiles: [demoRouteProfile],
  agentTemplates: resolveAgentTemplateCatalog(),
  mainAgentConfigs: [demoBundle.mainAgentConfig],
  mainAgentPrompts: demoBundle.mainAgentPrompt ? [demoBundle.mainAgentPrompt] : [],
  subagentOrchestrations: [demoBundle.subagentOrchestration],
  mcpSettings: { servers: [] },
};

export const demoWorkflowSettings: WorkflowSettingsSnapshot = {
  sessionMode: "agent",
  contextWindowLimitTokens: 262_144,
  maxOutputLimitTokens: "dynamic",
  followUpDeliveryMode: "steer",
  defaultCoreKind: "codex",
  defaultOrchestrationSelection: demoBundle.selection,
  showBilling: true,
};

export const demoThreadRuntimeConfig = buildThreadRuntimeConfigFromDefaults({
  settings: demoModelSettings,
  workflowDefaults: demoWorkflowSettings,
});

export const demoThreads: ThreadSummary[] = [
  {
    id: DEMO_THREAD_ID,
    title: "Supabase Center 配对 UI",
    prompt:
      "为 Eco Coding 的 Supabase Center 补全设备配对 UI，并加上基础测试。主代理用 Sol 规划，Explore/Coder/Tester 用 Luna max。",
    workspacePath: DEMO_WORKSPACE_PATH,
    status: "completed",
    createdAt: NOW,
    updatedAt: T_FINAL,
    message: "三个子代理已完成，可以开始验收。",
    coreKind: "codex",
    coreLockedAt: NOW,
    runtimeConfig: demoThreadRuntimeConfig,
  },
  {
    id: "thr_demo_table_preview",
    title: "表格预览交互优化",
    prompt: "优化 Feed 表格预览横屏与复制体验。",
    workspacePath: DEMO_WORKSPACE_PATH,
    status: "completed",
    createdAt: "2026-08-30T12:00:00.000Z",
    updatedAt: "2026-08-30T14:20:00.000Z",
    message: "已完成横屏视口与复制菜单。",
    coreKind: "pi",
    coreLockedAt: "2026-08-30T12:05:00.000Z",
  },
];

export const demoWorkspace: WorkspaceInfo = {
  path: DEMO_WORKSPACE_PATH,
  name: DEMO_WORKSPACE_NAME,
  isGitRepository: true,
  hasGitCommits: true,
  gitRoot: DEMO_WORKSPACE_PATH,
  branch: "beta",
  dirtyFileCount: 0,
  packageManager: "bun",
};

export const demoCandidateModels: CandidateModelView[] = [
  {
    id: "cand_demo_sol",
    providerId: demoProvider.id,
    modelId: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    sortOrder: 0,
    resolvedSupportsReasoning: true,
    resolvedContextTokens: 262_144,
    resolvedMaxOutputTokens: 32_768,
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    id: "cand_demo_luna",
    providerId: demoProvider.id,
    modelId: "gpt-5.6-luna",
    displayName: "GPT-5.6 Luna",
    sortOrder: 1,
    resolvedSupportsReasoning: true,
    resolvedContextTokens: 262_144,
    resolvedMaxOutputTokens: 32_768,
    createdAt: NOW,
    updatedAt: NOW,
  },
];

function subagentTimeline(
  agentId: string,
  role: ThreadRunProjectionAgent["role"],
  startedAt: string,
  lines: string[],
): ThreadRunProjectionTimelineItem[] {
  const startMs = Date.parse(startedAt);
  return lines.map((text, index) =>
    timelineItem({
      id: `${agentId}-msg-${index + 1}`,
      sequence: index + 1,
      eventType: "message.final",
      scope: "agent",
      role,
      agentId,
      text,
      at: new Date(startMs + (index + 1) * 20_000).toISOString(),
      streamKey: `${agentId}:block:${index + 1}`,
    }),
  );
}

function timelineItem(
  input: Partial<ThreadRunProjectionTimelineItem> & Pick<ThreadRunProjectionTimelineItem, "id">,
): ThreadRunProjectionTimelineItem {
  return {
    id: input.id,
    sequence: input.sequence ?? 1,
    eventType: input.eventType ?? "tool.started",
    scope: input.scope ?? "main",
    role: input.role ?? "planner",
    text: input.text ?? "",
    at: input.at ?? NOW,
    ...(input.runAttemptId && { runAttemptId: input.runAttemptId }),
    ...(input.requestId && { requestId: input.requestId }),
    ...(input.agentId && { agentId: input.agentId }),
    ...(input.streamKey && { streamKey: input.streamKey }),
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
    status: input.status ?? "stopped",
    startedAt: input.startedAt ?? T_EXPLORE,
    endedAt: input.endedAt ?? T_FINAL,
    durationMs: input.durationMs ?? 210_000,
    timeline: input.timeline ?? [],
    ...(input.taskName && { taskName: input.taskName }),
    ...(input.delegationPrompt && { delegationPrompt: input.delegationPrompt }),
    ...(input.nickname && { nickname: input.nickname }),
    ...(input.runAttemptId && { runAttemptId: input.runAttemptId }),
    ...(input.parentToolUseId && { parentToolUseId: input.parentToolUseId }),
  };
}

export const demoRunProjection: ThreadRunProjectionSnapshot = {
  thread: {
    threadId: DEMO_THREAD_ID,
    status: "completed",
    generatedAt: T_FINAL,
  },
  attempts: [
    {
      attemptId: "attempt_demo_1",
      phase: "execution",
      retryIndex: 0,
      status: "completed",
      startedAt: NOW,
      endedAt: T_FINAL,
    },
  ],
  requestSpans: [],
  agents: [
    subagent({
      agentId: "agent_explore",
      role: "explore",
      nickname: "Scout",
      taskName: "scan_auth_flow",
      runAttemptId: "attempt_demo_1",
      parentToolUseId: "toolu_explore",
      delegationPrompt: "梳理登录与 Supabase Center 配对相关代码路径，列出关键文件。",
      startedAt: T_EXPLORE,
      endedAt: T_EXPLORE,
      durationMs: 72_000,
      timeline: subagentTimeline("agent_explore", "explore", T_EXPLORE, [
        "已定位 `CenterServerSettingsPanel` 与 `device-pairing` 路由。",
        "配对状态来自 `centerServerSettingsGet`，需补设备列表 UI。",
      ]),
    }),
    subagent({
      agentId: "agent_coder",
      role: "coder",
      nickname: "Builder",
      taskName: "implement_pairing_ui",
      runAttemptId: "attempt_demo_1",
      parentToolUseId: "toolu_coder",
      delegationPrompt: "根据 Explore 结果，补全 Center 设置页的设备列表与授权码展示。",
      startedAt: T_CODER,
      endedAt: T_CODER,
      durationMs: 118_000,
      timeline: subagentTimeline("agent_coder", "coder", T_CODER, [
        "新增 `DevicePairingList` 组件，展示 pending / active 设备。",
        "授权码采用 6 位分组显示，并加复制按钮。",
      ]),
    }),
    subagent({
      agentId: "agent_tester",
      role: "tester",
      nickname: "Verifier",
      taskName: "verify_pairing_flow",
      runAttemptId: "attempt_demo_1",
      parentToolUseId: "toolu_tester",
      delegationPrompt: "为配对创建/加入流程补 smoke 测试，覆盖错误提示与成功路径。",
      startedAt: T_TESTER,
      endedAt: T_TESTER,
      durationMs: 95_000,
      timeline: subagentTimeline("agent_tester", "tester", T_TESTER, [
        "补 `center-pairing.smoke.test.ts`，覆盖无效码与成功配对。",
        "Mock IPC 返回 disconnected / paired 两种状态。",
      ]),
    }),
  ],
  timeline: [
    timelineItem({
      id: "user-prompt",
      sequence: 1,
      eventType: "thread.status",
      role: "user",
      runAttemptId: "attempt_demo_1",
      at: NOW,
      text: demoThreads[0]?.prompt ?? "",
      metadata: { liveType: "thread.user_prompt" },
    }),
    timelineItem({
      id: "planner-summary",
      sequence: 2,
      eventType: "message.final",
      role: "planner",
      runAttemptId: "attempt_demo_1",
      at: T_PLAN,
      streamKey: "planner:block:plan",
      text: "我会先让 Explore 梳理认证与配对链路，再并行委派 Coder 实现 UI、Tester 补 smoke。完成后统一验收 diff 与测试结果。",
    }),
    timelineItem({
      id: "tool-explore-start",
      sequence: 3,
      eventType: "tool.started",
      role: "planner",
      runAttemptId: "attempt_demo_1",
      at: T_EXPLORE,
      text: "Explore",
      metadata: {
        tool: { name: "Agent", toolUseId: "toolu_explore", status: "completed" },
        subagent: "explore",
        agentId: "agent_explore",
      },
    }),
    timelineItem({
      id: "tool-coder-start",
      sequence: 4,
      eventType: "tool.started",
      role: "planner",
      runAttemptId: "attempt_demo_1",
      at: T_CODER,
      text: "Coder",
      metadata: {
        tool: { name: "Agent", toolUseId: "toolu_coder", status: "completed" },
        subagent: "coder",
        agentId: "agent_coder",
      },
    }),
    timelineItem({
      id: "tool-tester-start",
      sequence: 5,
      eventType: "tool.started",
      role: "planner",
      runAttemptId: "attempt_demo_1",
      at: T_TESTER,
      text: "Tester",
      metadata: {
        tool: { name: "Agent", toolUseId: "toolu_tester", status: "completed" },
        subagent: "tester",
        agentId: "agent_tester",
      },
    }),
    timelineItem({
      id: "planner-final",
      sequence: 6,
      eventType: "message.final",
      role: "planner",
      runAttemptId: "attempt_demo_1",
      at: T_FINAL,
      streamKey: "planner:block:final",
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
  byRole: {
    planner: {
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
};

export const demoContextSnapshot: ThreadContextSnapshot = {
  occupied: 48_000,
  limit: 262_144,
  occupancyPct: 18,
  limitsResolved: true,
  segments: [],
  updatedAt: Date.parse(T_FINAL),
};

export const demoSubagentSessions: ThreadSubagentSessionTiming[] = [
  {
    agentId: "agent_explore",
    role: "explore",
    status: "stopped",
    startedAt: T_EXPLORE,
    lastActiveAt: T_EXPLORE,
    endedAt: T_EXPLORE,
    accumulatedMs: 72_000,
    durationMs: 72_000,
  },
  {
    agentId: "agent_coder",
    role: "coder",
    status: "stopped",
    startedAt: T_CODER,
    lastActiveAt: T_CODER,
    endedAt: T_CODER,
    accumulatedMs: 118_000,
    durationMs: 118_000,
  },
  {
    agentId: "agent_tester",
    role: "tester",
    status: "stopped",
    startedAt: T_TESTER,
    lastActiveAt: T_TESTER,
    endedAt: T_TESTER,
    accumulatedMs: 95_000,
    durationMs: 95_000,
  },
];

export const demoSubagentMetrics: ThreadSubagentMetricsSummary[] = [
  {
    agentId: "agent_explore",
    role: "explore",
    status: "stopped",
    inputTokens: 8_000,
    outputTokens: 1_800,
    cacheReadTokens: 46_000,
    cacheCreationTokens: 2_800,
    contextOccupied: 12_000,
    contextLimit: 262_144,
    ecoCostUsd: 0.0625,
    modelId: "gpt-5.6-luna",
  },
  {
    agentId: "agent_coder",
    role: "coder",
    status: "stopped",
    inputTokens: 10_000,
    outputTokens: 2_600,
    cacheReadTokens: 52_000,
    cacheCreationTokens: 3_200,
    contextOccupied: 18_000,
    contextLimit: 262_144,
    ecoCostUsd: 0.075,
    modelId: "gpt-5.6-luna",
  },
  {
    agentId: "agent_tester",
    role: "tester",
    status: "stopped",
    inputTokens: 6_000,
    outputTokens: 1_800,
    cacheReadTokens: 40_000,
    cacheCreationTokens: 2_000,
    contextOccupied: 10_000,
    contextLimit: 262_144,
    ecoCostUsd: 0.04,
    modelId: "gpt-5.6-luna",
  },
];

export const demoCoreAvailability: CoreAvailabilitySnapshot = {
  codex: { available: true, version: "0.163.0" },
  claude: { available: true, version: "0.3.301" },
  pi: { available: true, version: "2.23.0" },
  cursor: { available: false, reason: "演示模式未启用 Cursor ACP" },
};

export const demoMcpSettings: McpSettingsSnapshot = { servers: [] };

export const demoCenterServerSettings: CenterServerSettingsSnapshot = {
  settings: {
    enabled: false,
    supabaseUrl: "",
    serverUrl: "",
    hasAnonKey: false,
    deviceName: "Eco Demo Desktop",
    hasDeviceSecret: false,
    hasRefreshToken: false,
    hasVaultKey: false,
  },
  status: {
    state: "disabled",
  },
};

export const demoProxyBridgeSettings: ProxyBridgeSettingsSnapshot = {};

export const demoIntegratedWebSearchSettings: IntegratedWebSearchSettingsSnapshot = {
  enabled: false,
  provider: "tavily",
  hasApiKey: false,
  approvalMode: "always_allow",
};

export const demoGitSettings: GitSettingsSnapshot = {
  commitMessageRoleByMainAgentConfigId: {},
  commitMessageCandidateModelIdByMainAgentConfigId: {},
};

export const demoPersonalizationSettings: PersonalizationSettingsSnapshot = {
  globalRules: "",
};

export const demoGitStatus: GitWorkingTreeStatus = {
  workspacePath: DEMO_WORKSPACE_PATH,
  isGitRepository: true,
  hasGitCommits: true,
  branch: "beta",
  branches: ["beta", "main"],
  dirtyFileCount: 0,
  insertions: 0,
  deletions: 0,
  canCommit: false,
  aheadCount: 0,
  behindCount: 0,
  hasUpstream: true,
  gh: { available: false, authenticated: false },
};

export const demoWorkspaceInspect: WorkspaceInfo = demoWorkspace;

export function buildDemoSessionBootstrap(threadId: string): ThreadSessionBootstrapResult {
  const thread = demoThreads.find((entry) => entry.id === threadId);
  return {
    ...(thread ? { thread } : {}),
    followUps: [],
  };
}

export function resolveDemoThreadId(payload: unknown): string | undefined {
  if (typeof payload === "string") {
    return payload;
  }
  if (payload && typeof payload === "object" && "threadId" in payload) {
    const threadId = (payload as { threadId?: unknown }).threadId;
    return typeof threadId === "string" ? threadId : undefined;
  }
  return undefined;
}

export { DEMO_HOME_PROJECT_PATH, DEMO_THREAD_ID, DEMO_WORKSPACE_PATH };
