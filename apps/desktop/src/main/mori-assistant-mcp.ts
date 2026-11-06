import { isBuiltinHubServerName } from "../shared/composer-references";
import { buildMcpSdkConfig, type McpToolApprovalTarget, sanitizeMcpServerName } from "../shared/mcp";
import type { MoriAssistantSnapshot } from "../shared/mori-assistant";
import type { McpHubGateway } from "./mcp-hub-gateway";
import { prepareMcpSdkConfigForRuntime } from "./mcp-runtime";
import type { McpStore } from "./mcp-store";

/** Mori owns its upstreams and credentials independently of work conversations. */
export class MoriAssistantMcp {
  constructor(
    private readonly store: McpStore,
    private readonly gateway: McpHubGateway,
  ) {}

  listServers(): MoriAssistantSnapshot["mcpServers"] {
    const servers = this.store.listServers();
    return servers.map((server) => {
      const key = sanitizeMcpServerName(server.name);
      const reason = !server.enabled
        ? "已在 MCP 设置中禁用"
        : isBuiltinHubServerName(key)
          ? "名称与内置服务冲突"
          : servers.filter((item) => sanitizeMcpServerName(item.name) === key).length !== 1
            ? "服务名称规范化后重复"
            : undefined;
      return {
        id: server.id,
        name: server.name,
        transport: server.transport,
        available: !reason,
        ...(reason ? { reason } : {}),
      };
    });
  }

  private async prepare(threadId: string, ids: string[], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const catalog = this.listServers();
    for (const id of ids) {
      const server = catalog.find((item) => item.id === id);
      if (!server?.available)
        throw new Error(
          `MCP 服务不可用：${server?.name ?? id}（${server?.reason ?? "已删除"}）。请调整 Mori 的 MCP 勾选。`,
        );
    }
    const selected = this.store.listServers().filter((server) => ids.includes(server.id));
    const config = prepareMcpSdkConfigForRuntime(buildMcpSdkConfig(selected));
    const sync = this.gateway.syncSdkConfig(config);
    if (sync.unsupported.length) throw new Error(`不支持的 MCP 服务：${sync.unsupported.join("、")}`);
    await this.gateway.prepareThread({
      threadId,
      allowedServers: selected.map((server) => sanitizeMcpServerName(server.name)),
      allowedTools: config.allowedTools,
    });
    signal.throwIfAborted();
  }

  async search(threadId: string, ids: string[], query: string, signal: AbortSignal) {
    await this.prepare(threadId, ids, signal);
    return this.gateway.searchThreadTools(threadId, query, signal);
  }

  approvalTarget(ids: string[], toolId: string): McpToolApprovalTarget {
    const separator = toolId.indexOf(":");
    if (separator <= 0 || separator === toolId.length - 1)
      throw new Error("请使用 MCP 搜索结果中的 server:tool 工具名称。");
    const target = this.store.getToolApprovalTarget(toolId.slice(0, separator), toolId.slice(separator + 1));
    const server = target && this.listServers().find((item) => item.id === target.serverId);
    if (!target || !server?.available || !ids.includes(target.serverId))
      throw new Error("MCP 工具未勾选、不可用或不在允许列表中。");
    return target;
  }

  isApproved(target: McpToolApprovalTarget): boolean {
    return this.store.isToolApproved(target);
  }

  async call(
    threadId: string,
    ids: string[],
    toolId: string,
    args: Record<string, unknown>,
    target: McpToolApprovalTarget,
    signal: AbortSignal,
  ) {
    await this.prepare(threadId, ids, signal);
    const current = this.approvalTarget(ids, toolId);
    if (
      current.serverId !== target.serverId ||
      current.configurationRevision !== target.configurationRevision
    )
      throw new Error("MCP 配置或权限已变化，请重新确认工具调用。");
    return this.gateway.callThreadTool(threadId, toolId, args, signal);
  }

  revoke(threadId: string): void {
    this.gateway.revokeThread(threadId);
  }
  close(): Promise<void> {
    return this.gateway.close();
  }
}
