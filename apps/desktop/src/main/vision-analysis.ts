import type { PromptImageAttachment, RuntimeRoleRouteConfig } from "../shared/ipc";
import {
  BUILTIN_VISION_AGENT_ROLE,
  buildImageViewRequestBody,
  buildVisionAnalysisRequestBody,
  readImageViewResponse,
  readVisionAnalysisResponse,
} from "../shared/prompt-image-vision";
import type { RuntimeRoute } from "./billing-resolver";
import { resolveOrchestrationGuardrails } from "./orchestration-run-budget";
import { ECO_PROXY_BILLING_HEADERS } from "./proxy-billing-stamp";

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
    proxy = await host.startProxy(visionRoute, input.attachments, {
      threadId: input.threadId,
      ...(input.runAttemptId ? { runAttemptId: input.runAttemptId } : {}),
    });
    if (!proxy.aliasModelId) {
      throw new Error("看图子代理没有生成可调用的模型别名。");
    }
    const response = await fetch(`${proxy.baseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": proxy.apiKey,
        [ECO_PROXY_BILLING_HEADERS.agentId]: input.billingAgentId,
        [ECO_PROXY_BILLING_HEADERS.billingRole]: BUILTIN_VISION_AGENT_ROLE,
        ...(input.runAttemptId ? { [ECO_PROXY_BILLING_HEADERS.runAttemptId]: input.runAttemptId } : {}),
      },
      body: JSON.stringify(
        buildVisionAnalysisRequestBody({
          model: proxy.aliasModelId,
          prompt: input.prompt,
          imageCount: input.attachments.length,
        }),
      ),
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(maxVisionRequestRuntimeMs)])
        : AbortSignal.timeout(maxVisionRequestRuntimeMs),
    });
    const payload = (await response.json()) as unknown;
    if (!response.ok) {
      throw new Error(`看图子代理请求失败（HTTP ${response.status}）：${readVisionError(payload)}`);
    }
    report = readVisionAnalysisResponse(payload);
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
  const sourceRoute = host.resolveRoute(input.threadId, input.routesOverride);
  if (!sourceRoute) {
    throw new Error("image_view 缺少可用的模型路由。");
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
    proxy = await host.startProxy(imageViewRoute, input.attachments, {
      threadId: input.threadId,
      ...(input.runAttemptId ? { runAttemptId: input.runAttemptId } : {}),
    });
    if (!proxy.aliasModelId) {
      throw new Error("image_view 没有生成可调用的模型别名。");
    }
    const response = await fetch(`${proxy.baseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": proxy.apiKey,
        [ECO_PROXY_BILLING_HEADERS.agentId]: input.billingAgentId,
        [ECO_PROXY_BILLING_HEADERS.billingRole]: BUILTIN_VISION_AGENT_ROLE,
        ...(input.runAttemptId ? { [ECO_PROXY_BILLING_HEADERS.runAttemptId]: input.runAttemptId } : {}),
      },
      body: JSON.stringify(
        buildImageViewRequestBody({
          model: proxy.aliasModelId,
          prompt,
          ...(imageViewRoute.manualSpec?.maxOutputTokens
            ? { maxTokens: imageViewRoute.manualSpec.maxOutputTokens }
            : {}),
        }),
      ),
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(maxVisionRequestRuntimeMs)])
        : AbortSignal.timeout(maxVisionRequestRuntimeMs),
    });
    const payload = (await response.json()) as unknown;
    if (!response.ok) {
      throw new Error(`image_view 请求失败（HTTP ${response.status}）：${readVisionError(payload)}`);
    }
    return readImageViewResponse(payload);
  } catch (error) {
    throw new Error(`图片查看失败（model=${sourceRoute.modelId}）：${errorMessage(error)}`);
  } finally {
    await proxy?.close().catch(() => {});
    host.unregisterBilling(input.threadId, input.billingAgentId);
  }
}

function readVisionError(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const error = (value as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) {
      return error.trim();
    }
    if (error && typeof error === "object" && !Array.isArray(error)) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) {
        return message.trim();
      }
    }
  }
  return "上游未返回错误详情。";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
