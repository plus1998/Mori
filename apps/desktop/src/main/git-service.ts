import { buildCommitModelOptions } from "../shared/commit-model-options";
import type {
  CommitModelOptionView,
  GitCommitRequest,
  GitCommitResult,
  GitGenerateCommitMessageRequest,
  GitGenerateCommitMessageResult,
  GitListCommitModelOptionsRequest,
  GitListCommitModelOptionsResult,
  GitPullRequest,
  GitPullResult,
  GitPushRequest,
  GitPushResult,
  GitSaveCommitModelPreferenceRequest,
  GitSaveCommitModelPreferenceResult,
  RuntimeAgentRole,
} from "../shared/ipc";
import {
  type CommitMessageModelPreference,
  listCommitMessageCandidateModels,
} from "../shared/resolve-commit-message-route";
import type { AgentOrchestrationStore } from "./agent-orchestration-store";
import { type AnthropicProxyRoute, runtimeRouteToProxyRoute } from "./anthropic-proxy";
import { lookupCommitModelPricingHints, type RuntimeRoute } from "./billing-resolver";
import { summarizeCommitMessage } from "./git-commit-message";
import {
  checkoutGitBranch,
  collectCommitDiffContext,
  createCommit,
  createGitBranch,
  defaultGitRunner,
  discardWorkspaceChanges,
  fetchFromOrigin,
  type GitRunner,
  getGitWorkingTreeStatus,
  getWorkspaceDiff,
  getWorkspaceFileDiff,
  listGitCommits,
  pullChanges,
  pushChanges,
  stageChanges,
} from "./git-operations";
import type { GitSettingsStore } from "./git-settings-store";
import type { ModelsDevPricingCache } from "./models-dev-pricing-cache";
import type { ProviderStore } from "./provider-store";
import { logUpstreamError } from "./upstream-log";
import type { WorkflowSettingsStore } from "./workflow-settings-store";

const COMMIT_MESSAGE_ROLE: RuntimeAgentRole = "explore";

async function listCommitCandidates(input: { providerStore: ProviderStore }) {
  const providers = input.providerStore.listProvidersWithSecrets();
  return listCommitMessageCandidateModels(providers, (providerId) =>
    input.providerStore.listCandidateModels(providerId),
  );
}

async function resolveSavedCommitCandidateModel(input: {
  mainAgentConfigId?: string;
  candidateModelIdPreference?: CommitMessageModelPreference;
  gitSettingsStore: GitSettingsStore;
  providerStore: ProviderStore;
  agentOrchestrationStore: AgentOrchestrationStore;
  pricingCache: ModelsDevPricingCache;
}) {
  const candidates = await listCommitCandidates({ providerStore: input.providerStore });
  if (candidates.length === 0) {
    throw new Error("没有已配置的候选模型，无法生成提交信息。请在 Provider 设置中添加候选模型。");
  }
  const providers = input.providerStore.listProvidersWithSecrets();
  const hints = await lookupCommitModelPricingHints(
    input.pricingCache,
    providers,
    candidates.map((candidate) => ({
      candidateModelId: candidate.candidateModelId,
      providerId: candidate.providerId,
      providerName: candidate.providerName,
      modelId: candidate.modelId,
      ...(candidate.modelsDevMapping ? { modelsDevMapping: candidate.modelsDevMapping } : {}),
      ...(candidate.manualSpec ? { manualSpec: candidate.manualSpec } : {}),
    })),
  );
  const savedCandidateModelId = input.candidateModelIdPreference;
  if (!savedCandidateModelId || savedCandidateModelId === "auto") {
    throw new Error("未指定 Git 提交模型，无法生成提交信息。请在提交窗口中选择生成模型。");
  }
  const selected = candidates.find((candidate) => candidate.candidateModelId === savedCandidateModelId);
  if (!selected) {
    throw new Error(`Git 提交模型已不在候选模型列表中：${savedCandidateModelId}`);
  }
  return { selected, hints, candidates };
}

