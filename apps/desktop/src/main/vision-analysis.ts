import type { PromptImageAttachment, RuntimeRoleRouteConfig } from "../shared/ipc";
import { BUILTIN_VISION_AGENT_ROLE, buildVisionObservationPrompt } from "../shared/prompt-image-vision";
import { runtimeRouteToProxyRoute } from "./anthropic-proxy";
import type { RuntimeRoute } from "./billing-resolver";
import {
  buildStatelessModelRequest,
  readStatelessModelText,
  resolveRouteApiCompat,
} from "./bridge-auxiliary-request";
import { OAUTH_ACCOUNT_ID_HEADER } from "./chatgpt-gateway-account";
import { resolveOrchestrationGuardrails } from "./orchestration-run-budget";
import { ECO_PROXY_BILLING_HEADERS } from "./proxy-billing-stamp";
import { ImageViewNativeRequiredError } from "./image-view-errors";

const maxVisionRequestRuntimeMs = resolveOrchestrationGuardrails().maxSubagentRuntimeMs;

export interface VisionAnalysisRequest {
  threadId: string;
  prompt: string;
  attachments: readonly PromptImageAttachment[];
  billingAgentId: string;
  emitSubagentLifecycle: boolean;
  signal?: AbortSignal;
  routesOverride?: readonly RuntimeRoleRouteConfig[];
  runAttemptId?: string;
}

export interface VisionAnalysisHost {
  resolveRoute(threadId: string, routesOverride?: readonly RuntimeRoleRouteConfig[]): RuntimeRoute;
  startProxy(
    route: RuntimeRoute,
    attachments: readonly PromptImageAttachment[],
    stamp: {
      threadId: string;
      runAttemptId?: string;
    },
  ): Promise<{ baseUrl: string; apiKey: string; aliasModelId: string; close(): Promise<void> }>;
  registerBilling(threadId: string, agentId: string): void;
  unregisterBilling(threadId: string, agentId: string): void;
  emitSubagentStart(input: { threadId: string; agentId: string; imageCount: number }): void;
  emitSubagentStop(input: {
    threadId: string;
    agentId: string;
    imageCount: number;
    failed: boolean;
    report?: string;
  }): void;
}

export interface ImageViewHost {
  resolveRoute(threadId: string, routesOverride?: readonly RuntimeRoleRouteConfig[]): RuntimeRoute;
  startProxy(
    route: RuntimeRoute,
    attachments: readonly PromptImageAttachment[],
    stamp: {
      threadId: string;
      runAttemptId?: string;
    },
  ): Promise<{ baseUrl: string; apiKey: string; aliasModelId: string; close(): Promise<void> }>;
  registerBilling(threadId: string, agentId: string): void;
  unregisterBilling(threadId: string, agentId: string): void;
}

export interface ImageViewRequest {
  threadId: string;
  prompt: string;
  attachments: readonly PromptImageAttachment[];
  billingAgentId: string;
  signal?: AbortSignal;
  routesOverride?: readonly RuntimeRoleRouteConfig[];
  runAttemptId?: string;
}

