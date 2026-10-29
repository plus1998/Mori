import http from "node:http";
import { MODEL_MANAGEMENT_MCP_SERVER, MODEL_MANAGEMENT_PROMPT } from "../shared/model-management";
import { BrowserMcpAuthRegistry, createBrowserMcpControlSecret } from "./browser-mcp-auth";
import { buildEcoHttpInjection } from "./mcp-http-descriptor";
import { handleMcpStreamableHttpRequest } from "./mcp-streamable-http";
import { type ModelManagementService, modelManagementTools } from "./model-management-service";

export class ModelManagementMcpGateway {
  private readonly auth = new BrowserMcpAuthRegistry();
  private readonly secret = createBrowserMcpControlSecret();
  private server: http.Server | undefined;
  private starting: Promise<void> | undefined;
  constructor(private readonly service: ModelManagementService) {}

  async resolveInjection(threadId: string) {
    this.starting ??= this.start();
    await this.starting;
    const address = this.server?.address();
    if (!address || typeof address === "string") throw new Error("模型管理工具入口尚未启动。");
    return buildEcoHttpInjection({
      name: MODEL_MANAGEMENT_MCP_SERVER,
      controlBaseUrl: `http://127.0.0.1:${address.port}`,
      controlSecretHeader: "X-Eco-Models-Secret",
      controlSecret: this.secret,
      authToken: this.auth.ensure(threadId).token,
      enabledTools: modelManagementTools.map((tool) => tool.name),
    });
  }

  disposeThread(threadId: string): void {
    this.auth.revokeThread(threadId);
  }
  async close(): Promise<void> {
    const server = this.server;
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  }

  private async start(): Promise<void> {
    const server = http.createServer((request, response) => {
      void handleMcpStreamableHttpRequest(
        request,
        response,
        {
          serverName: MODEL_MANAGEMENT_MCP_SERVER,
          instructions: MODEL_MANAGEMENT_PROMPT,
          listTools: async ({ authToken }) => {
            if (!this.auth.resolve(authToken)) throw new Error("缺少当前会话认证。");
            return { tools: modelManagementTools };
          },
          callTool: async ({ name, arguments: args, authToken }) => {
            try {
              if (!this.auth.resolve(authToken)) throw new Error("缺少当前会话认证。");
              const result = await this.service.invoke(name, args);
              return {
                ...(result && typeof result === "object" && "ok" in result && result.ok === false
                  ? { isError: true }
                  : {}),
                content: [{ type: "text", text: JSON.stringify(result) }],
              };
            } catch (error) {
              return {
                isError: true,
                content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
              };
            }
          },
        },
        { controlSecretHeader: "x-eco-models-secret", controlSecret: this.secret },
      ).catch((error) => {
        if (!response.headersSent) response.writeHead(500);
        response.end(String(error));
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  }
}