async function resolveCommitProxyRoute(input: {
  mainAgentConfigId?: string;
  candidateModelIdPreference?: CommitMessageModelPreference;
  providerStore: ProviderStore;
  agentOrchestrationStore: AgentOrchestrationStore;
  gitSettingsStore: GitSettingsStore;
  pricingCache: ModelsDevPricingCache;
}): Promise<{ route: AnthropicProxyRoute; candidateModelId: string }> {
  const { selected } = await resolveSavedCommitCandidateModel(input);
  const provider = input.providerStore
    .listProvidersWithSecrets()
    .find((entry) => entry.id === selected.providerId);
  if (!provider) {
    throw new Error(`候选模型所属 Provider 未配置或已禁用：${selected.providerName}`);
  }
  const runtimeRoute: RuntimeRoute = {
    role: COMMIT_MESSAGE_ROLE,
    provider,
    modelId: selected.modelId,
    apiCompat: provider.apiCompat,
    ...(selected.manualSpec ? { manualSpec: selected.manualSpec } : {}),
    ...(selected.modelsDevMapping ? { modelsDevMapping: selected.modelsDevMapping } : {}),
  };
  return {
    route: runtimeRouteToProxyRoute(runtimeRoute),
    candidateModelId: selected.candidateModelId,
  };
}

export async function handleGitListCommitModelOptions(
  request: GitListCommitModelOptionsRequest,
  deps: {
    providerStore: ProviderStore;
    agentOrchestrationStore: AgentOrchestrationStore;
    gitSettingsStore: GitSettingsStore;
    pricingCache: ModelsDevPricingCache;
  },
  purpose: "general" | "approval" = "general",
): Promise<GitListCommitModelOptionsResult> {
  const providers = deps.providerStore.listProvidersWithSecrets();
  const candidates = listCommitMessageCandidateModels(
    providers,
    (providerId) => deps.providerStore.listCandidateModels(providerId),
    purpose,
  );
  const hints = await lookupCommitModelPricingHints(
    deps.pricingCache,
    providers,
    candidates.map((candidate) => ({
      candidateModelId: candidate.candidateModelId,
      providerId: candidate.providerId,
      providerName: candidate.providerName,
      modelId: candidate.modelId,
      ...(candidate.modelsDevMapping ? { modelsDevMapping: candidate.modelsDevMapping } : {}),
      ...(candidate.manualSpec ? { manualSpec: candidate.manualSpec } : {}),
    })),
  );
  const options: CommitModelOptionView[] = buildCommitModelOptions(candidates, hints);
  const savedCandidateModelId = request.mainAgentConfigId
    ? deps.gitSettingsStore.getCommitMessageCandidateModelIdForMainAgentConfig(request.mainAgentConfigId)
    : "auto";
  return {
    options,
    savedCandidateModelId,
  };
}

export async function handleGitSaveCommitModelPreference(
  request: GitSaveCommitModelPreferenceRequest,
  deps: {
    providerStore: ProviderStore;
    gitSettingsStore: GitSettingsStore;
    workflowSettingsStore: WorkflowSettingsStore;
  },
): Promise<GitSaveCommitModelPreferenceResult> {
  const candidates = await listCommitCandidates({ providerStore: deps.providerStore });
  const selected = candidates.find((candidate) => candidate.candidateModelId === request.candidateModelId);
  if (!selected) {
    throw new Error(`Git 提交模型已不在候选模型列表中：${request.candidateModelId}`);
  }
  const availableCandidateModelIds = new Set(candidates.map((candidate) => candidate.candidateModelId));
  if (request.mainAgentConfigId) {
    deps.gitSettingsStore.saveCommitMessageCandidateModelIdForMainAgentConfig(
      request.mainAgentConfigId,
      request.candidateModelId,
      availableCandidateModelIds,
    );
  } else {
    const workflow = deps.workflowSettingsStore.get();
    deps.workflowSettingsStore.save({
      ...workflow,
      defaultAuxiliaryModel: {
        providerId: selected.providerId,
        modelId: selected.modelId,
        candidateModelId: selected.candidateModelId,
      },
    });
  }
  return { savedCandidateModelId: request.candidateModelId };
}

