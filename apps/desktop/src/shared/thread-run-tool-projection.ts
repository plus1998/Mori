import { isEcoImageViewToolName } from "@eco/runtime/eco-image-view-names";
import { createToolOutputPreview } from "@eco/runtime/tool-output-preview";
import {
  parseThreadRunCodemodeMetadata,
  parseThreadRunImageViewMetadata,
  type ThreadRunCodemodeMetadata,
  type ThreadRunToolMetadata,
} from "./thread-run-events";

/**
 * 工具输出会按调用逐条落库，所以只有"输出本身就是卡片重点"的工具才值得存。
 * Bash 一直如此；查看图像也要，因为视觉模型的回答是提示词唯一的答案——不存它，
 * 卡片就只能显示图片，永远说不出问了什么、答了什么。codemode 同理：脚本的返回值
 * 就是模型看到的唯一东西，不存它卡片就只剩"执行了工具"。
 */
export function keepsOutputPreview(name: string): boolean {
  return (
    name === "Bash" || isEcoImageViewToolName(name) || name.trim().toLowerCase() === PI_CODEMODE_TOOL_NAME
  );
}

/** PI's `codemode` tool name (kept local so the shared layer stays renderer-safe). */
export const PI_CODEMODE_TOOL_NAME = "codemode";

/** PI prefixes every script result with `Script completed|failed\nWall time X seconds\nOutput:\n`. */
const PI_CODEMODE_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n/;

export function isCodemodeToolName(name: string | undefined): boolean {
  return name?.trim().toLowerCase() === PI_CODEMODE_TOOL_NAME;
}

/**
 * Assemble the codemode card payload from what the runtime already carries: the script in the
 * call input, the script output in the tool result, PI's `details` for the nested calls.
 */
export function resolveCodemodeMetadata(input: {
  name: string;
  callInput?: unknown;
  output?: string;
  details?: unknown;
}): ThreadRunCodemodeMetadata | undefined {
  if (!isCodemodeToolName(input.name)) {
    return undefined;
  }
  const callInput =
    input.callInput && typeof input.callInput === "object" && !Array.isArray(input.callInput)
      ? (input.callInput as Record<string, unknown>)
      : {};
  const argumentsRecord =
    callInput.arguments && typeof callInput.arguments === "object" && !Array.isArray(callInput.arguments)
      ? (callInput.arguments as Record<string, unknown>)
      : undefined;
  const script =
    (typeof callInput.code === "string" && callInput.code) ||
    (typeof argumentsRecord?.code === "string" && argumentsRecord.code) ||
    "";
  const rawOutput = input.output?.trim() ?? "";
  const output = rawOutput.replace(PI_CODEMODE_HEADER, "").trim();
  const details =
    input.details && typeof input.details === "object" && !Array.isArray(input.details)
      ? (input.details as Record<string, unknown>)
      : undefined;
  return parseThreadRunCodemodeMetadata({
    script,
    output,
    ...(details?.fullOutputPath !== undefined ? { fullOutputPath: details.fullOutputPath } : {}),
    ...(details?.calls !== undefined ? { calls: details.calls } : {}),
  });
}

