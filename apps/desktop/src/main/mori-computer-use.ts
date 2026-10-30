import {
  type ComputerUseSettingsSnapshot,
  ECO_COMPUTER_USE_ACTION_TOOLS,
  ECO_COMPUTER_USE_TOOLS,
} from "../shared/computer-use";
import type { MoriComputerUseStatus } from "../shared/mori-assistant";
import type { ComputerUseMcpGateway } from "./computer-use-mcp-gateway";
import type { ImageViewMcpGateway } from "./image-view-mcp-gateway";
import type { McpToolCallResult } from "./mcp-streamable-http";

export interface MoriComputerUseAccess {
  status(): MoriComputerUseStatus;
  listTools(signal: AbortSignal): ReturnType<ComputerUseMcpGateway["listTools"]>;
  callTool(
    threadId: string,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<McpToolCallResult>;
  viewScreenshot(
    threadId: string,
    path: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>>;
  close(): void;
}

export class MoriComputerUse implements MoriComputerUseAccess {
  private readonly screenshots = new Map<string, Set<string>>();
  constructor(
    private readonly deps: {
      gateway: Pick<ComputerUseMcpGateway, "isFeatureAvailableQuick" | "listTools" | "callTool">;
      settings(): ComputerUseSettingsSnapshot;
      imageView: Pick<ImageViewMcpGateway, "viewForThread">;
    },
  ) {}

  status(): MoriComputerUseStatus {
    const settings = this.deps.settings();
    return {
      enabled: settings.agentIntegrationEnabled,
      ...this.deps.gateway.isFeatureAvailableQuick(),
      actionApprovalMode: settings.actionApprovalMode,
    };
  }
  async listTools(signal: AbortSignal) {
    this.requireAvailable(signal);
    return this.deps.gateway.listTools(signal);
  }
  async callTool(threadId: string, name: string, args: Record<string, unknown>, signal: AbortSignal) {
    this.requireAvailable(signal);
    if (!(ECO_COMPUTER_USE_TOOLS as readonly string[]).includes(name))
      throw new Error(`未知电脑操作工具：${name}`);
    const result = await this.deps.gateway.callTool(name, args, signal);
    const paths = this.screenshots.get(threadId) ?? new Set<string>();
    bindScreenshotReferences(result, paths);
    while (paths.size > 64) {
      const oldest = paths.values().next().value;
      if (oldest) paths.delete(oldest);
    }
    this.screenshots.set(threadId, paths);
    return result;
  }
  async viewScreenshot(threadId: string, path: string, prompt: string, signal: AbortSignal) {
    this.requireAvailable(signal);
    if (!this.screenshots.get(threadId)?.has(path))
      throw new Error("只能分析当前 Mori 会话通过电脑操作获得的截图，请先重新读取应用状态。");
    return this.deps.imageView.viewForThread(threadId, { path, prompt }, signal);
  }
  close(): void {
    this.screenshots.clear();
  }
  private requireAvailable(signal: AbortSignal): void {
    signal.throwIfAborted();
    const status = this.status();
    if (!status.available) throw new Error(status.reason ?? "电脑操作不可用，请检查设置和系统权限。");
  }
}

export function isMoriComputerAction(name: string): boolean {
  return (ECO_COMPUTER_USE_ACTION_TOOLS as readonly string[]).includes(name);
}

function bindScreenshotReferences(value: unknown, paths: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) bindScreenshotReferences(item, paths);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") {
    const match = record.text.match(/^截图已保存：("(?:\\.|[^"\\])*")/u);
    if (match?.[1]) {
      paths.add(JSON.parse(match[1]) as string);
      record.text = `截图已保存：${match[1]}。如需分析，请调用 mori_computer_view，传入该 path 和具体的 prompt。`;
    }
  }
  for (const item of Object.values(record))
    if (item && typeof item === "object") bindScreenshotReferences(item, paths);
}