export async function handleGitGenerateCommitMessage(
  request: GitGenerateCommitMessageRequest,
  deps: {
    providerStore: ProviderStore;
    agentOrchestrationStore: AgentOrchestrationStore;
    gitSettingsStore: GitSettingsStore;
    pricingCache: ModelsDevPricingCache;
    run?: GitRunner;
    onCommitMessageDelta?: (text: string) => void;
  },
): Promise<GitGenerateCommitMessageResult> {
  requireCommitCandidateModelId(request.candidateModelId);
  const run = deps.run ?? defaultGitRunner;
  await stageChanges(request.workspacePath, { includeUnstaged: request.includeUnstaged }, run);
  const context = await collectCommitDiffContext(request.workspacePath, request.includeUnstaged, run);
  if (!context.stagedNameStatus.trim() && !context.unstagedNameStatus?.trim()) {
    throw new Error("没有可提交的变更。");
  }
  const candidateModelIdPreference = request.candidateModelId;
  const { route, candidateModelId } = await resolveCommitProxyRoute({
    ...(request.mainAgentConfigId ? { mainAgentConfigId: request.mainAgentConfigId } : {}),
    ...(candidateModelIdPreference !== undefined && {
      candidateModelIdPreference,
    }),
    providerStore: deps.providerStore,
    agentOrchestrationStore: deps.agentOrchestrationStore,
    gitSettingsStore: deps.gitSettingsStore,
    pricingCache: deps.pricingCache,
  });
  const commitInstructions = deps.gitSettingsStore.get().commitMessageInstructions;
  const message = await summarizeCommitMessage(
    route,
    context,
    fetch,
    commitInstructions,
    deps.onCommitMessageDelta,
  );
  if (!message?.trim()) {
    logUpstreamError("git-commit-message-failed", {
      mainAgentConfigId: request.mainAgentConfigId,
      workspacePath: request.workspacePath,
      candidateModelId,
      modelId: route.modelId,
      provider: route.provider.name,
      stagedFiles: context.stagedNameStatus,
      hasUnstaged: Boolean(context.unstagedNameStatus?.trim()),
    });
    throw new Error("模型未能生成有效的提交信息，请手动填写。");
  }
  return {
    message,
    candidateModelId,
    modelId: route.modelId,
    providerName: route.provider.name,
    role: COMMIT_MESSAGE_ROLE,
  };
}

export async function handleGitCommit(
  request: GitCommitRequest,
  deps: {
    providerStore: ProviderStore;
    agentOrchestrationStore: AgentOrchestrationStore;
    gitSettingsStore: GitSettingsStore;
    pricingCache: ModelsDevPricingCache;
    run?: GitRunner;
  },
): Promise<GitCommitResult> {
  if (!request.message?.trim()) {
    requireCommitCandidateModelId(request.candidateModelId);
  }
  const run = deps.run ?? defaultGitRunner;
  await stageChanges(request.workspacePath, { includeUnstaged: request.includeUnstaged }, run);

  let message = request.message?.trim() ?? "";
  let generated = false;
  let candidateModelId: string | undefined;
  let modelId: string | undefined;

  if (!message) {
    const generatedResult = await handleGitGenerateCommitMessage(request, deps);
    message = generatedResult.message;
    generated = true;
    candidateModelId = generatedResult.candidateModelId;
    modelId = generatedResult.modelId;
  }

  const commitSha = await createCommit(request.workspacePath, message, run);
  return {
    commitSha,
    message,
    generated,
    ...(candidateModelId && { candidateModelId }),
    ...(modelId && { modelId }),
    role: COMMIT_MESSAGE_ROLE,
  };
}

function requireCommitCandidateModelId(value: string | "auto" | undefined): asserts value is string {
  if (!value || value === "auto") {
    throw new Error("未指定 Git 提交模型，无法生成提交信息。请在提交窗口中选择生成模型。");
  }
}

export async function handleGitPush(
  request: GitPushRequest,
  run: GitRunner = defaultGitRunner,
): Promise<GitPushResult> {
  return pushChanges(request.workspacePath, request.branch ? { branch: request.branch } : {}, run);
}

export async function handleGitPull(
  request: GitPullRequest,
  run: GitRunner = defaultGitRunner,
): Promise<GitPullResult> {
  return pullChanges(request.workspacePath, request.branch ? { branch: request.branch } : {}, run);
}

export {
  checkoutGitBranch,
  createGitBranch,
  discardWorkspaceChanges,
  fetchFromOrigin,
  getGitWorkingTreeStatus,
  getWorkspaceDiff,
  getWorkspaceFileDiff,
  listGitCommits,
};
