import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { McpSdkConfig } from "../shared/mcp";
import { BrowserMcpAuthRegistry, createBrowserMcpControlSecret } from "./browser-mcp-auth";
import { buildEcoHttpInjection } from "./mcp-http-descriptor";
import { handleMcpStreamableHttpRequest, type McpToolDefinition } from "./mcp-streamable-http";
import type { WechatNotification } from "./mori-assistant-wechat";

export const ECO_WECHAT_MCP_SERVER = "eco_wechat";
export const ECO_WECHAT_TOOL = "send_wechat_message";
export const ECO_WECHAT_FULL_TOOL = `mcp__${ECO_WECHAT_MCP_SERVER}__${ECO_WECHAT_TOOL}`;
const CONTROL_SECRET_HEADER = "X-Eco-Wechat-Control-Secret";

export interface WechatMcpInjection {
  enabled: boolean;
  sdkEntry?: Record<string, unknown>;
  promptAppend?: string;
}

export interface WechatMcpGatewayDeps {
  send(
    threadId: string,
    notification: WechatNotification,
    notificationId: string,
    signal: AbortSignal,
  ): Promise<void>;
}

const TOOL: McpToolDefinition = {
  name: ECO_WECHAT_TOOL,
  description:
    "Send a text and/or image to the user's connected WeChat account. Use only when the user explicitly requested a WeChat notification. imagePath must be an absolute local path; imageUrl must be HTTP(S).",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", maxLength: 100_000 },
      imagePath: { type: "string", maxLength: 4_000 },
      imageUrl: { type: "string", maxLength: 8_000 },
    },
    additionalProperties: false,
  },
};

export class WechatMcpGateway {
  private readonly auth = new BrowserMcpAuthRegistry();
  private readonly controlSecret = createBrowserMcpControlSecret();
  private server: http.Server | undefined;
  private port: number | undefined;

  constructor(private readonly deps: WechatMcpGatewayDeps) {}

  async resolveInjection(threadId: string, authorized: boolean): Promise<WechatMcpInjection> {
    if (!authorized) {
      this.auth.revokeThread(threadId);
      return { enabled: false };
    }
    await this.start();
    const auth = this.auth.ensure(threadId);
    const httpEntry = buildEcoHttpInjection({
      name: ECO_WECHAT_MCP_SERVER,
      controlBaseUrl: this.controlBaseUrl,
      controlSecretHeader: CONTROL_SECRET_HEADER,
      controlSecret: this.controlSecret,
      authToken: auth.token,
      enabledTools: [ECO_WECHAT_TOOL],
    });
    return {
      enabled: true,
      sdkEntry: httpEntry.sdkEntry,
      promptAppend:
        "用户已明确要求微信通知。本轮可使用 eco_wechat 的 send_wechat_message 工具发送文字或图片；只在确有结果时调用，调用成功才可向用户确认已发送。",
    };
  }

  mergeIntoSdkConfig(base: McpSdkConfig, injection: WechatMcpInjection): McpSdkConfig {
    if (!injection.enabled || !injection.sdkEntry) return base;
    return {
      mcpServers: { ...base.mcpServers, [ECO_WECHAT_MCP_SERVER]: injection.sdkEntry },
      allowedTools: [...new Set([...base.allowedTools, ECO_WECHAT_FULL_TOOL])],
    };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((request, response) => void this.handle(request, response));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    this.port = (server.address() as AddressInfo).port;
  }

  private get controlBaseUrl(): string {
    if (!this.port) throw new Error("微信 MCP 服务尚未启动。");
    return `http://127.0.0.1:${this.port}`;
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const requestPath = (request.url ?? "").split("?")[0] ?? "";
    if (requestPath !== "/mcp" && !requestPath.startsWith("/mcp/")) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    await handleMcpStreamableHttpRequest(
      request,
      response,
      {
        serverName: ECO_WECHAT_MCP_SERVER,
        instructions: "发送微信消息前必须确认用户在本轮明确提出了微信通知要求。",
        listTools: async () => ({ tools: [TOOL] }),
        callTool: async ({ name, arguments: args, authToken, signal }) => {
          if (name !== ECO_WECHAT_TOOL) throw new Error(`未知微信工具：${name}`);
          const threadId = this.auth.resolve(authToken)?.threadId;
          if (!threadId) throw new Error("微信工具缺少有效的会话授权。");
          const text = typeof args.text === "string" ? args.text.trim() : "";
          const imagePath = typeof args.imagePath === "string" ? args.imagePath.trim() : "";
          const imageUrl = typeof args.imageUrl === "string" ? args.imageUrl.trim() : "";
          if (!text && !imagePath && !imageUrl) throw new Error("微信通知至少需要文字或图片。");
          if (imagePath && imageUrl) throw new Error("微信图片只能提供路径或 URL 其中之一。");
          const notification: WechatNotification = {
            ...(text ? { text } : {}),
            ...(imagePath || imageUrl ? { image: imagePath ? { path: imagePath } : { url: imageUrl } } : {}),
          };
          const digest = createHash("sha256").update(JSON.stringify(notification)).digest("hex").slice(0, 24);
          await this.deps.send(threadId, notification, `agent-wechat-${threadId}-${digest}`, signal);
          return { content: [{ type: "text", text: JSON.stringify({ sent: true }) }] };
        },
      },
      { controlSecretHeader: CONTROL_SECRET_HEADER, controlSecret: this.controlSecret },
    );
  }
}