export function projectThreadRunToolMetadata(
  tool: ThreadRunToolMetadata | undefined,
): ThreadRunToolMetadata | undefined {
  if (!tool) {
    return undefined;
  }
  const name = tool.name.trim();
  if (!name) {
    return undefined;
  }
  const outputPreview =
    keepsOutputPreview(name) && tool.outputPreview?.trim()
      ? createToolOutputPreview(tool.outputPreview)
      : undefined;
  const imageView = parseThreadRunImageViewMetadata(tool.imageView);
  const codemode = parseThreadRunCodemodeMetadata(tool.codemode);
  const projected = {
    name,
    ...(tool.detail?.trim() && { detail: tool.detail.trim() }),
    ...(outputPreview?.text && { outputPreview: outputPreview.text }),
    ...(outputPreview?.text &&
      (tool.outputPreviewTruncated || outputPreview.truncated) && {
        outputPreviewTruncated: true,
      }),
    ...(tool.toolUseId?.trim() && { toolUseId: tool.toolUseId.trim() }),
    ...(tool.durationMs !== undefined && Number.isFinite(tool.durationMs) && { durationMs: tool.durationMs }),
    ...(tool.exitCode !== undefined && Number.isFinite(tool.exitCode) && { exitCode: tool.exitCode }),
    ...(isThreadRunToolStatus(tool.status) && { status: tool.status }),
    ...(tool.nonExecutionKind === "denied" ||
    tool.nonExecutionKind === "interrupted" ||
    tool.nonExecutionKind === "cancelled"
      ? { nonExecutionKind: tool.nonExecutionKind }
      : {}),
    ...(tool.description?.trim() && { description: tool.description.trim() }),
    ...(tool.fileChange && { fileChange: tool.fileChange }),
    ...(tool.readTarget && { readTarget: tool.readTarget }),
    ...(tool.grepTarget && { grepTarget: tool.grepTarget }),
    ...(tool.webSearch && { webSearch: projectWebSearchMetadata(tool.webSearch) }),
    ...(imageView && { imageView }),
    ...(tool.imageDisplay?.artifactId.trim() && {
      imageDisplay: {
        artifactId: tool.imageDisplay.artifactId.trim(),
        ...(tool.imageDisplay.title?.trim() ? { title: tool.imageDisplay.title.trim() } : {}),
      },
    }),
    ...(tool.htmlHost?.pageId.trim() &&
      tool.htmlHost.publicUrl.trim() && {
        htmlHost: {
          pageId: tool.htmlHost.pageId.trim(),
          publicUrl: tool.htmlHost.publicUrl.trim(),
          ...(tool.htmlHost.title?.trim() ? { title: tool.htmlHost.title.trim() } : {}),
          ...(tool.htmlHost.expiresAt?.trim() ? { expiresAt: tool.htmlHost.expiresAt.trim() } : {}),
          ...(typeof tool.htmlHost.canExtend === "boolean" ? { canExtend: tool.htmlHost.canExtend } : {}),
        },
      }),
    ...(tool.mcpDiscovery?.kind === "search" && { mcpDiscovery: { kind: "search" as const } }),
    ...(tool.parentToolCallId?.trim() && { parentToolCallId: tool.parentToolCallId.trim() }),
    ...(codemode && { codemode }),
    ...(tool.sendMessage && { sendMessage: tool.sendMessage }),
  };
  return projected;
}

function projectWebSearchMetadata(
  value: NonNullable<ThreadRunToolMetadata["webSearch"]>,
): NonNullable<ThreadRunToolMetadata["webSearch"]> {
  const query = value.query?.trim();
  const url = value.url?.trim();
  const pattern = value.pattern?.trim();
  const provider = value.provider?.trim();
  const queries = Array.isArray(value.queries)
    ? value.queries
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim())
        .slice(0, 12)
    : undefined;
  const results = Array.isArray(value.results)
    ? value.results
        .map((entry) => {
          if (!entry || typeof entry !== "object") {
            return undefined;
          }
          const title = typeof entry.title === "string" ? entry.title.trim() : "";
          const hitUrl = typeof entry.url === "string" ? entry.url.trim() : "";
          const description =
            typeof entry.description === "string" ? entry.description.trim() : undefined;
          if (!title && !hitUrl && !description) {
            return undefined;
          }
          return {
            title,
            url: hitUrl,
            ...(description ? { description } : {}),
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
        .slice(0, 12)
    : undefined;
  const actionType = value.actionType;
  const mode = value.mode === "fetch" || value.mode === "search" ? value.mode : undefined;
  return {
    ...(query && { query }),
    ...(url && { url }),
    ...(pattern && { pattern }),
    ...(provider && { provider }),
    ...(queries && queries.length > 0 && { queries }),
    ...(results && results.length > 0 && { results }),
    ...(actionType === "search" ||
    actionType === "openPage" ||
    actionType === "findInPage" ||
    actionType === "other"
      ? { actionType }
      : {}),
    ...(mode && { mode }),
  };
}

export function projectThreadRunToolMetadataForFeed(
  tool: ThreadRunToolMetadata | undefined,
): ThreadRunToolMetadata | undefined {
  const projected = projectThreadRunToolMetadata(tool);
  if (!projected) {
    return undefined;
  }
  const { outputPreview: _outputPreview, outputPreviewTruncated: _truncated, ...feedTool } = projected;
  return feedTool;
}

function isThreadRunToolStatus(value: unknown): value is NonNullable<ThreadRunToolMetadata["status"]> {
  return value === "started" || value === "completed" || value === "failed";
}