export async function runVisionAnalysis(
  input: VisionAnalysisRequest,
  host: VisionAnalysisHost,
): Promise<string> {
  const sourceRoute = host.resolveRoute(input.threadId, input.routesOverride);
  if (!sourceRoute) {
    throw new Error("看图子代理缺少可用的模型路由。");
  }
  if (sourceRoute.provider.authMethod === "chatgpt_subscription" && !sourceRoute.accountId?.trim()) {
    throw new Error("ChatGPT OAuth 视觉模型尚未选择账号，请先选择账号和模型。");
  }
  if (sourceRoute.manualSpec?.supportsImageInput === false) {
    const label = sourceRoute.role === BUILTIN_VISION_AGENT_ROLE ? "视觉模型" : "主 Agent 模型";
    throw new Error(`${label} ${sourceRoute.modelId} 已明确配置为不支持图片输入。`);
  }

  const visionRoute: RuntimeRoute = {
    ...sourceRoute,
    role: BUILTIN_VISION_AGENT_ROLE,
    manualSpec: {
      ...sourceRoute.manualSpec,
      maxOutputTokens: 1600,
    },
  };

  if (input.emitSubagentLifecycle) {
    host.emitSubagentStart({
      threadId: input.threadId,
      agentId: input.billingAgentId,
      imageCount: input.attachments.length,
    });
  }
  host.registerBilling(input.threadId, input.billingAgentId);

  let report: string | undefined;
  let failure: unknown;
  let proxy: Awaited<ReturnType<VisionAnalysisHost["startProxy"]>> | undefined;
  try {
    proxy = await host.startProxy(visionRoute, [], {
      threadId: input.threadId,
      ...(input.runAttemptId ? { runAttemptId: input.runAttemptId } : {}),
    });
    if (!proxy.aliasModelId) {
      throw new Error("看图子代理没有生成可调用的模型别名。");
    }
    const modelRoute = runtimeRouteToProxyRoute(visionRoute);
    const visionPrompt = buildVisionObservationPrompt({
      prompt: input.prompt,
      imageCount: input.attachments.length,
    });
    const native = buildStatelessModelRequest(
      { ...modelRoute, modelId: proxy.aliasModelId },
      {
        system: visionPrompt.system,
        messages: [{ role: "user", content: visionPrompt.userMessage }],
        images: input.attachments,
        maxTokens: visionRoute.manualSpec?.maxOutputTokens ?? 1600,
      },
    );
    const response = await fetch(`${proxy.baseUrl.replace(/\/$/, "")}${native.path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": proxy.apiKey,
        "x-eco-route-role": "vision",
        ...(visionRoute.accountId ? { [OAUTH_ACCOUNT_ID_HEADER]: visionRoute.accountId } : {}),
        [ECO_PROXY_BILLING_HEADERS.agentId]: input.billingAgentId,
        [ECO_PROXY_BILLING_HEADERS.billingRole]: BUILTIN_VISION_AGENT_ROLE,
        ...(input.runAttemptId ? { [ECO_PROXY_BILLING_HEADERS.runAttemptId]: input.runAttemptId } : {}),
      },
      body: JSON.stringify(native.body),
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(maxVisionRequestRuntimeMs)])
        : AbortSignal.timeout(maxVisionRequestRuntimeMs),
    });
    if (!response.ok) {
      throw new Error(`视觉模型请求失败（HTTP ${response.status}）：${await response.text()}`);
    }
    const text = await readStatelessModelText(response, resolveRouteApiCompat(modelRoute));
    if (!text) throw new Error("视觉模型未返回可用正文。");
    report = text;
    return report;
  } catch (error) {
    failure = error;
    throw new Error(`图片理解失败：${errorMessage(error)}`);
  } finally {
    await proxy?.close().catch(() => {});
    host.unregisterBilling(input.threadId, input.billingAgentId);
    if (input.emitSubagentLifecycle) {
      host.emitSubagentStop({
        threadId: input.threadId,
        agentId: input.billingAgentId,
        imageCount: input.attachments.length,
        failed: Boolean(failure),
        ...(report ? { report } : {}),
      });
    }
  }
}

export async function runImageView(input: ImageViewRequest, host: ImageViewHost): Promise<string> {
  const prompt = input.prompt.trim();
  if (!prompt) {
    throw new Error("image_view 调用必须提供 prompt。");
  }
  let sourceRoute: RuntimeRoute;
  try {
    sourceRoute = host.resolveRoute(input.threadId, input.routesOverride);
  } catch (error) {
    if (error instanceof ImageViewNativeRequiredError) {
      throw new ImageViewNativeRequiredError(input.attachments[0]?.path);
    }
    throw error;
  }
  if (!sourceRoute) {
    throw new Error("image_view 缺少可用的模型路由。");
  }
  if (sourceRoute.provider.authMethod === "chatgpt_subscription" && !sourceRoute.accountId?.trim()) {
    throw new Error("ChatGPT OAuth 视觉模型尚未选择账号，请先选择账号和模型。");
  }
  if (sourceRoute.manualSpec?.supportsImageInput === false) {
    const label = sourceRoute.role === BUILTIN_VISION_AGENT_ROLE ? "视觉模型" : "主 Agent 模型";
    throw new Error(`${label} ${sourceRoute.modelId} 已明确配置为不支持图片输入。`);
  }

  const imageViewRoute: RuntimeRoute = {
    ...sourceRoute,
    role: BUILTIN_VISION_AGENT_ROLE,
  };
  host.registerBilling(input.threadId, input.billingAgentId);

  let proxy: Awaited<ReturnType<ImageViewHost["startProxy"]>> | undefined;
  try {
    proxy = await host.startProxy(imageViewRoute, [], {
      threadId: input.threadId,
      ...(input.runAttemptId ? { runAttemptId: input.runAttemptId } : {}),
    });
    if (!proxy.aliasModelId) {
      throw new Error("image_view 没有生成可调用的模型别名。");
    }
    const modelRoute = runtimeRouteToProxyRoute(imageViewRoute);
    const native = buildStatelessModelRequest(
      { ...modelRoute, modelId: proxy.aliasModelId },
      {
        messages: [{ role: "user", content: prompt }],
        images: input.attachments,
        maxTokens: imageViewRoute.manualSpec?.maxOutputTokens ?? 4096,
      },
    );
    const response = await fetch(`${proxy.baseUrl.replace(/\/$/, "")}${native.path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": proxy.apiKey,
        "x-eco-route-role": "vision",
        ...(imageViewRoute.accountId ? { [OAUTH_ACCOUNT_ID_HEADER]: imageViewRoute.accountId } : {}),
        [ECO_PROXY_BILLING_HEADERS.agentId]: input.billingAgentId,
        [ECO_PROXY_BILLING_HEADERS.billingRole]: BUILTIN_VISION_AGENT_ROLE,
        ...(input.runAttemptId ? { [ECO_PROXY_BILLING_HEADERS.runAttemptId]: input.runAttemptId } : {}),
      },
      body: JSON.stringify(native.body),
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(maxVisionRequestRuntimeMs)])
        : AbortSignal.timeout(maxVisionRequestRuntimeMs),
    });
    if (!response.ok) {
      throw new Error(`视觉模型请求失败（HTTP ${response.status}）：${await response.text()}`);
    }
    const text = await readStatelessModelText(response, resolveRouteApiCompat(modelRoute));
    if (!text) throw new Error("视觉模型未返回可用正文。");
    return text;
  } catch (error) {
    throw new Error(`图片查看失败（model=${sourceRoute.modelId}）：${errorMessage(error)}`);
  } finally {
    await proxy?.close().catch(() => {});
    host.unregisterBilling(input.threadId, input.billingAgentId);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
