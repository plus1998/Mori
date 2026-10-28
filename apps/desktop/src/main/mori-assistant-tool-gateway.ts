import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { buildCodexMcpServerOverride } from "@eco/runtime";
import { handleMcpStreamableHttpRequest } from "./mcp-streamable-http";
import type { AssistantTool } from "./mori-assistant-runtime";

export const MORI_COMPUTER_MCP_SERVER = "mori_computer";
export const MORI_TASK_MCP_SERVER = "mori_tasks";
const SECRET_HEADER = "x-mori-tool-secret";

/** Runtime-local capability endpoint. Existing native threads gain these tools on resume. */
export class MoriAssistantToolGateway {
  private readonly secret = randomBytes(24).toString("base64url");
  private server: http.Server | undefined;
  constructor(
    private readonly tools: AssistantTool[],
    private readonly call: (
      name: string,
      args: Record<string, unknown>,
      id: string,
      signal: AbortSignal,
    ) => Promise<unknown>,
    private readonly serverName: string = MORI_COMPUTER_MCP_SERVER,
  ) {}
  async start(): Promise<Record<string, unknown>> {
    if (this.server) throw new Error("Mori 工具入口已经启动。");
    const server = http.createServer((req, res) => {
      void handleMcpStreamableHttpRequest(
        req,
        res,
        {
          serverName: this.serverName,
          listTools: async () => ({ tools: this.tools.map((tool) => ({ ...tool })) }),
          callTool: async ({ name, arguments: args, signal }) => {
            signal.throwIfAborted();
            if (!this.tools.some((tool) => tool.name === name)) throw new Error("未知的 Mori 工具入口。");
            try {
              const result = await this.call(name, args, `${this.serverName}-${randomUUID()}`, signal);
              return { content: [{ type: "text", text: JSON.stringify(result) }] };
            } catch (error) {
              return {
                isError: true,
                content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
              };
            }
          },
        },
        { controlSecretHeader: SECRET_HEADER, controlSecret: this.secret },
      );
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    return {
      ...buildCodexMcpServerOverride({
        name: this.serverName,
        transport: "http",
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
        httpHeaders: { [SECRET_HEADER]: this.secret },
        enabledTools: this.tools.map((tool) => tool.name),
        toolTimeoutSec: 1800,
      }),
      required: true,
    };
  }
  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
